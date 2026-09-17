import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@ellie/config";
import { Client, discoverCertificate, fingerprint } from "@ellie/transport";
import { record, job, CAPABILITIES } from "@ellie/protocol";
import type { Action } from "@ellie/protocol";
import { runNode } from "../apps/node/src/index.ts";

import { fixture } from "./helpers.ts";

test("coordinator exposes a cancelled delivered command as settling only until node outcome", async () => {
  const f = await fixture(5_000);
  const stop = new AbortController();
  let agent: Promise<void> | undefined;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let dispatches = 0;
  try {
    const node = await f.pair("settling-node");
    let registered!: () => void;
    const ready = new Promise<void>((resolve) => (registered = resolve));
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: stop.signal,
      heartbeatMs: 100,
      executor: {
        capabilities: async () => [...CAPABILITIES],
        async execute(_action, signal) {
          dispatches++;
          entered();
          await held;
          signal?.throwIfAborted();
          return { ok: true, message: "Unexpected completed action." };
        },
      },
      onStatus: (status) => {
        if (status.startsWith("Node connected")) registered();
      },
    });
    let registrationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          registrationTimer = setTimeout(
            () => reject(new Error("Node registration timed out.")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (registrationTimer) clearTimeout(registrationTimer);
    }
    const caller = new AbortController();
    const command = f.controller.call(
      "POST",
      "/v1/commands",
      {
        nodeId: "settling-node",
        action: {
          tool: "browser.scroll",
          direction: "down",
          revision: "observed-revision",
        },
      },
      { signal: caller.signal },
    );
    await started;
    const cancellation = assert.rejects(command);
    caller.abort();
    await cancellation;
    const deadline = Date.now() + 2_000;
    let settling = false;
    while (Date.now() < deadline) {
      const nodes = (await f.controller.call("GET", "/v1/nodes")) as Array<{
        id: string;
        cancellationSettling?: true;
      }>;
      if (nodes.find((item) => item.id === "settling-node")?.cancellationSettling === true) {
        settling = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(settling, true);
    assert.equal(dispatches, 1);
    release();
    let cleared = false;
    const clearDeadline = Date.now() + 2_000;
    while (Date.now() < clearDeadline) {
      const nodes = (await f.controller.call("GET", "/v1/nodes")) as Array<{
        id: string;
        cancellationSettling?: true;
      }>;
      if (nodes.find((item) => item.id === "settling-node")?.cancellationSettling !== true) {
        cleared = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(cleared, true);
    assert.equal(dispatches, 1);
  } finally {
    release?.();
    stop.abort();
    if (agent) await agent;
    await f.close();
  }
});

test("real HTTPS command round trip through node executor with contextual follow-up", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const calls: Action[] = [];
  let agent: Promise<void> | undefined;
  try {
    const node = await f.pair("test-node");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client: node,
      preferences: defaults,
      signal: abort.signal,
      executor: {
        capabilities: async () => [...CAPABILITIES],
        execute: async (action) => {
          calls.push(action);
          return { ok: true, message: "Done." };
        },
      },
      onStatus: () => ready(),
    });
    await registered;
    for (const text of [
      "Ellie, open Arc",
      "put it in the top-left",
      "open Netflix",
      "move Arc to the big monitor and make it fullscreen",
      "put Messages next to it",
    ]) {
      assert.equal(
        record(await node.call("POST", "/v1/commands", { nodeId: "test-node", text })).ok,
        true,
      );
    }
    assert.deepEqual(
      calls.map((action) => action.tool),
      ["app.open", "window.place", "url.open", "window.place", "window.adjacent"],
    );
    assert.equal(record(calls[4]).anchor, defaults.browser);
    assert.equal(
      record(
        await node.call("POST", "/v1/commands", { nodeId: "test-node", text: "delete all files" }),
      ).ok,
      false,
    );
    assert.equal(calls.length, 5);
  } finally {
    abort.abort();
    await f.close();
    await agent;
  }
});
test("wrong fingerprint is rejected before credentials are sent", async () => {
  const f = await fixture();
  let requests = 0;
  f.app.server.on("request", () => {
    requests++;
  });
  try {
    await assert.rejects(discoverCertificate(f.origin, "00".repeat(32)), /fingerprint/);
    assert.equal(requests, 0);
    const cert = await discoverCertificate(f.origin, fingerprint(f.cert));
    assert.equal(fingerprint(cert), fingerprint(f.cert));
    assert.equal(requests, 0);
    const stranger = new Client(f.origin, f.cert);
    try {
      await assert.rejects(stranger.call("GET", "/v1/nodes"), /Authentication/);
    } finally {
      stranger.close();
    }
  } finally {
    await f.close();
  }
});
test("node credentials cannot control another Mac, issue invites, or spoof its result", async () => {
  const f = await fixture();
  try {
    const a = await f.pair("node-a");
    const b = await f.pair("node-b");
    for (const client of [a, b])
      await client.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    await assert.rejects(
      a.call("POST", "/v1/commands", { nodeId: "node-b", text: "open Arc" }),
      /themselves/,
    );
    await assert.rejects(a.call("POST", "/v1/invite", {}), /unavailable/);
    const pending = f.controller.call("POST", "/v1/commands", {
      nodeId: "node-b",
      text: "open Arc",
    });
    const task = job(record(await b.call("GET", "/v1/poll")).job);
    await assert.rejects(
      a.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } }),
      /matching/,
    );
    await b.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Done." } });
    assert.equal(record(await pending).ok, true);
    await f.controller.call("POST", "/v1/revoke", { id: "node-a" });
    await assert.rejects(a.call("GET", "/v1/nodes"), /Authentication/);
  } finally {
    await f.close();
  }
});
test("timeouts do not replay commands, failed actions do not advance pronoun context", async (t) => {
  const f = await fixture(150);
  try {
    const node = await f.pair("node");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const storageWait = new Int32Array(new SharedArrayBuffer(4));
    const delayDurableWrite = () => Atomics.wait(storageWait, 0, 0, 175);
    const create = f.jobStore.create.bind(f.jobStore);
    const markDelivered = f.jobStore.markDelivered.bind(f.jobStore);
    t.mock.method(f.jobStore, "create", (input: Parameters<typeof create>[0]) => {
      delayDurableWrite();
      create(input);
    });
    t.mock.method(f.jobStore, "markDelivered", (id: string, now?: number) => {
      delayDurableWrite();
      markDelivered(id, now);
    });
    const pending = node.call("POST", "/v1/commands", { nodeId: "node", text: "open Arc" });
    const task = job(record(await node.call("GET", "/v1/poll")).job);
    t.mock.timers.tick(151);
    assert.equal(record(await pending).ok, false);
    await assert.rejects(
      node.call("POST", "/v1/result", { id: task.id, result: { ok: true, message: "Late." } }),
      /matching/,
    );
    assert.equal(
      record(
        await node.call("POST", "/v1/commands", { nodeId: "node", text: "put it in the top-left" }),
      ).ok,
      false,
    );
    const failure = node.call("POST", "/v1/commands", { nodeId: "node", text: "open Arc" });
    const next = job(record(await node.call("GET", "/v1/poll")).job);
    assert.notEqual(next.id, task.id);
    await node.call("POST", "/v1/result", {
      id: next.id,
      result: { ok: false, message: "App missing." },
    });
    assert.equal(record(await failure).ok, false);
    assert.equal(
      record(
        await node.call("POST", "/v1/commands", { nodeId: "node", text: "put it in the top-left" }),
      ).ok,
      false,
    );
  } finally {
    await f.close();
  }
});
test("node applies its own permission policy even when the server grants a tool", async () => {
  const f = await fixture();
  const abort = new AbortController();
  let agent: Promise<void> | undefined;
  try {
    const node = await f.pair("restricted");
    let ready!: () => void;
    const registered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    agent = runNode({
      client: node,
      signal: abort.signal,
      preferences: { ...defaults, browser: "com.apple.Safari", apps: {} },
      executor: {
        capabilities: async () => [...CAPABILITIES],
        execute: async () => {
          throw new Error("Should never execute");
        },
      },
      onStatus: () => ready(),
    });
    await registered;
    const response = record(
      await node.call("POST", "/v1/commands", { nodeId: "restricted", text: "open Arc" }),
    );
    assert.equal(response.ok, false);
    assert.match(String(response.message), /not allowed/);
  } finally {
    abort.abort();
    await f.close();
    await agent;
  }
});
test("coordinator rejects unknown, oversized, and ungranted commands before dispatch", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("bounded");
    await node.call("POST", "/v1/register", { capabilities: [] });
    await assert.rejects(
      node.call("POST", "/v1/commands", { nodeId: "bounded", text: "open Arc" }),
      /Request rejected/,
    );
    await node.call("POST", "/v1/register", { capabilities: ["app.open"] });
    await assert.rejects(
      node.call("POST", "/v1/commands", { nodeId: "bounded", text: "x".repeat(501) }),
      /Request rejected/,
    );
    const unsupported = record(
      await node.call("POST", "/v1/commands", { nodeId: "bounded", text: "shell.exec whoami" }),
    );
    assert.equal(unsupported.ok, false);
  } finally {
    await f.close();
  }
});

test("command target errors distinguish unknown IDs from paired offline nodes", async () => {
  const f = await fixture();
  try {
    await f.pair("known-offline");
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", {
        nodeId: "known-offline",
        text: "open Arc",
      }),
      /paired but offline.*node service/,
    );
    await assert.rejects(
      f.controller.call("POST", "/v1/commands", {
        nodeId: "NODE_ID",
        text: "open Arc",
      }),
      /Unknown node ID.*ellie nodes.*exact ID/,
    );
  } finally {
    await f.close();
  }
});

test("explicit app grammar never falls through to a matching site alias", async () => {
  const f = await fixture();
  try {
    const node = await f.pair("explicit-app");
    await node.call("POST", "/v1/register", { capabilities: [...CAPABILITIES] });
    const response = record(
      await f.controller.call("POST", "/v1/commands", {
        nodeId: "explicit-app",
        text: "open app Netflix",
      }),
    );
    assert.equal(response.ok, false);
    assert.deepEqual(await f.controller.call("GET", "/v1/jobs"), []);
  } finally {
    await f.close();
  }
});
