import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeAccessError, LifeConflictError, LifeStore } from "../packages/life-core/src/index.ts";
import { LifePlanError, LifePlans, planDetails } from "../packages/life-plans/src/index.ts";

test("plans persist as scoped atomic checklists and filter before list bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-plans-"));
  await chmod(directory, 0o700);
  const path = join(directory, "life.sqlite"),
    alice = { userId: "alice" },
    bob = { userId: "bob" };
  let store = new LifeStore(path, { now: 1_000 }),
    plans = new LifePlans(store);
  try {
    const created = plans.create(alice, {
      scope: { type: "user", id: "alice" },
      title: "Launch trip",
      steps: ["Book train", "Pack bag"],
    });
    for (let index = 0; index < 501; index++)
      store.createRecord(alice, {
        kind: "goal",
        title: `Ordinary goal ${index}`,
        scope: { type: "user", id: "alice" },
        data: { completed: false },
      });
    assert.equal(
      plans.list(alice, { scope: created.record.scope }).plans[0]?.record.id,
      created.record.id,
    );
    assert.equal(
      plans.find(alice, created.record.scope, "launch TRIP").record.id,
      created.record.id,
    );
    assert.throws(() => plans.get(bob, created.record.id), LifeAccessError);
    const first = plans.setStep(alice, {
      id: created.record.id,
      stepId: created.steps[0]!.id,
      completed: true,
      expectedRevision: 1,
    });
    assert.equal(first.completedSteps, 1);
    assert.equal(first.completed, false);
    assert.throws(
      () =>
        plans.setStep(alice, {
          id: created.record.id,
          stepId: created.steps[1]!.id,
          completed: true,
          expectedRevision: 1,
        }),
      LifeConflictError,
    );
    const done = plans.setStep(alice, {
      id: created.record.id,
      stepId: created.steps[1]!.id,
      completed: true,
      expectedRevision: 2,
    });
    assert.equal(done.completed, true);
    assert.equal(done.record.data.completed, true);
    store.close();
    store = new LifeStore(path, { now: 2_000 });
    plans = new LifePlans(store);
    assert.equal(plans.get(alice, created.record.id).completedSteps, 2);
    assert.throws(
      () => planDetails({ ...done.record, data: { ...done.record.data, completed: false } }),
      (error: unknown) => error instanceof LifePlanError && error.code === "invalid_plan",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan limits and malformed steps are rejected before persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-plan-limits-"));
  await chmod(directory, 0o700);
  const store = new LifeStore(join(directory, "life.sqlite")),
    plans = new LifePlans(store),
    actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    assert.throws(() => plans.create(actor, { scope, title: "Empty", steps: [] }), /one through/);
    for (let index = 0; index < 64; index++)
      plans.create(actor, { scope, title: `Plan ${index}`, steps: ["One"] });
    assert.throws(
      () => plans.create(actor, { scope, title: "Too many", steps: ["One"] }),
      (error: unknown) => error instanceof LifePlanError && error.code === "capacity",
    );
    assert.equal(store.listPlanRecords(actor, { scope, limit: 65 }).length, 64);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
