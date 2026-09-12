import { record, string, result } from "@ellie/protocol";
import type { ComputeCapabilities, InferenceRequest, Result } from "@ellie/protocol";
import { inferenceWorkerConfig } from "@ellie/config";
import type { InferenceWorkerConfig } from "@ellie/config";

export interface InferenceWorker {
  advertise(signal: AbortSignal): Promise<ComputeCapabilities>;
  execute(request: InferenceRequest, signal: AbortSignal): Promise<Result>;
}
/** The endpoint is a locally configured runner, never a URL from a network job. */
export class LocalInferenceWorker implements InferenceWorker {
  private config: InferenceWorkerConfig;
  constructor(config: InferenceWorkerConfig) {
    this.config = inferenceWorkerConfig(config);
  }
  private async call(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const response = await fetch(new URL(path, this.config.endpoint), {
      method: body === undefined ? "GET" : "POST",
      signal,
      redirect: "error",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Local model runner is unavailable.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 128 * 1024) throw new Error("Local model response is too large.");
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel();
    }
  }
  async advertise(signal: AbortSignal): Promise<ComputeCapabilities> {
    const body = record(
      await this.call("/v1/models", AbortSignal.any([signal, AbortSignal.timeout(3000)])),
    );
    if (!Array.isArray(body.data) || body.data.length > 256)
      throw new Error("Invalid model inventory.");
    const ids = new Set(body.data.map((item) => string(record(item).id, 200)));
    return {
      kind: "inference-worker",
      backend: "local-openai",
      mode: "independent",
      models: this.config.models.filter((m) => ids.has(m.id)),
    };
  }
  async execute(request: InferenceRequest, signal: AbortSignal): Promise<Result> {
    // Recheck inventory: never request a model that the runner would need to download.
    if (!(await this.advertise(signal)).models.some((m) => m.id === request.model))
      throw new Error("Requested model is not installed and locally enabled.");
    const response = record(
      await this.call("/v1/chat/completions", signal, {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens,
        stream: false,
      }),
    );
    if (!Array.isArray(response.choices) || !response.choices.length)
      throw new Error("Model runner returned no completion.");
    const content = string(record(record(response.choices[0]).message).content, 100_000);
    return result({
      ok: true,
      message: content.length > 4000 ? content.slice(0, 3970) + "\n[Output truncated.]" : content,
    });
  }
}
