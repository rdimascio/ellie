import test from "node:test";
import assert from "node:assert/strict";
import { job as parseJob, record } from "@ellie/protocol";
import type { DecisionProvider, DecisionQuestion, DecisionResponse } from "@ellie/decisions";
import { fixture } from "./helpers.ts";
import { axSelectableItems, YOUTUBE_PURSUIT_PAGES } from "./fixtures/browser-ax-pages.ts";
import type { AxFixturePage } from "./fixtures/browser-ax-pages.ts";
import { parsePursueCommand, runBrowserPursuit } from "../apps/cli/src/browser-pursue.ts";
import type { PursueClient } from "../apps/cli/src/browser-pursue.ts";

function response(
  questions: Record<string, DecisionQuestion>,
  choices: Record<string, string>,
  probability = 0.995,
): DecisionResponse {
  const answers: DecisionResponse["answers"] = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type !== "choice") continue;
    const keys = Object.keys(question.criteria);
    const choice = choices[id] ?? "none";
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

/** Each pursuit step calls the provider once, in order; scripts a canned answer per step. */
function scriptedProvider(
  script: { progress: string; step?: string; probability?: number }[],
): DecisionProvider {
  let index = 0;
  return {
    id: "scripted",
    locality: "local",
    async evaluate(request) {
      const entry = script[index];
      if (!entry) throw new Error(`No scripted decision for evaluation ${index}.`);
      index++;
      return response(
        request.questions,
        { progress: entry.progress, ...(entry.step ? { step: entry.step } : {}) },
        entry.probability ?? 0.995,
      );
    },
  };
}

interface PageState {
  page: AxFixturePage;
  revision: string;
  connected: boolean;
}

/**
 * Minimal poll/result node driver. Mirrors the real accessibility contract only at the wire
 * shape level (browserWebMCPOperationResult); page transitions are entirely test-controlled.
 */
function fakeBrowserNode(
  node: PursueClient,
  state: PageState,
  opts: {
    onCommand?: (tool: string, dispatchIndex: number) => "advance" | "reject" | "same";
    nextPage?: (dispatchIndex: number) => { page: AxFixturePage; revision: string };
  } = {},
) {
  const stopSignal = new AbortController();
  const actions: Record<string, unknown>[] = [];
  let dispatchIndex = 0;
  const done = (async () => {
    while (!stopSignal.signal.aborted) {
      let polled: Record<string, unknown>;
      try {
        polled = record(
          await node.call("GET", "/v1/poll", undefined, { signal: stopSignal.signal }),
        );
      } catch {
        return;
      }
      if (!polled.job) continue;
      const task = parseJob(polled.job);
      const act = record(task.actions[0]);
      actions.push(act);
      if (act.tool === "browser.status") {
        await node.call("POST", "/v1/result", {
          id: task.id,
          result: state.connected
            ? {
                ok: true,
                message: "Browser tab connected.",
                browser: {
                  source: "accessibility",
                  operation: "status",
                  status: "connected",
                  revision: state.revision,
                  origin: new URL(state.page.url).origin,
                },
              }
            : {
                ok: false,
                message: "No reviewed browser tab is connected.",
                browser: { source: "webmcp", operation: "status", status: "unbound" },
              },
        });
      } else if (act.tool === "browser.read") {
        await node.call("POST", "/v1/result", {
          id: task.id,
          result: {
            ok: true,
            message: "Browser view read.",
            browser: {
              source: "accessibility",
              operation: "read",
              status: "completed",
              revision: state.revision,
              view: {
                title: state.page.title,
                items: axSelectableItems(state.page),
                axScrollDirections: state.page.scrollDirections,
              },
            },
          },
        });
      } else if (act.tool === "browser.select" || act.tool === "browser.scroll") {
        const instruction = opts.onCommand?.(act.tool, dispatchIndex) ?? "same";
        if (instruction === "reject" || act.revision !== state.revision) {
          await node.call("POST", "/v1/result", {
            id: task.id,
            result: { ok: false, message: "Browser page changed before the requested action." },
          });
        } else {
          await node.call("POST", "/v1/result", {
            id: task.id,
            result: {
              ok: false,
              message: "Browser action was dispatched without independent effect confirmation.",
              browser: {
                source: "accessibility",
                operation: "command",
                status: "unknown",
                revision: state.revision,
              },
            },
          });
          if (instruction === "advance" && opts.nextPage) {
            const next = opts.nextPage(dispatchIndex);
            state.page = next.page;
            state.revision = next.revision;
          }
        }
        dispatchIndex++;
      }
    }
  })();
  return {
    actions,
    stop: () => stopSignal.abort(),
    async close() {
      stopSignal.abort();
      await done.catch(() => {});
    },
  };
}

const CAPS = ["browser.read", "browser.control"];
const CYCLE = [
  { page: YOUTUBE_PURSUIT_PAGES.results, revision: "rev1" },
  { page: YOUTUBE_PURSUIT_PAGES.watch, revision: "rev2" },
  { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev3" },
];

test("a bounded pursuit reads, decides, and dispatches one select per step", async () => {
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "satisfied" },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    {
      onCommand: () => "advance",
      nextPage: () => ({ page: YOUTUBE_PURSUIT_PAGES.watch, revision: "rev1" }),
    },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "satisfied_unverified");
    assert.equal(report.dispatched, 1);
    assert.deepEqual(
      fake.actions.map((a) => a.tool),
      ["browser.status", "browser.read", "browser.select", "browser.status", "browser.read"],
    );
  } finally {
    await fake.close();
    await f.close();
  }
});

test("every dispatched mutation is reported unknown and never claimed as success", async () => {
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "unsatisfied", step: "item_0" },
    { progress: "satisfied" },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  let cursor = 0;
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    {
      onCommand: () => "advance",
      nextPage: () => CYCLE[cursor++ % CYCLE.length]!,
    },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 5,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "satisfied_unverified");
    assert.equal(report.dispatched, 2);
    assert.ok(report.steps.every((step) => step.outcome === "unknown"));
    assert.ok(report.lines.every((line) => !/succeeded|completed/i.test(line)));
  } finally {
    await fake.close();
    await f.close();
  }
});

test("an unchanged page after a dispatch stops the loop instead of clicking again", async () => {
  const provider = scriptedProvider([{ progress: "unsatisfied", step: "item_0" }]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(node, {
    page: YOUTUBE_PURSUIT_PAGES.home,
    revision: "rev0",
    connected: true,
  });
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 4,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "no_change");
    assert.equal(report.dispatched, 1);
    assert.equal(fake.actions.filter((a) => a.tool === "browser.select").length, 1);
  } finally {
    await fake.close();
    await f.close();
  }
});

test("the step bound stops the loop", async () => {
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "unsatisfied", step: "item_0" },
    { progress: "unsatisfied", step: "item_0" },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  let cursor = 0;
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    { onCommand: () => "advance", nextPage: () => CYCLE[cursor++ % CYCLE.length]! },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "exhausted");
    assert.equal(report.dispatched, 3);
    assert.equal(fake.actions.filter((a) => a.tool === "browser.select").length, 3);
  } finally {
    await fake.close();
    await f.close();
  }
});

test("an ambiguous step stops the loop and leaves prior dispatches visible", async () => {
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "unsatisfied", step: "item_0" },
    { progress: "unsatisfied", step: "item_0", probability: 0.5 },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  let cursor = 0;
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    { onCommand: () => "advance", nextPage: () => CYCLE[cursor++ % CYCLE.length]! },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 8,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "ambiguous");
    assert.equal(report.dispatched, 2);
    assert.equal(report.steps.length, 2);
    for (const step of report.steps) {
      assert.ok(step.revision);
      assert.ok(step.itemId);
      assert.ok(step.label);
    }
    assert.equal(fake.actions.filter((a) => a.tool === "browser.select").length, 2);
  } finally {
    await fake.close();
    await f.close();
  }
});

test("a wrong click is reported, not undone", async () => {
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "blocked" },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    {
      onCommand: () => "advance",
      nextPage: () => ({ page: YOUTUBE_PURSUIT_PAGES.unrelated, revision: "rev1" }),
    },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 2,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "blocked");
    assert.equal(report.dispatched, 1);
    assert.equal(report.steps[0]?.action, "select");
    assert.ok(report.steps[0]?.label);
    assert.notEqual(report.outcome, "satisfied_unverified");
    assert.ok(report.lines.some((line) => line.includes("example.com")));
  } finally {
    await fake.close();
    await f.close();
  }
});

test("shadow mode proposes without dispatching", async () => {
  const provider = scriptedProvider([{ progress: "unsatisfied", step: "item_0" }]);
  const f = await fixture(5000, { decisionRouting: { mode: "shadow", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(node, {
    page: YOUTUBE_PURSUIT_PAGES.home,
    revision: "rev0",
    connected: true,
  });
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 4,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "shadow");
    assert.equal(report.dispatched, 0);
    assert.equal(fake.actions.filter((a) => a.tool === "browser.select").length, 0);
    assert.equal(report.steps.length, 1);
    assert.equal(report.steps[0]?.outcome, "proposed");
  } finally {
    await fake.close();
    await f.close();
  }
});

test("cancellation between steps dispatches nothing further", async () => {
  const provider = scriptedProvider([{ progress: "unsatisfied", step: "item_0" }]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    {
      onCommand: () => "advance",
      nextPage: () => ({ page: YOUTUBE_PURSUIT_PAGES.results, revision: "rev1" }),
    },
  );
  const abort = new AbortController();
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 3,
      signal: abort.signal,
      onSettle: () => abort.abort(),
    });
    assert.equal(report.outcome, "cancelled");
    assert.equal(report.dispatched, 1);
    assert.deepEqual(
      fake.actions.map((a) => a.tool),
      ["browser.status", "browser.read", "browser.select"],
    );
  } finally {
    await fake.close();
    await f.close();
  }
});

test("the total deadline clamps every request and forbids a mutation after expiry", async () => {
  let clock = 0;
  const calls: { path: string; tool?: string; timeoutMs?: number }[] = [];
  const client: PursueClient = {
    async call(_method, path, body, options) {
      const action =
        body && typeof body === "object" && "action" in body ? record(body.action) : undefined;
      calls.push({
        path,
        ...(action ? { tool: String(action.tool) } : {}),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      clock += 10_000;
      if (path === "/v1/decisions/browser-step")
        return {
          ok: true,
          mode: "execute",
          step: {
            kind: "select",
            itemId: "aaaaaaaa-0000-4000-8000-000000000001",
            label: "A video",
            probability: 0.995,
            margin: 0.99,
          },
        };
      if (action?.tool === "browser.status")
        return {
          ok: true,
          message: "Browser tab connected.",
          browser: {
            source: "accessibility",
            operation: "status",
            status: "connected",
            revision: "rev0",
            origin: "https://www.youtube.com",
          },
        };
      if (action?.tool === "browser.read")
        return {
          ok: true,
          message: "Browser view read.",
          browser: {
            source: "accessibility",
            operation: "read",
            status: "completed",
            revision: "rev0",
            view: {
              items: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", label: "A video" }],
              axScrollDirections: [],
            },
          },
        };
      throw new Error("A mutation was dispatched after the total deadline.");
    },
  };

  const report = await runBrowserPursuit(client, {
    nodeId: "node-1",
    goal: "open a video",
    maxSteps: 2,
    signal: new AbortController().signal,
    totalTimeoutMs: 25_000,
    now: () => clock,
  });

  assert.equal(report.outcome, "exhausted");
  assert.equal(report.dispatched, 0);
  assert.deepEqual(
    calls.map(({ path, tool }) => ({ path, tool })),
    [
      { path: "/v1/commands", tool: "browser.status" },
      { path: "/v1/commands", tool: "browser.read" },
      { path: "/v1/decisions/browser-step", tool: undefined },
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.timeoutMs),
    [20_000, 15_000, 5_000],
  );
});

test("a changed revision between read and select fails closed without a retry", async () => {
  const provider = scriptedProvider([{ progress: "unsatisfied", step: "item_0" }]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    { onCommand: () => "reject" },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal: "play some lofi",
      maxSteps: 8,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "unavailable");
    assert.equal(report.steps.length, 1);
    assert.equal(report.steps[0]?.outcome, "unknown");
    assert.equal(fake.actions.filter((a) => a.tool === "browser.select").length, 1);
    assert.equal(fake.actions.filter((a) => a.tool === "browser.read").length, 1);
  } finally {
    await fake.close();
    await f.close();
  }
});

test("the loop never emits a free-text argument", async () => {
  const goal = "find the secret admin panel";
  const provider = scriptedProvider([
    { progress: "unsatisfied", step: "item_0" },
    { progress: "satisfied" },
  ]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  const fake = fakeBrowserNode(
    node,
    { page: YOUTUBE_PURSUIT_PAGES.home, revision: "rev0", connected: true },
    {
      onCommand: () => "advance",
      nextPage: () => ({ page: YOUTUBE_PURSUIT_PAGES.watch, revision: "rev1" }),
    },
  );
  try {
    const report = await runBrowserPursuit(f.controller, {
      nodeId: "node-1",
      goal,
      maxSteps: 3,
      signal: new AbortController().signal,
    });
    assert.equal(report.outcome, "satisfied_unverified");
    const allowed = new Set(["browser.status", "browser.read", "browser.select", "browser.scroll"]);
    assert.ok(fake.actions.every((action) => allowed.has(String(action.tool))));
    assert.ok(!JSON.stringify(fake.actions).includes(goal));
  } finally {
    await fake.close();
    await f.close();
  }
});

test("missing decision routing refuses without creating a node job", async () => {
  const f = await fixture(5000);
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: CAPS });
  try {
    await assert.rejects(
      f.controller.call("POST", "/v1/decisions/browser-step", {
        nodeId: "node-1",
        goal: "goal",
        observation: {
          url: "https://www.youtube.com/",
          items: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", label: "A video" }],
          scrollDirections: [],
        },
        position: { stepIndex: 0, maxSteps: 3, alreadySelected: [] },
      }),
    );
    assert.equal(f.jobStore.list().length, 0);
  } finally {
    await f.close();
  }
});

test("a node without browser.control is never offered a click", async () => {
  const provider = scriptedProvider([{ progress: "unsatisfied", step: "item_0" }]);
  const f = await fixture(5000, { decisionRouting: { mode: "execute", provider } });
  const node = await f.pair("node-1");
  await node.call("POST", "/v1/register", { capabilities: ["browser.read"] });
  try {
    await assert.rejects(
      f.controller.call("POST", "/v1/decisions/browser-step", {
        nodeId: "node-1",
        goal: "goal",
        observation: {
          url: "https://www.youtube.com/",
          items: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", label: "A video" }],
          scrollDirections: [],
        },
        position: { stepIndex: 0, maxSteps: 3, alreadySelected: [] },
      }),
    );
    assert.equal(f.jobStore.list().length, 0);
  } finally {
    await f.close();
  }
});

test("parsePursueCommand requires an explicit bounded step count and content disclosure", () => {
  assert.throws(() => parsePursueCommand(["--node", "abc", "--allow-page-content", "goal"]));
  assert.throws(() =>
    parsePursueCommand(["--node", "abc", "--max-steps", "0", "--allow-page-content", "goal"]),
  );
  assert.throws(() =>
    parsePursueCommand(["--node", "abc", "--max-steps", "9", "--allow-page-content", "goal"]),
  );
  assert.throws(() => parsePursueCommand(["--node", "abc", "--max-steps", "3", "goal"]));
  assert.throws(() =>
    parsePursueCommand(["--node", "abc", "--max-steps", "3", "--allow-page-content"]),
  );
  assert.throws(() =>
    parsePursueCommand([
      "--node",
      "abc",
      "--max-steps",
      "3",
      "--allow-page-content",
      "x".repeat(301),
    ]),
  );
  const parsed = parsePursueCommand([
    "--node",
    "abc",
    "--max-steps",
    "8",
    "--allow-page-content",
    "play",
    "some",
    "music",
  ]);
  assert.deepEqual(parsed, { nodeId: "abc", goal: "play some music", maxSteps: 8 });
});
