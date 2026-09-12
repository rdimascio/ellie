import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { defaults, inferenceWorkerConfig, nodeConfig } from "@ellie/config";
import { computeEligible, selectWorker } from "@ellie/compute";
import {
  computeCapabilities,
  telemetry,
  inferenceRequest,
  inferenceJob,
  record,
} from "@ellie/protocol";
import type { ComputeCapabilities, NodeInfo, Telemetry } from "@ellie/protocol";
import { fixture } from "./helpers.ts";
import { LocalInferenceWorker } from "../apps/node/src/inference.ts";
import { runNode } from "../apps/node/src/index.ts";
import { batteryState } from "../apps/node/src/telemetry.ts";

const GiB = 1024 ** 3;
const compute: ComputeCapabilities = {
  kind: "inference-worker",
  backend: "local-openai",
  mode: "independent",
  models: [{ id: "test-model", requiredFreeMemoryBytes: 4 * GiB }],
};
function metrics(): Telemetry {
  return {
    totalMemoryBytes: 16 * GiB,
    freeMemoryBytes: 8 * GiB,
    activeJobs: 0,
    load: 0.1,
    power: { source: "ac", batteryPercent: 100, lowPowerMode: false },
    thermal: "nominal",
    network: { roundTripMs: 3, quality: "good" },
  };
}
function node(id: string, now = Date.now()): NodeInfo {
  return {
    id,
    capabilities: [],
    executionCapabilities: [],
    computeCapabilities: structuredClone(compute),
    telemetry: metrics(),
    lastSeen: now,
    telemetryReceivedAt: now,
  };
}
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Expected worker state was not published.");
    await delay(10);
  }
}
const registration = () => ({
  capabilities: [],
  computeCapabilities: compute,
  telemetry: metrics(),
});

test("independent scheduler gates memory, inventory, freshness, load, battery, thermal, network and reservations", () => {
  const now = Date.now();
  for (const mutate of [
    (n: NodeInfo) => {
      n.telemetry!.freeMemoryBytes = GiB;
    },
    (n: NodeInfo) => {
      n.telemetry!.activeJobs = 1;
    },
    (n: NodeInfo) => {
      n.telemetry!.load = 2;
    },
    (n: NodeInfo) => {
      n.telemetry!.power = { source: "battery", batteryPercent: 15, lowPowerMode: false };
    },
    (n: NodeInfo) => {
      n.telemetry!.power.lowPowerMode = true;
    },
    (n: NodeInfo) => {
      n.telemetry!.thermal = "critical";
    },
    (n: NodeInfo) => {
      n.telemetry!.thermal = "serious";
    },
    (n: NodeInfo) => {
      n.telemetry!.network.quality = "poor";
    },
    (n: NodeInfo) => {
      n.telemetry!.network.roundTripMs = 1000;
    },
    (n: NodeInfo) => {
      n.telemetryReceivedAt = now - 35_001;
    },
    (n: NodeInfo) => {
      n.lastSeen = now - 35_001;
    },
    (n: NodeInfo) => {
      delete n.telemetryReceivedAt;
    },
    (n: NodeInfo) => {
      delete n.computeCapabilities;
    },
    (n: NodeInfo) => {
      n.computeCapabilities!.models = [];
    },
  ]) {
    const candidate = node("bad", now);
    mutate(candidate);
    assert.equal(computeEligible(candidate, "test-model", now), false);
  }
  const a = node("a", now);
  const b = node("b", now);
  b.telemetry!.power.source = "battery";
  assert.equal(selectWorker([b, a], "test-model", new Set(), now)?.id, "a");
  assert.equal(selectWorker([a, b], "test-model", new Set(["a"]), now)?.id, "b");
  assert.equal(selectWorker([a], "other-model", new Set(), now), undefined);
  assert.equal(selectWorker([a], "test-model", new Set(["a"]), now), undefined);
});

test("compute protocol validates metrics and preserves old configs; only local runner origins allowed", () => {
  assert.deepEqual(telemetry(metrics()), metrics());
  for (const bad of [NaN, Infinity, -1, "8 GB"])
    assert.throws(() => telemetry({ ...metrics(), freeMemoryBytes: bad }));
  assert.throws(() => telemetry({ ...metrics(), freeMemoryBytes: 100 * GiB }));
  assert.throws(() =>
    computeCapabilities({ ...compute, models: [...compute.models, ...compute.models] }),
  );
  assert.throws(
    () => inferenceRequest({ model: "m", prompt: "p", mode: "distributed-mlx" }),
    /advanced/,
  );
  assert.equal(
    nodeConfig({
      version: 1,
      id: "old",
      serverUrl: "https://127.0.0.1:7437",
      preferences: defaults,
    }).executionEnabled,
    true,
  );
  for (const endpoint of [
    "https://example.com",
    "http://localhost:8080",
    "http://127.0.0.1@evil.test",
    "http://127.0.0.1/path",
    "http://127.0.0.1?x=1",
  ]) {
    assert.throws(() => inferenceWorkerConfig({ endpoint, models: compute.models }));
  }
  assert.equal(
    inferenceWorkerConfig({ endpoint: "http://127.0.0.1:8080", models: compute.models }).models
      .length,
    1,
  );
  assert.deepEqual(
    batteryState("Now drawing from 'Battery Power'\n -InternalBattery-0 27%; discharging"),
    { source: "battery", batteryPercent: 27 },
  );
  assert.deepEqual(batteryState("Now drawing from 'AC Power'"), {
    source: "ac",
    batteryPercent: null,
  });
  assert.deepEqual(batteryState("unavailable"), { source: "unknown", batteryPercent: null });
});

test("server reserves different workers for concurrent inference, preserves authorization and refuses busy pool", async () => {
  const f = await fixture();
  try {
    const a = await f.pair("a");
    const b = await f.pair("b");
    for (const client of [a, b]) await client.call("POST", "/v1/register", registration());
    await assert.rejects(
      a.call("POST", "/v1/inference", { model: "test-model", prompt: "hello" }),
      /unavailable/,
    );
    const first = f.controller.call("POST", "/v1/inference", {
      model: "test-model",
      prompt: "one",
    });
    const aTask = inferenceJob(record(await a.call("GET", "/v1/poll")).job);
    const second = f.controller.call("POST", "/v1/inference", {
      model: "test-model",
      prompt: "two",
    });
    const bTask = inferenceJob(record(await b.call("GET", "/v1/poll")).job);
    assert.notEqual(aTask.id, bTask.id);
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", { model: "test-model", prompt: "three" }),
      /No eligible/,
    );
    await assert.rejects(
      b.call("POST", "/v1/result", { id: aTask.id, result: { ok: true, message: "spoof" } }),
      /matching/,
    );
    await a.call("POST", "/v1/result", { id: aTask.id, result: { ok: true, message: "first" } });
    await b.call("POST", "/v1/result", { id: bTask.id, result: { ok: true, message: "second" } });
    assert.equal(record(await first).workerId, "a");
    assert.equal(record(await second).workerId, "b");
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", {
        model: "test-model",
        prompt: "stale after completion",
      }),
      /No eligible/,
    );
    await a.call("POST", "/v1/heartbeat", registration());
    const third = f.controller.call("POST", "/v1/inference", {
      model: "test-model",
      prompt: "fresh",
    });
    const task = inferenceJob(record(await a.call("GET", "/v1/poll")).job);
    await a.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "third" } });
    assert.equal(record(await third).ok, true);
  } finally {
    await f.close();
  }
});

test("inference timeout is not retried and late results cannot finish subsequent jobs", async () => {
  const f = await fixture(100);
  try {
    const a = await f.pair("a");
    await a.call("POST", "/v1/register", registration());
    const pending = f.controller.call("POST", "/v1/inference", {
      model: "test-model",
      prompt: "hello",
    });
    const task = inferenceJob(record(await a.call("GET", "/v1/poll")).job);
    assert.equal(record(await pending).ok, false);
    await assert.rejects(
      a.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "late" } }),
      /matching/,
    );
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", { model: "test-model", prompt: "again" }),
      /No eligible/,
    );
  } finally {
    await f.close();
  }
});

test("compute-only node runs through local HTTP adapter; local memory recheck rejects a stale server placement", async () => {
  const requests: unknown[] = [];
  const runner = createServer((req, res) => {
    if (req.url === "/v1/models")
      return res.end(JSON.stringify({ data: [{ id: "test-model" }, { id: "not-enabled" }] }));
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ choices: [{ message: { content: "Hello from this Mac." } }] }));
    })();
  });
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(runner.address() as AddressInfo).port}`;
  const f = await fixture();
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let freeMemory = 8 * GiB;
  try {
    const client = await f.pair("compute-only");
    const worker = new LocalInferenceWorker({ endpoint, models: compute.models });
    assert.deepEqual((await worker.advertise(abort.signal)).models, compute.models);
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client,
      worker,
      preferences: defaults,
      signal: abort.signal,
      collect: async (activeJobs) => ({ ...metrics(), activeJobs, freeMemoryBytes: freeMemory }),
      onStatus: () => ready(),
    });
    await registered;
    const response = record(
      await f.controller.call("POST", "/v1/inference", { model: "test-model", prompt: "hello" }),
    );
    assert.equal(response.message, "Hello from this Mac.");
    assert.equal(response.workerId, "compute-only");
    assert.deepEqual(record(requests[0]).messages, [{ role: "user", content: "hello" }]);
    // Publish a fresh advertisement, then change local resources before execution.
    await eventually(
      async () =>
        ((await f.controller.call("GET", "/v1/nodes")) as NodeInfo[])[0]?.telemetryReceivedAt !==
        undefined,
    );
    freeMemory = GiB;
    const declined = record(
      await f.controller.call("POST", "/v1/inference", {
        model: "test-model",
        prompt: "too little RAM now",
      }),
    );
    assert.equal(declined.ok, false);
    assert.equal(requests.length, 1);
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", { nodeId: "compute-only", text: "open Arc" }),
      /rejected/,
    );
  } finally {
    abort.abort();
    await f.close();
    await agent;
    runner.closeAllConnections();
    await new Promise<void>((resolve) => runner.close(() => resolve()));
  }
});

test("runner redirects never send prompts to a different endpoint", async () => {
  const runner = createServer((_req, res) =>
    res.writeHead(302, { location: "http://127.0.0.1:1/v1/models" }).end(),
  );
  await new Promise<void>((resolve) => runner.listen(0, "127.0.0.1", resolve));
  try {
    const worker = new LocalInferenceWorker({
      endpoint: `http://127.0.0.1:${(runner.address() as AddressInfo).port}`,
      models: compute.models,
    });
    await assert.rejects(worker.advertise(new AbortController().signal));
  } finally {
    runner.closeAllConnections();
    await new Promise<void>((resolve) => runner.close(() => resolve()));
  }
});

test("busy workers keep publishing load and withdraw unavailable models without losing the node", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  let available = true;
  let release!: () => void;
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const client = await f.pair("heartbeat-worker");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client,
      preferences: defaults,
      signal: abort.signal,
      heartbeatMs: 20,
      collect: async (activeJobs) => ({ ...metrics(), activeJobs }),
      worker: {
        advertise: async () => {
          if (!available) throw new Error("runner stopped");
          return compute;
        },
        execute: async () => {
          await finish;
          return { ok: true, message: "done" };
        },
      },
      onStatus: () => ready(),
    });
    await registered;
    const pending = f.controller.call("POST", "/v1/inference", {
      model: "test-model",
      prompt: "hello",
    });
    await eventually(
      async () =>
        ((await f.controller.call("GET", "/v1/nodes")) as NodeInfo[])[0]?.telemetry?.activeJobs ===
        1,
    );
    release();
    assert.equal(record(await pending).ok, true);
    available = false;
    await eventually(
      async () =>
        ((await f.controller.call("GET", "/v1/nodes")) as NodeInfo[])[0]?.computeCapabilities ===
        undefined,
    );
    await assert.rejects(
      f.controller.call("POST", "/v1/inference", { model: "test-model", prompt: "hello" }),
      /No eligible/,
    );
  } finally {
    release();
    abort.abort();
    await f.close();
    await agent;
  }
});
