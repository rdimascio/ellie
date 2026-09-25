import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBrowserStepQuestions,
  decideBrowserStep,
  MAX_STEP_ITEMS,
} from "@ellie/router/browser-decision";
import type { BrowserStepObservation } from "@ellie/router/browser-decision";
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

function observation(overrides: Partial<BrowserStepObservation> = {}): BrowserStepObservation {
  return {
    url: "https://www.youtube.com/",
    title: "YouTube",
    items: [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", label: "Lo-fi beats to code to" },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", label: "Full album stream" },
    ],
    scrollDirections: [],
    ...overrides,
  };
}

const position = { stepIndex: 0, maxSteps: 4, alreadySelected: [] };
const options = (extra: Record<string, unknown> = {}) => ({
  signal: new AbortController().signal,
  ...position,
  ...extra,
});

test("one observed element becomes a bounded select decision", async () => {
  const obs = observation();
  const decision = await decideBrowserStep(
    "play some lofi",
    obs,
    provider({ progress: "unsatisfied", step: "item_0" }),
    options(),
  );
  assert.equal(decision.kind, "select");
  if (decision.kind === "select") {
    assert.equal(decision.itemId, obs.items[0]!.id);
    assert.equal(decision.label, obs.items[0]!.label);
    assert.equal(decision.probability, 0.995);
  }
});

test("page labels are data and never become action fields", async () => {
  const injected = "; rm -rf /";
  const control = "badlabel";
  const oversized = "x".repeat(600);
  const obs = observation({
    items: [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", label: injected },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", label: control },
      { id: "aaaaaaaa-0000-4000-8000-000000000003", label: oversized },
    ],
  });
  const { questions } = buildBrowserStepQuestions("goal", obs, position);
  assert.equal(questions.step?.type, "choice");
  if (questions.step?.type !== "choice") return;
  const criteria = Object.keys(questions.step.criteria);
  assert.ok(
    criteria.every((id) => /^(item_\d+|scroll_down|scroll_up|done|cannot|unknown|none)$/.test(id)),
  );
  // Control-char label is dropped entirely; injected text and the oversized label survive as items,
  // truncated, never surfacing as a literal criterion key.
  assert.equal(criteria.filter((id) => id.startsWith("item_")).length, 2);
  const decision = await decideBrowserStep(
    "goal",
    obs,
    provider({ progress: "unsatisfied", step: "item_1" }),
    options(),
  );
  assert.equal(decision.kind, "select");
  if (decision.kind === "select") {
    assert.equal(decision.itemId, obs.items[2]!.id);
    assert.equal(decision.label.length, 160);
  }
});

test("candidate items are truncated to the step bound and stay under MAX_CHOICES", async () => {
  const many = Array.from({ length: 64 }, (_, i) => ({
    id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
    label: `Item ${i}`,
  }));
  const obs = observation({ items: many });
  const { questions } = buildBrowserStepQuestions("goal", obs, position);
  assert.equal(questions.step?.type, "choice");
  if (questions.step?.type !== "choice") return;
  const keys = Object.keys(questions.step.criteria);
  assert.ok(
    keys.every(
      (id) =>
        id === "unknown" ||
        id === "none" ||
        id === "done" ||
        id === "cannot" ||
        /^item_\d+$/.test(id),
    ),
  );
  assert.equal(keys.filter((id) => /^item_\d+$/.test(id)).length, MAX_STEP_ITEMS);
  assert.ok(keys.length <= 255);
});

test("scroll choices appear only when the read observed that direction", async () => {
  const withDown = observation({ scrollDirections: ["down"] });
  const scrolled = await decideBrowserStep(
    "goal",
    withDown,
    provider({ progress: "unsatisfied", step: "scroll_down" }),
    options(),
  );
  assert.equal(scrolled.kind, "scroll");
  if (scrolled.kind === "scroll") assert.equal(scrolled.direction, "down");
  const withoutDown = observation({ scrollDirections: [] });
  const bogusScroll: DecisionProvider = {
    id: "bogus",
    locality: "local",
    async evaluate(request) {
      const base = response(request.questions, { progress: "unsatisfied" });
      return {
        ...base,
        answers: {
          ...base.answers,
          step: {
            type: "choice",
            choice: "scroll_down",
            confidence: 0.995,
            probabilities: { scroll_down: 1 },
          },
        },
      };
    },
  };
  // scroll_down is not a criterion of this question; validateDecisionResponse rejects it.
  await assert.rejects(decideBrowserStep("goal", withoutDown, bogusScroll, options()));
});

test("a satisfied goal ends the step without an action", async () => {
  const decision = await decideBrowserStep(
    "goal",
    observation(),
    provider({ progress: "satisfied", step: "item_0" }),
    options(),
  );
  assert.equal(decision.kind, "satisfied");
});

test("low probability and low margin never yield an action", async () => {
  const low = await decideBrowserStep(
    "goal",
    observation(),
    provider({ progress: "unsatisfied", step: "item_0" }, 0.5),
    options(),
  );
  assert.equal(low.kind, "ambiguous");
  const obs = observation();
  const { questions } = buildBrowserStepQuestions("goal", obs, position);
  assert.equal(questions.step?.type, "choice");
  if (questions.step?.type !== "choice") return;
  const keys = Object.keys(questions.step.criteria);
  const nearTie: DecisionResponse = {
    model: "tie",
    latencyMs: 1,
    answers: {
      progress: response(questions, { progress: "unsatisfied" }).answers.progress!,
      step: {
        type: "choice",
        choice: "item_0",
        confidence: 0.55,
        probabilities: Object.fromEntries(
          keys.map((key) => [key, key === "item_0" ? 0.55 : key === "item_1" ? 0.45 : 0]),
        ),
      },
    },
  };
  const tied = await decideBrowserStep(
    "goal",
    obs,
    {
      id: "tie",
      locality: "local",
      async evaluate() {
        return nearTie;
      },
    },
    options(),
  );
  assert.equal(tied.kind, "ambiguous");
});

test("unknown and none choices never yield an action", async () => {
  for (const step of ["unknown", "none", "done", "cannot"]) {
    const decision = await decideBrowserStep(
      "goal",
      observation(),
      provider({ progress: "unsatisfied", step }),
      options(),
    );
    assert.notEqual(decision.kind, "select");
    assert.notEqual(decision.kind, "scroll");
  }
});

test("an empty, oversized, or control-character goal is rejected before the provider is used", async () => {
  let called = 0;
  const stub: DecisionProvider = {
    id: "stub",
    locality: "local",
    async evaluate(request) {
      called++;
      return response(request.questions, {});
    },
  };
  for (const goal of ["", "   ", "x".repeat(301), "goaltext"]) {
    const decision = await decideBrowserStep(goal, observation(), stub, options());
    assert.equal(decision.kind, "ambiguous");
  }
  assert.equal(called, 0);
});

test("an observation with no item and no scroll direction abstains before the provider is used", async () => {
  let called = 0;
  const stub: DecisionProvider = {
    id: "stub",
    locality: "local",
    async evaluate(request) {
      called++;
      return response(request.questions, {});
    },
  };
  const decision = await decideBrowserStep(
    "goal",
    observation({ items: [], scrollDirections: [] }),
    stub,
    options(),
  );
  assert.equal(decision.kind, "blocked");
  assert.equal(called, 0);
});

test("cancellation during evaluation cannot produce an action", async () => {
  const controller = new AbortController();
  const delayed: DecisionProvider = {
    id: "slow",
    locality: "local",
    async evaluate(request) {
      controller.abort();
      return response(request.questions, { progress: "unsatisfied", step: "item_0" });
    },
  };
  await assert.rejects(
    decideBrowserStep("goal", observation(), delayed, {
      ...position,
      signal: controller.signal,
    }),
    /cancelled/,
  );
});

test("fixture selectable-link rule matches the documented accessibility contract", async () => {
  const { axSelectableItems, YOUTUBE_PURSUIT_PAGES } =
    await import("./fixtures/browser-ax-pages.ts");
  for (const page of Object.values(YOUTUBE_PURSUIT_PAGES)) {
    const items = axSelectableItems(page);
    assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  }
  const results = axSelectableItems(YOUTUBE_PURSUIT_PAGES.results);
  assert.ok(results.length > 0);
  const again = axSelectableItems(YOUTUBE_PURSUIT_PAGES.results);
  assert.notDeepEqual(
    results.map((item) => item.id),
    again.map((item) => item.id),
  );
  assert.deepEqual(
    results.map((item) => item.label).sort(),
    again.map((item) => item.label).sort(),
  );
  const link = (over: Partial<import("./fixtures/browser-ax-pages.ts").AxFixtureNode>) =>
    ({
      kind: "link" as const,
      label: "A video",
      value: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      enabled: true,
      actions: ["press"],
      ...over,
    }) satisfies import("./fixtures/browser-ax-pages.ts").AxFixtureNode;
  const edgeCases = {
    url: "https://www.youtube.com/",
    title: "YouTube",
    scrollDirections: [] as ("up" | "down")[],
    nodes: [
      link({ label: "Duplicate one", value: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }),
      link({ label: "Duplicate two", value: "https://www.youtube.com/watch?v=bbbbbbbbbbb" }),
      link({
        label: "Disabled video",
        value: "https://www.youtube.com/watch?v=ccccccccccc",
        enabled: false,
      }),
      link({ label: "Not a watch link", value: "https://www.youtube.com/results?search_query=x" }),
      link({ label: "Unique video", value: "https://www.youtube.com/watch?v=ddddddddddd" }),
    ],
  };
  const items = axSelectableItems(edgeCases);
  assert.deepEqual(
    items.map((item) => item.label),
    ["Unique video"],
  );
});
