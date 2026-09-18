import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalDecisionProvider,
  TypeSafeDecisionProvider,
  validateDecisionResponse,
} from "@ellie/decisions";
import type { DecisionQuestion, DecisionRequest } from "@ellie/decisions";

const questions: Record<string, DecisionQuestion> = {
  action: {
    type: "choice",
    instructions: "Which action?",
    criteria: { open: null, ignore: "No action" },
  },
  urgent: { type: "noul", instructions: "Is this urgent?" },
  priority: { type: "score", instructions: "Rate priority", criteria: ["Low", "High"] },
};
const answers = {
  action: {
    type: "choice",
    choice: "open",
    probabilities: { open: 0.8, ignore: 0.2 },
    confidence: 0.6,
  },
  urgent: { type: "noul", noul: 0.7 },
  priority: {
    type: "score",
    score: 0.7,
    probabilities: { "0": 0.3, "1": 0.7 },
    confidence: 0.4,
    legend: { "0": "Low", "1": "High" },
  },
};

function request(signal = new AbortController().signal): DecisionRequest {
  return { state: { text: "Open the app" }, questions, signal };
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

test("TypeSafe provider sends one fixed-endpoint request and normalizes token usage", async () => {
  let calls = 0;
  const provider = new TypeSafeDecisionProvider({
    apiKey: "test-secret",
    fetch: async (url, init) => {
      calls++;
      assert.ok(init);
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer test-secret");
      assert.deepEqual(JSON.parse(init.body as string), {
        state: { text: "Open the app" },
        model: "jev-latest",
        questions,
      });
      return json({ model: "jev-latest", answers, usage: { input_tokens: 12, output_tokens: 8 } });
    },
  });
  const response = await provider.evaluate(request());
  assert.equal(provider.locality, "cloud");
  assert.equal(calls, 1);
  assert.deepEqual(response.answers, answers);
  assert.deepEqual(response.usage, { inputTokens: 12, outputTokens: 8 });
  assert.ok(response.latencyMs >= 0);
});

test("response validation rejects wrong answer IDs, types, options, distributions, scores, and legends", () => {
  const base = { model: "jev-latest", answers, latencyMs: 1 };
  assert.deepEqual(validateDecisionResponse(questions, base).answers, answers);
  const mutated = (id: keyof typeof answers, patch: Record<string, unknown>): unknown => ({
    ...base,
    answers: { ...answers, [id]: { ...answers[id], ...patch } },
  });
  for (const invalid of [
    { ...base, answers: { action: answers.action, urgent: answers.urgent } },
    { ...base, answers: { ...answers, extra: answers.urgent } },
    mutated("urgent", { type: "choice" }),
    mutated("urgent", { noul: Number.NaN }),
    mutated("action", { choice: "ignore" }),
    mutated("action", { probabilities: { open: 0.7, ignore: 0.2 } }),
    mutated("action", { probabilities: { open: 0.7, ignore: 0.2, other: 0.1 } }),
    mutated("action", { confidence: 1.1 }),
    mutated("priority", { score: 0.1 }),
    mutated("priority", { legend: { "0": "Wrong", "1": "High" } }),
    { ...base, model: "x".repeat(201) },
    { ...base, usage: { inputTokens: Infinity, outputTokens: 1 } },
  ])
    assert.throws(() => validateDecisionResponse(questions, invalid), /Invalid decision response/);
});

test("validator keeps prototype-like IDs as own data keys", () => {
  const specialQuestions = Object.fromEntries([
    ["__proto__", { type: "noul", instructions: "yes?" }],
    [
      "constructor",
      {
        type: "choice",
        instructions: "pick",
        criteria: Object.fromEntries([
          ["__proto__", null],
          ["constructor", null],
        ]),
      },
    ],
  ]) as Record<string, DecisionQuestion>;
  const specialAnswers = Object.fromEntries([
    ["__proto__", { type: "noul", noul: 0.4 }],
    [
      "constructor",
      {
        type: "choice",
        choice: "__proto__",
        probabilities: Object.fromEntries([
          ["__proto__", 0.9],
          ["constructor", 0.1],
        ]),
        confidence: 0.8,
      },
    ],
  ]);
  const result = validateDecisionResponse(specialQuestions, {
    model: "test",
    answers: specialAnswers,
    latencyMs: 1,
  });
  assert.deepEqual(Object.keys(result.answers), ["__proto__", "constructor"]);
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype);
  assert.equal(result.answers["__proto__"]?.type, "noul");
});

test("TypeSafe provider never follows redirects, retries, or leaks response bodies", async () => {
  let calls = 0;
  const provider = new TypeSafeDecisionProvider({
    apiKey: "top-secret",
    fetch: async () => {
      calls++;
      return new Response("top-secret, private state", { status: 429 });
    },
  });
  await assert.rejects(provider.evaluate(request()), (error: Error) => {
    assert.match(error.message, /HTTP 429/);
    assert.doesNotMatch(error.message, /top-secret|private state/);
    return true;
  });
  assert.equal(calls, 1);
  const redirected = new TypeSafeDecisionProvider({
    apiKey: "test",
    fetch: async () =>
      new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
  });
  await assert.rejects(redirected.evaluate(request()), /redirected/);
});

test("request and response sizes are bounded before full processing", async () => {
  let calls = 0;
  const provider = new TypeSafeDecisionProvider({
    apiKey: "test",
    fetch: async () => {
      calls++;
      return json({ model: "jev-latest", answers });
    },
  });
  await assert.rejects(
    provider.evaluate({ ...request(), state: "x".repeat(300_000) }),
    /too large/,
  );
  assert.equal(calls, 0);
  const largeResponse = new TypeSafeDecisionProvider({
    apiKey: "test",
    fetch: async () => new Response("x".repeat(1_100_000)),
  });
  await assert.rejects(largeResponse.evaluate(request()), /too large/);
});

test("choice and score questions allow 255 levels and reject 256", async () => {
  const criteria = Object.fromEntries(
    Array.from({ length: 255 }, (_, index) => [`option_${index}`, null]),
  );
  const probabilities = Object.fromEntries(
    Object.keys(criteria).map((key, index) => [key, index === 254 ? 1 : 0]),
  );
  const levels = Array.from({ length: 255 }, (_, index) => `Level ${index}`);
  const scoreProbabilities = Object.fromEntries(
    levels.map((_, index) => [String(index), index === 254 ? 1 : 0]),
  );
  const twoQuestions: Record<string, DecisionQuestion> = {
    choice: { type: "choice", instructions: "Select", criteria },
    score: { type: "score", instructions: "Rate", criteria: levels },
  };
  let calls = 0;
  const provider = new TypeSafeDecisionProvider({
    apiKey: "test",
    fetch: async () => {
      calls++;
      return json({
        model: "jev-latest",
        answers: {
          choice: { type: "choice", choice: "option_254", probabilities, confidence: 1 },
          score: {
            type: "score",
            score: 254,
            probabilities: scoreProbabilities,
            confidence: 1,
            legend: Object.fromEntries(levels.map((text, index) => [String(index), text])),
          },
        },
      });
    },
  });
  const response = await provider.evaluate({ ...request(), questions: twoQuestions });
  assert.equal(response.answers.choice?.type, "choice");
  assert.equal(response.answers.score?.type, "score");
  assert.equal(calls, 1);
  await assert.rejects(
    provider.evaluate({
      ...request(),
      questions: {
        choice: {
          type: "choice",
          instructions: "Select",
          criteria: { ...criteria, option_255: null },
        },
      },
    }),
    /Invalid decision request/,
  );
  await assert.rejects(
    provider.evaluate({
      ...request(),
      questions: {
        score: { type: "score", instructions: "Rate", criteria: [...levels, "Level 255"] },
      },
    }),
    /Invalid decision request/,
  );
  assert.equal(calls, 1);
});

test("early HTTP rejection cancels unread response bodies", async () => {
  for (const { status, headers, error } of [
    { status: 302, headers: {}, error: /redirected/ },
    { status: 503, headers: {}, error: /HTTP 503/ },
    { status: 200, headers: { "content-length": "1048577" }, error: /too large/ },
  ]) {
    let cancelled = false;
    const provider = new TypeSafeDecisionProvider({
      apiKey: "test",
      fetch: async () =>
        new Response(
          new ReadableStream({
            start() {},
            cancel() {
              cancelled = true;
            },
          }),
          {
            status,
            headers,
          },
        ),
    });
    await assert.rejects(provider.evaluate(request()), error);
    assert.equal(cancelled, true);
  }
});

test("deadline and caller cancellation work when injected fetch ignores the signal", async () => {
  const never = async (): Promise<Response> => new Promise(() => {});
  const provider = new TypeSafeDecisionProvider({ apiKey: "test", timeoutMs: 5, fetch: never });
  await assert.rejects(provider.evaluate(request()), /timed out/);
  const controller = new AbortController();
  const pending = new TypeSafeDecisionProvider({
    apiKey: "test",
    timeoutMs: 1000,
    fetch: never,
  }).evaluate(request(controller.signal));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  let bodyCancelled = false;
  const stalledBody = new TypeSafeDecisionProvider({
    apiKey: "test",
    timeoutMs: 5,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start() {},
          cancel() {
            bodyCancelled = true;
          },
        }),
      ),
  });
  await assert.rejects(stalledBody.evaluate(request()), /timed out/);
  assert.equal(bodyCancelled, true);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(provider.evaluate(request(alreadyAborted.signal)), /cancelled/);
});

test("injected fetch failures cannot expose credentials or state", async () => {
  const provider = new TypeSafeDecisionProvider({
    apiKey: "private-key",
    fetch: async () => {
      throw new Error("Decision private-key private-state");
    },
  });
  await assert.rejects(
    provider.evaluate({ ...request(), state: "private-state" }),
    (error: Error) => {
      assert.equal(error.message, "Decision endpoint failed");
      return true;
    },
  );
});

test("local provider accepts only loopback endpoints and maps chat JSON to the shared answer contract", async () => {
  for (const endpoint of [
    "https://example.com",
    "http://192.168.1.2:8000",
    "http://localhost:8000",
    "http://localhost.evil.test",
    "http://0x7f000001:8000",
    "http://127.1:8000",
    "file:///tmp/model",
    "http://127.0.0.1:8000/v1/chat/completions",
    "http://user:pass@127.0.0.1:8000",
  ])
    assert.throws(() => new LocalDecisionProvider({ endpoint, model: "local-model" }), /endpoint/);

  const provider = new LocalDecisionProvider({
    endpoint: "http://127.0.0.1:8000",
    model: "local-model",
    fetch: async (url, init) => {
      assert.equal(url, "http://127.0.0.1:8000/v1/chat/completions");
      assert.equal(init?.redirect, "manual");
      const body = JSON.parse(init?.body as string);
      assert.equal(body.model, "local-model");
      assert.equal(body.stream, false);
      assert.equal(body.messages[1].role, "user");
      assert.deepEqual(JSON.parse(body.messages[1].content).questions, questions);
      return json({
        model: "local-model",
        choices: [{ message: { content: JSON.stringify({ answers }) } }],
        usage: { prompt_tokens: 33, completion_tokens: 44 },
      });
    },
  });
  const response = await provider.evaluate(request());
  assert.equal(provider.locality, "local");
  assert.deepEqual(response.answers, answers);
  assert.deepEqual(response.usage, { inputTokens: 33, outputTokens: 44 });
});

test("local malformed chat content is rejected without echoing it", async () => {
  const provider = new LocalDecisionProvider({
    endpoint: "http://[::1]:1234",
    model: "local",
    fetch: async () => json({ choices: [{ message: { content: "private state <not json>" } }] }),
  });
  await assert.rejects(provider.evaluate(request()), (error: Error) => {
    assert.equal(error.message, "Invalid decision response");
    return true;
  });
});

test("local provider rejects completions cut short at the token limit", async () => {
  const provider = new LocalDecisionProvider({
    endpoint: "http://127.0.0.1:1234",
    model: "local",
    fetch: async () =>
      json({
        choices: [{ finish_reason: "length", message: { content: JSON.stringify({ answers }) } }],
      }),
  });
  await assert.rejects(provider.evaluate(request()), /Invalid decision response/);
});

test("provider constructor bounds model length and rejects a key with a newline", () => {
  assert.throws(
    () => new TypeSafeDecisionProvider({ apiKey: "secret\nheader" }),
    /Invalid TypeSafe API key/,
  );
  assert.throws(
    () => new TypeSafeDecisionProvider({ apiKey: "test", model: "x".repeat(201) }),
    /Invalid decision model/,
  );
  assert.throws(
    () => new LocalDecisionProvider({ endpoint: "http://127.0.0.1", model: "x".repeat(201) }),
    /Invalid decision model/,
  );
  assert.doesNotThrow(
    () => new TypeSafeDecisionProvider({ apiKey: "test", model: "x".repeat(200) }),
  );
});
