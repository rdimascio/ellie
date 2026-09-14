export type ModelStatusReason =
  | "not-configured"
  | "runner-unreachable"
  | "model-not-installed"
  | "probe-unsupported"
  | "ready";

export interface ModelStatus {
  mode: "deterministic" | "local";
  configured: boolean;
  available: boolean;
  model?: string;
  checkedAt: number;
  /** Features configured for model use; availability is reported separately. */
  capabilities: { chat: boolean; customApps: boolean };
  reason: ModelStatusReason;
}

export interface LocalModelConfiguration {
  endpoint: string;
  model: string;
}

export function validateLocalModelConfiguration(config: LocalModelConfiguration): URL {
  const url = new URL(config.endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "")) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error("Local model URL must be an unauthenticated HTTP loopback base URL.");
  if (
    typeof config.model !== "string" ||
    !config.model ||
    config.model.length > 200 ||
    config.model.trim() !== config.model ||
    [...config.model].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("Use a valid installed local model ID.");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return new URL("models", url);
}

const MAX_BYTES = 128 * 1024;
const CACHE_MS = 15_000;

/** Read-only inventory check. Never starts inference, installs models or exposes runner details. */
export class LocalModelReadiness {
  private readonly endpoint?: URL;
  private readonly model?: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: ModelStatus;
  private inFlight?: Promise<ModelStatus>;
  private transport?: Promise<ModelStatusReason>;
  private controller?: AbortController;
  private closed = false;

  constructor(
    config?: LocalModelConfiguration,
    dependencies: { fetcher?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {
    if (config) {
      this.endpoint = validateLocalModelConfiguration(config);
      this.model = config.model;
    }
    this.fetcher = dependencies.fetcher ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.timeoutMs = dependencies.timeoutMs ?? 2_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 5_000)
      throw new RangeError("Model inventory timeout must be between 1 and 5000 ms.");
  }

  private result(reason: ModelStatusReason): ModelStatus {
    const configured = Boolean(this.endpoint);
    return {
      mode: configured ? "local" : "deterministic",
      configured,
      available: reason === "ready",
      ...(this.model ? { model: this.model } : {}),
      checkedAt: this.now(),
      capabilities: { chat: configured, customApps: configured },
      reason,
    };
  }

  async status(): Promise<ModelStatus> {
    if (!this.endpoint) return this.result("not-configured");
    if (this.closed) return this.result("runner-unreachable");
    const elapsed = this.cached ? this.now() - this.cached.checkedAt : Infinity;
    if (this.cached && elapsed >= 0 && elapsed < CACHE_MS) return structuredClone(this.cached);
    if (this.inFlight) return structuredClone(await this.inFlight);
    // A custom/noncooperative transport must not create an unbounded queue of probes.
    if (this.transport) return this.result("runner-unreachable");
    const controller = new AbortController();
    this.controller = controller;
    const transport = this.probe(controller.signal);
    this.transport = transport;
    void transport.finally(() => {
      if (this.transport === transport) this.transport = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<ModelStatusReason>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("runner-unreachable");
      }, this.timeoutMs);
    });
    const pending = Promise.race([transport, deadline]).then((reason) => {
      clearTimeout(timer);
      const result = this.result(reason);
      this.cached = result;
      return result;
    });
    this.inFlight = pending;
    try {
      return structuredClone(await pending);
    } finally {
      if (this.inFlight === pending) this.inFlight = undefined;
    }
  }

  close(): void {
    this.closed = true;
    this.controller?.abort();
  }

  private async probe(signal: AbortSignal): Promise<ModelStatusReason> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let decoding = false;
    try {
      const response = await this.fetcher(this.endpoint!, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return "runner-unreachable";
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return [404, 405, 501].includes(response.status)
          ? "probe-unsupported"
          : "runner-unreachable";
      }
      if (!response.body) return "probe-unsupported";
      reader = response.body.getReader();
      if (Number(response.headers.get("content-length")) > MAX_BYTES) return "probe-unsupported";
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        if (signal.aborted) return "runner-unreachable";
        const { value, done } = await reader.read();
        if (signal.aborted) return "runner-unreachable";
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) return "probe-unsupported";
        chunks.push(value);
      }
      decoding = true;
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return "probe-unsupported";
      const data = (payload as Record<string, unknown>).data;
      if (
        !Array.isArray(data) ||
        data.length > 256 ||
        data.some(
          (entry) =>
            !entry ||
            typeof entry !== "object" ||
            Array.isArray(entry) ||
            typeof entry.id !== "string" ||
            !entry.id ||
            entry.id.length > 200,
        )
      )
        return "probe-unsupported";
      return data.some((entry) => entry.id === this.model) ? "ready" : "model-not-installed";
    } catch {
      return signal.aborted || !decoding ? "runner-unreachable" : "probe-unsupported";
    } finally {
      // Cancellation is best effort, and may itself be noncooperative in custom transports.
      void reader?.cancel().catch(() => {});
    }
  }
}
