import { experimental_evaluate as evaluate } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import type {
  DecisionAnswer,
  DecisionProvider,
  DecisionQuestion,
  DecisionRequest,
  DecisionResponse,
} from "./index.ts";
import { validateDecisionResponse } from "./index.ts";
import {
  jsonBody,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  timeout,
  validateRequest,
} from "./http.ts";

const MODEL = "typesafe-ai/jev";
const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/evaluation-model";

function fail(): never {
  throw new Error("Gateway decision unavailable");
}

function confidence(metadata: unknown, id: string): number {
  if (!metadata || typeof metadata !== "object") fail();
  const typesafe = (metadata as Record<string, unknown>).typesafe;
  if (!typesafe || typeof typesafe !== "object") fail();
  const confidence = (typesafe as Record<string, unknown>).confidence;
  if (!confidence || typeof confidence !== "object" || Array.isArray(confidence)) fail();
  const value = (confidence as Record<string, unknown>)[id];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) fail();
  return value;
}

function gatewayQuestions(questions: Record<string, DecisionQuestion>) {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      question.type === "noul"
        ? { type: "boolean" as const, instructions: question.instructions }
        : question,
    ]),
  );
}

function normalizeAnswers(
  questions: Record<string, DecisionQuestion>,
  answers: Record<string, unknown>,
  metadata: unknown,
): Record<string, DecisionAnswer> {
  const result: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) fail();
    const value = answer as Record<string, unknown>;
    let normalized: DecisionAnswer;
    if (question.type === "noul") {
      if (value.type !== "boolean") fail();
      normalized = { type: "noul", noul: value.probability as number };
    } else if (question.type === "choice") {
      if (
        value.type !== "choice" ||
        !value.probabilities ||
        typeof value.probabilities !== "object" ||
        Array.isArray(value.probabilities)
      )
        fail();
      const probabilities = value.probabilities as Record<string, number>;
      normalized = {
        type: "choice",
        choice: value.choice as string,
        probabilities,
        confidence: confidence(metadata, id),
      };
    } else {
      if (
        value.type !== "score" ||
        !value.probabilities ||
        typeof value.probabilities !== "object" ||
        Array.isArray(value.probabilities)
      )
        fail();
      const probabilities = value.probabilities as Record<string, number>;
      normalized = {
        type: "score",
        score: value.score as number,
        probabilities,
        confidence: confidence(metadata, id),
        legend: Object.fromEntries(question.criteria.map((text, index) => [String(index), text])),
      };
    }
    Object.defineProperty(result, id, {
      value: normalized,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

/** A bounded transport for the SDK's fixed evaluation endpoint. */
async function boundedFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  fetchImpl: typeof fetch,
  apiKey: string,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (
    url !== GATEWAY_URL ||
    init?.method !== "POST" ||
    typeof init.body !== "string" ||
    Buffer.byteLength(init.body) > MAX_REQUEST_BYTES
  )
    fail();
  const sdkHeaders = new Headers(init.headers);
  if (
    sdkHeaders.get("authorization") !== `Bearer ${apiKey}` ||
    sdkHeaders.get("ai-model-id") !== MODEL ||
    sdkHeaders.get("ai-evaluation-model-specification-version") !== "4" ||
    sdkHeaders.get("ai-gateway-auth-method") !== "api-key"
  )
    fail();
  const headers = new Headers();
  for (const name of [
    "authorization",
    "ai-model-id",
    "ai-evaluation-model-specification-version",
    "ai-gateway-auth-method",
    "ai-gateway-protocol-version",
    "content-type",
  ]) {
    const value = sdkHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  const response = await fetchImpl(input, { ...init, headers, redirect: "manual" });
  const discard = (): void => {
    if (response.body) void response.body.cancel().catch(() => {});
  };
  if (
    init.signal?.aborted ||
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    !response.ok
  ) {
    discard();
    fail();
  }
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    discard();
    fail();
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => {});
  };
  init.signal?.addEventListener("abort", cancel, { once: true });
  if (init.signal?.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) fail();
      chunks.push(value);
    }
  } finally {
    init.signal?.removeEventListener("abort", cancel);
    cancel();
  }
  const body = Buffer.concat(chunks);
  // The SDK schema can strip unknown rounding fields. Check the original wire
  // declaration so malformed metadata cannot silently become an unrounded result.
  try {
    const payload: unknown = JSON.parse(body.toString("utf8"));
    if (payload && typeof payload === "object" && "rounding" in payload) {
      const rounding = (payload as Record<string, unknown>).rounding;
      if (!rounding || typeof rounding !== "object" || Array.isArray(rounding)) fail();
      if (
        Object.keys(rounding).some(
          (key) => key !== "probabilityDecimals" && key !== "scoreDecimals",
        )
      )
        fail();
    }
  } catch {
    fail();
  }
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

export class GatewayDecisionProvider implements DecisionProvider {
  readonly id = "gateway";
  readonly locality = "cloud" as const;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; timeoutMs?: number; fetch?: typeof fetch }) {
    if (
      typeof options.apiKey !== "string" ||
      !options.apiKey.trim() ||
      options.apiKey.length > 4096 ||
      /\s/.test(options.apiKey)
    )
      throw new Error("Invalid Gateway API key");
    this.apiKey = options.apiKey;
    this.timeoutMs = timeout(options.timeoutMs);
    this.fetchImpl = options.fetch ?? fetch;
  }

  async evaluate(request: DecisionRequest): Promise<DecisionResponse> {
    validateRequest(request);
    if (
      request.state === null ||
      (typeof request.state !== "string" &&
        (typeof request.state !== "object" || request.state === null))
    )
      throw new Error("Invalid decision request");
    jsonBody({ state: request.state, questions: gatewayQuestions(request.questions) });
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = (): void => {
      controller.abort();
      rejectAbort(new Error("Gateway decision unavailable"));
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(onAbort, this.timeoutMs);
    const start = performance.now();
    try {
      // Observe an abort that raced with listener registration before starting SDK work.
      if (controller.signal.aborted) return await aborted;
      const sdkModel = createGateway({
        apiKey: this.apiKey,
        fetch: (input, init) => boundedFetch(input, init, this.fetchImpl, this.apiKey),
      }).evaluationModel(MODEL);
      const model = {
        specificationVersion: sdkModel.specificationVersion,
        provider: sdkModel.provider,
        modelId: sdkModel.modelId,
        supportedQuestionTypes: sdkModel.supportedQuestionTypes,
        async doEvaluate(options: Parameters<typeof sdkModel.doEvaluate>[0]) {
          const result = await sdkModel.doEvaluate(options);
          if (result.warnings.length !== 0) fail();
          return result;
        },
      };
      const task = evaluate({
        model,
        state: request.state as Parameters<typeof evaluate>[0]["state"],
        questions: gatewayQuestions(request.questions),
        maxRetries: 0,
        abortSignal: controller.signal,
        providerOptions: { gateway: { only: ["typesafe-ai"] } },
      });
      const result = await Promise.race([task, aborted]);
      if (controller.signal.aborted) fail();
      if (result.response.modelId !== MODEL) fail();
      const usage =
        result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined
          ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
          : undefined;
      return validateDecisionResponse(request.questions, {
        model: result.response.modelId,
        answers: normalizeAnswers(request.questions, result.answers, result.providerMetadata),
        ...(usage ? { usage } : {}),
        ...(result.rounding ? { rounding: result.rounding } : {}),
        latencyMs: performance.now() - start,
      });
    } catch {
      return fail();
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      controller.abort();
    }
  }
}
