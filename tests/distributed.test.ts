import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { defaults, nodeConfig, serverConfig } from "@ellie/config";
import { distributedGroupProblem } from "@ellie/compute";
import {
  distributedMlxPlan,
  distributedMlxGroup,
  inferenceJob,
  inferenceRequest,
  record,
} from "@ellie/protocol";
import type { DistributedMlxGroup, NodeInfo, Telemetry } from "@ellie/protocol";
import { fixture } from "./helpers.ts";
import { DistributedScheduler } from "../apps/server/src/distributed.ts";
import { runNode } from "../apps/node/src/index.ts";

const GiB = 1024 ** 3;
function group(): DistributedMlxGroup {
  const now = Date.now();
  return {
    mode: "distributed-mlx",
    id: "two-macs",
    planId: "model-v1",
    nodeIds: ["a", "b"],
    model: "local-model",
    backend: "ring",
    strategy: "pipeline",
    explicitlyEnabled: true,
    timeoutMs: 4000,
    qualification: {
      measuredAt: now - 1000,
      expiresAt: now + 60_000,
      bandwidthBytesPerSecond: 1_000_000_000,
      latencyMs: 1,
      minBandwidthBytesPerSecond: 100_000_000,
      maxLatencyMs: 5,
    },
  };
}
function metrics(activeJobs = 0): Telemetry {
  return {
    freeMemoryBytes: 8 * GiB,
    totalMemoryBytes: 16 * GiB,
    activeJobs,
    load: 0.1,
    power: { source: "ac", batteryPercent: 100, lowPowerMode: false },
    thermal: "nominal",
    network: { roundTripMs: 2, quality: "good" },
  };
}
const caps = (g: DistributedMlxGroup, rank: number) => [
  { plan: distributedMlxPlan(g), rank, requiredFreeMemoryBytes: 4 * GiB },
];
const registration = (g: DistributedMlxGroup, rank: number) => ({
  capabilities: [],
  distributedCapabilities: caps(g, rank),
  telemetry: metrics(),
  computeCapabilities: {
    kind: "inference-worker",
    backend: "local-openai",
    mode: "independent",
    models: [{ id: "local-model", requiredFreeMemoryBytes: GiB }],
  },
});
const request = () =>
  inferenceRequest({
    mode: "distributed-mlx",
    groupId: "two-macs",
    model: "local-model",
    prompt: "synthetic private prompt",
  });
const nodes = (g: DistributedMlxGroup): NodeInfo[] =>
  g.nodeIds.map((id, rank) => ({
    id,
    capabilities: [],
    executionCapabilities: [],
    distributedCapabilities: caps(g, rank),
    telemetry: metrics(),
    lastSeen: Date.now(),
    telemetryReceivedAt: Date.now(),
  }));
async function eventually(check: () => Promise<boolean>) {
  const until = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("Expected distributed state not reached.");
    await delay(10);
  }
}

test("distributed configuration requires matching local consent, bounded plans and measured qualification", () => {
  const g = group();
  assert.deepEqual(distributedMlxGroup(g), g);
  for (const patch of [
    { explicitlyEnabled: false },
    { nodeIds: ["a", "a"] },
    { nodeIds: ["a"] },
    { backend: "auto" },
    { strategy: "tensor" },
    { timeoutMs: 120_001 },
    { qualification: { ...g.qualification, expiresAt: Infinity } },
  ])
    assert.throws(() => distributedMlxGroup({ ...g, ...patch }));
  assert.throws(() =>
    serverConfig({
      version: 1,
      host: "127.0.0.1",
      port: 7437,
      preferences: defaults,
      distributedGroups: [g, g],
    }),
  );
  const local = {
    python: "/venv/bin/python3",
    groups: [
      {
        plan: g,
        modelPath: "/models/m",
        communicationFile: "/config/ring.json",
        requiredFreeMemoryBytes: GiB,
      },
    ],
  };
  const config = {
    version: 1,
    id: "a",
    serverUrl: "https://127.0.0.1",
    preferences: defaults,
    distributedWorker: local,
  };
  assert.ok(nodeConfig(config).distributedWorker);
  assert.throws(() => nodeConfig({ ...config, id: "outsider" }));
  assert.throws(() =>
    nodeConfig({ ...config, distributedWorker: { ...local, python: "python3" } }),
  );
  assert.equal(inferenceRequest({ model: "local-model", prompt: "test" }).mode, "independent");
  const available = nodes(g);
  assert.equal(distributedGroupProblem(g, available, new Set()), undefined);
  assert.match(distributedGroupProblem(g, available, new Set(["b"]))!, /busy/);
  assert.match(
    distributedGroupProblem(
      { ...g, qualification: { ...g.qualification, bandwidthBytesPerSecond: 1 } },
      available,
      new Set(),
    )!,
    /qualification/,
  );
  for (const change of [
    (n: NodeInfo) => {
      n.telemetry!.freeMemoryBytes = 1;
    },
    (n: NodeInfo) => {
      n.telemetry!.power.source = "battery";
    },
    (n: NodeInfo) => {
      n.telemetry!.thermal = "unknown";
    },
    (n: NodeInfo) => {
      n.telemetryReceivedAt = Date.now() - 36_000;
    },
    (n: NodeInfo) => {
      n.distributedCapabilities![0]!.plan.planId = "other-model";
    },
    (n: NodeInfo) => {
      n.distributedCapabilities![0]!.plan.nodeIds.reverse();
    },
  ]) {
    const changed = nodes(g);
    change(changed[1]!);
    assert.match(distributedGroupProblem(g, changed, new Set())!, /unavailable/);
  }
});

test("group reservation commits atomically and does not leak slots when persistence fails", async () => {
  const f = await fixture();
  const g = group();
  const scheduler = new DistributedScheduler({
    groups: [g],
    store: f.jobStore,
    nodes: () => nodes(g),
    invalidate: () => {},
  });
  const original = f.jobStore.create.bind(f.jobStore);
  let count = 0;
  f.jobStore.create = (input) => {
    if (++count === 2) throw new Error("synthetic disk failure");
    original(input);
  };
  try {
    assert.throws(() => scheduler.submit(request(), new Set(), () => {}), /disk failure/);
    assert.equal(scheduler.busy().size, 0);
    assert.deepEqual(f.jobStore.list(), []);
  } finally {
    scheduler.shutdown();
    await f.close();
  }
});

test("HTTPS reserves all Macs, waits for readiness, excludes desktop and independent work, then returns rank zero", async () => {
  const g = group();
  const f = await fixture(2000, { distributedGroups: [g] });
  try {
    const a = await f.pair("a"),
      b = await f.pair("b");
    await a.call("POST", "/v1/register", registration(g, 0));
    await b.call("POST", "/v1/register", registration(g, 1));
    await assert.rejects(a.call("POST", "/v1/inference", request()), /unavailable/);
    const response = f.controller.call("POST", "/v1/inference", request());
    const at = inferenceJob(record(await a.call("GET", "/v1/poll")).job);
    const bt = inferenceJob(record(await b.call("GET", "/v1/poll")).job);
    assert.equal(at.assignment!.leaseId, bt.assignment!.leaseId);
    assert.equal(at.assignment!.rank, 0);
    assert.equal(bt.assignment!.rank, 1);
    assert.equal(record(await a.call("POST", "/v1/start", { id: at.id })).ready, false);
    await assert.rejects(f.controller.call("POST", "/v1/inference", request()), /busy/);
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", { model: "local-model", prompt: "independent" }),
      /No eligible/,
    );
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", { nodeId: "a", text: "open Arc" }),
      /busy/,
    );
    await assert.rejects(b.call("POST", "/v1/start", { id: at.id }), /rejected|matching/);
    assert.equal(record(await b.call("POST", "/v1/start", { id: bt.id })).ready, true);
    assert.equal(record(await a.call("POST", "/v1/start", { id: at.id })).ready, true);
    await a.call("POST", "/v1/result", {
      id: at.id,
      result: { ok: true, message: "generated text" },
    });
    await assert.rejects(f.controller.call("POST", "/v1/inference", request()), /busy/);
    await b.call("POST", "/v1/result", { id: bt.id, result: { ok: true, message: "shard done" } });
    const outcome = record(await response);
    assert.equal(outcome.message, "generated text");
    assert.deepEqual(outcome.workerIds, ["a", "b"]);
    assert.equal(JSON.stringify(f.jobStore.list()).includes("synthetic private prompt"), false);
    await a.call("POST", "/v1/result", {
      id: at.id,
      result: { ok: true, message: "generated text" },
    });
    await assert.rejects(f.controller.call("POST", "/v1/inference", request()), /unavailable/);
  } finally {
    await f.close();
  }
});

test("one rank failure cancels peers and holds even the completed Mac until teardown acknowledgement", async () => {
  const g = group();
  const f = await fixture(2000, { distributedGroups: [g] });
  try {
    const a = await f.pair("a"),
      b = await f.pair("b");
    await a.call("POST", "/v1/register", registration(g, 0));
    await b.call("POST", "/v1/register", registration(g, 1));
    const response = f.controller.call("POST", "/v1/inference", request());
    const at = inferenceJob(record(await a.call("GET", "/v1/poll")).job);
    const bt = inferenceJob(record(await b.call("GET", "/v1/poll")).job);
    await a.call("POST", "/v1/result", {
      id: at.id,
      result: { ok: false, message: "synthetic failed shard" },
    });
    assert.equal(record(await response).ok, false);
    const beat = record(await b.call("POST", "/v1/heartbeat", registration(g, 1)));
    assert.deepEqual(beat.cancelJobIds, [bt.id]);
    assert.equal(record(await b.call("POST", "/v1/start", { id: bt.id })).cancel, true);
    await a.call("POST", "/v1/heartbeat", registration(g, 0));
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", { model: "local-model", prompt: "too soon" }),
      /No eligible/,
    );
    await b.call("POST", "/v1/result", { id: bt.id, result: { ok: false, message: "stopped" } });
    assert.equal(f.jobStore.get(bt.id)?.state, "cancelled");
    const status = (await f.controller.call("GET", "/v1/groups")) as Array<{ jobs: unknown[] }>;
    assert.deepEqual(status[0]!.jobs, []);
  } finally {
    await f.close();
  }
});

test("whole-group cancellation before delivery releases reservations without sending any rank", async () => {
  const f = await fixture();
  const g = group();
  let outcome: unknown;
  const scheduler = new DistributedScheduler({
    groups: [g],
    store: f.jobStore,
    nodes: () => nodes(g),
    invalidate: () => {},
  });
  try {
    const cancel = scheduler.submit(request(), new Set(), (value) => {
      outcome = value;
    });
    cancel();
    assert.equal(record(outcome).ok, false);
    assert.equal(scheduler.busy().size, 0);
    assert.equal(scheduler.deliver("a"), undefined);
    assert.ok(f.jobStore.list().every((j) => j.state === "cancelled"));
  } finally {
    scheduler.shutdown();
    await f.close();
  }
});

test("a stale cancellation callback cannot release a newer lease on the same Macs", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now++);
  const f = await fixture();
  const g = group();
  const scheduler = new DistributedScheduler({
    groups: [g],
    store: f.jobStore,
    nodes: () => nodes(g),
    invalidate: () => {},
  });
  try {
    const oldCancel = scheduler.submit(request(), new Set(), () => {});
    oldCancel();
    const newCancel = scheduler.submit(request(), new Set(), () => {});
    oldCancel();
    assert.equal(scheduler.busy().size, 2);
    assert.ok(scheduler.deliver("a"));
    newCancel();
  } finally {
    scheduler.shutdown();
    await f.close();
  }
});

test("deadline and unhealthy telemetry cancel the entire group without accepting a late success", async () => {
  for (const reason of ["deadline", "thermal"] as const) {
    const f = await fixture();
    const g = group();
    const available = nodes(g);
    let outcome: unknown;
    const scheduler = new DistributedScheduler({
      groups: [g],
      store: f.jobStore,
      nodes: () => available,
      invalidate: () => {},
    });
    try {
      scheduler.submit(request(), new Set(), (value) => {
        outcome = value;
      });
      const a = scheduler.deliver("a")!,
        b = scheduler.deliver("b")!;
      scheduler.start("a", a.id);
      scheduler.start("b", b.id);
      if (reason === "deadline") a.expiresAt = Date.now() - 1;
      else available[1]!.telemetry!.thermal = "critical";
      scheduler.report("a", a.id, { ok: true, message: "late success" });
      assert.equal(record(outcome).ok, false);
      assert.equal(scheduler.busy().size, 2);
      scheduler.report("b", b.id, { ok: false, message: "stopped" });
      assert.equal(scheduler.busy().size, 0);
      assert.equal(
        f.jobStore.get(a.id)?.outcomeCode,
        reason === "deadline" ? "timed_out" : "operation_failed",
      );
    } finally {
      scheduler.shutdown();
      await f.close();
    }
  }
});

test("node agents cross the start barrier together and propagate controller cancellation to both runners", async () => {
  const g = group();
  g.timeoutMs = 10_000;
  const f = await fixture(2000, { distributedGroups: [g] });
  const stop = new AbortController();
  const prepared = new Set<number>(),
    executed = new Set<number>(),
    aborted = new Set<number>();
  const tasks: Promise<void>[] = [];
  try {
    for (const [rank, id] of g.nodeIds.entries()) {
      const client = await f.pair(id);
      tasks.push(
        runNode({
          client,
          preferences: defaults,
          signal: stop.signal,
          heartbeatMs: 20,
          collect: async (active) => metrics(active),
          distributedWorker: {
            advertise: async () => caps(g, rank),
            prepare: async () => {
              if (rank === 1) await delay(100);
              prepared.add(rank);
            },
            execute: async (_task, signal) => {
              assert.equal(prepared.size, 2);
              executed.add(rank);
              try {
                await delay(20_000, undefined, { signal });
              } finally {
                if (signal.aborted) aborted.add(rank);
              }
              return { ok: true, message: "unreachable" };
            },
          },
        }),
      );
    }
    await eventually(
      async () => ((await f.controller.call("GET", "/v1/nodes")) as unknown[]).length === 2,
    );
    const response = f.controller.call("POST", "/v1/inference", request());
    await eventually(async () => executed.size === 2);
    const job = f.jobStore.list()[0]!;
    await f.controller.call("POST", `/v1/jobs/${job.id}`, {});
    assert.equal(record(await response).ok, false);
    await eventually(
      async () => aborted.size === 2 && f.jobStore.list().every((j) => j.state === "cancelled"),
    );
  } finally {
    stop.abort();
    await Promise.all(tasks);
    await f.close();
  }
});

test("graceful node shutdown acknowledges teardown and cancels the remaining rank", async () => {
  const g = group();
  g.timeoutMs = 10_000;
  const f = await fixture(2000, { distributedGroups: [g] });
  const stops = [new AbortController(), new AbortController()];
  const tasks: Promise<void>[] = [];
  const clients: Awaited<ReturnType<typeof f.pair>>[] = [];
  const executing = new Set<number>();
  try {
    for (const [rank, id] of g.nodeIds.entries()) {
      const client = await f.pair(id);
      clients.push(client);
      tasks.push(
        runNode({
          client,
          preferences: defaults,
          signal: stops[rank]!.signal,
          heartbeatMs: 20,
          collect: async (active) => metrics(active),
          distributedWorker: {
            advertise: async () => caps(g, rank),
            prepare: async () => {},
            execute: async (_task, signal) => {
              executing.add(rank);
              await delay(20_000, undefined, { signal });
              return { ok: true, message: "unreachable" };
            },
          },
        }),
      );
    }
    await eventually(
      async () => ((await f.controller.call("GET", "/v1/nodes")) as unknown[]).length === 2,
    );
    const response = f.controller.call("POST", "/v1/inference", request());
    await eventually(async () => executing.size === 2);
    stops[0]!.abort();
    clients[0]!.close();
    await tasks[0];
    assert.equal(record(await response).ok, false);
    await eventually(async () => {
      const status = (await f.controller.call("GET", "/v1/groups")) as Array<{ jobs: unknown[] }>;
      return status[0]!.jobs.length === 0;
    });
  } finally {
    stops.forEach((s) => s.abort());
    await Promise.all(tasks);
    await f.close();
  }
});
