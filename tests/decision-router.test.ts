import test from "node:test";
import assert from "node:assert/strict";
import { buildDesktopQuestions, decideDesktop } from "@ellie/router/decision";
import { defaults } from "@ellie/config";
import type { DecisionProvider, DecisionQuestion, DecisionResponse } from "@ellie/decisions";

function response(
  questions: Record<string, DecisionQuestion>,
  choices: Record<string, string>,
  probability = 0.995,
): DecisionResponse {
  const answers: DecisionResponse["answers"] = {};
  for (const [id, question] of Object.entries(questions)) {
    assert.equal(question.type, "choice");
    if (question.type !== "choice") continue;
    const keys = Object.keys(question.criteria);
    const choice = choices[id] ?? "none";
    assert.ok(keys.includes(choice), `${id}: ${choice}`);
    answers[id] = {
      type: "choice",
      choice,
      confidence: probability,
      probabilities: Object.fromEntries(
        keys.map((key) => [
          key,
          key === choice ? probability : (1 - probability) / (keys.length - 1),
        ]),
      ),
    };
  }
  return { model: "stub", answers, latencyMs: 1 };
}

function provider(choices: Record<string, string>, probability = 0.995): DecisionProvider {
  return {
    id: "stub",
    locality: "local",
    async evaluate(request) {
      return response(request.questions, choices, probability);
    },
  };
}

const options = () => ({ signal: new AbortController().signal });

test("opaque allowlist IDs assemble only a single protocol action", async () => {
  const app = await decideDesktop(
    "Bring up Notes",
    {},
    defaults,
    provider({ request: "single", operation: "app.open", app: "app_3" }),
    options(),
  );
  assert.equal(app.kind, "plan");
  if (app.kind === "plan") {
    assert.deepEqual(app.plan.actions, [{ tool: "app.open", app: "com.apple.Notes" }]);
    assert.deepEqual(app.plan.nextContext, { lastApp: "com.apple.Notes" });
    assert.equal(app.probability, 0.995);
  }
  const site = await decideDesktop(
    "Show YouTube",
    {},
    defaults,
    provider({ request: "single", operation: "url.open", site: "site_1" }),
    options(),
  );
  assert.equal(site.kind, "plan");
  if (site.kind === "plan")
    assert.deepEqual(site.plan.actions, [
      { tool: "url.open", app: defaults.browser, url: defaults.sites.youtube },
    ]);
  for (const input of [
    "Bring up Notes again",
    "Open Notes please",
    "Open Notes right now",
    "Open that Notes window",
  ]) {
    const polite = await decideDesktop(
      input,
      {},
      defaults,
      provider({ request: "single", operation: "app.open", app: "app_3" }),
      options(),
    );
    assert.equal(polite.kind, "plan", input);
  }
});

test("layout, monitor, and previous application remain distinct bounded choices", async () => {
  const context = { lastApp: "com.apple.Notes" };
  const placement = await decideDesktop(
    "Make it fullscreen on the largest monitor",
    context,
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_0",
      layout: "fullscreen",
      monitor: "largest",
    }),
    options(),
  );
  assert.equal(placement.kind, "plan");
  if (placement.kind === "plan")
    assert.deepEqual(placement.plan.actions, [
      { tool: "window.place", app: "com.apple.Notes", layout: "fullscreen", monitor: "largest" },
    ]);
  const maximize = await decideDesktop(
    "Maximize it",
    context,
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_0",
      layout: "maximize",
      monitor: "current",
    }),
    options(),
  );
  assert.equal(maximize.kind, "plan");
  if (maximize.kind === "plan")
    assert.deepEqual(maximize.plan.actions, [
      { tool: "window.place", app: "com.apple.Notes", layout: "maximize", monitor: "current" },
    ]);
  const invalidContext = await decideDesktop(
    "Maximize it",
    { lastApp: "com.apple.Terminal" },
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "unknown",
      layout: "maximize",
      monitor: "current",
    }),
    options(),
  );
  assert.equal(invalidContext.kind, "clarify");
  const confidentGuess = await decideDesktop(
    "Maximize it",
    {},
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_3",
      layout: "maximize",
      monitor: "current",
    }),
    options(),
  );
  assert.equal(confidentGuess.kind, "clarify");
  const wrongPronounTarget = await decideDesktop(
    "Maximize it",
    context,
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_1",
      layout: "maximize",
      monitor: "current",
    }),
    options(),
  );
  assert.equal(wrongPronounTarget.kind, "clarify");
  const localReference = await decideDesktop(
    "Move Arc to the largest monitor and make it fullscreen",
    {},
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_0",
      layout: "fullscreen",
      monitor: "largest",
    }),
    options(),
  );
  assert.equal(localReference.kind, "plan");
  const priorCannotOverrideNamed = await decideDesktop(
    "Move Arc to the largest monitor and make it fullscreen",
    context,
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_0",
      layout: "fullscreen",
      monitor: "largest",
    }),
    options(),
  );
  assert.equal(priorCannotOverrideNamed.kind, "clarify");
  const namedWithPrior = await decideDesktop(
    "Move Arc to the largest monitor and make it fullscreen",
    context,
    defaults,
    provider({
      request: "single",
      operation: "window.place",
      app: "app_1",
      layout: "fullscreen",
      monitor: "largest",
    }),
    options(),
  );
  assert.equal(namedWithPrior.kind, "plan");
});

test("adjacent placement rejects identical target and anchor", async () => {
  const same = await decideDesktop(
    "Put Notes next to Notes",
    {},
    defaults,
    provider({
      request: "single",
      operation: "window.adjacent",
      app: "app_3",
      anchor: "app_3",
    }),
    options(),
  );
  assert.equal(same.kind, "clarify");
  const distinct = await decideDesktop(
    "Put Messages next to Notes",
    {},
    defaults,
    provider({
      request: "single",
      operation: "window.adjacent",
      app: "app_1",
      anchor: "app_3",
    }),
    options(),
  );
  assert.equal(distinct.kind, "plan");
  if (distinct.kind === "plan")
    assert.deepEqual(distinct.plan.actions, [
      { tool: "window.adjacent", app: "com.apple.MobileSMS", anchor: "com.apple.Notes" },
    ]);
  const wrongAnchor = await decideDesktop(
    "Put Messages next to it",
    { lastApp: "com.apple.Notes" },
    defaults,
    provider({ request: "single", operation: "window.adjacent", app: "app_2", anchor: "app_3" }),
    options(),
  );
  assert.equal(wrongAnchor.kind, "clarify");
});

test("ambiguous, unsupported, and low-margin outcomes never yield a plan", async () => {
  for (const status of ["ambiguous", "multi", "not_request", "unsupported"]) {
    const result = await decideDesktop(
      "Do something",
      {},
      defaults,
      provider({ request: status }),
      options(),
    );
    assert.notEqual(result.kind, "plan");
  }
  const low = await decideDesktop(
    "Open Notes",
    {},
    defaults,
    provider({ request: "single", operation: "app.open", app: "app_3" }, 0.5),
    options(),
  );
  assert.equal(low.kind, "clarify");
  const unknown = await decideDesktop(
    "Could you open an unknown app?",
    {},
    defaults,
    provider({ request: "single", operation: "app.open", app: "unknown" }),
    options(),
  );
  assert.equal(unknown.kind, "clarify");
});

test("obvious compound, negated, and quoted requests are rejected before provider use", async () => {
  let called = 0;
  const stub: DecisionProvider = {
    id: "stub",
    locality: "local",
    async evaluate(request) {
      called++;
      return response(request.questions, {});
    },
  };
  for (const input of [
    "Open Notes and delete files",
    "Don't open Notes",
    "She said 'open Notes'",
    "Open Notes; rm -rf /",
    "Open Notes\nOpen Messages",
    "Open Terminal",
    "Open app Netflix",
    "Visit Notes",
  ]) {
    const result = await decideDesktop(input, {}, defaults, stub, options());
    assert.equal(result.kind, "unsupported", input);
  }
  assert.equal(called, 0);
  const contraction = await decideDesktop(
    "I'd like to open Notes",
    {},
    defaults,
    provider({ request: "single", operation: "app.open", app: "app_3" }),
    options(),
  );
  assert.equal(contraction.kind, "plan");
});

test("candidate generation caps choices and cannot inherit prototype properties", () => {
  const apps = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`app${i}`, `org.example.App${i}`]),
  );
  const prefs = { ...defaults, apps: { ...apps, constructor: "org.example.Constructor" } };
  const { questions } = buildDesktopQuestions("Open constructor", {}, prefs);
  assert.equal(questions.app?.type, "choice");
  if (questions.app?.type === "choice") {
    assert.ok(Object.keys(questions.app.criteria).length <= 255);
    assert.ok(
      Object.keys(questions.app.criteria).every(
        (id) => id === "unknown" || id === "none" || /^app_\d+$/.test(id),
      ),
    );
  }
});

test("invalid provider responses and cancellation cannot create plans", async () => {
  const broken: DecisionProvider = {
    id: "bad",
    locality: "local",
    async evaluate() {
      return { model: "bad", answers: {}, latencyMs: 1 };
    },
  };
  await assert.rejects(decideDesktop("Open Notes", {}, defaults, broken, options()));
  const controller = new AbortController();
  const delayed: DecisionProvider = {
    id: "slow",
    locality: "local",
    async evaluate(request) {
      controller.abort();
      return response(request.questions, {
        request: "single",
        operation: "app.open",
        app: "app_3",
      });
    },
  };
  await assert.rejects(
    decideDesktop("Open Notes", {}, defaults, delayed, { signal: controller.signal }),
    /cancelled/,
  );
});
