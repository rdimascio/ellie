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
    if (refresh) {
      this.observationEpoch += 1;
      this.observedSite = undefined;
      this.youtubeCompanionRevision = undefined;
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
      if (!this.companion) throw new Error("Browser companion is unavailable.");
      return this.companion.execute(browserAction, binding, signal);
    }
    // The selected YouTube document exposes a reviewed DOM search snapshot through the
    // companion. Keep scoped AX scroll and playback on their existing adapter.
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
        if (
          browserAction.tool === "browser.read" &&
          result.browser.operation === "read" &&
          !signal.aborted &&
          epoch === this.observationEpoch &&
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
        this.companion.invalidate();
      }
    }
    if (
      binding.origin === "https://www.youtube.com" &&
      !this.companion &&
      browserAction.tool === "browser.search"
    )
      throw new Error("Observed YouTube search companion is unavailable.");
    if (browserAction.tool === "browser.read") {
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
    const readEpoch = this.observationEpoch;
    const accessibilityBinding: BrowserAccessibilityBinding = {
      availability: "accessibility",
      documentId: binding.documentId,
      url: binding.url,
      revision: browserBindingRevision(binding),
    };
    const result = await this.accessibility.execute(adapterAction, accessibilityBinding, signal);
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
