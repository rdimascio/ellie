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

type WebMCP = { execute(action: Action, signal: AbortSignal): Promise<Result> };

/** Selects the adapter from fresh pre-dispatch binding evidence. It never falls through after dispatch. */
export class BrowserOperationSelector {
  private readonly binding: (
    signal: AbortSignal,
    refresh?: boolean,
  ) => Promise<BrowserBinding | "unbound" | "unsupported">;
  private readonly webmcp: WebMCP;
  private readonly accessibility: BrowserAccessibilityRuntime;
  constructor(
    binding: (
      signal: AbortSignal,
      refresh?: boolean,
    ) => Promise<BrowserBinding | "unbound" | "unsupported">,
    webmcp: WebMCP,
    accessibility: BrowserAccessibilityRuntime,
  ) {
    this.binding = binding;
    this.webmcp = webmcp;
    this.accessibility = accessibility;
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
    if (typeof binding !== "object" || binding.availability === "webmcp")
      return this.webmcp.execute(adapterAction, signal);
    const accessibilityBinding: BrowserAccessibilityBinding = {
      availability: "accessibility",
      documentId: binding.documentId,
      url: binding.url,
      revision: browserBindingRevision(binding),
    };
    return this.accessibility.execute(adapterAction, accessibilityBinding, signal);
  }
}
