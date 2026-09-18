import {
  browserWebMCPAction,
  browserWebMCPOperationResult,
  type Action,
  type Result,
} from "@ellie/protocol";
import type {
  BrowserAccessibilityBinding,
  BrowserAccessibilityRuntime,
} from "./browser-accessibility-runtime.ts";
import { browserBindingRevision, type BrowserBinding } from "./browser-operations.ts";
import type { BrowserCompanionOperations } from "./browser-companion-operations.ts";

type WebMCP = {
  execute(action: Action, signal: AbortSignal): Promise<Result>;
  inspectSelectedPage?: (
    binding: BrowserBinding,
    signal: AbortSignal,
  ) => Promise<NonNullable<import("@ellie/protocol").BrowserView["site"]>>;
};

/** Selects the adapter from fresh pre-dispatch binding evidence. It never falls through after dispatch. */
export class BrowserOperationSelector {
  private observationEpoch = 0;
  private observedSite?: {
    revision: string;
    site: NonNullable<import("@ellie/protocol").BrowserView["site"]>;
  };
  private youtubeCompanionRevision?: string;
  private axFallback?: {
    revision: string;
    url: string;
    directions: Set<"up" | "down">;
  };
  private readonly binding: (
    signal: AbortSignal,
    refresh?: boolean,
  ) => Promise<BrowserBinding | "unbound" | "unsupported">;
  private readonly webmcp: WebMCP;
  private readonly accessibility: BrowserAccessibilityRuntime;
  private readonly companion?: BrowserCompanionOperations;
  constructor(
    binding: (
      signal: AbortSignal,
      refresh?: boolean,
    ) => Promise<BrowserBinding | "unbound" | "unsupported">,
    webmcp: WebMCP,
    accessibility: BrowserAccessibilityRuntime,
    companion?: BrowserCompanionOperations,
  ) {
    this.binding = binding;
    this.webmcp = webmcp;
    this.accessibility = accessibility;
    this.companion = companion;
  }

  async execute(action: Action, signal: AbortSignal): Promise<Result> {
    if (!action.tool.startsWith("browser.")) throw new Error("Unsupported browser operation.");
    const browserAction = browserWebMCPAction(action);
    const refresh = browserAction.tool === "browser.refresh";
    if (signal.aborted) throw new Error("Browser request was cancelled.");
    let binding: BrowserBinding | "unbound" | "unsupported";
    try {
      binding = await this.binding(signal, refresh);
    } catch {
      if (signal.aborted) throw new Error("Browser request was cancelled.");
      if (browserAction.tool !== "browser.status" && !refresh)
        throw new Error("Browser connection is unavailable.");
      return browserWebMCPOperationResult({
        ok: false,
        message: "Browser connection is unavailable.",
        browser: { source: "webmcp", operation: "status", status: "unavailable" },
      });
    }
    if (signal.aborted) throw new Error("Browser request was cancelled.");
    const adapterAction = refresh ? browserWebMCPAction({ tool: "browser.status" }) : browserAction;
    const revision = typeof binding === "object" ? browserBindingRevision(binding) : undefined;
    if (this.observedSite?.revision !== revision) this.observedSite = undefined;
    if (this.youtubeCompanionRevision !== revision) this.youtubeCompanionRevision = undefined;
    if (
      this.axFallback?.revision !== revision ||
      (typeof binding === "object" && this.axFallback?.url !== binding.url)
    )
      this.axFallback = undefined;
    if (refresh) {
      this.observationEpoch += 1;
      this.observedSite = undefined;
      this.youtubeCompanionRevision = undefined;
      this.axFallback = undefined;
      this.companion?.invalidate();
    }
    if (
      browserAction.tool === "browser.scrollRow" &&
      (typeof binding !== "object" ||
        binding.availability !== "companion" ||
        binding.origin !== "https://www.netflix.com")
    )
      throw new Error(
        "Observed row scrolling is available only for the selected Netflix companion page.",
      );
    if (typeof binding !== "object" || binding.availability === "webmcp")
      return this.webmcp.execute(adapterAction, signal);
    if (binding.availability === "companion") {
      const accessibilityBinding: BrowserAccessibilityBinding = {
        availability: "accessibility",
        documentId: binding.documentId,
        url: binding.url,
        revision: browserBindingRevision(binding),
      };
      const sameSelectedBinding = async () => {
        if (signal.aborted) throw new Error("Browser request was cancelled.");
        const current = await this.binding(signal);
        if (
          signal.aborted ||
          typeof current !== "object" ||
          current.availability !== "companion" ||
          current.bindingId !== binding.bindingId ||
          current.documentId !== binding.documentId ||
          current.origin !== binding.origin ||
          current.url !== binding.url ||
          current.expiresAt !== binding.expiresAt ||
          current.expiresAt <= Date.now()
        )
          throw new Error("Browser page changed during read.");
      };
      if (browserAction.tool === "browser.read") {
        this.observationEpoch += 1;
        const epoch = this.observationEpoch;
        this.axFallback = undefined;
        let companionRead: Awaited<ReturnType<BrowserCompanionOperations["execute"]>> | undefined;
        if (this.companion)
          companionRead = await this.companion.execute(browserAction, binding, signal);
        if (
          companionRead &&
          (companionRead.ok !== true ||
            companionRead.browser.operation !== "read" ||
            companionRead.browser.status !== "completed" ||
            companionRead.browser.view.site?.page !== "unsupported")
        )
          return companionRead;
        // Only a successful, validated unsupported-page read (or no companion at all)
        // permits a second read. Failed/unknown companion reads remain terminal.
        await sameSelectedBinding();
        if (epoch !== this.observationEpoch) throw new Error("Browser page changed during read.");
        this.companion?.invalidate();
        // Status is the helper's read-only bind/rebind entry. A previous AX session
        // cannot read a newly selected document until this binding is prepared.
        const axStatus = await this.accessibility.execute(
          browserWebMCPAction({ tool: "browser.status" }),
          accessibilityBinding,
          signal,
        );
        await sameSelectedBinding();
        if (
          epoch !== this.observationEpoch ||
          !axStatus.ok ||
          axStatus.browser.source !== "accessibility" ||
          axStatus.browser.operation !== "status" ||
          axStatus.browser.status !== "connected" ||
          axStatus.browser.revision !== revision ||
          axStatus.browser.origin !== binding.origin
        )
          throw new Error("Browser accessibility binding is unavailable.");
        const axRead = await this.accessibility.execute(
          browserAction,
          accessibilityBinding,
          signal,
        );
        await sameSelectedBinding();
        if (
          epoch !== this.observationEpoch ||
          axRead.browser.operation !== "read" ||
          axRead.browser.status !== "completed" ||
          axRead.browser.source !== "accessibility" ||
          axRead.browser.revision !== revision ||
          !Array.isArray(axRead.browser.view.axScrollDirections)
        )
          throw new Error("Browser accessibility observation is unavailable.");
        this.axFallback = {
          revision: revision!,
          url: binding.url,
          directions: new Set(axRead.browser.view.axScrollDirections),
        };
        return axRead;
      }
      if (browserAction.tool === "browser.status")
        return this.companion
          ? this.companion.execute(browserAction, binding, signal)
          : this.accessibility.execute(browserAction, accessibilityBinding, signal);
      if (this.axFallback) {
        if (
          browserAction.tool !== "browser.scroll" ||
          (browserAction.direction !== "up" && browserAction.direction !== "down") ||
          !this.axFallback.directions.has(browserAction.direction)
        )
          throw new Error("Read the page again for an observed browser control.");
        // Keep the AX choice, but consume its observed control before dispatch.
        // An unknown effect cannot fall through to the companion or be replayed.
        this.axFallback.directions.clear();
        this.observationEpoch += 1;
        this.companion?.invalidate();
        if (signal.aborted) throw new Error("Browser request was cancelled.");
        return this.accessibility.execute(browserAction, accessibilityBinding, signal);
      }
      if (!this.companion) throw new Error("Browser companion is unavailable.");
      return this.companion.execute(browserAction, binding, signal);
    }
    const accessibilityBinding: BrowserAccessibilityBinding = {
      availability: "accessibility",
      documentId: binding.documentId,
      url: binding.url,
      revision: browserBindingRevision(binding),
    };
    let armedYouTubeRead: Awaited<ReturnType<BrowserAccessibilityRuntime["execute"]>> | undefined;
    let armedYouTubeEpoch: number | undefined;
    // The explicit YouTube read also arms the scoped AX generation used by scroll and
    // playback. A companion page alone must not advertise controls AX cannot perform.
    if (
      binding.origin === "https://www.youtube.com" &&
      this.companion &&
      (browserAction.tool === "browser.read" ||
        browserAction.tool === "browser.search" ||
        (browserAction.tool === "browser.select" && this.youtubeCompanionRevision === revision))
    ) {
      if (browserAction.tool === "browser.read") {
        this.observationEpoch += 1;
        this.observedSite = undefined;
        this.youtubeCompanionRevision = undefined;
        this.companion.invalidate();
        armedYouTubeEpoch = this.observationEpoch;
        armedYouTubeRead = await this.accessibility.execute(
          browserAction,
          accessibilityBinding,
          signal,
        );
        if (
          signal.aborted ||
          armedYouTubeEpoch !== this.observationEpoch ||
          armedYouTubeRead.browser.operation !== "read" ||
          armedYouTubeRead.browser.status !== "completed" ||
          armedYouTubeRead.browser.source !== "accessibility" ||
          armedYouTubeRead.browser.revision !== revision
        )
          throw new Error("Browser page changed during read.");
      } else if (
        browserAction.tool === "browser.search" ||
        browserAction.tool === "browser.select"
      ) {
        this.observationEpoch += 1;
        this.observedSite = undefined;
        this.youtubeCompanionRevision = undefined;
      }
      const epoch = this.observationEpoch;
      try {
        const result = await this.companion.execute(browserAction, binding, signal);
        if (signal.aborted || epoch !== this.observationEpoch)
          throw new Error("Browser page changed during read.");
        if (
          browserAction.tool === "browser.read" &&
          result.browser.operation === "read" &&
          result.browser.view.site?.provider === "youtube"
        ) {
          this.observedSite = {
            revision: browserBindingRevision(binding),
            site: result.browser.view.site,
          };
          this.youtubeCompanionRevision = revision;
        }
        return result;
      } catch (error) {
        if (browserAction.tool !== "browser.read" || signal.aborted) throw error;
        // Only a read can fall back; a mutation can already have run.
        if (epoch !== this.observationEpoch) throw new Error("Browser page changed during read.");
        this.companion.invalidate();
      }
    }
    if (
      binding.origin === "https://www.youtube.com" &&
      !this.companion &&
      browserAction.tool === "browser.search"
    )
      throw new Error("Observed YouTube search companion is unavailable.");
    if (browserAction.tool === "browser.read" && !armedYouTubeRead) {
      this.observationEpoch += 1;
      this.observedSite = undefined;
      this.youtubeCompanionRevision = undefined;
      this.companion?.invalidate();
    }
    if (
      browserAction.tool === "browser.scroll" ||
      browserAction.tool === "browser.search" ||
      browserAction.tool === "browser.select" ||
      browserAction.tool === "browser.playback"
    ) {
      const site = this.observedSite?.site;
      if (binding.origin === "https://www.youtube.com" && !site)
        throw new Error("Browser page needs a fresh read before an action.");
      if (site && (site.page === "login" || site.page === "unsupported"))
        throw new Error("Browser page needs attention before an action.");
      if (
        browserAction.tool === "browser.playback" &&
        site &&
        (site.page !== "watch" ||
          (browserAction.action === "play" && site.playback !== "paused") ||
          (browserAction.action === "pause" && site.playback !== "playing"))
      )
        throw new Error("Browser playback state is unavailable.");
      // A dispatched mutation may change the page without changing the binding revision.
      // The next action requires an explicit fresh read, even after an unknown outcome.
      this.observationEpoch += 1;
      this.observedSite = undefined;
      this.youtubeCompanionRevision = undefined;
      this.companion?.invalidate();
    }
    const readEpoch = armedYouTubeEpoch ?? this.observationEpoch;
    const result =
      armedYouTubeRead ??
      (await this.accessibility.execute(adapterAction, accessibilityBinding, signal));
    if (browserAction.tool !== "browser.read" || binding.origin !== "https://www.youtube.com")
      return result;
    if (signal.aborted) throw new Error("Browser request was cancelled.");
    if (result.browser.operation !== "read" || !this.webmcp.inspectSelectedPage)
      throw new Error("Browser page observation is unavailable.");
    const site = await this.webmcp.inspectSelectedPage(binding, signal);
    if (signal.aborted) throw new Error("Browser request was cancelled.");
    if (readEpoch !== this.observationEpoch) throw new Error("Browser page changed during read.");
    const observed = browserWebMCPOperationResult({
      ...result,
      browser: {
        ...result.browser,
        view: { ...result.browser.view, site },
      },
    });
    this.observedSite = { revision: browserBindingRevision(binding), site };
    return observed;
  }
}
