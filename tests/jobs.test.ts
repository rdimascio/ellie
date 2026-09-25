import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { defaults } from "@ellie/config";
import { CAPABILITIES, VERSION, job, record } from "@ellie/protocol";
import type { Action } from "@ellie/protocol";
import type { Client } from "@ellie/transport";
import { runNode, reconnectDelay } from "../apps/node/src/index.ts";
import { JobStore } from "../apps/server/src/jobs.ts";
import { fixture } from "./helpers.ts";

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Expected state was not published.");
    await delay(10);
  }
}

test("job schema migrates from zero and restart recovers every lifecycle without replay payloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-jobs-"));
  const path = join(dir, "jobs.sqlite");
  try {
    const store = new JobStore(path, { now: 100 });
    const create = (id: string, expiresAt = 1000) =>
      store.create({ id, kind: "desktop", target: "node", createdAt: 100, expiresAt });
    create("queued");
    create("expired", 199);
    create("delivered");
    store.markDelivered("delivered", 110);
    create("running");
    store.markDelivered("running", 110);
    store.markRunning("running", 120);
    create("completed");
    store.finish("completed", "completed", "succeeded", true, 130);
    create("failed");
    store.finish("failed", "failed", "operation_failed", false, 130);
    create("cancelled");
    store.requestCancellation("cancelled", 130);
    create("cancelling");
    store.markDelivered("cancelling", 110);
    store.requestCancellation("cancelling", 130);
    store.close();

    const reopened = new JobStore(path, { now: 200 });
    assert.equal(reopened.get("queued")?.state, "cancelled");
    assert.equal(reopened.get("queued")?.outcomeCode, "abandoned_after_restart");
    assert.equal(reopened.get("expired")?.state, "expired");
    assert.equal(reopened.get("delivered")?.state, "unknown");
    assert.equal(reopened.get("running")?.state, "unknown");
    assert.equal(reopened.get("cancelling")?.state, "unknown");
    assert.equal(reopened.get("completed")?.state, "completed");
    assert.equal(reopened.get("failed")?.state, "failed");
    assert.equal(reopened.get("cancelled")?.state, "cancelled");
    reopened.close();

    const database = new DatabaseSync(path, { readOnly: true });
    assert.equal(database.prepare("PRAGMA user_version").get()?.user_version, 1);
    const columns = database
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((row) => row.name);
    assert.deepEqual(columns, [
      "id",
      "kind",
      "target",
      "state",
      "created_at",
      "updated_at",
      "expires_at",
      "outcome_ok",
      "outcome_code",
    ]);
    database.close();
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("job store rejects symlinks, corruption and unsupported schemas with recovery guidance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-job-errors-"));
  try {
    const unsupportedPath = join(dir, "unsupported.sqlite");
    const unsupported = new DatabaseSync(unsupportedPath);
    unsupported.exec("PRAGMA user_version = 2");
    unsupported.close();
    await chmod(unsupportedPath, 0o600);
    assert.throws(() => new JobStore(unsupportedPath), /preserve.*move it aside/);

    const corruptPath = join(dir, "corrupt.sqlite");
    await writeFile(corruptPath, "not a sqlite database", { mode: 0o600 });
    assert.throws(() => new JobStore(corruptPath), /could not be opened safely.*preserve/);

    const target = join(dir, "target.sqlite");
    await writeFile(target, "do not follow", { mode: 0o600 });
    const linkPath = join(dir, "link.sqlite");
    await symlink(target, linkPath);
    assert.throws(() => new JobStore(linkPath), /could not be opened safely/);

    const publicDirectory = join(dir, "public");
    await chmod(dir, 0o700);
    const publicStore = new JobStore(join(publicDirectory, "seed.sqlite"));
    publicStore.close();
    await chmod(publicDirectory, 0o777);
    assert.throws(
      () => new JobStore(join(publicDirectory, "seed.sqlite")),
      /could not be opened safely/,
    );

    const publicFile = join(dir, "public.sqlite");
    const privateStore = new JobStore(publicFile);
    privateStore.close();
    await chmod(publicFile, 0o644);
    assert.throws(() => new JobStore(publicFile), /could not be opened safely/);

    const hardTarget = join(dir, "hard-target.sqlite");
    const hardStore = new JobStore(hardTarget);
    hardStore.close();
    const hardLink = join(dir, "hard-link.sqlite");
    await link(hardTarget, hardLink);
    assert.throws(() => new JobStore(hardLink), /could not be opened safely/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second live coordinator cannot recover or mutate active job state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-job-owner-"));
  try {
    const path = join(dir, "jobs.sqlite");
    const owner = new JobStore(path, { now: 100 });
    owner.create({
      id: "still-queued",
      kind: "desktop",
      target: "node",
      createdAt: 100,
      expiresAt: 1000,
    });
    assert.throws(() => new JobStore(path, { now: 200 }), /already in use by another coordinator/);
    assert.equal(owner.get("still-queued")?.state, "queued");
    owner.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("coordinator shutdown is idempotent and releases its database lock", async () => {
  const f = await fixture();
  try {
    assert.doesNotThrow(() => f.app.shutdown());
    assert.doesNotThrow(() => f.app.shutdown());
    const reopened = new JobStore(join(f.dir, "jobs.sqlite"));
    reopened.close();
  } finally {
    await f.close();
  }
});

test("terminal job retention is bounded by age and row count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-job-retention-"));
  try {
    const store = new JobStore(join(dir, "jobs.sqlite"), {
      now: 0,
      retentionMs: 100,
      maxRows: 2,
    });
    for (let index = 0; index < 4; index++) {
      store.create({
        id: `job-${index}`,
        kind: "desktop",
        target: "node",
        createdAt: index * 10,
        expiresAt: 1000,
      });
      store.finish(`job-${index}`, "completed", "succeeded", true, index * 10);
    }
    assert.deepEqual(
      store.list().map((item) => item.id),
      ["job-3", "job-2"],
    );
    store.create({
      id: "later-job",
      kind: "desktop",
      target: "node",
      createdAt: 200,
      expiresAt: 1000,
    });
    store.finish("later-job", "completed", "succeeded", true, 200);
    assert.deepEqual(
      store.list().map((item) => item.id),
      ["later-job"],
    );
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("caller abort reaches a running node and records cancellation without claiming rollback", async () => {
  const f = await fixture();
  const stop = new AbortController();
  const request = new AbortController();
  let agent: Promise<void> | undefined;
  let executions = 0;
  try {
    const client = await f.pair("cancel-node");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client,
      preferences: defaults,
      signal: stop.signal,
      heartbeatMs: 10,
      reconnect: { baseMs: 1, maxMs: 5, random: () => 0.5 },
      executor: {
        capabilities: async () => [...CAPABILITIES],
        execute: async (_action: Action, signal?: AbortSignal) => {
          executions++;
          return new Promise((resolve) =>
            signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  ok: false,
                  message: "Cancellation requested; native completion is unknown.",
                }),
              { once: true },
            ),
          );
        },
      },
      onStatus: (status) => {
        if (status.startsWith("Node connected.")) ready();
      },
    });
    await registered;
    const command = client.call(
      "POST",
      "/v1/commands",
      { nodeId: "cancel-node", text: "open Arc" },
      { signal: request.signal },
    );
    void command.catch(() => {});
    await eventually(async () => {
      const jobs = (await client.call("GET", "/v1/jobs")) as Array<{ state: string }>;
      return jobs[0]?.state === "running";
    });
    request.abort();
    await assert.rejects(command, /side effect.*may still finish.*does not undo/);
    await eventually(async () => {
      const jobs = (await client.call("GET", "/v1/jobs")) as Array<{ state: string }>;
      return jobs[0]?.state === "cancelled";
    });
    assert.equal(executions, 1);
  } finally {
    stop.abort();
    await f.close();
    await agent;
  }
});

test("cancellation wins the delivered-to-start race and delivery commit failures send no job", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("race-node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const command = f.controller.call("POST", "/v1/commands", {
      nodeId: "race-node",
      text: "open Arc",
    });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    const cancelled = record(await f.controller.call("POST", `/v1/jobs/${task.id}`, {}));
    assert.equal(cancelled.state, "cancellation_requested");
    assert.equal(record(await node.call("POST", "/v1/start", { id: task.id })).cancel, true);
    await node.call("POST", "/v1/result", {
      id: task.id,
      result: { ok: false, message: "Never executed." },
    });
    assert.match(String(record(await command).message), /does not undo/);
    assert.equal(f.jobStore.get(task.id)?.state, "cancelled");

    const original = f.jobStore.markDelivered.bind(f.jobStore);
    f.jobStore.markDelivered = () => {
      throw new Error("synthetic commit failure");
    };
    const blocked = f.controller.call("POST", "/v1/commands", {
      nodeId: "race-node",
      text: "open Arc",
    });
    await assert.rejects(node.call("GET", "/v1/poll"), /delivery could not be committed/);
    assert.equal(record(await blocked).ok, false);
    f.jobStore.markDelivered = original;
  } finally {
    await f.close();
  }
});

test("undelivered jobs expire before delivery", async () => {
  const f = await fixture(40);
  try {
    const node = await f.pair("storage-node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const queued = f.controller.call("POST", "/v1/commands", {
      nodeId: "storage-node",
      text: "open Arc",
    });
    assert.equal(record(await queued).ok, false);
    assert.equal(f.jobStore.list()[0]?.state, "expired");
    assert.equal(f.jobStore.list()[0]?.outcomeCode, "expired_before_delivery");
  } finally {
    await f.close();
  }
});

test("a result commit failure quarantines the node", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("storage-node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const running = f.controller.call("POST", "/v1/commands", {
      nodeId: "storage-node",
      text: "open Arc",
    });
    void running.catch(() => {});
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    await node.call("POST", "/v1/start", { id: task.id });
    const original = f.jobStore.finish.bind(f.jobStore);
    f.jobStore.finish = () => {
      throw new Error("synthetic result commit failure");
    };
    await assert.rejects(
      node.call("POST", "/v1/result", {
        id: task.id,
        result: { ok: true, message: "Done." },
      }),
      /outcome could not be committed/,
    );
    await assert.rejects(running, /outcome could not be committed/);
    f.jobStore.finish = original;
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", {
        nodeId: "storage-node",
        text: "open Arc",
      }),
      /busy/,
    );
  } finally {
    await f.close();
  }
});

test("a cancellation persistence failure quarantines queued work before delivery", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("cancel-storage-node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const command = f.controller.call("POST", "/v1/commands", {
      nodeId: "cancel-storage-node",
      text: "open Arc",
    });
    void command.catch(() => {});
    await eventually(async () => f.jobStore.list()[0]?.state === "queued");
    const id = f.jobStore.list()[0]!.id;
    const original = f.jobStore.requestCancellation.bind(f.jobStore);
    f.jobStore.requestCancellation = () => {
      throw new Error("synthetic cancellation commit failure");
    };
    await assert.rejects(f.controller.call("POST", `/v1/jobs/${id}`, {}), /Request rejected/);
    await assert.rejects(command, /Cancellation state could not be committed/);
    await assert.rejects(node.call("GET", "/v1/poll"), /Cancellation state could not be committed/);
    assert.equal(f.jobStore.list()[0]?.state, "queued");
    f.jobStore.requestCancellation = original;
  } finally {
    await f.close();
  }
});

test("SQLite contains lifecycle metadata but no command, action, prompt, or response content", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("private-node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const command = f.controller.call("POST", "/v1/commands", {
      nodeId: "private-node",
      text: "open Arc",
    });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    await node.call("POST", "/v1/result", {
      id: task.id,
      result: { ok: true, message: "secret response content" },
    });
    await command;
    const bytes = await readFile(join(f.dir, "jobs.sqlite"));
    const image = bytes.toString("utf8");
    for (const secret of ["open Arc", "app.open", "secret response content"])
      assert.equal(image.includes(secret), false);
  } finally {
    await f.close();
  }
});

test("reconnect delay is exponentially bounded and jittered", () => {
  assert.equal(
    reconnectDelay(0, () => 0, { baseMs: 100, maxMs: 1000 }),
    100,
  );
  assert.equal(
    reconnectDelay(1, () => 0, { baseMs: 100, maxMs: 1000 }),
    150,
  );
  assert.equal(
    reconnectDelay(2, () => 1, { baseMs: 100, maxMs: 1000 }),
    500,
  );
  assert.equal(
    reconnectDelay(20, () => 1, { baseMs: 100, maxMs: 1000 }),
    1000,
  );
});

test("transport uses an absolute deadline and releases an interrupted long poll", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("deadline-node");
    await node.call("POST", "/v1/register", { capabilities: [] });
    const started = Date.now();
    await assert.rejects(
      node.call("GET", "/v1/poll", undefined, { timeoutMs: 30 }),
      /absolute deadline/,
    );
    assert.ok(Date.now() - started < 500);
    await assert.rejects(
      node.call("GET", "/v1/poll", undefined, { timeoutMs: 30 }),
      /absolute deadline/,
    );
  } finally {
    await f.close();
  }
});

test("node stop aborts an active long poll and connection events do not spam retries", async () => {
  const f = await fixture();
  const stop = new AbortController();
  let agent: Promise<void> | undefined;
  try {
    const node = await f.pair("stop-node");
    let ready!: () => void;
    const connected = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: stop.signal,
      onEvent: (event) => {
        if (event === "connected") ready();
      },
    });
    await connected;
    const started = Date.now();
    stop.abort();
    await agent;
    assert.ok(Date.now() - started < 500);
  } finally {
    stop.abort();
    await f.close();
    await agent;
  }

  const retryStop = new AbortController();
  const events: string[] = [];
  let registrations = 0;
  const fake = {
    call: async (
      _method: "GET" | "POST",
      path: string,
      _body?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> => {
      if (path === "/v1/register" && registrations++ === 0)
        throw new Error("synthetic network loss");
      if (path === "/v1/register") return { ok: true };
      if (path === "/v1/heartbeat") return { ok: true, cancelJobIds: [] };
      if (options?.signal?.aborted) throw new Error("stopped");
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        }),
      );
    },
  } as unknown as Client;
  await runNode({
    client: fake,
    preferences: defaults,
    signal: retryStop.signal,
    reconnect: { baseMs: 1, maxMs: 1, random: () => 0.5 },
    onEvent: (event) => {
      events.push(event);
      if (event === "connected") retryStop.abort();
    },
  });
  assert.deepEqual(events, ["reconnecting", "connected"]);
});

test("a lost result acknowledgement is retried after reconnect without replaying the action", async () => {
  const f = await fixture();
  const stop = new AbortController();
  let agent: Promise<void> | undefined;
  let executions = 0;
  let resultPosts = 0;
  let registrations = 0;
  let settleRead!: () => void;
  const settled = new Promise<void>((resolve) => {
    settleRead = resolve;
  });
  try {
    const node = await f.pair("result-reconnect-node");
    const client = {
      call: async (
        method: "GET" | "POST",
        path: string,
        body?: unknown,
        options?: { signal?: AbortSignal; timeoutMs?: number },
      ): Promise<unknown> => {
        if (path === "/v1/result") resultPosts++;
        if (path.startsWith("/v1/jobs/") && registrations < 2)
          throw new Error("synthetic interrupted connection");
        const reply = await node.call(method, path, body, options);
        if (path === "/v1/register") registrations++;
        if (path === "/v1/result" && resultPosts === 1)
          throw new Error("synthetic lost acknowledgement");
        if (path.startsWith("/v1/jobs/")) settleRead();
        return reply;
      },
    } as Client;
    let ready!: () => void;
    const connected = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client,
      preferences: defaults,
      signal: stop.signal,
      heartbeatMs: 10,
      reconnect: { baseMs: 1, maxMs: 1, random: () => 0.5 },
      executor: {
        capabilities: async () => [...CAPABILITIES],
        execute: async () => {
          executions++;
          return { ok: true, message: "Done." };
        },
      },
      onEvent: (event) => {
        if (event === "connected") ready();
      },
    });
    await connected;
    const command = record(
      await f.controller.call("POST", "/v1/commands", {
        nodeId: "result-reconnect-node",
        text: "open Arc",
      }),
    );
    assert.equal(command.ok, true);
    await settled;
    assert.equal(executions, 1);
    assert.equal(resultPosts, 2);
    assert.equal(registrations, 2);
    assert.equal(f.jobStore.list()[0]?.state, "completed");
    assert.equal(f.jobStore.list()[0]?.outcomeCode, "succeeded");
  } finally {
    stop.abort();
    await f.close();
    await agent;
  }
});

test("desktop job expiry aborts an active executor before a later action", async () => {
  const stop = new AbortController();
  let executions = 0;
  let delivered = false;
  let finish!: () => void;
  const resultReported = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const task = {
    version: VERSION,
    id: "expiring-job",
    expiresAt: Date.now() + 300,
    actions: [
      { tool: "app.open" as const, app: "company.thebrowser.Browser" },
      { tool: "app.open" as const, app: "com.apple.MobileSMS" },
    ],
  };
  const fake = {
    call: async (
      _method: "GET" | "POST",
      path: string,
      _body?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> => {
      if (path === "/v1/register") return { ok: true };
      if (path === "/v1/heartbeat") return { ok: true, cancelJobIds: [] };
      if (path === "/v1/start") return { cancel: false };
      if (path === "/v1/result") {
        finish();
        return { ok: true };
      }
      if (!delivered) {
        delivered = true;
        return { job: task };
      }
      if (options?.signal?.aborted) throw new Error("stopped");
      return new Promise((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        }),
      );
    },
  } as unknown as Client;
  const agent = runNode({
    client: fake,
    preferences: defaults,
    signal: stop.signal,
    executor: {
      capabilities: async () => [...CAPABILITIES],
      execute: async (_action, signal) => {
        executions++;
        return new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve({ ok: false, message: "Expired." }), {
            once: true,
          }),
        );
      },
    },
  });
  await resultReported;
  stop.abort();
  await agent;
  assert.equal(executions, 1);
});
