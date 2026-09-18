import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { browserWebMCPOperationResult, browserWebMCPResultFor } from "@ellie/protocol";
import { BrowserCompanionOperations } from "../apps/node/src/browser-companion-operations.ts";
import { BrowserOperationSelector } from "../apps/node/src/browser-operation-selector.ts";
import {
  browserBindingRevision,
  type BrowserBinding,
} from "../apps/node/src/browser-operations.ts";

const binding: BrowserBinding = {
  bindingId: "disney-binding",
  documentId: "disney-document",
  origin: "https://www.disneyplus.com",
  url: "https://www.disneyplus.com/browse/entity-2fa6a394-c272-41ef-afaa-714116cb16f2",
  expiresAt: Date.now() + 60_000,
  availability: "companion",
};
const revision = browserBindingRevision(binding);
const result = (site: Record<string, unknown>) => ({
  ok: true,
  message: "Observed.",
  browser: {
    source: "companion",
    operation: "read",
    status: "completed",
    revision,
    view: { items: [], site },
  },
});

test("Disney+ site wire accepts only browse/login/unsupported with unavailable playback", () => {
  assert.equal(
    browserWebMCPOperationResult(
      result({ provider: "disneyplus", page: "browse", playback: "unavailable" }),
    ).browser.operation,
    "read",
  );
  for (const invalid of [
    { provider: "disneyplus", page: "watch", playback: "paused" },
    { provider: "disneyplus", page: "browse", playback: "playing" },
    { provider: "disneyplus", page: "browse", playback: "unavailable", rows: [] },
    { provider: "disneyplus", page: "results", playback: "unavailable" },
    { provider: "disneyplus", page: "browse", playback: "unavailable", currentTimeSeconds: 1 },
  ])
    assert.throws(() => browserWebMCPOperationResult(result(invalid)));
});

test("Disney+ production selector permits one observed title choice, never search/play/replay", async () => {
  const candidate = randomUUID();
  const commands: string[] = [];
  let page: "browse" | "login" = "browse";
  let wrongAdapter = 0;
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute") throw new Error("wrong request");
      commands.push(request.command.type);
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        url: binding.url,
        value:
          request.command.type === "inspect"
            ? {
                snapshotId: randomUUID(),
                candidates: page === "browse" ? [{ id: candidate, title: "Observed title" }] : [],
                playback: { available: false },
                site: { provider: "disneyplus", page, playback: "unavailable" },
              }
            : { outcome: "navigation_observed" },
      });
    },
  });
  const selector = new BrowserOperationSelector(
    async () => binding,
    {
      execute: async () => {
        wrongAdapter += 1;
        throw new Error("wrong WebMCP adapter");
      },
    },
    {
      execute: async () => {
        wrongAdapter += 1;
        throw new Error("wrong Accessibility adapter");
      },
    } as never,
    companion,
  );
  const signal = new AbortController().signal;
  const read = () => selector.execute({ tool: "browser.read", view: "summary", revision }, signal);
  const observed = browserWebMCPOperationResult(await read());
  assert.equal(observed.browser.operation, "read");
  assert.equal(observed.browser.view.items[0]?.label, "Observed title");
  for (const forbidden of [
    { tool: "browser.search", query: "movie", revision },
    { tool: "browser.scroll", direction: "left", revision },
    { tool: "browser.playback", action: "play", revision },
  ])
    await assert.rejects(() => selector.execute(forbidden as never, signal), /Disney\+/);
  assert.deepEqual(commands, ["inspect"]);
  await assert.rejects(
    () =>
      selector.execute(
        { tool: "browser.select", itemId: candidate, revision: "0".repeat(64) },
        signal,
      ),
    /changed before/,
  );
  assert.deepEqual(commands, ["inspect"]);
  const choice = browserWebMCPOperationResult(
    await selector.execute({ tool: "browser.select", itemId: candidate, revision }, signal),
  );
  assert.equal(choice.browser.operation, "command");
  assert.equal(choice.browser.status, "unknown");
  await assert.rejects(
    () => selector.execute({ tool: "browser.select", itemId: candidate, revision }, signal),
    /Read the Disney\+ page/,
  );
  assert.deepEqual(commands, ["inspect", "open"]);
  page = "login";
  await read();
  await assert.rejects(
    () => selector.execute({ tool: "browser.select", itemId: candidate, revision }, signal),
    /needs attention/,
  );
  assert.deepEqual(commands, ["inspect", "open", "inspect"]);
  assert.equal(wrongAdapter, 0);
});

test("Disney+ one vertical scroll consumes its read without fallback or replay", async () => {
  const commands: string[] = [];
  let currentBinding = binding;
  let page: "browse" | "login" = "browse";
  let wrongAdapter = 0;
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute") throw new Error("wrong request");
      commands.push(request.command.type);
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: currentBinding.bindingId,
        documentId: currentBinding.documentId,
        url: currentBinding.url,
        value:
          request.command.type === "inspect"
            ? {
                snapshotId: randomUUID(),
                candidates: [],
                playback: { available: false },
                site: { provider: "disneyplus", page, playback: "unavailable" },
              }
            : { outcome: "scrolled" },
      });
    },
  });
  const selector = new BrowserOperationSelector(
    async () => currentBinding,
    {
      execute: async () => {
        wrongAdapter++;
        throw new Error("wrong WebMCP adapter");
      },
    },
    {
      execute: async () => {
        wrongAdapter++;
        throw new Error("wrong Accessibility adapter");
      },
    } as never,
    companion,
  );
  const signal = new AbortController().signal;
  const read = () => selector.execute({ tool: "browser.read", view: "summary", revision }, signal);
  await read();
  const moved = browserWebMCPOperationResult(
    await selector.execute({ tool: "browser.scroll", direction: "down", revision }, signal),
  );
  assert.equal(moved.browser.operation, "command");
  assert.equal(moved.browser.status, "unknown");
  assert.deepEqual(commands, ["inspect", "scrollViewport"]);
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "down", revision }, signal),
    /Read the Disney\+ page/,
  );
  assert.deepEqual(commands, ["inspect", "scrollViewport"]);
  assert.equal(wrongAdapter, 0);

  page = "login";
  await read();
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "up", revision }, signal),
    /needs attention/,
  );
  assert.deepEqual(commands, ["inspect", "scrollViewport", "inspect"]);
  page = "browse";
  await read();
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "up", revision }, cancelled.signal),
    /cancelled/,
  );
  assert.deepEqual(commands, ["inspect", "scrollViewport", "inspect", "inspect"]);

  currentBinding = { ...binding, documentId: "replacement-document" };
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "up", revision }, signal),
    /changed before/,
  );
  assert.deepEqual(commands, ["inspect", "scrollViewport", "inspect", "inspect"]);
});
