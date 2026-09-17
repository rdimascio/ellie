import { randomUUID } from "node:crypto";
import {
  BROWSER_WEBMCP_PROTOCOL,
  browserWebMCPRequest,
  browserWebMCPResult,
  browserWebMCPOperationResult,
  type BrowserAction,
  type BrowserCompanionCommand,
  type BrowserWebMCPRequest,
  type BrowserWebMCPResult,
  type BrowserWebMCPOperationResult,
  type BrowserView,
} from "@ellie/protocol";
import { browserBindingRevision, type BrowserBinding } from "./browser-operations.ts";

type Bridge = {
  request(
    request: Exclude<BrowserWebMCPRequest, { type: "cancel" }>,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPResult>;
};
type Observation = {
  bindingId: string;
  documentId: string;
  url: string;
  revision: string;
  snapshotId: string;
  items: Map<string, string>;
  rowCandidateId?: string;
  rows: Map<string, string>;
  site: NonNullable<BrowserView["site"]>;
};
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Browser companion result is invalid.");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== [...keys].sort().join())
    throw new Error("Browser companion result is invalid.");
  return row;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

/** The reviewed DOM companion is limited to the exact selected Netflix document. */
export class BrowserCompanionOperations {
  private observed?: Observation;
  private readonly bridge: Bridge;
  constructor(bridge: Bridge) {
    this.bridge = bridge;
  }

  private async call(
    binding: BrowserBinding,
    command: BrowserCompanionCommand,
    signal: AbortSignal,
  ) {
    const request = browserWebMCPRequest({
      protocol: BROWSER_WEBMCP_PROTOCOL,
      id: randomUUID(),
      type: "media.execute",
      bindingId: binding.bindingId,
      documentId: binding.documentId,
      command,
    });
    if (request.type !== "media.execute") throw new Error("Browser companion request is invalid.");
    const response = browserWebMCPResult(await this.bridge.request(request, signal));
    if (response.id !== request.id) throw new Error("Browser companion reply changed.");
    if (response.status !== "ok") return response;
    const wrapper = exact(response.value, ["bindingId", "documentId", "url", "value"]);
    if (
      wrapper.bindingId !== binding.bindingId ||
      wrapper.documentId !== binding.documentId ||
      wrapper.url !== binding.url
    )
      throw new Error("Browser companion page changed.");
    return { ...response, value: wrapper.value };
  }

  async execute(
    action: BrowserAction,
    binding: BrowserBinding,
    signal: AbortSignal,
  ): Promise<BrowserWebMCPOperationResult> {
    if (
      binding.availability !== "companion" ||
      binding.origin !== "https://www.netflix.com" ||
      new URL(binding.url).origin !== binding.origin ||
      binding.expiresAt <= Date.now()
    )
      throw new Error("Browser companion is unavailable.");
    const revision = browserBindingRevision(binding);
    if (
      this.observed?.revision !== revision ||
      this.observed?.bindingId !== binding.bindingId ||
      this.observed?.documentId !== binding.documentId ||
      this.observed?.url !== binding.url
    )
      this.observed = undefined;
    if (action.tool === "browser.status" || action.tool === "browser.refresh") {
      if (action.tool === "browser.refresh") this.observed = undefined;
      return browserWebMCPOperationResult({
        ok: true,
        message: "Browser companion tab connected.",
        browser: {
          source: "companion",
          operation: "status",
          status: "connected",
          revision,
          origin: binding.origin,
        },
      });
    }
    if (action.revision !== revision)
      throw new Error("Browser page changed before the requested action.");
    if (action.tool === "browser.read") {
      if (action.view !== "summary") throw new Error("Browser view is unsupported.");
      this.observed = undefined;
      if (signal.aborted) throw new Error("Browser request was cancelled.");
      const response = await this.call(
        binding,
        { type: "inspect", actionId: randomUUID() },
        signal,
      );
      if (signal.aborted || response.status !== "ok")
        throw new Error("Browser companion read failed.");
      const raw = response.value as Record<string, unknown>;
      const value = exact(
        raw,
        Object.hasOwn(raw, "rowCandidateId")
          ? ["snapshotId", "candidates", "playback", "site", "rowCandidateId"]
          : ["snapshotId", "candidates", "playback", "site"],
      );
      if (
        !uuid(value.snapshotId) ||
        !Array.isArray(value.candidates) ||
        value.candidates.length > 40
      )
        throw new Error("Browser companion read is invalid.");
      const items = new Map<string, string>();
      for (const rawCandidate of value.candidates) {
        const item = exact(rawCandidate, ["id", "title"]);
        if (
          !uuid(item.id) ||
          typeof item.title !== "string" ||
          !item.title ||
          Buffer.byteLength(item.title) > 500 ||
          /\p{C}/u.test(item.title) ||
          items.has(item.id)
        )
          throw new Error("Browser companion read is invalid.");
        items.set(item.id, item.title);
      }
      if (
        value.rowCandidateId !== undefined &&
        (!uuid(value.rowCandidateId) || !items.has(value.rowCandidateId))
      )
        throw new Error("Browser companion row is invalid.");
      const checked = browserWebMCPOperationResult({
        ok: true,
        message: "Netflix page observed.",
        browser: {
          source: "companion",
          operation: "read",
          status: "completed",
          revision,
          view: { items: [...items].map(([id, label]) => ({ id, label })), site: value.site },
        },
      });
      if (checked.browser.operation !== "read" || checked.browser.view.site?.provider !== "netflix")
        throw new Error("Browser companion observation is invalid.");
      this.observed = {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        url: binding.url,
        revision,
        snapshotId: value.snapshotId,
        items,
        ...(value.rowCandidateId === undefined ? {} : { rowCandidateId: value.rowCandidateId }),
        rows: new Map(checked.browser.view.site.rows?.map((row) => [row.id, row.label]) || []),
        site: checked.browser.view.site,
      };
      return checked;
    }
    if (action.tool === "browser.search") throw new Error("Netflix search is unsupported.");
    const observed = this.observed;
    if (!observed) throw new Error("Read the Netflix page before an action.");
    if (observed.site.page === "login" || observed.site.page === "unsupported")
      throw new Error("Netflix page needs attention before an action.");
    let command: BrowserCompanionCommand;
    if (action.tool === "browser.scrollRow") {
      if (observed.site.page !== "browse" || !observed.rows.has(action.rowId))
        throw new Error("Netflix row choice is stale; read and choose a row again.");
      command = {
        type: "scrollSelectedRow",
        actionId: randomUUID(),
        snapshotId: observed.snapshotId,
        rowId: action.rowId,
        direction: action.direction,
      };
    } else if (action.tool === "browser.scroll") {
      if (action.direction === "up" || action.direction === "down")
        command = { type: "scrollViewport", actionId: randomUUID(), direction: action.direction };
      else throw new Error("Choose an observed Netflix row before horizontal browsing.");
    } else if (action.tool === "browser.select") {
      if (observed.site.page !== "browse" || !observed.items.has(action.itemId))
        throw new Error("Netflix selection is stale.");
      command = {
        type: "open",
        actionId: randomUUID(),
        snapshotId: observed.snapshotId,
        candidateId: action.itemId,
      };
    } else if (action.tool === "browser.playback") {
      if (
        observed.site.page !== "watch" ||
        observed.site.playback !== (action.action === "play" ? "paused" : "playing")
      )
        throw new Error("Netflix playback state is unavailable.");
      command = { type: action.action, actionId: randomUUID() };
    } else throw new Error("Browser operation is unsupported.");
    // Once admitted, the mutation consumes the observation even if its result is lost.
    this.observed = undefined;
    if (signal.aborted) throw new Error("Browser request was cancelled.");
    let status: "unknown" | "failed" | "cancelled" = "unknown";
    try {
      const response = await this.call(binding, command, signal);
      // The extension emits these statuses only before its effect request.
      // Transport loss or any post-effect error remains unverified.
      if (response.status === "cancelled") status = "cancelled";
      else if (!["ok", "unknown", "timed_out"].includes(response.status)) status = "failed";
    } catch {
      /* dispatch may have happened */
    }
    return browserWebMCPOperationResult({
      ok: false,
      message:
        status === "unknown"
          ? "Netflix action outcome is unknown; read the page again."
          : "Netflix action was stopped before dispatch; read the page again.",
      browser: { source: "companion", operation: "command", status, revision },
    });
  }
}
