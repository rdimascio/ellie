import { browserWebMCPAction, type Action, type Result } from "@ellie/protocol";
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
  ) => Promise<BrowserBinding | "unbound" | "unsupported">;
  private readonly webmcp: WebMCP;
  private readonly accessibility: BrowserAccessibilityRuntime;
  constructor(
    binding: (signal: AbortSignal) => Promise<BrowserBinding | "unbound" | "unsupported">,
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
    const binding = await this.binding(signal);
    if (typeof binding !== "object" || binding.availability === "webmcp")
      return this.webmcp.execute(browserAction, signal);
    const accessibilityBinding: BrowserAccessibilityBinding = {
      availability: "accessibility",
      documentId: binding.documentId,
      url: binding.url,
      revision: browserBindingRevision(binding),
    };
    return this.accessibility.execute(browserAction, accessibilityBinding, signal);
  }
}
