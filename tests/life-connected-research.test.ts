import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import {
  createConnectedResearch,
  type ConnectedResearchSnapshot,
} from "../packages/life-connectors/src/research.ts";
import type {
  LifeAnticipationResult,
  ConnectorObservation,
} from "../packages/life-anticipation/src/index.ts";

const NOW = Date.UTC(2026, 8, 14, 12),
  DAY = 86_400_000;
const CAPABILITIES = ["life.connections.read", "life.connections.write"];
const owner = "user:alice" as const;

function observations(connectionId = "account-a"): ConnectorObservation[] {
  return [
    {
      connectionId,
      sourceKey: "visit",
      sourceRevision: "r1",
      observedAt: NOW - 1,
      title: "Dentist appointment",
      kind: "event",
      data: { startAt: NOW + DAY, status: "confirmed", organizerIsSelf: true },
    },
    ...[21, 14, 7].map((days, index): ConnectorObservation => ({
      connectionId,
      sourceKey: `message-${index}`,
      sourceRevision: "r1",
      observedAt: NOW - 1,
      title: "Message",
      kind: "message",
      data: {
        sentAt: NOW - days * DAY,
        from: "me@example.test",
        to: ["friend@example.test"],
        subject: "Hello",
        direction: "outgoing",
      },
    })),
    ...[90, 60, 30].map((days, index): ConnectorObservation => ({
      connectionId,
      sourceKey: `payment-${index}`,
      sourceRevision: "r1",
      observedAt: NOW - 1,
      title: "Payment",
      kind: "transaction",
      data: {
        postedAt: NOW - days * DAY,
        amountDecimal: "12.34",
        currency: "USD",
        merchant: "StreamCo",
        pending: false,
      },
    })),
  ];
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ellie-connected-research-"));
  let clock = NOW,
    capabilities = CAPABILITIES;
  let state: ConnectedResearchSnapshot = {
    generation: 1,
    contextRevision: "context-1",
    observations: observations(),
    explicitSettings: {},
    timeZone: "UTC",
    mode: "prepare",
  };
  const calls: {
    actorId: string;
    connectionId: string;
    generation: number;
    result: LifeAnticipationResult;
  }[] = [];
  let syncCount = 0;
  let sync: (signal: AbortSignal) => Promise<void> = async () => {};
  let accepted = true;
  const makeRuntime = () =>
    new TaskRuntime({
      directory,
      now: () => clock,
      capabilityResolver: () => capabilities,
      concurrency: 4,
    });
  let tasks = makeRuntime();
  const makeResearch = () =>
    createConnectedResearch({
      tasks,
      now: () => clock,
      snapshot: (actorId, connectionId) =>
        actorId === "alice" && connectionId === "account-a"
          ? state
          : { ...state, mode: "revoked", observations: [] },
      sync: async (_actor, _connection, signal) => {
        syncCount++;
        await sync(signal);
      },
      publish: (actorId, connectionId, generation, result, signal, contextRevision) => {
        assert.equal(signal.aborted, false);
        if (
          !accepted ||
          generation !== state.generation ||
          contextRevision !== state.contextRevision ||
          state.mode === "revoked"
        )
          return false;
        calls.push({ actorId, connectionId, generation, result });
        return true;
      },
    });
  let research = makeResearch();
  return {
    directory,
    calls,
    get tasks() {
      return tasks;
    },
    get research() {
      return research;
    },
    get syncCount() {
      return syncCount;
    },
    setState: (patch: Partial<ConnectedResearchSnapshot>) => {
      state = { ...state, ...patch };
    },
    setClock: (value: number) => {
      clock = value;
    },
    setCapabilities: (value: string[]) => {
      capabilities = value;
    },
    setSync: (value: typeof sync) => {
      sync = value;
    },
    rejectPublication: () => {
      accepted = false;
    },
    async restart(markRunning?: string) {
      await research.close();
      await tasks.close();
      if (markRunning) {
        const db = new DatabaseSync(join(directory, "task-runtime.sqlite"));
        db.prepare("UPDATE tasks SET state='running',attempt=1 WHERE id=?").run(markRunning);
        db.close();
      }
      tasks = makeRuntime();
      research = makeResearch();
    },
    async drain() {
      for (let index = 0; index < 8; index++) await tasks.tick();
    },
    async close() {
      await research.close();
      await tasks.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("account connection schedules bounded durable research and publishes all personas together", async () => {
  const f = await fixture();
  try {
    const first = await f.research.connectionAdded("alice", "account-a");
    assert.equal((await f.research.connectionAdded("alice", "account-a")).id, first.id);
    assert.equal(f.tasks.list({ owner }).length, 3);
    await f.drain();
    assert.equal(f.syncCount, 1);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      new Set(f.calls[0]!.result.proposals.map((p) => p.kind)),
      new Set(["prepare_event", "follow_up", "review_recurring_expense"]),
    );
    const tree = f.tasks.list({ owner });
    assert.equal(tree.length, 7);
    assert.equal(tree.filter((t) => t.handler === "life.connected.specialist").length, 3);
    assert.equal(tree.filter((t) => t.handler === "life.connected.publish").length, 1);
    assert.ok(tree.every((t) => !JSON.stringify(t.input).includes("Dentist")));
    const scheduled = tree.filter((t) => t.state === "scheduled");
    assert.equal(scheduled.length, 2);
    assert.ok(
      scheduled.every((t) => t.missedRunPolicy?.kind === "latest" && t.deadlineAt === undefined),
    );
    assert.ok(
      tree
        .filter((t) => t.parentId === first.id)
        .every((t) => t.budget.maxTasks === 9 && t.budget.maxConcurrency === 2),
    );
  } finally {
    await f.close();
  }
});

test("scheduled research survives restart and skipped hours coalesce to one current sync", async () => {
  const f = await fixture();
  try {
    const first = await f.research.connectionAdded("alice", "account-a");
    await f.drain();
    await f.restart();
    assert.equal((await f.research.connectionAdded("alice", "account-a")).id, first.id);
    f.setClock(NOW + 5 * 3_600_000);
    await f.drain();
    assert.equal(f.syncCount, 2);
    assert.equal(f.calls.length, 2);
    const occurrences = f.tasks
      .list({ owner })
      .filter(
        (t) => t.handler === "life.connected.sync" && t.parentId !== undefined && !t.schedule,
      );
    assert.equal(occurrences.length, 1);
  } finally {
    await f.close();
  }
});

test("interrupted initial sync resumes without duplicating previously enqueued children", async () => {
  const f = await fixture();
  try {
    const first = await f.research.connectionAdded("alice", "account-a");
    await f.tasks.tick();
    assert.equal(f.tasks.list({ owner, parentId: first.id }).length, 4);
    await f.restart(first.id);
    await f.tasks.tick();
    f.setClock(NOW + 1_000);
    await f.drain();
    assert.equal(f.tasks.get(first.id, owner)?.state, "succeeded");
    assert.equal(f.tasks.list({ owner, parentId: first.id }).length, 4);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("refresh coalesces within a minute and cancellation traverses scheduled descendants", async () => {
  const f = await fixture();
  try {
    await f.research.connectionAdded("alice", "account-a");
    await f.drain();
    const first = await f.research.refresh("alice", "account-a");
    assert.equal((await f.research.refresh("alice", "account-a")).id, first.id);
    await f.tasks.tick();
    f.research.revoke("alice", "account-a");
    assert.equal(f.tasks.get(first.id, owner)?.state, "succeeded");
    assert.ok(f.tasks.list({ owner, parentId: first.id }).every((t) => t.state === "cancelled"));
    await f.drain();
    assert.equal(f.calls.length, 1);
    await assert.rejects(
      () => f.research.connectionAdded("alice", "account-a"),
      /newly linked connection/,
    );
  } finally {
    await f.close();
  }
});

test("resumed sync replaces an interrupted stale batch within its retry budget", async () => {
  const f = await fixture();
  try {
    const initial = await f.research.connectionAdded("alice", "account-a");
    await f.tasks.tick();
    f.setState({ contextRevision: "context-2" });
    await f.restart(initial.id);
    await f.tasks.tick();
    f.setClock(NOW + 1_000);
    await f.drain();
    assert.equal(f.tasks.get(initial.id, owner)?.state, "succeeded");
    assert.equal(f.tasks.list({ owner, parentId: initial.id }).length, 8);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.result.proposals.length, 3);
  } finally {
    await f.close();
  }
});

test("permission or context changes bypass refresh dedupe within the same minute", async () => {
  const f = await fixture();
  try {
    await f.research.connectionAdded("alice", "account-a");
    await f.drain();
    const first = await f.research.refresh("alice", "account-a");
    f.setState({ generation: 2, mode: "observe" });
    const afterGrant = await f.research.refresh("alice", "account-a");
    assert.notEqual(afterGrant.id, first.id);
    f.setState({ contextRevision: "context-2" });
    const afterContext = await f.research.refresh("alice", "account-a");
    assert.notEqual(afterContext.id, afterGrant.id);
    assert.equal((await f.research.refresh("alice", "account-a")).id, afterContext.id);
  } finally {
    await f.close();
  }
});

test("revocation is safe before research exists and after personal task deletion", async () => {
  const f = await fixture();
  try {
    assert.doesNotThrow(() => f.research.revoke("alice", "account-a"));
    await f.research.connectionAdded("alice", "account-a");
    f.tasks.beginPersonalDeletion(owner, "test-reset");
    await f.tasks.drainPersonalDeletion(owner, "test-reset");
    f.tasks.completePersonalDeletion(owner, "test-reset");
    assert.equal(f.tasks.list({ owner }).length, 0);
    assert.doesNotThrow(() => f.research.revoke("alice", "account-a"));
  } finally {
    await f.close();
  }
});

test("revocation aborts active work and blocks late children when a provider ignores abort", async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void, receivedSignal: AbortSignal | undefined;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  f.setSync(async (signal) => {
    receivedSignal = signal;
    started();
    await gate;
  });
  try {
    const root = await f.research.connectionAdded("alice", "account-a"),
      tick = f.tasks.tick();
    await entered;
    f.setState({ mode: "revoked", generation: 2 });
    f.research.revoke("alice", "account-a");
    assert.equal(receivedSignal?.aborted, true);
    release();
    await tick;
    await f.drain();
    assert.equal(f.tasks.get(root.id, owner)?.state, "cancelled");
    assert.equal(f.tasks.list({ owner, parentId: root.id }).length, 0);
    assert.equal(f.calls.length, 0);
  } finally {
    release();
    await f.close();
  }
});

test("generation changes, current source revisions, and publication CAS reject stale results", async () => {
  for (const change of ["generation", "source", "context", "cas"] as const) {
    const f = await fixture();
    try {
      await f.research.connectionAdded("alice", "account-a");
      await f.tasks.tick();
      await f.tasks.tick();
      await f.tasks.tick();
      const publisher = f.tasks
        .list({ owner })
        .find((t) => t.handler === "life.connected.publish")!;
      assert.equal(publisher.state, "queued");
      if (change === "generation") f.setState({ generation: 2 });
      else if (change === "source")
        f.setState({ observations: observations().map((o) => ({ ...o, sourceRevision: "r2" })) });
      else if (change === "context")
        f.setState({
          contextRevision: "context-2",
          explicitSettings: { preferredAppointmentTime: "afternoon" },
        });
      else f.rejectPublication();
      await f.drain();
      if (change === "source") assert.equal(f.calls[0]!.result.proposals.length, 0);
      else assert.equal(f.calls.length, 0);
      assert.equal(f.tasks.get(publisher.id, owner)?.state, "succeeded");
    } finally {
      await f.close();
    }
  }
});

test("research rejects cross-owner accounts and excludes unrelated connection evidence", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.research.connectionAdded("bob", "account-a"), /unavailable/);
    f.setState({ observations: [...observations(), ...observations("account-b")] });
    await f.research.connectionAdded("alice", "account-a");
    await f.drain();
    assert.ok(
      f.calls[0]!.result.proposals.every((p) =>
        p.evidenceRefs.every((r) => r.connectionId === "account-a"),
      ),
    );
    assert.equal(f.tasks.list({ owner: "user:bob" }).length, 0);
  } finally {
    await f.close();
  }
});

test("capability revocation and paused connections prevent provider calls", async () => {
  for (const reason of ["capability", "pause"] as const) {
    const f = await fixture();
    try {
      await f.research.connectionAdded("alice", "account-a");
      if (reason === "capability") f.setCapabilities([]);
      else f.setState({ mode: "paused" });
      await f.drain();
      assert.equal(f.syncCount, 0);
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("close aborts and drains its work without closing the shared task runtime", async () => {
  const f = await fixture();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setSync(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
        started();
      }),
  );
  try {
    await f.research.connectionAdded("alice", "account-a");
    const tick = f.tasks.tick();
    await entered;
    await f.research.close();
    await tick;
    assert.equal(f.calls.length, 0);
    assert.equal(f.tasks.list({ owner }).length, 3);
    await assert.rejects(() => f.research.refresh("alice", "account-a"), /closed/);
  } finally {
    await f.close();
  }
});
