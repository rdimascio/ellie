import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  browserWebMCPRequest,
  browserWebMCPOperationResult,
  browserWebMCPResultFor,
  type BrowserWebMCPRequest,
} from "@ellie/protocol";
import { BrowserCompanionOperations } from "../apps/node/src/browser-companion-operations.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import {
  browserBindingRevision,
  type BrowserBinding,
} from "../apps/node/src/browser-operations.ts";

const binding = (suffix: string, url = "https://www.netflix.com/browse"): BrowserBinding => ({
  bindingId: `binding-${suffix}`,
  documentId: `document-${suffix}`,
  origin: "https://www.netflix.com",
  url,
  expiresAt: Date.now() + 60_000,
  availability: "companion",
});

test("companion wire admits only fixed commands and rejects arbitrary input", () => {
  const base = {
    protocol: "ellie.browser-webmcp.v1",
    id: "request-1",
    type: "media.execute",
    bindingId: "binding-1",
    documentId: "document-1",
  };
  const command = {
    type: "open",
    actionId: randomUUID(),
    snapshotId: randomUUID(),
    candidateId: randomUUID(),
  };
  assert.equal(browserWebMCPRequest({ ...base, command }).type, "media.execute");
  for (const invalid of [
    { ...command, url: "https://www.netflix.com/account" },
    { type: "search", actionId: randomUUID(), query: "anything" },
    { type: "play", actionId: randomUUID(), script: "alert(1)" },
  ])
    assert.throws(() => browserWebMCPRequest({ ...base, command: invalid }));
});

test("Netflix selector consumes read authority after one unknown and never enters WebMCP or AX", async () => {
  let selected = binding("browse");
  let bridgeCalls = 0;
  let webmcpCalls = 0;
  let axCalls = 0;
  const commands: string[] = [];
  const snapshotId = randomUUID(),
    first = randomUUID(),
    second = randomUUID();
  const bridge = {
    async request(request: Exclude<BrowserWebMCPRequest, { type: "cancel" }>) {
      bridgeCalls += 1;
      assert.equal(request.type, "media.execute");
      if (request.type !== "media.execute") throw new Error("wrong request");
      commands.push(request.command.type);
      const value =
        request.command.type === "inspect"
          ? selected.url.includes("/watch/")
            ? {
                snapshotId,
                candidates: [],
                playback: { available: true, paused: true },
                site: {
                  provider: "netflix",
                  page: "watch",
                  playback: "paused",
                  currentTimeSeconds: 4,
                },
              }
            : {
                snapshotId,
                candidates: [
                  { id: first, title: "Synthetic first" },
                  { id: second, title: "Synthetic second" },
                ],
                playback: { available: false },
                rowCandidateId: first,
                site: {
                  provider: "netflix",
                  page: "browse",
                  playback: "unavailable",
                  horizontalScrollAvailable: true,
                },
              }
          : { outcome: "scrolled" };
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: selected.bindingId,
        documentId: selected.documentId,
        url: selected.url,
        value,
      });
    },
  };
  const companion = new BrowserCompanionOperations(bridge);
  const selector = new BrowserOperationSelector(
    async () => selected,
    {
      execute: async () => {
        webmcpCalls += 1;
        throw new Error("wrong WebMCP adapter");
      },
    },
    {
      execute: async () => {
        axCalls += 1;
        throw new Error("wrong AX adapter");
      },
    } as never,
    companion,
  );
  const signal = new AbortController().signal;
  const revision = browserBindingRevision(selected);
  const status = browserWebMCPOperationResult(
    await selector.execute({ tool: "browser.status" }, signal),
  );
  assert.equal(status.browser.operation, "status");
  assert.equal(status.browser.source, "companion");
  const read = browserWebMCPOperationResult(
    await selector.execute({ tool: "browser.read", view: "summary", revision }, signal),
  );
  assert.equal(read.browser.operation, "read");
  if (read.browser.operation !== "read") throw new Error("wrong result");
  assert.deepEqual(
    read.browser.view.items.map(({ id }) => id),
    [first, second],
  );
  assert.equal(read.browser.view.site?.horizontalScrollAvailable, true);
  const scroll = browserWebMCPOperationResult(
    await selector.execute({ tool: "browser.scroll", direction: "right", revision }, signal),
  );
  assert.equal(scroll.browser.operation, "command");
  assert.equal(scroll.browser.status, "unknown");
  assert.deepEqual(commands, ["inspect", "scrollRow"]);
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "right", revision }, signal),
    /Read the Netflix page/,
  );
  await assert.rejects(
    () => selector.execute({ tool: "browser.search", query: "title", revision }, signal),
    /unsupported/,
  );
  assert.equal(bridgeCalls, 2, "unknown and unsupported search cannot dispatch again");
  assert.equal(webmcpCalls, 0);
  assert.equal(axCalls, 0);

  selected = binding("watch", "https://www.netflix.com/watch/123");
  const watchRevision = browserBindingRevision(selected);
  // A new document must be separately read before playback; old item/revision is stale.
  await assert.rejects(() =>
    selector.execute({ tool: "browser.select", itemId: first, revision }, signal),
  );
  await assert.rejects(
    () =>
      selector.execute(
        { tool: "browser.playback", action: "play", revision: watchRevision },
        signal,
      ),
    /Read the Netflix page/,
  );
  assert.equal(bridgeCalls, 2);
  const watchRead = browserWebMCPOperationResult(
    await selector.execute(
      { tool: "browser.read", view: "summary", revision: watchRevision },
      signal,
    ),
  );
  assert.equal(watchRead.browser.operation, "read");
  if (watchRead.browser.operation !== "read") throw new Error("wrong result");
  assert.equal(watchRead.browser.view.site?.playback, "paused");
  const play = browserWebMCPOperationResult(
    await selector.execute(
      { tool: "browser.playback", action: "play", revision: watchRevision },
      signal,
    ),
  );
  assert.equal(play.browser.status, "unknown");
  assert.deepEqual(commands, ["inspect", "scrollRow", "inspect", "play"]);
  await assert.rejects(
    () =>
      selector.execute(
        { tool: "browser.playback", action: "pause", revision: watchRevision },
        signal,
      ),
    /Read the Netflix page/,
  );
  assert.equal(bridgeCalls, 4);
});

test("a confirmed pre-effect companion rejection is failed or cancelled, never an unknown replay", async () => {
  for (const [bridgeStatus, expected] of [
    ["page_changed", "failed"],
    ["cancelled", "cancelled"],
  ] as const) {
    const current = binding(bridgeStatus);
    const revision = browserBindingRevision(current);
    let calls = 0;
    const companion = new BrowserCompanionOperations({
      async request(request) {
        if (request.type !== "media.execute") throw new Error("unexpected request");
        calls += 1;
        return request.command.type === "inspect"
          ? browserWebMCPResultFor(request.id, "ok", {
              bindingId: current.bindingId,
              documentId: current.documentId,
              url: current.url,
              value: {
                snapshotId: randomUUID(),
                candidates: [],
                playback: { available: false },
                site: { provider: "netflix", page: "browse", playback: "unavailable" },
              },
            })
          : browserWebMCPResultFor(request.id, bridgeStatus);
      },
    });
    await companion.execute(
      { tool: "browser.read", view: "summary", revision },
      current,
      new AbortController().signal,
    );
    const result = browserWebMCPOperationResult(
      await companion.execute(
        { tool: "browser.scroll", direction: "down", revision },
        current,
        new AbortController().signal,
      ),
    );
    assert.equal(result.browser.operation, "command");
    assert.equal(result.browser.status, expected);
    await assert.rejects(
      () =>
        companion.execute(
          { tool: "browser.scroll", direction: "down", revision },
          current,
          new AbortController().signal,
        ),
      /Read the Netflix page/,
    );
    assert.equal(calls, 2);
  }
});
