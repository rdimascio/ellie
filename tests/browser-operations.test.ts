import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync } from "node:fs";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_WEBMCP_PROTOCOL,
  browserWebMCPAction,
  browserWebMCPResultFor,
  browserWebMCPOperationResult,
  result,
  type BrowserWebMCPRequest,
} from "@ellie/protocol";
import {
  canonicalReviewedBrowserRegistry,
  loadReviewedBrowserRegistry,
  reviewedBrowserRegistry,
} from "../apps/node/src/browser-operation-registry.ts";
import { BrowserWebMCPOperations } from "../apps/node/src/browser-operations.ts";

const schema = { additionalProperties: false, type: "object" };
const schemaHash = createHash("sha256")
  .update('{"additionalProperties":false,"type":"object"}')
  .digest("hex");
const successHash = createHash("sha256").update('{"applied":true}').digest("hex");
const registry = reviewedBrowserRegistry({
  version: 1,
  bindings: [
    {
      id: "summary",
      origin: "https://video.example",
      operation: "read",
      toolName: "read_view",
      inputSchemaSha256: schemaHash,
    },
    ...["scroll", "search", "select", "playback"].map((operation) => ({
      id: operation,
      origin: "https://video.example",
      operation,
      toolName: operation,
      inputSchemaSha256: schemaHash,
      successValueSha256: successHash,
      argumentKey: operation === "select" ? "item" : operation,
    })),
  ],
});

test("browser operation and structured result contracts are closed and bounded", () => {
  assert.deepEqual(browserWebMCPAction({ tool: "browser.status" }), {
    tool: "browser.status",
  });
  assert.deepEqual(
    browserWebMCPAction({
      tool: "browser.scroll",
      direction: "right",
      revision: "a".repeat(64),
    }),
    {
      tool: "browser.scroll",
      direction: "right",
      revision: "a".repeat(64),
    },
  );
  for (const malformed of [
    { tool: "browser.status", extra: true },
    { tool: "browser.scroll", direction: "diagonal", revision: "x" },
    { tool: "browser.search", query: "x".repeat(201), revision: "x" },
    {
      tool: "browser.select",
      itemId: "label with spaces",
      revision: "x",
    },
  ])
    assert.throws(() => browserWebMCPAction(malformed));

  const old = result({ ok: true, message: "Done." });
  assert.deepEqual(old, { ok: true, message: "Done." });
  assert.throws(() =>
    browserWebMCPOperationResult({
      ok: true,
      message: "x",
      browser: {
        source: "webmcp",
        operation: "read",
        status: "completed",
        revision: "r",
        view: {
          items: Array.from({ length: 65 }, (_, index) => ({ id: `i${index}`, label: "x" })),
        },
      },
    }),
  );
  assert.deepEqual(
    browserWebMCPOperationResult({
      ok: true,
      message: "x",
      browser: {
        source: "accessibility",
        operation: "status",
        status: "connected",
        revision: "r",
        origin: "https://video.example",
      },
    }),
    {
      ok: true,
      message: "x",
      browser: {
        source: "accessibility",
        operation: "status",
        status: "connected",
        revision: "r",
        origin: "https://video.example",
      },
    },
  );
  assert.throws(() =>
    browserWebMCPOperationResult({
      ok: true,
      message: "overclaimed",
      browser: {
        source: "accessibility",
        operation: "command",
        status: "completed",
        revision: "r",
      },
    }),
  );
});

test("reviewed browser registry is canonical, private and rejects unsafe authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ellie-browser-registry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moved = `${root}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true }));
  const path = join(root, "registry.json");
  await writeFile(path, canonicalReviewedBrowserRegistry(registry), { mode: 0o600 });
  assert.deepEqual(loadReviewedBrowserRegistry(path), registry);
  await chmod(path, 0o644);
  assert.throws(() => loadReviewedBrowserRegistry(path));
  await rm(path);
  await symlink(join(root, "missing"), path);
  assert.throws(() => loadReviewedBrowserRegistry(path));
  assert.throws(() =>
    reviewedBrowserRegistry({
      version: 1,
      bindings: [{ ...registry.bindings[0], origin: "https://video.example/path" }],
    }),
  );

  await rm(path);
  await writeFile(path, canonicalReviewedBrowserRegistry(registry), { mode: 0o600 });
  assert.throws(() =>
    loadReviewedBrowserRegistry(path, {
      beforeFinalValidation() {
        renameSync(root, moved);
        mkdirSync(root, { mode: 0o700 });
      },
    }),
  );
});

test("executor binds reviewed WebMCP tools, returns typed views and rejects stale selections", async () => {
  const calls: BrowserWebMCPRequest[] = [];
  let documentId = "document-1";
  let changeAfterList = false;
  let incompatibleAnnotations = false;
  const bridge = {
    async request(request: BrowserWebMCPRequest) {
      calls.push(request);
      if (request.type === "binding.status")
        return browserWebMCPResultFor(request.id, "ok", {
          bindingId: "binding-1",
          documentId,
          origin: "https://video.example",
          url: "https://video.example/watch",
          expiresAt: Date.now() + 60_000,
          availability: "webmcp",
        });
      if (request.type === "tools.list") {
        const response = browserWebMCPResultFor(request.id, "ok", {
          bindingId: "binding-1",
          documentId,
          tools: registry.bindings.map((item) => ({
            handle: `handle-${item.operation}`,
            name: item.toolName,
            description: "reviewed fixture",
            inputSchema: schema,
            annotations: {
              ...(incompatibleAnnotations
                ? { destructiveHint: false, idempotentHint: true }
                : { untrustedContentHint: false, consequentialHint: false }),
              readOnlyHint: item.operation === "read",
            },
          })),
        });
        if (changeAfterList) documentId = "document-after-list";
        return response;
      }
      if (request.type === "tool.execute" && request.documentId !== documentId)
        return browserWebMCPResultFor(request.id, "page_changed");
      if (request.type === "tool.execute" && request.toolHandle === "handle-read")
        return browserWebMCPResultFor(request.id, "ok", {
          items: [{ id: "episode-1", label: "Episode one" }],
        });
      return browserWebMCPResultFor(request.id, "ok", { applied: true });
    },
  };
  const executor = new BrowserWebMCPOperations(bridge, registry);
  const status = await executor.execute({ tool: "browser.status" }, AbortSignal.timeout(1000));
  assert.equal(status.browser.operation, "status");
  assert.equal(status.browser.source, "webmcp");
  assert.equal(status.browser.status, "connected");
  const currentRevision = status.browser.revision!;
  const view = await executor.execute(
    { tool: "browser.read", view: "summary", revision: currentRevision },
    AbortSignal.timeout(1000),
  );
  assert.deepEqual(view.browser.operation === "read" ? view.browser.view.items : [], [
    { id: "episode-1", label: "Episode one" },
  ]);
  await executor.execute(
    {
      tool: "browser.select",
      itemId: "episode-1",
      revision: currentRevision,
    },
    AbortSignal.timeout(1000),
  );
  const selection = calls.find(
    (call) => call.type === "tool.execute" && call.toolHandle === "handle-select",
  );
  assert.deepEqual(selection?.type === "tool.execute" ? selection.args : undefined, {
    item: "episode-1",
  });
  const unknownBridge = {
    ...bridge,
    async request(request: BrowserWebMCPRequest) {
      if (request.type === "tool.execute")
        return browserWebMCPResultFor(request.id, "ok", { applied: false });
      return bridge.request(request);
    },
  };
  const unknownExecutor = new BrowserWebMCPOperations(unknownBridge, registry);
  const unknown = await unknownExecutor.execute(
    {
      tool: "browser.playback",
      action: "play",
      revision: currentRevision,
    },
    AbortSignal.timeout(1000),
  );
  assert.equal(unknown.browser.operation === "command" ? unknown.browser.status : "", "unknown");
  incompatibleAnnotations = true;
  await assert.rejects(() =>
    executor.execute(
      {
        tool: "browser.playback",
        action: "play",
        revision: currentRevision,
      },
      AbortSignal.timeout(1000),
    ),
  );
  incompatibleAnnotations = false;
  documentId = "document-race";
  const raceStatus = await executor.execute({ tool: "browser.status" }, AbortSignal.timeout(1000));
  const raceRevision = raceStatus.browser.revision!;
  changeAfterList = true;
  const raced = await executor.execute(
    {
      tool: "browser.playback",
      action: "pause",
      revision: raceRevision,
    },
    AbortSignal.timeout(1000),
  );
  assert.equal(raced.browser.operation === "command" ? raced.browser.status : "", "unknown");
  changeAfterList = false;
  await assert.rejects(() =>
    executor.execute(
      {
        tool: "browser.select",
        itemId: "unobserved",
        revision: currentRevision,
      },
      AbortSignal.timeout(1000),
    ),
  );
  documentId = "document-2";
  const dispatchedBeforeStaleRevision = calls.filter((call) => call.type === "tool.execute").length;
  await assert.rejects(() =>
    executor.execute(
      {
        tool: "browser.playback",
        action: "play",
        revision: currentRevision,
      },
      AbortSignal.timeout(1000),
    ),
  );
  assert.equal(calls.at(-1)?.type, "binding.status");
  assert.equal(
    calls.filter((call) => call.type === "tool.execute").length,
    dispatchedBeforeStaleRevision,
  );
  assert.equal(BROWSER_WEBMCP_PROTOCOL, "ellie.browser-webmcp.v1");
});
