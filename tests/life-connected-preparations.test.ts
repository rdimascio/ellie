import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AnticipatoryProposal } from "../packages/life-anticipation/src/index.ts";
import {
  ConnectedPreparations,
  type ConnectedPreparationMapping,
} from "../packages/life-connectors/src/preparations.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

const actorId = "alice";
const connectionId = "calendar-1";
const evidenceRefs = [{ connectionId, sourceKey: "appointment-1", sourceRevision: "revision-1" }];

async function fixture(start = Date.UTC(2026, 8, 14, 16)) {
  const root = await mkdtemp(join(tmpdir(), "ellie-connected-preparations-"));
  await chmod(root, 0o700);
  const lifeDirectory = join(root, "life"),
    taskDirectory = join(root, "tasks");
  await mkdir(lifeDirectory, { mode: 0o700 });
  await mkdir(taskDirectory, { mode: 0o700 });
  let now = start,
    current = true;
  const life = new LifeStore(join(lifeDirectory, "life.sqlite"), { now: () => now }),
    tasks = new TaskRuntime({
      directory: taskDirectory,
      now: () => now,
      capabilityResolver: () => ["life.records.read", "life.records.write"],
    });
  const source = life.createRecord(
    { userId: actorId },
    {
      id: "connected-source-1",
      kind: "source",
      title: "Connected calendar",
      scope: { type: "user", id: actorId },
      data: { type: "connected-source-v1" },
    },
  );
  const preparations = new ConnectedPreparations({
    life,
    tasks,
    now: () => now,
    isCurrent: (_actor, connection, refs) =>
      current && connection === connectionId && refs[0]?.sourceRevision === "revision-1",
  });
  const proposal = (overrides: Partial<AnticipatoryProposal> = {}): AnticipatoryProposal => ({
    key: "prepare:appointment-1",
    kind: "prepare_event",
    title: "Prepare for doctor appointment",
    reason: "The connected calendar has an upcoming appointment.",
    evidenceRefs,
    confidence: 0.9,
    expiresAt: start + 2 * 60 * 60_000,
    steps: ["Gather forms"],
    suggestedReminderAt: start + 60_000,
    horizon: "day",
    ...overrides,
  });
  return {
    root,
    life,
    tasks,
    source,
    preparations,
    proposal,
    setNow(value: number) {
      now = value;
    },
    setCurrent(value: boolean) {
      current = value;
    },
    async close() {
      await tasks.close();
      life.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function notifications(life: LifeStore) {
  return life
    .listRecords(
      { userId: actorId },
      { scope: { type: "user", id: actorId }, kinds: ["event"], limit: 500 },
    )
    .filter((record) => record.data.type === "notification");
}

test("connected preparation is deterministic across apply/restart and delivers once", async () => {
  const f = await fixture();
  try {
    const first = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id);
    assert.ok(first);
    assert.deepEqual(f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id), first);
    assert.equal(f.life.getRecord({ userId: actorId }, first.recordId)?.data.taskId, first.taskId);

    await f.tasks.close();
    const reopened = new TaskRuntime({
      directory: join(f.root, "tasks"),
      now: () => f.proposal().suggestedReminderAt!,
      capabilityResolver: () => ["life.records.read", "life.records.write"],
    });
    new ConnectedPreparations({
      life: f.life,
      tasks: reopened,
      now: () => f.proposal().suggestedReminderAt!,
      isCurrent: () => true,
    });
    await reopened.tick();
    await reopened.tick();
    assert.equal(notifications(f.life).length, 1);
    assert.equal(
      reopened.deliveryOccurrences(first.taskId, `user:${actorId}`).latest?.result &&
        (
          reopened.deliveryOccurrences(first.taskId, `user:${actorId}`).latest!.result as {
            status: string;
          }
        ).status,
      "delivered",
    );
    await reopened.close();
  } finally {
    f.life.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("revoked or changed evidence and expired proposals never deliver", async () => {
  const f = await fixture();
  try {
    const mapping = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id);
    assert.ok(mapping);
    f.setCurrent(false);
    f.setNow(f.proposal().suggestedReminderAt!);
    await f.tasks.tick();
    assert.equal(notifications(f.life).length, 0);
    const outcome = f.tasks.deliveryOccurrences(mapping.taskId, `user:${actorId}`).latest,
      result = (outcome?.result ?? {}) as { status?: string; reason?: string };
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "connection_or_evidence_changed");

    assert.equal(
      f.preparations.apply(
        actorId,
        connectionId,
        f.proposal({ key: "expired", suggestedReminderAt: f.proposal().expiresAt + 1 }),
        f.source.id,
      ),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("connected notification handler rejects a task from another owner scope", async () => {
  const f = await fixture();
  try {
    const task = f.tasks.enqueue({
      owner: "group:shared",
      handler: "life.connected.notify",
      input: {
        actorId,
        connectionId,
        recordId: "connected-source-1",
        recordRevision: 1,
        templateTaskId: "foreign-task",
        evidenceRefs,
        expiresAt: f.proposal().expiresAt,
      },
      capabilities: ["life.records.read", "life.records.write"],
      allowedCapabilities: ["life.records.read", "life.records.write"],
    });
    await f.tasks.tick();
    assert.deepEqual(f.tasks.get(task.id, "group:shared")?.result, {
      status: "skipped",
      reason: "owner_mismatch",
    });
    assert.equal(notifications(f.life).length, 0);
  } finally {
    await f.close();
  }
});

test("quiet hours and disabled proactive suggestions skip without a later burst", async () => {
  const f = await fixture();
  try {
    f.life.setUserSetting({ userId: actorId }, "timeZone", "America/Los_Angeles");
    f.life.setUserSetting({ userId: actorId }, "quietHours", {
      enabled: true,
      start: 9,
      end: 10,
    });
    const mapping = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id);
    assert.ok(mapping);
    f.setNow(f.proposal().suggestedReminderAt!); // 09:01 in Los Angeles.
    await f.tasks.tick();
    assert.equal(notifications(f.life).length, 0);
    const result = (f.tasks.deliveryOccurrences(mapping.taskId, `user:${actorId}`).latest?.result ??
      {}) as { reason?: string };
    assert.equal(result.reason, "proactivity_or_quiet_hours");
    f.setNow(f.proposal().suggestedReminderAt! + 60 * 60_000);
    await f.tasks.tick();
    assert.equal(notifications(f.life).length, 0);

    const disabled = f.preparations.apply(
      actorId,
      connectionId,
      f.proposal({
        key: "proactivity-disabled",
        suggestedReminderAt: f.proposal().suggestedReminderAt! + 61 * 60_000,
        expiresAt: f.proposal().expiresAt + 61 * 60_000,
      }),
      f.source.id,
    );
    assert.ok(disabled);
    f.life.setUserSetting({ userId: actorId }, "proactiveSuggestions", false);
    f.setNow(f.proposal().suggestedReminderAt! + 61 * 60_000);
    await f.tasks.tick();
    assert.equal(notifications(f.life).length, 0);
    const disabledResult = (f.tasks.deliveryOccurrences(disabled.taskId, `user:${actorId}`).latest
      ?.result ?? {}) as { reason?: string };
    assert.equal(disabledResult.reason, "proactivity_or_quiet_hours");
  } finally {
    await f.close();
  }
});

test("invalidation deletes untouched generated reminders but preserves user edits", async () => {
  const f = await fixture();
  try {
    const untouched = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id);
    assert.ok(untouched);
    f.preparations.invalidate(actorId, untouched);
    assert.equal(f.life.getRecord({ userId: actorId }, untouched.recordId), undefined);
    assert.equal(f.tasks.get(untouched.taskId, `user:${actorId}`)?.state, "cancelled");

    const editedMapping = f.preparations.apply(
      actorId,
      connectionId,
      f.proposal({ key: "second", suggestedReminderAt: f.proposal().suggestedReminderAt! + 1 }),
      f.source.id,
    );
    assert.ok(editedMapping);
    const record = f.life.getRecord({ userId: actorId }, editedMapping.recordId)!;
    f.life.updateRecord({ userId: actorId }, record.id, record.revision, {
      title: "My edited reminder",
    });
    f.preparations.invalidate(actorId, editedMapping);
    const preserved = f.life.getRecord({ userId: actorId }, editedMapping.recordId);
    assert.equal(preserved?.title, "My edited reminder");
    assert.equal(preserved?.data.cancelled, true);
    assert.ok(preserved?.provenance.every((item) => item.invalidatedAt !== undefined));
  } finally {
    await f.close();
  }
});

test("a new authority generation can restore a cancelled preparation without orphaning the old id", async () => {
  const f = await fixture();
  try {
    const first = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id, 4);
    assert.ok(first);
    f.preparations.invalidate(actorId, first);
    assert.equal(f.life.getRecord({ userId: actorId }, first.recordId), undefined);

    const suppressed = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id, 4);
    assert.equal(suppressed, undefined);
    assert.equal(f.life.getRecord({ userId: actorId }, first.recordId), undefined);

    const restored = f.preparations.apply(actorId, connectionId, f.proposal(), f.source.id, 5);
    assert.ok(restored);
    assert.notEqual(restored.taskId, first.taskId);
    assert.notEqual(restored.recordId, first.recordId);
  } finally {
    await f.close();
  }
});

test("a weekly preparation creates a guarded routine schedule", async () => {
  const f = await fixture();
  try {
    const mapping = f.preparations.apply(
      actorId,
      connectionId,
      f.proposal({
        key: "weekly-call",
        suggestedReminderAt: undefined,
        expiresAt: f.proposal().expiresAt + 90 * 86_400_000,
        suggestedSchedule: { kind: "weekly", weekday: 1, time: "09:00", timeZone: "UTC" },
      }),
      f.source.id,
      2,
    );
    assert.ok(mapping);
    const record = f.life.getRecord({ userId: actorId }, mapping.recordId),
      task = f.tasks.get(mapping.taskId, `user:${actorId}`);
    assert.equal(record?.kind, "routine");
    assert.deepEqual(task?.schedule, {
      kind: "weekly",
      weekday: 1,
      time: "09:00",
      timeZone: "UTC",
    });
    assert.equal(task?.handler, "life.connected.notify");
    f.setNow(f.proposal().suggestedReminderAt!);
    const repeated = f.preparations.apply(
      actorId,
      connectionId,
      f.proposal({
        key: "weekly-call",
        suggestedReminderAt: undefined,
        expiresAt: f.proposal().expiresAt + 90 * 86_400_000,
        suggestedSchedule: { kind: "weekly", weekday: 1, time: "09:00", timeZone: "UTC" },
      }),
      f.source.id,
      2,
    );
    assert.equal(repeated?.taskId, mapping.taskId);
    assert.equal(repeated?.expiresAt, mapping.expiresAt);
  } finally {
    await f.close();
  }
});
