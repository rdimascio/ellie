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

export const GENERATED_APP_QUALITY_GUIDANCE = [
  "Produce a complete usable app, including its empty, loading, ready, and failure states.",
  "Use a consistent Ellie theme: system font, light/dark color-scheme support, CSS custom properties for background, surface, text, muted text, accent, border, focus, success, and error colors, and comfortable spacing and touch targets.",
  "Make the layout responsive without horizontal page scrolling at narrow widths. Keep primary controls and status visible, and use readable line lengths.",
  "Use semantic elements, programmatic labels, visible keyboard focus, and native keyboard behavior. Add custom key handling only when the requested interaction needs it.",
  "During storage reads, show a loading state and disable dependent controls. Validate or default loaded JSON before rendering it.",
  "Await storage writes before reporting success. On rejected reads or writes, keep user input when possible and show a concise inline error with a labeled retry control.",
  "For revisions, preserve existing storage keys and compatible value shapes unless the user explicitly requests a data reset or migration.",
].join("\n");

export const GENERATED_APP_BROWSER_ACCEPTANCE = {
  command: "bun run life:test",
  exercises: [
    "meaningful generated controls",
    "storage failure and retry",
    "persistence after reload",
    "rejected storage bounds and capabilities",
    "blocked network and parent-document access",
    "revision and rollback storage compatibility",
  ],
  limitation:
    "Static candidate validation checks structure and script syntax only; functional verification requires this authenticated browser flow.",
} as const;

export function generatedAppQualityIssue(html: string): string | undefined {
  const uncommented = html.replace(/<!--[\s\S]*?-->/g, ""),
    scripts = [...uncommented.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)],
    withoutNonVisual = uncommented.replace(/<(head|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ""),
    document = withoutNonVisual.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ""),
    visibleText = document
      .replace(/<[^>]*>/g, " ")
      .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ")
      .trim(),
    visualElement =
      /<(?:main|section|article|header|footer|nav|h[1-6]|p|ul|ol|li|button|input|textarea|select|canvas|svg|table|form|details|progress|meter)\b/i.test(
        document,
      ),
    meaningfulScript = scripts.some(
      (match) =>
        match[1]!
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "")
          .trim().length > 0,
    );
  if (!visibleText && !visualElement && !meaningfulScript)
    return "The generated candidate contains no visible document or meaningful script.";
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

  validateCandidate(candidate: { html: string }, options: { revision?: boolean } = {}): void {
    const issue = generatedAppQualityIssue(candidate.html);
    if (!issue) return;
    throw new PluginBuildError(
      "invalid_candidate",
      options.revision
        ? "The generated revision had no usable visual document, so the current app was kept."
        : "The generated app had no usable visual document and was not installed.",
      { cause: new Error(issue) },
    );
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
