import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRemote } from "../apps/server/src/browser-remote.ts";

interface UpstreamCall {
  method: "GET" | "POST";
  path: string;
  body: unknown;
  options: { timeoutMs?: number } | undefined;
}

function upstreamReturning(value: unknown): {
  calls: UpstreamCall[];
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
} {
  const calls: UpstreamCall[] = [];
  return {
    calls,
    async call(method, path, body, options) {
      calls.push({ method, path, body, options });
      return value;
    },
  };
}

test("browser remote sends only the canonical finite app command upstream", async () => {
  const upstream = upstreamReturning({ ok: true, message: "untrusted upstream detail" });
  const remote = createBrowserRemote(upstream, [{ id: "living-room-mini", label: "Living room" }]);

  assert.deepEqual(await remote.openApp("living-room-mini", "safari"), {
    ok: true,
    message: "Opened Safari.",
  });
  assert.deepEqual(upstream.calls, [
    {
      method: "POST",
      path: "/v1/commands",
      body: { nodeId: "living-room-mini", text: "open app safari" },
      options: { timeoutMs: 35_000 },
    },
  ]);

  await assert.rejects(remote.openApp("unconfigured-mini", "arc"));
  await assert.rejects(remote.openApp("living-room-mini", "run arbitrary shell text" as never));
  assert.equal(upstream.calls.length, 1);
});

test("browser remote rejects invalid configured targets before upstream access", () => {
  const upstream = upstreamReturning([]);
  assert.throws(() => createBrowserRemote(upstream, []), /Invalid remote targets/);
  assert.throws(
    () =>
      createBrowserRemote(upstream, [
        { id: "living-room-mini", label: "Living room" },
        { id: "living-room-mini", label: "Duplicate" },
      ]),
    /Invalid remote targets/,
  );
  assert.throws(() => createBrowserRemote(upstream, [{ id: "../private", label: "Invalid id" }]));
  assert.throws(
    () => createBrowserRemote(upstream, [{ id: "living-room-mini", label: "secret\nlabel" }]),
    /Invalid remote label/,
  );
  assert.deepEqual(upstream.calls, []);
});

test("browser remote rejects malformed coordinator responses", async () => {
  const malformedNodes = upstreamReturning({ nodes: [] });
  const nodesRemote = createBrowserRemote(malformedNodes, [
    { id: "living-room-mini", label: "Living room" },
  ]);
  await assert.rejects(nodesRemote.nodes(), /Nodes unavailable/);

  const excessiveNodes = upstreamReturning(Array.from({ length: 129 }, () => ({})));
  const excessiveRemote = createBrowserRemote(excessiveNodes, [
    { id: "living-room-mini", label: "Living room" },
  ]);
  await assert.rejects(excessiveRemote.nodes(), /Nodes unavailable/);

  const malformedCommand = upstreamReturning({ ok: "yes", message: "private detail" });
  const commandRemote = createBrowserRemote(malformedCommand, [
    { id: "living-room-mini", label: "Living room" },
  ]);
  await assert.rejects(commandRemote.openApp("living-room-mini", "arc"), /outcome unknown/i);
});

test("browser remote preserves the explicit refresh operation and validates a status result", async () => {
  const upstream = upstreamReturning({
    ok: true,
    message: "Browser tab connected.",
    browser: {
      source: "accessibility",
      operation: "status",
      status: "connected",
      revision: "fresh-revision",
      origin: "https://www.youtube.com",
    },
  });
  const remote = createBrowserRemote(upstream, [{ id: "living-room-mini", label: "Living room" }]);
  assert.ok(remote.execute);
  const result = await remote.execute("living-room-mini", { tool: "browser.refresh" });
  assert.ok("browser" in result);
  assert.equal(result.browser.operation, "status");
  assert.deepEqual(upstream.calls[0]?.body, {
    nodeId: "living-room-mini",
    action: { tool: "browser.refresh" },
  });
});

test("browser remote replaces upstream failure detail with a fixed public result", async () => {
  const upstream = upstreamReturning({
    ok: false,
    message: "credential failed at /private/coordinator/path",
    token: "upstream-secret",
  });
  const remote = createBrowserRemote(upstream, [{ id: "living-room-mini", label: "Living room" }]);
  const result = await remote.openApp("living-room-mini", "messages");
  assert.deepEqual(result, {
    ok: false,
    message: "The app could not be opened. Check the selected Mac.",
  });
  assert.doesNotMatch(JSON.stringify(result), /credential|private|token|secret/);
});

test("browser remote projects configured nodes with bounded freshness and app capability", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const upstream = upstreamReturning([
    {
      id: "fresh-mini",
      label: "Untrusted replacement",
      lastSeen: now,
      executionCapabilities: ["app.open", "private.admin"],
      privateTelemetry: "secret",
    },
    { id: "legacy-mini", lastSeen: now, capabilities: ["app.open"] },
    { id: "stale-mini", lastSeen: now - 60_001, executionCapabilities: ["app.open"] },
    { id: "future-mini", lastSeen: now + 5_001, executionCapabilities: ["app.open"] },
    { id: "incapable-mini", lastSeen: now, executionCapabilities: ["url.open"] },
    { id: "unconfigured-mini", lastSeen: now, executionCapabilities: ["app.open"] },
  ]);
  const remote = createBrowserRemote(upstream, [
    { id: "fresh-mini", label: "Fresh" },
    { id: "legacy-mini", label: "Legacy" },
    { id: "stale-mini", label: "Stale" },
    { id: "future-mini", label: "Future" },
    { id: "incapable-mini", label: "Incapable" },
    { id: "missing-mini", label: "Missing" },
  ]);

  assert.deepEqual(await remote.nodes(), [
    { id: "fresh-mini", label: "Fresh", online: true, capabilities: ["app.open"] },
    { id: "legacy-mini", label: "Legacy", online: true, capabilities: ["app.open"] },
    { id: "stale-mini", label: "Stale", online: false, capabilities: ["app.open"] },
    { id: "future-mini", label: "Future", online: false, capabilities: ["app.open"] },
    { id: "incapable-mini", label: "Incapable", online: false, capabilities: [] },
    { id: "missing-mini", label: "Missing", online: false, capabilities: [] },
  ]);
  assert.deepEqual(upstream.calls, [
    {
      method: "GET",
      path: "/v1/nodes",
      body: undefined,
      options: { timeoutMs: 5000 },
    },
  ]);
});

test("native bridge forwards cancellation to both pinned discovery and command requests", async () => {
  const controller = new AbortController();
  const calls: { timeoutMs?: number; signal?: AbortSignal }[] = [];
  const remote = createBrowserRemote(
    {
      async call(_method, path, _body, options) {
        calls.push(options!);
        return path === "/v1/nodes" ? [] : { ok: true };
      },
    },
    [{ id: "test-mini", label: "Test Mac" }],
  );
  await remote.nodes({ signal: controller.signal });
  await remote.openApp("test-mini", "arc", { signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.timeoutMs),
    [5000, 35_000],
  );
  assert.ok(calls.every((call) => call.signal === controller.signal));
  controller.abort();
  assert.ok(calls.every((call) => call.signal?.aborted));
});

test("production remote derives a bounded dynamic inventory from registered coordinator nodes", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const inventory = [
    { id: "living-room-mini", lastSeen: now, executionCapabilities: ["app.open"] },
    { id: "office-mini", lastSeen: now - 60_001, capabilities: ["app.open"] },
  ];
  const upstream = {
    calls: [] as UpstreamCall[],
    async call(
      method: "GET" | "POST",
      path: string,
      body?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<unknown> {
      this.calls.push({ method, path, body, options });
      return method === "GET" ? inventory : { ok: false };
    },
  };
  const remote = createBrowserRemote(upstream);
  assert.deepEqual(await remote.nodes(), [
    {
      id: "living-room-mini",
      label: "Mac · living-room-mini",
      online: true,
      capabilities: ["app.open"],
    },
    {
      id: "office-mini",
      label: "Mac · office-mini",
      online: false,
      capabilities: ["app.open"],
    },
  ]);
  assert.deepEqual(await remote.openApp("living-room-mini", "arc"), {
    ok: false,
    message: "The app could not be opened. Check the selected Mac.",
  });
});

test("production remote rejects excessive duplicate and noncanonical registered inventories", async () => {
  for (const value of [
    Array.from({ length: 17 }, (_, index) => ({ id: `mac-${index}` })),
    [{ id: "mac-a" }, { id: "mac-a" }],
    [{ id: "../private" }],
  ]) {
    await assert.rejects(createBrowserRemote(upstreamReturning(value)).nodes());
  }
});
