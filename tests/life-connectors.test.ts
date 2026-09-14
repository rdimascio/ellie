import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ConnectorBroker, type CredentialVault } from "../packages/life-connectors/src/broker.ts";
import { ConnectorStore } from "../packages/life-connectors/src/store.ts";
import type {
  LifeProviderAdapter,
  ProviderCredential,
  ProviderObservation,
  ProviderPullInput,
} from "../packages/life-connectors/src/provider-types.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

const event = (revision: string, title = "Appointment"): ProviderObservation => ({
  sourceKey: "event-1",
  sourceRevision: revision,
  observedAt: 1,
  title,
  kind: "event",
  data: { startAt: 1_800_000_000_000, status: "confirmed" },
});

test("connector pages advance stable cursors atomically and stay actor-private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-connectors-test-")),
    store = new ConnectorStore(join(directory, "connectors.sqlite"));
  try {
    const created = store.create("actor-a", "google-calendar", "prepare");
    assert.equal(store.get("actor-b", created.id), undefined);
    assert.deepEqual(store.list("actor-b"), []);
    const connected = store.update(
      "actor-a",
      created.id,
      created.generation,
      {
        state: "connected",
        accountId: "account-a",
        label: "Calendar",
        grantedScopes: ["calendar.readonly"],
      },
      true,
    );
    store.ingest(
      "actor-a",
      created.id,
      connected.generation,
      {
        accountId: "account-a",
        items: [event("revision-1")],
        continuation: "page-2",
        complete: false,
      },
      10,
    );
    const partial = store.get("actor-a", created.id)!;
    assert.equal(partial.cursor, undefined);
    assert.equal(partial.continuation, "page-2");
    assert.equal(partial.lastSyncAt, undefined);
    assert.equal(
      store.evidenceCurrent("actor-a", [
        {
          connectionId: created.id,
          sourceKey: "event-1",
          sourceRevision: "revision-1",
        },
      ]),
      true,
    );

    assert.throws(() =>
      store.ingest(
        "actor-a",
        created.id,
        connected.generation,
        {
          accountId: "account-a",
          items: [event("must-not-commit")],
          complete: true,
        },
        11,
      ),
    );
    assert.equal(store.observations("actor-a", created.id)[0]?.sourceRevision, "revision-1");
    assert.equal(store.get("actor-a", created.id)?.continuation, "page-2");

    store.ingest(
      "actor-a",
      created.id,
      connected.generation,
      {
        accountId: "account-a",
        items: [event("revision-2", "Changed appointment")],
        cursor: "sync-2",
        complete: true,
      },
      12,
    );
    const complete = store.get("actor-a", created.id)!;
    assert.equal(complete.cursor, "sync-2");
    assert.equal(complete.continuation, undefined);
    assert.equal(complete.lastSyncAt, 12);
    assert.equal(store.observations("actor-a", created.id)[0]?.sourceRevision, "revision-2");

    assert.throws(() =>
      store.ingest(
        "actor-b",
        created.id,
        connected.generation,
        {
          accountId: "account-a",
          items: [],
          cursor: "stolen",
          complete: true,
        },
        13,
      ),
    );
    assert.equal(store.get("actor-a", created.id)?.cursor, "sync-2");

    store.ingest(
      "actor-a",
      created.id,
      connected.generation,
      {
        accountId: "account-a",
        items: [
          {
            sourceKey: "event-1",
            sourceRevision: "revision-deleted",
            observedAt: 14,
            title: "Deleted event",
            deleted: true,
            kind: "deleted",
            data: { previousKind: "event" },
          },
        ],
        cursor: "sync-3",
        complete: true,
      },
      14,
    );
    assert.equal(store.observations("actor-a", created.id)[0]?.kind, "deleted");
    assert.equal(
      store.evidenceCurrent("actor-a", [
        {
          connectionId: created.id,
          sourceKey: "event-1",
          sourceRevision: "revision-2",
        },
      ]),
      false,
    );

    store.revoke("actor-a", created.id);
    assert.equal(store.get("actor-a", created.id)?.state, "revoked");
    assert.equal(
      store.evidenceCurrent("actor-a", [
        {
          connectionId: created.id,
          sourceKey: "event-1",
          sourceRevision: "revision-2",
        },
      ]),
      false,
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

class MemoryVault implements CredentialVault {
  readonly values = new Map<string, Record<string, unknown>>();
  put(id: string, value: Record<string, unknown>) {
    this.values.set(id, structuredClone(value));
  }
  get<T>(id: string): T | undefined {
    const value = this.values.get(id);
    return value ? (structuredClone(value) as T) : undefined;
  }
  delete(id: string) {
    this.values.delete(id);
  }
}

class CalendarFixture implements LifeProviderAdapter {
  readonly id = "google-calendar" as const;
  observations: ProviderObservation[];
  pulls = 0;
  gate?: Promise<void>;
  constructor(observations: ProviderObservation[]) {
    this.observations = observations;
  }
  async identity(_credential: ProviderCredential, _signal: AbortSignal) {
    return { accountId: "calendar-account", label: "Fixture calendar" };
  }
  async pull(_input: ProviderPullInput) {
    this.pulls++;
    await this.gate;
    return {
      accountId: "calendar-account",
      items: structuredClone(this.observations),
      cursor: `cursor-${this.pulls}`,
      complete: true as const,
    };
  }
}

async function until(check: () => boolean, tick: () => Promise<void>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await tick();
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.fail("Connected workflow did not settle.");
}

test("broker sync publishes private preparation once and preserves user corrections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-broker-test-"));
  let now = Date.UTC(2026, 8, 14, 12);
  const life = new LifeStore(join(directory, "life.sqlite"), { now: () => now }),
    store = new ConnectorStore(join(directory, "connectors.sqlite")),
    tasks = new TaskRuntime({
      directory: join(directory, "tasks"),
      now: () => now,
      capabilityResolver: () => [
        "life.connections.read",
        "life.connections.write",
        "life.records.read",
        "life.records.write",
      ],
      tickMs: 25,
    }),
    DAY = 86_400_000,
    appointment = (sourceKey: string, title: string, startAt: number): ProviderObservation => ({
      sourceKey,
      sourceRevision: `stable-${sourceKey}`,
      observedAt: now - 1,
      title,
      kind: "event",
      data: {
        startAt,
        endAt: startAt + 30 * 60_000,
        timeZone: "UTC",
        status: "confirmed",
        organizerIsSelf: true,
      },
    }),
    provider = new CalendarFixture([
      appointment("morning-1", "Dental appointment", now - 40 * DAY - 3 * 60 * 60_000),
      appointment("morning-2", "Clinic appointment", now - 20 * DAY - 3 * 60 * 60_000),
      appointment("morning-3", "Project appointment", now - 5 * DAY - 3 * 60 * 60_000),
      appointment("doctor", "Doctor visit", now + 5 * DAY),
    ]),
    broker = new ConnectorBroker({
      store,
      life,
      vault: new MemoryVault(),
      providers: [provider],
      tasks,
      now: () => now,
    }),
    actor = { userId: "actor-a" },
    scope = { type: "user", id: "actor-a" } as const;
  try {
    tasks.start();
    const connection = await broker.connect(
      actor.userId,
      "google-calendar",
      { accessToken: "synthetic-only" },
      "prepare",
      ["calendar.readonly"],
    );
    await until(
      () =>
        life
          .listRecords(actor, { scope, kinds: ["goal"] })
          .some((record) => record.title === "Prepare for Doctor visit"),
      () => tasks.tick(),
    );
    const inferred = life
        .listRecords(actor, { scope, kinds: ["memory"] })
        .find((record) => /morning appointments may be preferred/i.test(record.title)),
      plan = life
        .listRecords(actor, { scope, kinds: ["goal"] })
        .find((record) => record.title === "Prepare for Doctor visit");
    assert.ok(inferred);
    assert.ok(plan);
    assert.equal(plan.data.type, "life-plan-v1");
    const firstPlanRevision = plan.revision,
      firstReminder = store
        .derived(actor.userId, connection.id)
        .find((mapping) => mapping.key.startsWith("reminder:") && mapping.taskId);
    assert.ok(firstReminder);

    now += 61_000;
    await broker.refresh(actor.userId, connection.id);
    await until(
      () => provider.pulls >= 2,
      () => tasks.tick(),
    );
    await until(
      () =>
        tasks
          .list({ owner: `user:${actor.userId}` })
          .filter((task) => task.handler === "life.connected.publish")
          .every((task) => task.state === "succeeded"),
      () => tasks.tick(),
    );
    assert.equal(life.getRecord(actor, plan.id)?.revision, firstPlanRevision);

    const pullsBeforeObserve = provider.pulls;
    await broker.setMode(actor.userId, connection.id, "observe");
    const planCount = life.listRecords(actor, { scope, kinds: ["goal"] }).length;
    now += 61_000;
    await broker.refresh(actor.userId, connection.id);
    await until(
      () => provider.pulls > pullsBeforeObserve,
      () => tasks.tick(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(life.listRecords(actor, { scope, kinds: ["goal"] }).length, planCount);
    assert.equal(tasks.get(firstReminder.taskId!, `user:${actor.userId}`)?.state, "cancelled");
    assert.equal(life.getRecord(actor, firstReminder.recordId), undefined);

    await broker.setMode(actor.userId, connection.id, "prepare");
    now += 61_000;
    await broker.refresh(actor.userId, connection.id);
    await until(
      () =>
        store
          .derived(actor.userId, connection.id)
          .some((mapping) => mapping.key === firstReminder.key && Boolean(mapping.taskId)),
      () => tasks.tick(),
    );
    const restoredReminder = store
      .derived(actor.userId, connection.id)
      .find((mapping) => mapping.key === firstReminder.key && mapping.taskId);
    assert.ok(restoredReminder);
    assert.notEqual(restoredReminder.taskId, firstReminder.taskId);
    assert.notEqual(restoredReminder.recordId, firstReminder.recordId);

    const currentPlan = life.getRecord(actor, plan.id)!;
    const edited = life.updateRecord(actor, plan.id, currentPlan.revision, {
      body: "Keep my handwritten preparation notes.",
    });
    now += 61_000;
    const pullsBeforeEdit = provider.pulls;
    await broker.refresh(actor.userId, connection.id);
    await until(
      () => provider.pulls > pullsBeforeEdit,
      () => tasks.tick(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(life.getRecord(actor, plan.id)?.body, "Keep my handwritten preparation notes.");
    assert.equal(life.getRecord(actor, plan.id)?.revision, edited.revision);

    let releaseGate!: () => void;
    provider.gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    provider.observations = [
      {
        sourceKey: "doctor",
        sourceRevision: "doctor-deleted",
        observedAt: now + 1,
        title: "Deleted calendar event",
        deleted: true,
        kind: "deleted",
        data: { previousKind: "event" },
      },
    ];
    const lateSync = broker.sync(actor.userId, connection.id);
    void lateSync.catch(() => {});
    await until(
      () => provider.pulls > pullsBeforeEdit + 1,
      async () => {},
    );
    const revoking = broker.revoke(actor.userId, connection.id);
    releaseGate();
    await revoking;
    await assert.rejects(lateSync);
    assert.equal(store.get(actor.userId, connection.id)?.state, "revoked");
    const revokedInsight = life.getRecord(actor, inferred.id);
    assert.ok(
      !revokedInsight ||
        !revokedInsight.provenance.some((item) => item.invalidatedAt === undefined),
    );
    assert.equal(life.getRecord(actor, plan.id)?.body, "Keep my handwritten preparation notes.");
  } finally {
    await broker.close();
    await tasks.close();
    store.close();
    life.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("broker restart resumes durable sync without duplicating a preparation plan", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-broker-restart-")),
    lifePath = join(directory, "life.sqlite"),
    connectorPath = join(directory, "connectors.sqlite"),
    taskPath = join(directory, "tasks"),
    vault = new MemoryVault();
  let now = Date.UTC(2026, 8, 14, 12),
    provider = new CalendarFixture([
      {
        sourceKey: "doctor",
        sourceRevision: "doctor-v1",
        observedAt: now - 1,
        title: "Doctor visit",
        kind: "event",
        data: {
          startAt: now + 5 * 86_400_000,
          status: "confirmed",
          organizerIsSelf: true,
          timeZone: "UTC",
        },
      },
    ]),
    life = new LifeStore(lifePath, { now: () => now }),
    store = new ConnectorStore(connectorPath),
    tasks = new TaskRuntime({
      directory: taskPath,
      now: () => now,
      tickMs: 25,
      capabilityResolver: () => [
        "life.connections.read",
        "life.connections.write",
        "life.records.read",
        "life.records.write",
      ],
    }),
    broker = new ConnectorBroker({
      store,
      life,
      vault,
      providers: [provider],
      tasks,
      now: () => now,
    });
  const actor = { userId: "restart-actor" },
    scope = { type: "user", id: actor.userId } as const;
  try {
    tasks.start();
    const connection = await broker.connect(
      actor.userId,
      "google-calendar",
      { accessToken: "synthetic" },
      "prepare",
    );
    await until(
      () => life.listRecords(actor, { scope, kinds: ["goal"] }).length === 1,
      () => tasks.tick(),
    );
    await broker.close();
    await tasks.close();
    store.close();
    life.close();

    now += 61_000;
    life = new LifeStore(lifePath, { now: () => now });
    store = new ConnectorStore(connectorPath);
    tasks = new TaskRuntime({
      directory: taskPath,
      now: () => now,
      tickMs: 25,
      capabilityResolver: () => [
        "life.connections.read",
        "life.connections.write",
        "life.records.read",
        "life.records.write",
      ],
    });
    broker = new ConnectorBroker({
      store,
      life,
      vault,
      providers: [provider],
      tasks,
      now: () => now,
    });
    tasks.start();
    await broker.resume(actor.userId);
    await broker.refresh(actor.userId, connection.id);
    await until(
      () => provider.pulls >= 2,
      () => tasks.tick(),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(life.listRecords(actor, { scope, kinds: ["goal"] }).length, 1);
  } finally {
    await broker.close();
    await tasks.close();
    store.close();
    life.close();
    await rm(directory, { recursive: true, force: true });
  }
});
