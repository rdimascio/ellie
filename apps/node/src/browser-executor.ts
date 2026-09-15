import type { Executor } from "@ellie/macos";
import type { Action, Capability, Result } from "@ellie/protocol";
import { BROWSER_CAPABILITIES } from "@ellie/protocol";
import type { BrowserWebMCPOperations } from "./browser-operations.ts";

/** Composes the fixed desktop helper with an initialized reviewed browser executor. */
export class BrowserNodeExecutor implements Executor {
  private readonly desktop: Executor;
  private readonly browser: BrowserWebMCPOperations;
  constructor(desktop: Executor, browser: BrowserWebMCPOperations) {
    this.desktop = desktop;
    this.browser = browser;
  }

  async capabilities(): Promise<Capability[]> {
    return [...new Set([...(await this.desktop.capabilities()), ...BROWSER_CAPABILITIES])];
  }

  execute(action: Action, signal?: AbortSignal): Promise<Result> {
    return action.tool.startsWith("browser.")
      ? this.browser.execute(action, signal ?? new AbortController().signal)
      : this.desktop.execute(action, signal);
  }
}
