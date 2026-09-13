import { spawn } from "node:child_process";
import { nativeHelperPath } from "@ellie/config";
import type { Action, Capability, Result } from "@ellie/protocol";
import { CAPABILITIES, record, result } from "@ellie/protocol";
export interface Executor {
  capabilities(): Promise<Capability[]>;
  execute(action: Action, signal?: AbortSignal): Promise<Result>;
}
export class MacOSExecutor implements Executor {
  private async call(payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (process.platform !== "darwin") throw new Error("The native executor requires macOS.");
    return new Promise((resolve, reject) => {
      const child = spawn(nativeHelperPath(), [], {
        stdio: ["pipe", "pipe", "pipe"],
        signal,
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Native action timed out; check the window before retrying."));
      }, 20_000);
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.length > 65536) child.kill();
      });
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timer);
        reject(
          signal?.aborted
            ? new Error(
                "Native action cancellation was requested; a side effect may still have finished.",
              )
            : new Error("Native helper missing or could not start. Run bun run build:macos."),
        );
      });
      child.on("close", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(new Error("Native helper returned an invalid response."));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(payload));
    });
  }
  async health(): Promise<unknown> {
    return this.call({ command: "telemetry" });
  }
  async capabilities(): Promise<Capability[]> {
    const status = record(await this.call({ command: "doctor" }));
    return status.accessibility === true ? [...CAPABILITIES] : ["app.open", "url.open"];
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Result> {
    return result(await this.call(action, signal));
  }
}
