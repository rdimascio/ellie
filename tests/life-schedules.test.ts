import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import {
  ScheduledDeliveries,
  ScheduledDeliveryError,
} from "../packages/life-harness/src/schedules.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import type { OwnerScope, TaskRecord } from "../packages/task-runtime/src/index.ts";

test("scheduled deliveries require exact scoped record and task bindings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-schedules-"));
  await chmod(directory, 0o700);
  const store = new LifeStore(join(directory, "life.sqlite"), { now: 1_000 }),
    tasks = new TaskRuntime({ directory: join(directory, "tasks"), now: () => 1_000 }),
    actor = { userId: "alice" },
    group = store.createGroup(actor, { id: "home", name: "Home" });
  store.setGroupMember(actor, group.id, { userId: "bob", role: "member" });
  try {
    tasks.registerHandler({ name: "reminder.notify", run: async () => undefined });
    const draft = store.createRecord(actor, {
        kind: "reminder",
        title: "Take bins out",
        scope: { type: "group", id: group.id },
        data: { dueAt: 10_000, completed: false },
      }),
      task = tasks.schedule({
        owner: "group:home",
        handler: "reminder.notify",
        input: { recordId: draft.id, scope: draft.scope },
        schedule: { kind: "once", at: 10_000 },
      }),
      reminder = store.updateRecord(actor, draft.id, draft.revision, {
        data: { ...draft.data, taskId: task.id },
      }),
      lookup = new ScheduledDeliveries(store, tasks);
    assert.deepEqual(lookup.statusFor(reminder), {
      taskId: task.id,
      status: "scheduled",
      scheduleStatus: "scheduled",
      actions: ["pause", "cancel", "run"],
    });
    assert.equal(
      lookup.find({ userId: "bob" }, reminder.scope, "take bins OUT").record.id,
      reminder.id,
    );
    await lookup.control(actor, { scope: reminder.scope, idOrTitle: reminder.id, action: "pause" });
    assert.equal(lookup.find(actor, reminder.scope, reminder.id).status, "paused");

    const wrong = store.createRecord(actor, {
      kind: "timer",
      title: "Wrong binding",
      scope: reminder.scope,
      data: { taskId: task.id },
    });
    assert.throws(
      () => lookup.find(actor, reminder.scope, wrong.id),
      (error: unknown) =>
        error instanceof ScheduledDeliveryError && error.code === "invalid_binding",
    );
    assert.throws(
      () => lookup.find({ userId: "mallory" }, reminder.scope, reminder.id),
      /not a member/,
    );

    const guide = store.createRecord(actor, {
      kind: "routine",
      title: "Draft improvement",
      scope: { type: "user", id: "alice" },
      data: {
        type: "learning-improvement-v1",
        status: "ready",
        taskId: task.id,
      },
    });
    assert.throws(
      () => lookup.find(actor, guide.scope, guide.id),
      (error: unknown) =>
        error instanceof ScheduledDeliveryError && error.code === "invalid_binding",
    );
  } finally {
    await tasks.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal templates derive delivery only from the current occurrence result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-schedule-status-"));
  await chmod(directory, 0o700);
  const store = new LifeStore(join(directory, "life.sqlite"), { now: 1_000 }),
    actor = { userId: "alice" },
    record = store.createRecord(actor, {
      kind: "reminder",
      title: "Status reminder",
      scope: { type: "user", id: "alice" },
      data: { taskId: "template", completed: false },
    });
  const task = (
    id: string,
    state: TaskRecord["state"],
    extra: Partial<TaskRecord> = {},
  ): TaskRecord => ({
    id,
    owner: "user:alice",
    handler: "reminder.notify",
    input: { recordId: record.id, scope: record.scope },
    state,
    requiredCapabilities: [],
    allowedCapabilities: [],
    rootId: "template",
    dependsOn: [],
    budget: {},
    attempt: 0,
    idempotencyKey: id,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });
  const template = task("template", "succeeded", {
      schedule: { kind: "once", at: 1_000 },
      outcomeCode: "schedule_complete",
      outcomeVerified: true,
    }),
    active = task("active", "running", { parentId: "template", createdAt: 2 }),
    skipped = task("skipped", "succeeded", {
      parentId: "template",
      createdAt: 3,
      outcomeVerified: true,
      outcomeCode: "outcome_verified",
      result: { status: "skipped" },
    });
  let occurrences: { active?: TaskRecord; latest?: TaskRecord } = { latest: skipped };
  const runtime = {
    get: (id: string, requestedOwner?: OwnerScope) =>
      id === template.id && (!requestedOwner || requestedOwner === template.owner)
        ? template
        : undefined,
    deliveryOccurrences: () => occurrences,
    pause: () => false,
    resume: () => false,
    cancel: () => false,
    runNow: async () => {},
  } as unknown as TaskRuntime;
  try {
    const deliveries = new ScheduledDeliveries(store, runtime);
    assert.deepEqual(deliveries.statusFor(record), {
      taskId: "template",
      status: "skipped",
      scheduleStatus: "complete",
      occurrence: {
        taskId: "skipped",
        state: "succeeded",
        status: "skipped",
        outcomeCode: "outcome_verified",
        outcomeVerified: true,
      },
      actions: [],
    });
    skipped.state = "cancelled";
    delete skipped.result;
    assert.equal(deliveries.statusFor(record).status, "cancelled");
    occurrences = { active, latest: skipped };
    const terminalWithActive = deliveries.statusFor(record);
    assert.equal(terminalWithActive.status, "running");
    assert.equal(terminalWithActive.occurrence?.taskId, "active");
    assert.deepEqual(terminalWithActive.actions, ["cancel"]);
    template.state = "scheduled";
    const recurring = deliveries.statusFor(record);
    assert.equal(recurring.status, "scheduled");
    assert.equal(recurring.scheduleStatus, "scheduled");
    assert.equal(recurring.occurrence?.taskId, "active");
    assert.equal(recurring.occurrence?.status, "running");
    template.state = "cancelled";
    occurrences = {};
    assert.equal(deliveries.statusFor(record).status, "cancelled");
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
