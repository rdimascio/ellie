import test from "node:test";
import assert from "node:assert/strict";
import { GatewayDecisionProvider } from "@ellie/decisions";
import type { DecisionQuestion, DecisionRequest } from "@ellie/decisions";
import { defaults } from "@ellie/config";
import { buildDesktopQuestions, decideDesktop } from "@ellie/router/decision";

const questions: Record<string, DecisionQuestion> = {
  action: {
    type: "choice",
    instructions: "Choose",
    criteria: { open: null, ignore: "Do nothing" },
  },
  urgent: { type: "noul", instructions: "Urgent?" },
  priority: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
};

const gatewayAnswers = {
  action: { type: "choice", choice: "open", probabilities: { open: 0.97, ignore: 0.03 } },
  urgent: { type: "boolean", probability: 0.61 },
  priority: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
};

function request(signal = new AbortController().signal): DecisionRequest {
  return { state: { input: "Open Arc" }, questions, signal };
}

function wire(answers: unknown = gatewayAnswers, extras: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      answers,
      usage: { inputTokens: 31, outputTokens: 7 },
      providerMetadata: { typesafe: { confidence: { action: 0.84, priority: 0.73 } } },
      ...extras,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

test("Gateway SDK evaluation uses only the fixed TypeSafe endpoint and normalizes typed answers", async () => {
  let calls = 0;
  const provider = new GatewayDecisionProvider({
    apiKey: "test-gateway-key",
    fetch: async (input, init) => {
      calls++;
      assert.equal(input, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer test-gateway-key");
      assert.equal(headers.get("ai-model-id"), "typesafe-ai/jev");
      assert.equal(headers.get("ai-gateway-auth-method"), "api-key");
      assert.equal(headers.get("ai-evaluation-model-specification-version"), "4");
      assert.equal(headers.get("ai-o11y-environment"), null);
      const body = JSON.parse(init?.body as string);
      assert.equal(body.state.input, "Open Arc");
      assert.equal(body.questions.urgent.type, "boolean");
      assert.equal(body.questions.action.type, "choice");
      assert.deepEqual(body.providerOptions.gateway.only, ["typesafe-ai"]);
      return wire();
    },
  });
  const result = await provider.evaluate(request());
  assert.equal(calls, 1);
  assert.equal(provider.locality, "cloud");
  assert.equal(result.model, "typesafe-ai/jev");
  assert.deepEqual(result.usage, { inputTokens: 31, outputTokens: 7 });
  assert.deepEqual(result.answers, {
    action: {
      type: "choice",
      choice: "open",
      probabilities: { open: 0.97, ignore: 0.03 },
      confidence: 0.84,
    },
    urgent: { type: "noul", noul: 0.61 },
    priority: {
      type: "score",
      score: 0.8,
      probabilities: { "0": 0.2, "1": 0.8 },
      confidence: 0.73,
      legend: { "0": "low", "1": "high" },
    },
  });
  assert.ok(result.latencyMs >= 0);
});

test("missing distributions or documented confidence metadata fail closed", async () => {
  for (const response of [
    wire({ ...gatewayAnswers, action: { type: "choice", choice: "open" } }),
    wire(gatewayAnswers, { providerMetadata: {} }),
    wire(gatewayAnswers, { providerMetadata: { typesafe: { confidence: { action: 0.84 } } } }),
    wire(gatewayAnswers, {
      providerMetadata: { typesafe: { confidence: { action: 1.1, priority: 0.73 } } },
    }),
  ]) {
    const provider = new GatewayDecisionProvider({ apiKey: "test", fetch: async () => response });
    await assert.rejects(provider.evaluate(request()), /Gateway decision unavailable/);
  }
});

test("remote warnings fail before the SDK can print their contents", async () => {
  const original = process.emitWarning;
  const emitted: unknown[] = [];
  process.emitWarning = ((warning: unknown) => {
    emitted.push(warning);
  }) as typeof process.emitWarning;
  try {
    const provider = new GatewayDecisionProvider({
      apiKey: "test",
      fetch: async () =>
        wire(gatewayAnswers, { warnings: [{ type: "other", message: "private-state-sentinel" }] }),
    });
    await assert.rejects(provider.evaluate(request()), /Gateway decision unavailable/);
    assert.deepEqual(emitted, []);
  } finally {
    process.emitWarning = original;
  }
});

test("declared two-decimal rounding retains raw probabilities and cannot promote a .97 gate", async () => {
  const response = wire(
    {
      ...gatewayAnswers,
      action: { type: "choice", choice: "open", probabilities: { open: 0.97, ignore: 0.04 } },
    },
    { rounding: { probabilityDecimals: 2, scoreDecimals: 2 } },
  );
  const provider = new GatewayDecisionProvider({ apiKey: "test", fetch: async () => response });
  const result = await provider.evaluate(request());
  assert.equal(result.answers.action?.type, "choice");
  if (result.answers.action?.type !== "choice") throw new Error("Wrong answer type");
  assert.equal(result.answers.action.probabilities.open, 0.97);
  assert.deepEqual(result.rounding, { probabilityDecimals: 2, scoreDecimals: 2 });
});

test("a rounded .97 choice remains below the router's .98 execution gate", async () => {
  const input = "Bring up Arc";
  const built = buildDesktopQuestions(input, {}, defaults);
  const selected: Record<string, string> = {
    request: "single",
    operation: "app.open",
    app: "app_0",
  };
  const answers = Object.fromEntries(
    Object.entries(built.questions).map(([id, question]) => {
      if (question.type !== "choice") throw new Error("Expected choice question");
      const keys = Object.keys(question.criteria);
      const winner = selected[id] ?? "none";
      const runner = keys.find((key) => key !== winner)!;
      return [
        id,
        {
          type: "choice",
          choice: winner,
          probabilities: Object.fromEntries(
            keys.map((key) => [key, key === winner ? 0.97 : key === runner ? 0.04 : 0]),
          ),
        },
      ];
    }),
  );
  const metadata = {
    typesafe: {
      confidence: Object.fromEntries(Object.keys(built.questions).map((id) => [id, 0.8])),
    },
  };
  const provider = new GatewayDecisionProvider({
    apiKey: "test",
    fetch: async () =>
      wire(answers, { providerMetadata: metadata, rounding: { probabilityDecimals: 2 } }),
  });
  const decision = await decideDesktop(input, {}, defaults, provider, {
    signal: new AbortController().signal,
    minProbability: 0.98,
    minMargin: 0.2,
  });
  assert.equal(decision.kind, "clarify");
});

test("Gateway transport strips environment-derived observation headers", async () => {
  const prior = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "private-environment-sentinel";
  try {
    const provider = new GatewayDecisionProvider({
      apiKey: "test",
      fetch: async (_input, init) => {
        assert.equal(new Headers(init?.headers).get("ai-o11y-environment"), null);
        return wire();
      },
    });
    await provider.evaluate(request());
  } finally {
    if (prior === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prior;
  }
});

test("invalid rounding metadata and absent partial usage fail or omit safely", async () => {
  for (const rounding of [{ probabilityDecimals: 1 }, { surprise: 2 }]) {
    const invalid = new GatewayDecisionProvider({
      apiKey: "test",
      fetch: async () => wire(gatewayAnswers, { rounding }),
    });
    await assert.rejects(invalid.evaluate(request()), /Gateway decision unavailable/);
  }
  const partial = new GatewayDecisionProvider({
    apiKey: "test",
    fetch: async () => wire(gatewayAnswers, { usage: { inputTokens: 10 } }),
  });
  assert.equal((await partial.evaluate(request())).usage, undefined);
});

test("Gateway failures never retry or expose remote bodies", async () => {
  let calls = 0;
  const provider = new GatewayDecisionProvider({
    apiKey: "private-key",
    fetch: async () => {
      calls++;
      return new Response("private-key and private state", { status: 429 });
    },
  });
  await assert.rejects(provider.evaluate(request()), (error: Error) => {
    assert.equal(error.message, "Gateway decision unavailable");
    return true;
  });
  assert.equal(calls, 1);
});

test("redirects and oversized Gateway bodies are rejected and cancelled", async () => {
  for (const { status, headers } of [
    { status: 302, headers: {} },
    { status: 200, headers: { "content-length": "1048577" } },
  ]) {
    let cancelled = false;
    const provider = new GatewayDecisionProvider({
      apiKey: "test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {},
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers },
        ),
    });
    await assert.rejects(provider.evaluate(request()), /Gateway decision unavailable/);
    assert.equal(cancelled, true);
  }
  const provider = new GatewayDecisionProvider({
    apiKey: "test",
    fetch: async () => new Response("x".repeat(1_100_000)),
  });
  await assert.rejects(provider.evaluate(request()), /Gateway decision unavailable/);
});

test("large inputs are rejected before any Gateway transport", async () => {
  let calls = 0;
  const provider = new GatewayDecisionProvider({
    apiKey: "test",
    fetch: async () => {
      calls++;
      return wire();
    },
  });
  await assert.rejects(
    provider.evaluate({ ...request(), state: "x".repeat(300_000) }),
    /too large/,
  );
  assert.equal(calls, 0);
});

test("Gateway deadline covers a fetch that ignores abort and an unread body", async () => {
  const never = async (): Promise<Response> => new Promise(() => {});
  const provider = new GatewayDecisionProvider({ apiKey: "test", timeoutMs: 5, fetch: never });
  await assert.rejects(provider.evaluate(request()), /Gateway decision unavailable/);
  const controller = new AbortController();
  const pending = new GatewayDecisionProvider({
    apiKey: "test",
    timeoutMs: 1000,
    fetch: never,
  }).evaluate(request(controller.signal));
  controller.abort();
  await assert.rejects(pending, /Gateway decision unavailable/);
});
