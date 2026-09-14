import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { TaskRuntime, nextOccurrence } from "../packages/task-runtime/src/index.ts";

const owner = "user:alice" as const;
const handler = (
  name: string,
  run: (signal: AbortSignal, input: unknown) => Promise<unknown> = async (_signal, input) => input,
) => ({
  name,
  run: ({ signal }: { signal: AbortSignal }, input: unknown) => run(signal, input),
  checkOutcome: () => true,
});

async function fixture(now = 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-runtime-"));
  let clock = now;
  const runtime = new TaskRuntime({
    directory,
    now: () => clock,
    capabilityResolver: () => ["notify"],
    concurrency: 4,
  });
  return {
    directory,
    runtime,
    setNow: (value: number) => {
      clock = value;
    },
    close: async () => {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a queued task survives restart and a running unsafe task becomes unknown", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("safe"));
    const queued = f.runtime.enqueue({
      owner,
      handler: "safe",
      input: { value: 1 },
    });
    const interrupted = f.runtime.enqueue({
      owner,
      handler: "safe",
      input: { value: 2 },
    });
    await f.runtime.close();
    const database = new DatabaseSync(join(f.directory, "task-runtime.sqlite"));
    database.prepare("UPDATE tasks SET state='running' WHERE id=?").run(interrupted.id);
    database.close();
    const reopened = new TaskRuntime({
      directory: f.directory,
      now: () => 2_000,
    });
    reopened.registerHandler(handler("safe"));
    await reopened.tick();
    assert.equal(reopened.get(queued.id, owner)?.state, "succeeded");
    assert.equal(reopened.get(interrupted.id, owner)?.state, "unknown");
    assert.equal(reopened.get(interrupted.id, owner)?.outcomeCode, "side_effect_outcome_unknown");
    await reopened.close();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("atomic workflows persist, wait for children, inherit bounds, and cancel as one tree", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("child"));
    f.runtime.registerHandler(handler("aggregate"));
    assert.throws(
      () =>
        f.runtime.enqueueWorkflow({
          root: { owner, handler: "aggregate" },
          children: [{ handler: "missing" }],
        }),
      /Unknown task handler/,
    );
    assert.deepEqual(f.runtime.list({ owner }), []);
    assert.throws(
      () =>
        f.runtime.enqueueWorkflow({
          root: { owner, handler: "aggregate", id: "cycle-root" },
          children: [{ handler: "child", dependsOn: ["cycle-root"] } as never],
        }),
      /caller-supplied dependencies/,
    );
    assert.equal(f.runtime.get("cycle-root", owner), undefined);

    const deadlineAt = 20_000;
    const cancelled = f.runtime.enqueueWorkflow({
      root: {
        owner,
        handler: "aggregate",
        deadlineAt,
        allowedCapabilities: [],
        budget: { maxTasks: 3, maxConcurrency: 2 },
      },
      children: [{ handler: "child" }, { handler: "child" }],
    });
    assert.deepEqual(
      cancelled.root.dependsOn,
      cancelled.children.map((child) => child.id),
    );
    assert.ok(cancelled.children.every((child) => child.deadlineAt === deadlineAt));
    assert.equal(f.runtime.cancel(cancelled.root.id, owner), true);
    assert.ok(
      cancelled.children.every((child) => f.runtime.get(child.id, owner)?.state === "cancelled"),
    );

    const expiring = f.runtime.enqueueWorkflow({
      root: { owner, handler: "aggregate", deadlineAt: 1_500, allowedCapabilities: [] },
      children: [{ handler: "child" }],
    });
    f.setNow(1_501);
    await f.runtime.tick();
    assert.equal(f.runtime.get(expiring.root.id, owner)?.state, "expired");
    assert.equal(f.runtime.get(expiring.children[0]!.id, owner)?.state, "expired");

    const persisted = f.runtime.enqueueWorkflow({
      root: { owner, handler: "aggregate", allowedCapabilities: [] },
      children: [
        { handler: "child", input: "one" },
        { handler: "child", input: "two" },
      ],
    });
    await f.runtime.close();
    const reopened = new TaskRuntime({ directory: f.directory, now: () => 2_000 });
    reopened.registerHandler(handler("child"));
    reopened.registerHandler(handler("aggregate"));
    await reopened.tick();
    assert.equal(reopened.get(persisted.root.id, owner)?.state, "queued");
    await reopened.tick();
    assert.equal(reopened.get(persisted.root.id, owner)?.state, "succeeded");
    await reopened.close();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("runNow rejects terminal tasks instead of pretending to rerun them", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("once"));
    const task = f.runtime.enqueue({ owner, handler: "once" });
    await f.runtime.tick();
    assert.equal(f.runtime.get(task.id, owner)?.state, "succeeded");
    await assert.rejects(() => f.runtime.runNow(task.id, owner), /terminal state succeeded/);
  } finally {
    await f.close();
  }
});

test("resumable handlers retry after restart only with an explicit retry policy", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler({ ...handler("resume"), resumable: true });
    const task = f.runtime.enqueue({
      owner,
      handler: "resume",
      retry: { maxAttempts: 2 },
    });
    await f.runtime.close();
    const database = new DatabaseSync(join(f.directory, "task-runtime.sqlite"));
    database.prepare("UPDATE tasks SET state='running',attempt=1 WHERE id=?").run(task.id);
    database.close();
    const reopened = new TaskRuntime({
      directory: f.directory,
      now: () => 2_000,
    });
    reopened.registerHandler({ ...handler("resume"), resumable: true });
    await reopened.tick();
    assert.equal(reopened.get(task.id, owner)?.state, "succeeded");
    assert.equal(reopened.get(task.id, owner)?.attempt, 2);
    await reopened.close();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("duplicate scheduler ticks create one occurrence and daily schedules avoid DST duplicates", async () => {
  const f = await fixture(Date.UTC(2026, 10, 1, 8, 29));
  try {
    let runs = 0;
    f.runtime.registerHandler({
      ...handler("remind", async () => ++runs),
      requiredCapabilities: ["notify"],
    });
    const schedule = f.runtime.schedule({
      owner,
      handler: "remind",
      schedule: {
        kind: "daily",
        time: "01:30",
        timeZone: "America/Los_Angeles",
      },
    });
    const first = nextOccurrence(schedule.schedule!, Date.UTC(2026, 10, 1, 7, 0))!;
    assert.equal(first, Date.UTC(2026, 10, 1, 8, 30));
    f.setNow(first);
    await Promise.all([f.runtime.tick(), f.runtime.tick()]);
    assert.equal(runs, 1);
    assert.equal(f.runtime.list({ owner, parentId: schedule.id }).length, 1);
    assert.equal(nextOccurrence(schedule.schedule!, first), Date.UTC(2026, 10, 2, 9, 30));
  } finally {
    await f.close();
  }
});

test("daily schedules preserve minutes across half-hour DST transitions and skip gaps", () => {
  assert.equal(
    nextOccurrence(
      { kind: "daily", time: "02:30", timeZone: "Australia/Lord_Howe" },
      Date.UTC(2026, 9, 3, 0),
    ),
    Date.UTC(2026, 9, 3, 15, 30),
  );
  assert.equal(
    nextOccurrence(
      { kind: "daily", time: "02:15", timeZone: "Australia/Lord_Howe" },
      Date.UTC(2026, 9, 3, 0),
    ),
    Date.UTC(2026, 9, 4, 15, 15),
  );
});

test("weekly schedules preserve calendar weekday in years below 100", () => {
  const januaryFirst = new Date(0);
  januaryFirst.setUTCFullYear(50, 0, 1);
  januaryFirst.setUTCHours(10, 0, 0, 0);
  const januaryEighth = new Date(0);
  januaryEighth.setUTCFullYear(50, 0, 8);
  januaryEighth.setUTCHours(9, 0, 0, 0);
  assert.equal(
    nextOccurrence(
      {
        kind: "weekly",
        weekday: januaryFirst.getUTCDay(),
        time: "09:00",
        timeZone: "UTC",
      },
      januaryFirst.getTime(),
    ),
    januaryEighth.getTime(),
  );
});

test("cancellation propagates through AbortSignal and marks descendants cancelled", async () => {
  const f = await fixture();
  try {
    let observedAbort = false;
    f.runtime.registerHandler(
      handler("slow", async (signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          ),
        );
        return null;
      }),
    );
    const parent = f.runtime.enqueue({ owner, handler: "slow" });
    const child = f.runtime.enqueue({
      owner,
      handler: "slow",
      parentId: parent.id,
    });
    const ticking = f.runtime.tick();
    await delay(10);
    assert.equal(f.runtime.cancel(parent.id, owner), true);
    await ticking;
    assert.equal(observedAbort, true);
    assert.equal(f.runtime.get(parent.id, owner)?.state, "cancelled");
    assert.equal(f.runtime.get(child.id, owner)?.state, "cancelled");
  } finally {
    await f.close();
  }
});

test("capabilities are rechecked at dispatch and owner scopes cannot inspect each other", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-scope-"));
  let granted = true;
  const runtime = new TaskRuntime({
    directory,
    capabilityResolver: () => (granted ? ["notify"] : []),
  });
  try {
    runtime.registerHandler({
      ...handler("notify"),
      requiredCapabilities: ["notify"],
    });
    const task = runtime.enqueue({ owner, handler: "notify" });
    granted = false;
    await runtime.tick();
    assert.equal(runtime.get(task.id, owner)?.outcomeCode, "capability_revoked");
    assert.equal(runtime.get(task.id, "user:bob"), undefined);
    assert.deepEqual(runtime.list({ owner: "user:bob" }), []);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a task-tree budget is shared by descendants", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("unit"));
    const root = f.runtime.enqueue({
      owner,
      handler: "unit",
      budget: { maxTasks: 2 },
    });
    f.runtime.enqueue({ owner, handler: "unit", parentId: root.id });
    assert.throws(
      () => f.runtime.enqueue({ owner, handler: "unit", parentId: root.id }),
      /budget exhausted/,
    );
  } finally {
    await f.close();
  }
});

test("watch events persistently deduplicate owner-scoped handler work", async () => {
  const f = await fixture();
  try {
    const seen: unknown[] = [];
    f.runtime.registerHandler(
      handler("watch", async (_signal, input) => {
        seen.push(input);
        return input;
      }),
    );
    f.runtime.watch({
      owner,
      handler: "watch",
      topic: "calendar.changed",
      input: { source: "calendar" },
    });
    assert.equal(
      f.runtime.publish({
        owner,
        topic: "calendar.changed",
        dedupeKey: "revision-1",
        payload: { eventId: "event-1" },
      }).length,
      1,
    );
    assert.deepEqual(
      f.runtime.publish({
        owner,
        topic: "calendar.changed",
        dedupeKey: "revision-1",
      }),
      [],
    );
    assert.deepEqual(
      f.runtime.publish({
        owner: "user:bob",
        topic: "calendar.changed",
        dedupeKey: "revision-1",
      }),
      [],
    );
    await f.runtime.tick();
    assert.deepEqual(seen, [{ watchInput: { source: "calendar" }, event: { eventId: "event-1" } }]);
  } finally {
    await f.close();
  }
});

test("watches validate bounded templates and support scoped lifecycle controls", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler({ name: "watch.safe", async run() {} });
    assert.throws(
      () =>
        f.runtime.watch({
          owner: "user:alice",
          topic: "change",
          handler: "watch.safe",
          budget: { maxRuntimeMs: Number.MAX_SAFE_INTEGER },
        }),
      /budget/i,
    );
    const id = f.runtime.watch({
      owner: "user:alice",
      topic: "change",
      handler: "watch.safe",
    });
    assert.equal(f.runtime.listWatches("user:alice")[0]?.id, id);
    assert.equal(f.runtime.pauseWatch(id, "user:bob"), false);
    assert.equal(f.runtime.pauseWatch(id, "user:alice"), true);
    assert.equal(f.runtime.listWatches("user:alice")[0]?.paused, true);
    assert.equal(f.runtime.resumeWatch(id, "user:alice"), true);
    assert.equal(f.runtime.removeWatch(id, "user:alice"), true);
    assert.deepEqual(f.runtime.listWatches("user:alice"), []);
  } finally {
    await f.close();
  }
});

test("independent tasks run in parallel while dependencies preserve ordering", async () => {
  const f = await fixture();
  try {
    const events: string[] = [];
    f.runtime.registerHandler(
      handler("work", async (_signal, input) => {
        const name = String(input);
        events.push(`${name}:start`);
        await delay(20);
        events.push(`${name}:end`);
        return name;
      }),
    );
    const first = f.runtime.enqueue({ owner, handler: "work", input: "first" });
    f.runtime.enqueue({ owner, handler: "work", input: "parallel" });
    f.runtime.enqueue({
      owner,
      handler: "work",
      input: "dependent",
      dependsOn: [first.id],
    });
    await f.runtime.tick();
    assert.ok(events.indexOf("parallel:start") < events.indexOf("first:end"));
    assert.equal(events.includes("dependent:start"), false);
    await f.runtime.tick();
    assert.ok(events.indexOf("dependent:start") > events.indexOf("first:end"));
  } finally {
    await f.close();
  }
});

test("unsafe handlers never retry and resumable retries keep one operation key", async () => {
  const f = await fixture();
  try {
    const unsafeKeys: string[] = [],
      safeKeys: string[] = [];
    f.runtime.registerHandler({
      name: "unsafe",
      async run(context) {
        unsafeKeys.push(context.idempotencyKey);
        throw new Error("failed");
      },
      checkOutcome: () => true,
    });
    let safeAttempts = 0;
    f.runtime.registerHandler({
      name: "safe-retry",
      resumable: true,
      async run(context) {
        safeKeys.push(context.idempotencyKey);
        if (++safeAttempts === 1) throw new Error("retry");
        return true;
      },
      checkOutcome: () => true,
    });
    const unsafe = f.runtime.enqueue({
      owner,
      handler: "unsafe",
      retry: { maxAttempts: 3 },
    });
    const safe = f.runtime.enqueue({
      owner,
      handler: "safe-retry",
      retry: { maxAttempts: 2 },
    });
    await f.runtime.tick();
    await f.runtime.tick();
    assert.equal(f.runtime.get(unsafe.id, owner)?.state, "failed");
    assert.deepEqual(unsafeKeys, [unsafe.id]);
    assert.equal(f.runtime.get(safe.id, owner)?.state, "succeeded");
    assert.deepEqual(safeKeys, [safe.id, safe.id]);
  } finally {
    await f.close();
  }
});

test("a handler resolving after its deadline records an unknown outcome", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(
      handler("late", async () => {
        await delay(20);
        return "possibly applied";
      }),
    );
    const task = f.runtime.enqueue({
      owner,
      handler: "late",
      budget: { maxRuntimeMs: 5 },
    });
    await f.runtime.tick();
    assert.equal(f.runtime.get(task.id, owner)?.state, "unknown");
    assert.equal(f.runtime.get(task.id, owner)?.outcomeCode, "deadline_outcome_unknown");
  } finally {
    await f.close();
  }
});

test("concurrency is reserved before an asynchronous capability check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-capacity-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let running = 0,
    maximum = 0;
  const runtime = new TaskRuntime({
    directory,
    concurrency: 1,
    capabilityResolver: async () => {
      await gate;
      return [];
    },
  });
  try {
    runtime.registerHandler(
      handler("gated", async () => {
        running++;
        maximum = Math.max(maximum, running);
        await delay(5);
        running--;
        return true;
      }),
    );
    const first = runtime.enqueue({ id: "a-first", owner, handler: "gated" });
    const second = runtime.enqueue({ id: "b-second", owner, handler: "gated" });
    const tick = runtime.tick();
    await delay(5);
    const competing = runtime.tick();
    assert.equal(runtime.get(first.id, owner)?.state, "running");
    assert.equal(runtime.get(second.id, owner)?.state, "queued");
    release();
    await Promise.all([tick, competing]);
    await runtime.tick();
    assert.equal(maximum, 1);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second live runtime cannot recover work owned by the first", async () => {
  const f = await fixture();
  try {
    assert.throws(() => new TaskRuntime({ directory: f.directory }), /opened safely|locked/);
  } finally {
    await f.close();
  }
});

test("shutdown is bounded and preserves an uncooperative task as unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-stop-"));
  const runtime = new TaskRuntime({ directory, leaseMs: 20 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.registerHandler(
    handler("stuck", async () => {
      await gate;
      return true;
    }),
  );
  const task = runtime.enqueue({ owner, handler: "stuck" });
  const tick = runtime.tick();
  await delay(5);
  await assert.rejects(() => runtime.close(), /did not stop cooperatively/);
  assert.equal(runtime.get(task.id, owner)?.state, "unknown");
  release();
  await tick;
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
});

test("child handlers cannot exceed the parent capability ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-ceiling-"));
  const runtime = new TaskRuntime({
    directory,
    capabilityResolver: () => ["read", "write"],
  });
  try {
    runtime.registerHandler({
      ...handler("read"),
      requiredCapabilities: ["read"],
    });
    runtime.registerHandler({
      ...handler("write"),
      requiredCapabilities: ["write"],
    });
    const parent = runtime.enqueue({
      owner,
      handler: "read",
      allowedCapabilities: ["read"],
    });
    assert.throws(
      () => runtime.enqueue({ owner, handler: "write", parentId: parent.id }),
      /capability ceiling/,
    );
    assert.throws(
      () =>
        runtime.enqueue({
          owner,
          handler: "write",
          parentId: parent.id,
          allowedCapabilities: ["read", "write"],
        }),
      /exceeds its parent capability ceiling/,
    );
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability lookup failure releases reservations without dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-task-grant-failure-"));
  let runs = 0;
  const runtime = new TaskRuntime({
    directory,
    capabilityResolver: () => {
      throw new Error("private resolver detail");
    },
  });
  try {
    runtime.registerHandler(handler("guarded", async () => ++runs));
    const task = runtime.enqueue({ owner, handler: "guarded" });
    await runtime.tick();
    assert.equal(runs, 0);
    assert.equal(runtime.get(task.id, owner)?.state, "failed");
    assert.equal(runtime.get(task.id, owner)?.outcomeCode, "capability_resolution_failed");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation prevents late child creation", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("child"));
    let childError = "";
    f.runtime.registerHandler({
      name: "parent",
      async run(context) {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        try {
          context.enqueueChild({ handler: "child" });
        } catch (error) {
          childError = error instanceof Error ? error.message : String(error);
        }
        return true;
      },
      checkOutcome: () => true,
    });
    const parent = f.runtime.enqueue({
      owner,
      handler: "parent",
      allowedCapabilities: [],
    });
    const ticking = f.runtime.tick();
    await delay(5);
    f.runtime.cancel(parent.id, owner);
    await ticking;
    assert.match(childError, /no longer active/);
    assert.deepEqual(f.runtime.list({ owner, parentId: parent.id }), []);
    assert.throws(
      () => f.runtime.enqueue({ owner, handler: "child", parentId: parent.id }),
      /terminal parent/,
    );
  } finally {
    await f.close();
  }
});

test("deadline during outcome verification cannot publish success", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler({
      name: "slow-check",
      async run() {
        return true;
      },
      async checkOutcome() {
        await delay(20);
        return true;
      },
    });
    const task = f.runtime.enqueue({
      owner,
      handler: "slow-check",
      budget: { maxRuntimeMs: 5 },
    });
    await f.runtime.tick();
    assert.equal(f.runtime.get(task.id, owner)?.state, "unknown");
    assert.equal(f.runtime.get(task.id, owner)?.outcomeCode, "outcome_check_deadline_unknown");
  } finally {
    await f.close();
  }
});

test("children inherit and cannot extend parent time bounds", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("bounded"));
    const parent = f.runtime.enqueue({
      owner,
      handler: "bounded",
      deadlineAt: 2_000,
      expiresAt: 3_000,
    });
    const child = f.runtime.enqueue({
      owner,
      handler: "bounded",
      parentId: parent.id,
    });
    assert.equal(child.deadlineAt, 2_000);
    assert.equal(child.expiresAt, 3_000);
    assert.throws(
      () =>
        f.runtime.enqueue({
          owner,
          handler: "bounded",
          parentId: parent.id,
          deadlineAt: 2_001,
        }),
      /exceeds/,
    );
  } finally {
    await f.close();
  }
});

test("recurring occurrences receive independent subtree budgets", async () => {
  const f = await fixture(0);
  try {
    let runs = 0;
    f.runtime.registerHandler(handler("routine", async () => ++runs));
    const routine = f.runtime.schedule({
      owner,
      handler: "routine",
      budget: { maxTasks: 1 },
      schedule: { kind: "interval", everyMs: 1_000, anchor: 1_000 },
    });
    for (const at of [1_000, 2_000, 3_000]) {
      f.setNow(at);
      await f.runtime.tick();
    }
    assert.equal(runs, 3);
    assert.equal(f.runtime.list({ owner, parentId: routine.id }).length, 3);
  } finally {
    await f.close();
  }
});

test("personal export is paged, generation-bound, and excludes group work", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler({
      name: "exportable",
      async run(context, input) {
        context.progress({ message: "private progress" });
        return input;
      },
      checkOutcome: () => true,
    });
    f.runtime.enqueue({ owner, handler: "exportable", input: { private: "value" } });
    f.runtime.enqueue({ owner: "group:home", handler: "exportable", input: { shared: true } });
    f.runtime.watch({ owner, topic: "export", handler: "exportable", input: { watched: true } });
    await f.runtime.tick();
    f.runtime.publish({
      owner,
      topic: "export",
      dedupeKey: "event-1",
      payload: { event: "private" },
    });
    assert.deepEqual(f.runtime.personalSummary(owner), {
      generation: f.runtime.exportPersonal({ owner }).generation,
      tasks: 2,
      watches: 1,
      watchEvents: 1,
      progress: 1,
      bytes: f.runtime.personalSummary(owner).bytes,
    });
    assert.ok(f.runtime.personalSummary(owner).bytes > 0);
    const first = f.runtime.exportPersonal({ owner, limit: 1 });
    const items = [...first.items];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = f.runtime.exportPersonal({
        owner,
        cursor,
        limit: 1,
        expectedGeneration: first.generation,
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    assert.ok(
      items.some((item) => item.type === "task" && JSON.stringify(item).includes("private")),
    );
    assert.ok(
      items.some((item) => item.type === "watch" && JSON.stringify(item).includes("watched")),
    );
    assert.ok(
      items.some(
        (item) => item.type === "progress" && JSON.stringify(item).includes("private progress"),
      ),
    );
    assert.ok(
      items.some((item) => item.type === "watchEvent" && JSON.stringify(item).includes("event-1")),
    );
    assert.doesNotMatch(JSON.stringify(items), /shared/);
    f.runtime.enqueue({ owner, handler: "exportable" });
    assert.throws(
      () =>
        f.runtime.exportPersonal({
          owner,
          cursor: first.nextCursor,
          expectedGeneration: first.generation,
        }),
      /changed/,
    );
    assert.throws(
      () => f.runtime.exportPersonal({ owner, cursor: "x".repeat(1_001) }),
      /cursor is invalid/,
    );
    const wrongOwnerCursor = Buffer.from(
      JSON.stringify({
        owner: "user:someone-else",
        generation: f.runtime.exportPersonal({ owner }).generation,
        section: "tasks",
        offset: 0,
      }),
    ).toString("base64url");
    assert.throws(() => f.runtime.exportPersonal({ owner, cursor: wrongOwnerCursor }), /changed/);
    assert.throws(
      () => f.runtime.exportPersonal({ owner: "group:home" as `user:${string}` }),
      /user owner/,
    );
  } finally {
    await f.close();
  }
});

test("personal deletion freezes admission across restart and preserves group tasks", async () => {
  const f = await fixture();
  try {
    f.runtime.registerHandler(handler("personal"));
    const personal = f.runtime.enqueue({ owner, handler: "personal", input: "erase me" });
    const shared = f.runtime.enqueue({
      owner: "group:home",
      handler: "personal",
      input: "keep me",
    });
    f.runtime.watch({ owner, topic: "personal", handler: "personal" });
    const reviewedGeneration = f.runtime.exportPersonal({ owner }).generation;
    assert.throws(
      () =>
        f.runtime.beginPersonalDeletion(owner, "stale-review", {
          expectedGeneration: reviewedGeneration - 1,
        }),
      /changed after deletion review/,
    );
    const deletion = f.runtime.beginPersonalDeletion(owner, "delete-1", {
      expectedGeneration: reviewedGeneration,
    });
    assert.equal(deletion.state, "draining");
    assert.equal(f.runtime.get(personal.id, owner)?.input, null);
    assert.equal(f.runtime.get(shared.id, "group:home")?.input, "keep me");
    for (const blocked of [
      () => f.runtime.enqueue({ owner, handler: "personal" }),
      () =>
        f.runtime.schedule({ owner, handler: "personal", schedule: { kind: "once", at: 2_000 } }),
      () => f.runtime.watch({ owner, topic: "blocked", handler: "personal" }),
      () => f.runtime.publish({ owner, topic: "personal", dedupeKey: "blocked" }),
      () =>
        f.runtime.enqueueWorkflow({
          root: { owner, handler: "personal" },
          children: [{ handler: "personal" }],
        }),
      () => f.runtime.resume(personal.id, owner),
    ])
      assert.throws(blocked, /frozen/);
    await assert.rejects(() => f.runtime.runNow(personal.id, owner), /frozen/);
    await f.runtime.close();

    const reopened = new TaskRuntime({ directory: f.directory, now: () => 2_000 });
    reopened.registerHandler(handler("personal"));
    assert.equal(reopened.getPersonalDeletion(owner)?.operationId, "delete-1");
    assert.throws(() => reopened.enqueue({ owner, handler: "personal" }), /frozen/);
    const ready = await reopened.drainPersonalDeletion(owner, "delete-1");
    assert.equal(ready.state, "ready");
    assert.deepEqual(reopened.list({ owner }), []);
    assert.equal(reopened.get(shared.id, "group:home")?.input, "keep me");
    const completed = reopened.completePersonalDeletion(owner, "delete-1");
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.unknownTaskIds, []);
    assert.equal(reopened.completePersonalDeletion(owner, "delete-1").state, "completed");
    assert.ok(reopened.enqueue({ owner, handler: "personal" }));
    await reopened.close();
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("schema version one migrates without losing queued work", async () => {
  const f = await fixture();
  f.runtime.registerHandler(handler("migrated"));
  const task = f.runtime.enqueue({ owner, handler: "migrated", input: "preserved" });
  await f.runtime.close();
  const database = new DatabaseSync(join(f.directory, "task-runtime.sqlite"));
  for (const row of database
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE '%generation%'")
    .all() as Array<{ name: string }>)
    database.exec(`DROP TRIGGER ${row.name}`);
  database.exec("DROP TABLE owner_deletions; DROP TABLE owner_generations; PRAGMA user_version=1;");
  database.close();
  const reopened = new TaskRuntime({ directory: f.directory });
  try {
    reopened.registerHandler(handler("migrated"));
    assert.equal(reopened.get(task.id, owner)?.input, "preserved");
    assert.equal(reopened.exportPersonal({ owner }).items[0]?.type, "task");
  } finally {
    await reopened.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("personal deletion reports running outcomes unknown and blocks late persistence", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  try {
    f.runtime.registerHandler({
      name: "external",
      async run(context) {
        await blocked;
        context.progress({ message: "late secret" });
        return { secret: "late result" };
      },
      checkOutcome: () => true,
    });
    const task = f.runtime.enqueue({ owner, handler: "external", input: { secret: "input" } });
    const ticking = f.runtime.tick();
    await delay(5);
    const deletion = f.runtime.beginPersonalDeletion(owner, "delete-running");
    assert.deepEqual(deletion.unknownTaskIds, [task.id]);
    assert.equal(f.runtime.get(task.id, owner)?.state, "unknown");
    assert.equal(f.runtime.get(task.id, owner)?.outcomeCode, "personal_deletion_outcome_unknown");
    assert.equal(f.runtime.get(task.id, owner)?.input, null);
    assert.equal(
      (await f.runtime.drainPersonalDeletion(owner, "delete-running", { timeoutMs: 5 })).state,
      "draining",
    );
    release();
    await ticking;
    const ready = await f.runtime.drainPersonalDeletion(owner, "delete-running");
    assert.equal(ready.state, "ready");
    assert.deepEqual(f.runtime.progress(task.id, owner), []);
    assert.equal(f.runtime.get(task.id, owner), undefined);
  } finally {
    await f.runtime.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a stale personal drain cannot purge tasks admitted after another drain completes", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  try {
    f.runtime.registerHandler({
      name: "drain-race",
      async run() {
        await blocked;
      },
      checkOutcome: () => true,
    });
    f.runtime.enqueue({ owner, handler: "drain-race", input: "private" });
    const ticking = f.runtime.tick();
    await delay(5);
    f.runtime.beginPersonalDeletion(owner, "delete-concurrently");
    const staleDrain = f.runtime.drainPersonalDeletion(owner, "delete-concurrently");
    const database = (f.runtime as unknown as { db: DatabaseSync }).db;
    database
      .prepare(
        "UPDATE owner_deletions SET state='ready',ready_at=? WHERE owner_scope=? AND operation_id=?",
      )
      .run(Date.now(), owner, "delete-concurrently");
    f.runtime.completePersonalDeletion(owner, "delete-concurrently");
    const admitted = f.runtime.enqueue({ owner, handler: "drain-race", input: "new work" });
    release();
    await ticking;
    assert.equal((await staleDrain).state, "completed");
    assert.equal(f.runtime.get(admitted.id, owner)?.input, "new work");
  } finally {
    await f.runtime.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("personal deletion does not abort or erase a running group-owned callback", async () => {
  const f = await fixture();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  try {
    f.runtime.registerHandler({
      name: "shared-running",
      async run() {
        await blocked;
        return { shared: "retained" };
      },
      checkOutcome: () => true,
    });
    const shared = f.runtime.enqueue({
      owner: "group:home",
      handler: "shared-running",
      input: { shared: "input" },
    });
    const ticking = f.runtime.tick();
    await delay(5);
    const deletion = f.runtime.beginPersonalDeletion(owner, "delete-personal-only");
    assert.deepEqual(deletion.unknownTaskIds, []);
    assert.equal(f.runtime.get(shared.id, "group:home")?.state, "running");
    assert.equal(
      (await f.runtime.drainPersonalDeletion(owner, "delete-personal-only")).state,
      "ready",
    );
    release();
    await ticking;
    assert.equal(f.runtime.get(shared.id, "group:home")?.state, "succeeded");
    assert.deepEqual(f.runtime.get(shared.id, "group:home")?.result, { shared: "retained" });
  } finally {
    await f.runtime.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
