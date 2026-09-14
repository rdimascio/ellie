export type PluginBuildErrorCode =
  | "cancelled"
  | "timeout"
  | "invalid_candidate"
  | "context_changed"
  | "access_revoked"
  | "conflict"
  | "model_unavailable";

export class PluginBuildError extends Error {
  readonly code: PluginBuildErrorCode;
  constructor(code: PluginBuildErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginBuildError";
    this.code = code;
  }
}

export function pluginBuildTimeout(value?: number): number {
  const timeoutMs = value ?? 90_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new TypeError("Plugin build timeout must be between 1 and 120000 milliseconds.");
  return timeoutMs;
}

export class BoundedPluginBuilder {
  private active = 0;
  private readonly limit: number;
  constructor(limit = 2) {
    this.limit = limit;
  }

  run<T>(
    execute: (signal: AbortSignal) => Promise<T>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = pluginBuildTimeout(options.timeoutMs);
    if (options.signal?.aborted)
      throw new PluginBuildError("cancelled", "Plugin build was cancelled before it started.");
    if (this.active >= this.limit)
      throw new PluginBuildError(
        "model_unavailable",
        "Two plugin builds are already running. Wait for one to finish and try again.",
      );
    this.active++;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort(new Error("Plugin build deadline exceeded."));
    }, timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, deadline.signal])
      : deadline.signal;
    const actual = Promise.resolve().then(() => {
      if (signal.aborted)
        throw timedOut
          ? new PluginBuildError("timeout", `Plugin build exceeded its ${timeoutMs} ms deadline.`)
          : new PluginBuildError("cancelled", "Plugin build was cancelled.");
      return execute(signal);
    });
    void actual.then(
      () => {
        this.active--;
      },
      () => {
        this.active--;
      },
    );
    let rejectInterruption!: (reason: PluginBuildError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    const onAbort = () =>
      rejectInterruption(
        timedOut
          ? new PluginBuildError("timeout", `Plugin build exceeded its ${timeoutMs} ms deadline.`)
          : new PluginBuildError("cancelled", "Plugin build was cancelled."),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    return Promise.race([actual, interrupted]).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  }
}
