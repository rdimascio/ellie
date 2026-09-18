import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDistributedWorker } from "../apps/node/src/distributed.ts";
import { inferenceJob } from "@ellie/protocol";

async function runtime(body: string) {
  const dir = await mkdtemp(join(tmpdir(), "ellie-rank-"));
  const python = join(dir, "synthetic-python");
  await writeFile(
    python,
    `#!${process.execPath}\nlet input = ''; process.stdin.on('data', x => input += x); process.stdin.on('end', () => { const request = JSON.parse(input); ${body} });\n`,
    { mode: 0o700 },
  );
  const modelPath = join(dir, "model");
  await mkdir(modelPath);
  await writeFile(join(modelPath, "config.json"), "{}");
  await writeFile(join(modelPath, "model.safetensors"), "synthetic");
  const communicationFile = join(dir, "ring.json");
  await writeFile(communicationFile, '[["127.0.0.1:5100"],["127.0.0.1:5101"]]');
  const plan = {
    mode: "distributed-mlx" as const,
    id: "group",
    planId: "v1",
    nodeIds: ["a", "b"],
    model: "model",
    backend: "ring" as const,
    strategy: "pipeline" as const,
    explicitlyEnabled: true as const,
  };
  const worker = new LocalDistributedWorker(
    { python, groups: [{ plan, modelPath, communicationFile, requiredFreeMemoryBytes: 1 }] },
    "a",
    join(dir, "locks"),
  );
  const task = inferenceJob({
    version: 1,
    kind: "inference",
    id: "lease-0",
    expiresAt: Date.now() + 5000,
    request: {
      mode: "distributed-mlx",
      groupId: "group",
      model: "model",
      prompt: "$(do-not-run) 🦋",
      maxTokens: 20,
    },
    assignment: { plan, rank: 0, leaseId: "lease" },
  });
  return { dir, worker, task, close: () => rm(dir, { recursive: true, force: true }) };
}

test("rank adapter validates consent and passes the prompt only through stdin with a bounded JSON result", async () => {
  const f = await runtime(
    "process.stdout.write(JSON.stringify({ok:true,message:request.prompt ?? 'ready'}));",
  );
  try {
    assert.equal((await f.worker.advertise(AbortSignal.timeout(2000))).length, 1);
    await f.worker.prepare(f.task, AbortSignal.timeout(2000));
    assert.equal(
      (await f.worker.execute(f.task, AbortSignal.timeout(2000))).message,
      f.task.request.prompt,
    );
    const wrongRank = structuredClone(f.task);
    wrongRank.assignment!.rank = 1;
    await assert.rejects(f.worker.execute(wrongRank, AbortSignal.timeout(2000)), /not enabled/);
    const changedModel = structuredClone(f.task);
    changedModel.assignment!.plan.model = "not-allowed";
    await assert.rejects(f.worker.prepare(changedModel, AbortSignal.timeout(2000)), /not enabled/);
    await rm(join(f.dir, "model"), { recursive: true });
    assert.deepEqual(await f.worker.advertise(AbortSignal.timeout(2000)), []);
  } finally {
    await f.close();
  }
});

test("rank adapter kills an uncooperative process and waits for exit before acknowledging cancellation", async () => {
  const f = await runtime(
    "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(request.lockPath + '.ready', String(process.pid)); setInterval(() => {}, 1000);",
  );
  try {
    const abort = new AbortController();
    const pending = f.worker.execute(f.task, abort.signal);
    const rejection = assert.rejects(pending, /cancelled/);
    let pid = 0;
    const until = Date.now() + 2000;
    while (!pid && Date.now() < until) {
      pid = Number(
        await readFile(join(f.dir, "locks", "group.lock.ready"), "utf8").catch(() => "0"),
      );
      if (!pid) await delay(10);
    }
    assert.ok(pid, "synthetic process reached its signal handler");
    const now = Date.now();
    abort.abort();
    await rejection;
    const elapsed = Date.now() - now;
    assert.ok(
      elapsed >= 1000 && elapsed < 4000,
      `expected kill escalation and reap, got ${elapsed}ms`,
    );
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await f.close();
  }
});

test("rank adapter rejects oversized output without exposing runner stderr", async () => {
  const f = await runtime(
    "process.stderr.write('synthetic secret prompt'); process.stdout.write('x'.repeat(70000));",
  );
  try {
    await assert.rejects(f.worker.execute(f.task, AbortSignal.timeout(2000)), (error: Error) => {
      assert.equal(error.message.includes("secret"), false);
      return /failed/.test(error.message);
    });
  } finally {
    await f.close();
  }
});
