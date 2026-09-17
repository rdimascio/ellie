import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  browserWebMCPAction,
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
  const rowId = randomUUID();
  assert.deepEqual(
    browserWebMCPAction({
      tool: "browser.scrollRow",
      direction: "right",
      rowId,
      revision: "a".repeat(64),
    }),
    { tool: "browser.scrollRow", direction: "right", rowId, revision: "a".repeat(64) },
  );
  assert.throws(() =>
    browserWebMCPAction({
      tool: "browser.scrollRow",
      direction: "right",
      rowId: "a[href]",
      revision: "a".repeat(64),
    }),
  );
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
  assert.equal(
    browserWebMCPRequest({
      ...base,
      command: {
        type: "scrollSelectedRow",
        actionId: randomUUID(),
        snapshotId: randomUUID(),
        rowId: randomUUID(),
        direction: "right",
      },
    }).type,
    "media.execute",
  );
  const observedSearch = {
    type: "searchObserved",
    actionId: randomUUID(),
    snapshotId: randomUUID(),
    controlId: randomUUID(),
    query: `Space " & < 🌙`,
  };
  assert.deepEqual(browserWebMCPRequest({ ...base, command: observedSearch }), {
    ...base,
    command: observedSearch,
  });
  for (const invalid of [
    { ...command, url: "https://www.netflix.com/account" },
    { type: "search", actionId: randomUUID(), query: "anything" },
    { ...observedSearch, query: "<script>\n" },
    { ...observedSearch, controlId: "input[type=search]" },
    { ...observedSearch, url: "https://www.netflix.com/search" },
    { type: "play", actionId: randomUUID(), script: "alert(1)" },
    {
      type: "scrollSelectedRow",
      actionId: randomUUID(),
      snapshotId: randomUUID(),
      rowId: "a[href]",
      direction: "right",
    },
  ])
    assert.throws(() => browserWebMCPRequest({ ...base, command: invalid }));
});

test("Netflix row observations require bounded distinct opaque IDs and closed labels", () => {
  const duplicateId = randomUUID();
  const base = {
    ok: true,
    message: "Observed.",
    browser: {
      source: "companion",
      operation: "read",
      status: "completed",
      revision: "a".repeat(64),
      view: {
        items: [],
        site: {
          provider: "netflix",
          page: "browse",
          playback: "unavailable",
          rows: [{ id: duplicateId, label: "Row 1: Featured" }],
        },
      },
    },
  };
  assert.equal(browserWebMCPOperationResult(base).browser.operation, "read");
  for (const rows of [
    [{ id: "a[href]", label: "Row" }],
    Array.from({ length: 9 }, () => ({ id: randomUUID(), label: "Row" })),
    [{ id: randomUUID(), label: "\u0000" }],
    [
      { id: duplicateId, label: "First" },
      { id: duplicateId, label: "Second" },
    ],
  ])
    assert.throws(() =>
      browserWebMCPOperationResult({
        ...base,
        browser: {
          ...base.browser,
          view: { ...base.browser.view, site: { ...base.browser.view.site, rows } },
        },
      }),
    );
  assert.throws(() =>
    browserWebMCPOperationResult({
      ...base,
      browser: {
        ...base.browser,
        view: { ...base.browser.view, site: { ...base.browser.view.site, provider: "youtube" } },
      },
    }),
  );
});

test("Netflix search control observation is closed, browse/results-only and tied to an opaque ID", () => {
  const base = {
    ok: true,
    message: "Observed.",
    browser: {
      source: "companion",
      operation: "read",
      status: "completed",
      revision: "a".repeat(64),
      view: {
        items: [],
        site: {
          provider: "netflix",
          page: "browse",
          playback: "unavailable",
          searchControl: { id: randomUUID(), label: "Search" },
        },
      },
    },
  };
  assert.equal(browserWebMCPOperationResult(base).browser.operation, "read");
  assert.equal(
    browserWebMCPOperationResult({
      ...base,
      browser: {
        ...base.browser,
        view: { ...base.browser.view, site: { ...base.browser.view.site, page: "results" } },
      },
    }).browser.operation,
    "read",
  );
  for (const searchControl of [
    { id: "input[type=search]", label: "Search" },
    { id: randomUUID(), label: "Search\u0000" },
    { id: randomUUID(), label: "Search", selector: "input" },
  ])
    assert.throws(() =>
      browserWebMCPOperationResult({
        ...base,
        browser: {
          ...base.browser,
          view: { ...base.browser.view, site: { ...base.browser.view.site, searchControl } },
        },
      }),
    );
  assert.throws(() =>
    browserWebMCPOperationResult({
      ...base,
      browser: {
        ...base.browser,
        view: { ...base.browser.view, site: { ...base.browser.view.site, page: "watch" } },
      },
    }),
  );
});

test("observed row actions never fall through to WebMCP or accessibility", async () => {
  for (const availability of ["webmcp", "accessibility"] as const) {
    let dispatches = 0;
    const current: BrowserBinding = { ...binding(availability), availability };
    const selector = new BrowserOperationSelector(
      async () => current,
      {
        execute: async () => {
          dispatches += 1;
          throw new Error("unexpected WebMCP dispatch");
        },
      },
      {
        execute: async () => {
          dispatches += 1;
          throw new Error("unexpected AX dispatch");
        },
      } as never,
    );
    await assert.rejects(
      () =>
        selector.execute(
          {
            tool: "browser.scrollRow",
            direction: "right",
            rowId: randomUUID(),
            revision: browserBindingRevision(current),
          },
          new AbortController().signal,
        ),
      /only for the selected Netflix companion/,
    );
    assert.equal(dispatches, 0);
  }
});

test("Netflix selector consumes read authority after one unknown and never enters WebMCP or AX", async () => {
  let selected = binding("browse");
  let bridgeCalls = 0;
  let webmcpCalls = 0;
  let axCalls = 0;
  const commands: string[] = [];
  const snapshotId = randomUUID(),
    first = randomUUID(),
    second = randomUUID(),
    rowId = randomUUID();
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
                  rows: [{ id: rowId, label: "Row 1: Synthetic titles" }],
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
  assert.deepEqual(read.browser.view.site?.rows, [{ id: rowId, label: "Row 1: Synthetic titles" }]);
  await assert.rejects(
    () => selector.execute({ tool: "browser.scroll", direction: "right", revision }, signal),
    /Choose an observed Netflix row/,
  );
  const scroll = browserWebMCPOperationResult(
    await selector.execute(
      { tool: "browser.scrollRow", direction: "right", rowId, revision },
      signal,
    ),
  );
  assert.equal(scroll.browser.operation, "command");
  assert.equal(scroll.browser.status, "unknown");
  assert.deepEqual(commands, ["inspect", "scrollSelectedRow"]);
  await assert.rejects(
    () =>
      selector.execute({ tool: "browser.scrollRow", direction: "right", rowId, revision }, signal),
    /Read the Netflix page/,
  );
  await assert.rejects(
    () => selector.execute({ tool: "browser.search", query: "title", revision }, signal),
    /Read the Netflix page/,
  );
  assert.equal(bridgeCalls, 2, "unknown cannot dispatch search without a fresh read");
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
  assert.deepEqual(commands, ["inspect", "scrollSelectedRow", "inspect", "play"]);
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

test("observed Netflix search needs fresh results before selection and never replays", async () => {
  let current = binding("search");
  const revision = browserBindingRevision(current);
  const signal = new AbortController().signal;
  const snapshotId = randomUUID(),
    controlId = randomUUID(),
    resultId = randomUUID();
  const commands: string[] = [];
  let controlAvailable = false;
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute") throw new Error("unexpected request");
      commands.push(request.command.type);
      if (request.command.type === "searchObserved") {
        assert.equal(request.command.snapshotId, snapshotId);
        assert.equal(request.command.controlId, controlId);
        assert.equal(request.command.query, `Space " & < 🌙`);
        return browserWebMCPResultFor(request.id, "unknown");
      }
      if (request.command.type === "open") {
        assert.equal(request.command.candidateId, resultId);
        return browserWebMCPResultFor(request.id, "unknown");
      }
      const isResults = current.url.includes("/search?q=");
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: current.bindingId,
        documentId: current.documentId,
        url: current.url,
        value: {
          snapshotId,
          candidates: isResults ? [{ id: resultId, title: "Synthetic search result" }] : [],
          playback: { available: false },
          site: {
            provider: "netflix",
            page: isResults ? "results" : "browse",
            playback: "unavailable",
            ...(controlAvailable ? { searchControl: { id: controlId, label: "Search" } } : {}),
          },
        },
      });
    },
  });
  await companion.execute({ tool: "browser.read", view: "summary", revision }, current, signal);
  await assert.rejects(
    () => companion.execute({ tool: "browser.search", query: "public", revision }, current, signal),
    /search control is unavailable/,
  );
  assert.deepEqual(commands, ["inspect"]);
  controlAvailable = true;
  const read = await companion.execute(
    { tool: "browser.read", view: "summary", revision },
    current,
    signal,
  );
  assert.equal(read.browser.operation, "read");
  if (read.browser.operation !== "read") throw new Error("unexpected result");
  assert.deepEqual(read.browser.view.site?.searchControl, { id: controlId, label: "Search" });
  const result = await companion.execute(
    { tool: "browser.search", query: `Space " & < 🌙`, revision },
    current,
    signal,
  );
  assert.equal(result.browser.status, "unknown");
  await assert.rejects(
    () => companion.execute({ tool: "browser.search", query: "again", revision }, current, signal),
    /Read the Netflix page/,
  );
  current = binding(
    "results",
    "https://www.netflix.com/search?q=Space%20%22%20%26%20%3C%20%F0%9F%8C%99",
  );
  const resultsRevision = browserBindingRevision(current);
  await assert.rejects(
    () =>
      companion.execute(
        { tool: "browser.select", itemId: resultId, revision: resultsRevision },
        current,
        signal,
      ),
    /Read the Netflix page/,
  );
  const results = await companion.execute(
    { tool: "browser.read", view: "summary", revision: resultsRevision },
    current,
    signal,
  );
  assert.equal(results.browser.operation, "read");
  if (results.browser.operation !== "read") throw new Error("unexpected result");
  assert.equal(results.browser.view.site?.page, "results");
  assert.deepEqual(
    results.browser.view.items.map((item) => item.id),
    [resultId],
  );
  const selection = await companion.execute(
    { tool: "browser.select", itemId: resultId, revision: resultsRevision },
    current,
    signal,
  );
  assert.equal(selection.browser.status, "unknown");
  await assert.rejects(
    () =>
      companion.execute(
        { tool: "browser.select", itemId: resultId, revision: resultsRevision },
        current,
        signal,
      ),
    /Read the Netflix page/,
  );
  assert.deepEqual(commands, ["inspect", "inspect", "searchObserved", "inspect", "open"]);
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
