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

const selected = (url: string): BrowserBinding => ({
  availability: "accessibility",
  origin: "https://www.youtube.com",
  url,
  bindingId: `binding-${randomUUID()}`,
  documentId: `document-${randomUUID()}`,
  expiresAt: Date.now() + 60_000,
});

test("YouTube observed search consumes a pinned document and requires a fresh results read", async () => {
  let binding = selected("https://www.youtube.com/");
  const firstRevision = browserBindingRevision(binding);
  const searchControl = randomUUID();
  const resultId = randomUUID();
  const commands: string[] = [];
  let axCommands = 0;
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute") throw new Error("unexpected protocol request");
      commands.push(request.command.type);
      if (request.command.type === "searchObserved") {
        assert.equal(request.command.controlId, searchControl);
        assert.equal(request.command.query, "Artemis official launch");
        return browserWebMCPResultFor(request.id, "unknown");
      }
      if (request.command.type === "open") {
        assert.equal(request.command.candidateId, resultId);
        return browserWebMCPResultFor(request.id, "unknown");
      }
      const results = new URL(binding.url).pathname === "/results";
      const site = {
        provider: "youtube",
        page: results ? "results" : "home",
        playback: "unavailable",
        searchControl: { id: searchControl, label: "Search" },
      };
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        url: binding.url,
        value: {
          snapshotId: randomUUID(),
          candidates: results ? [{ id: resultId, title: "Observed public result" }] : [],
          playback: { available: false },
          searchControl: site.searchControl,
          site,
        },
      });
    },
  });
  const selector = new BrowserOperationSelector(
    async () => binding,
    {
      execute: async () => {
        throw new Error("unexpected WebMCP dispatch");
      },
    },
    {
      execute: async () => {
        axCommands += 1;
        throw new Error("unexpected AX dispatch");
      },
    } as never,
    companion,
  );
  const signal = new AbortController().signal;
  const read = (revision: string) =>
    selector.execute({ tool: "browser.read", view: "summary", revision }, signal);
  const first = await read(firstRevision);
  if (!("browser" in first)) throw new Error("missing browser result");
  assert.equal(first.browser.operation, "read");
  if (first.browser.operation !== "read") throw new Error("unexpected response");
  assert.equal(first.browser.source, "companion");
  assert.deepEqual(first.browser.view.site?.searchControl, { id: searchControl, label: "Search" });
  const search = await selector.execute(
    { tool: "browser.search", query: "Artemis official launch", revision: firstRevision },
    signal,
  );
  if (!("browser" in search)) throw new Error("missing browser result");
  assert.equal(search.browser.status, "unknown");
  await assert.rejects(
    () =>
      selector.execute({ tool: "browser.search", query: "again", revision: firstRevision }, signal),
    /Read the YouTube page/,
  );
  binding = selected("https://www.youtube.com/results?search_query=Artemis%20official%20launch");
  const resultsRevision = browserBindingRevision(binding);
  await assert.rejects(
    () =>
      selector.execute(
        { tool: "browser.select", itemId: resultId, revision: resultsRevision },
        signal,
      ),
    /fresh read/,
  );
  const results = await read(resultsRevision);
  if (!("browser" in results)) throw new Error("missing browser result");
  assert.equal(results.browser.operation, "read");
  if (results.browser.operation !== "read") throw new Error("unexpected response");
  assert.deepEqual(
    results.browser.view.items.map((item) => item.id),
    [resultId],
  );
  const chosen = await selector.execute(
    { tool: "browser.select", itemId: resultId, revision: resultsRevision },
    signal,
  );
  if (!("browser" in chosen)) throw new Error("missing browser result");
  assert.equal(chosen.browser.status, "unknown");
  await assert.rejects(
    () =>
      selector.execute(
        { tool: "browser.select", itemId: resultId, revision: resultsRevision },
        signal,
      ),
    /fresh read/,
  );
  assert.deepEqual(commands, ["inspect", "searchObserved", "inspect", "open"]);
  assert.equal(axCommands, 0);
});

test("YouTube search control is accepted only on home/results and no other provider or binding", async () => {
  const site = (provider: string, page: string) => ({
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
          provider,
          page,
          playback: "unavailable",
          searchControl: { id: randomUUID(), label: "Search" },
        },
      },
    },
  });
  for (const page of ["home", "results"])
    assert.equal(browserWebMCPOperationResult(site("youtube", page)).browser.operation, "read");
  for (const [provider, page] of [
    ["youtube", "watch"],
    ["youtube_tv", "browse"],
    ["disneyplus", "browse"],
  ] as [string, string][])
    assert.throws(() => browserWebMCPOperationResult(site(provider, page)));
  for (const source of ["accessibility", "webmcp"]) {
    const observed = site("youtube", "home");
    assert.throws(() =>
      browserWebMCPOperationResult({
        ...observed,
        browser: { ...observed.browser, source },
      }),
    );
  }
  const companion = new BrowserCompanionOperations({
    async request() {
      throw new Error("must not dispatch");
    },
  });
  for (const wrong of [
    { ...selected("https://www.youtube.com/"), origin: "https://www.netflix.com" },
    { ...selected("https://www.youtube.com/"), availability: "companion" as const },
    { ...selected("https://www.youtube.com/"), url: "https://www.netflix.com/browse" },
  ])
    await assert.rejects(
      () =>
        companion.execute(
          { tool: "browser.read", view: "summary", revision: browserBindingRevision(wrong) },
          wrong,
          new AbortController().signal,
        ),
      /unavailable/,
    );
});

test("unavailable read-only YouTube companion preserves AX read/select but never retries search through AX", async () => {
  const binding = selected("https://www.youtube.com/results?search_query=public");
  const revision = browserBindingRevision(binding);
  const itemId = "observed-result";
  const axActions: string[] = [];
  const companionCommands: string[] = [];
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute") throw new Error("unexpected request");
      companionCommands.push(request.command.type);
      throw new Error("observed adapter unavailable before effect");
    },
  });
  const selector = new BrowserOperationSelector(
    async () => binding,
    {
      execute: async () => {
        throw new Error("unexpected WebMCP dispatch");
      },
      inspectSelectedPage: async () => ({
        provider: "youtube",
        page: "results",
        playback: "unavailable",
      }),
    },
    {
      execute: async (action: { tool: string }) => {
        axActions.push(action.tool);
        if (action.tool === "browser.read")
          return browserWebMCPOperationResult({
            ok: true,
            message: "AX observation.",
            browser: {
              source: "accessibility",
              operation: "read",
              status: "completed",
              revision,
              view: { items: [{ id: itemId, label: "Observed result" }] },
            },
          });
        return browserWebMCPOperationResult({
          ok: false,
          message: "AX action unverified.",
          browser: {
            source: "accessibility",
            operation: "command",
            status: "unknown",
            revision,
          },
        });
      },
    } as never,
    companion,
  );
  const signal = new AbortController().signal;
  const page = await selector.execute({ tool: "browser.read", view: "summary", revision }, signal);
  if (!("browser" in page) || page.browser.operation !== "read") throw new Error("missing AX read");
  assert.equal(page.browser.source, "accessibility");
  await assert.rejects(
    () => selector.execute({ tool: "browser.search", query: "again", revision }, signal),
    /Read the YouTube page/,
  );
  assert.deepEqual(axActions, ["browser.read"]);
  await selector.execute({ tool: "browser.read", view: "summary", revision }, signal);
  const selectedResult = await selector.execute(
    { tool: "browser.select", itemId, revision },
    signal,
  );
  if (!("browser" in selectedResult)) throw new Error("missing AX command");
  assert.equal(selectedResult.browser.status, "unknown");
  assert.deepEqual(axActions, ["browser.read", "browser.read", "browser.select"]);
  assert.deepEqual(companionCommands, ["inspect", "inspect"]);
  await assert.rejects(
    () => selector.execute({ tool: "browser.select", itemId, revision }, signal),
    /fresh read/,
  );
});

test("a late YouTube read cannot restore search authority after refresh", async () => {
  const binding = selected("https://www.youtube.com/");
  const revision = browserBindingRevision(binding);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const companion = new BrowserCompanionOperations({
    async request(request) {
      if (request.type !== "media.execute" || request.command.type !== "inspect")
        throw new Error("unexpected dispatch");
      entered();
      await held;
      const control = { id: randomUUID(), label: "Search" };
      return browserWebMCPResultFor(request.id, "ok", {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        url: binding.url,
        value: {
          snapshotId: randomUUID(),
          candidates: [],
          playback: { available: false },
          searchControl: control,
          site: {
            provider: "youtube",
            page: "home",
            playback: "unavailable",
            searchControl: control,
          },
        },
      });
    },
  });
  const signal = new AbortController().signal;
  const reading = companion.execute(
    { tool: "browser.read", view: "summary", revision },
    binding,
    signal,
  );
  await started;
  await companion.execute({ tool: "browser.refresh" }, binding, signal);
  release();
  await assert.rejects(reading, /read failed/);
  await assert.rejects(
    () => companion.execute({ tool: "browser.search", query: "public", revision }, binding, signal),
    /Read the YouTube page/,
  );
});
