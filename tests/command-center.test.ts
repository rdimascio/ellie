import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, JOB_STATES, action } from "@ellie/protocol";
import {
  DEMO_ACTIONS,
  SCENARIOS,
  STATUS_COPY,
  canSubmit,
  reduceDemo,
  scenarioState,
} from "../apps/command-center/src/model.ts";

test("synthetic controls follow every registered operation and all job states have honest labels", () => {
  assert.deepEqual(
    DEMO_ACTIONS.map((command) => action(command.action).tool).sort(),
    [...CAPABILITIES].sort(),
  );
  assert.deepEqual(Object.keys(STATUS_COPY).sort(), [...JOB_STATES].sort());
  assert.match(STATUS_COPY.unknown.detail, /may have happened.*will not repeat/);
  assert.match(STATUS_COPY.cancelled.detail, /does not undo/);
});

test("unavailable and unsupported demo actions cannot queue work", () => {
  for (const scenario of ["offline", "loading", "empty"] as const) {
    const state = scenarioState(scenario);
    assert.equal(canSubmit(state, "app.open"), false);
    assert.equal(reduceDemo(state, { type: "submit", index: 0 }), state);
  }
  const study = reduceDemo(scenarioState("ready"), { type: "select", id: "demo-study" });
  assert.equal(canSubmit(study, "app.open"), true);
  assert.equal(reduceDemo(study, { type: "submit", index: 2 }), study);
});

test("queued demo cancellation wins a late completion and scenario changes invalidate old callbacks", () => {
  const queued = reduceDemo(scenarioState("ready"), { type: "submit", index: 0 });
  const id = queued.jobs[0]!.id;
  assert.equal(queued.jobs[0]?.state, "queued");
  assert.equal(reduceDemo(queued, { type: "submit", index: 0 }), queued);
  const cancelled = reduceDemo(queued, { type: "cancel", id });
  assert.equal(cancelled.jobs[0]?.state, "cancelled");
  assert.equal(reduceDemo(cancelled, { type: "complete", id, illustration: "app" }), cancelled);
  const reset = reduceDemo(queued, { type: "scenario", scenario: "unknown" });
  assert.equal(reduceDemo(reset, { type: "complete", id, illustration: "app" }), reset);
  assert.equal(reset.jobs[0]?.state, "unknown");
  for (const scenario of Object.keys(SCENARIOS))
    assert.ok(scenarioState(scenario as keyof typeof SCENARIOS));
});

test("cancelling delivered or running work waits for confirmation and blocks another request", () => {
  for (const pendingState of ["delivered", "running"] as const) {
    const state = scenarioState("running");
    state.jobs[0]!.state = pendingState;
    const requested = reduceDemo(state, { type: "cancel", id: state.jobs[0]!.id });
    assert.equal(requested.jobs[0]?.state, "cancellation_requested");
    assert.equal(canSubmit(requested, "app.open"), false);
    assert.equal(reduceDemo(requested, { type: "cancel", id: state.jobs[0]!.id }), requested);
  }
});

test("a switched target cannot relabel an outstanding request or apply another Mac's illustration", () => {
  const queued = reduceDemo(scenarioState("ready"), { type: "submit", index: 2 });
  const switched = reduceDemo(queued, { type: "select", id: "demo-study" });
  const completed = reduceDemo(switched, {
    type: "complete",
    id: queued.jobs[0]!.id,
    illustration: "left",
  });
  assert.equal(completed.jobs[0]?.target, "Living room Mac");
  assert.equal(completed.jobs[0]?.state, "completed");
  assert.equal(completed.illustration, "welcome");
});
