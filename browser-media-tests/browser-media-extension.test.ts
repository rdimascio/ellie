import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const source = new URL("../apps/browser-media-extension/", import.meta.url).pathname;

function extensionEvent() {
  const listeners: Array<(...values: any[]) => void> = [];
  return {
    addListener(listener: (...values: any[]) => void) {
      listeners.push(listener);
    },
    emit(...values: any[]) {
      for (const listener of listeners) listener(...values);
    },
  };
}

test("native host status reports a delayed missing-host failure without reconnecting", async () => {
  const background = await readFile(join(source, "background.js"), "utf8");
  const disconnect = extensionEvent();
  const nativeMessages = extensionEvent();
  const runtimeMessages = extensionEvent();
  const removed = extensionEvent();
  const replaced = extensionEvent();
  const updated = extensionEvent();
  const posted: unknown[] = [];
  const notifications: unknown[] = [];
  let connects = 0;
  const runtime: Record<string, any> = {
    onMessage: runtimeMessages,
    connectNative() {
      connects += 1;
      return {
        onDisconnect: disconnect,
        onMessage: nativeMessages,
        postMessage(value: unknown) {
          posted.push(value);
        },
      };
    },
    sendMessage(value: unknown) {
      notifications.push(value);
      return Promise.resolve();
    },
  };
  const context: Record<string, any> = {
    chrome: {
      runtime,
      tabs: { onRemoved: removed, onReplaced: replaced, onUpdated: updated },
      windows: { get: async () => ({ id: 1, focused: true }) },
    },
    AbortController,
    URL,
    Promise,
    Set,
    Map,
    Date,
    Error,
    Object,
    Array,
    String,
    Number,
    RegExp,
    crypto,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(
    `${background}\n;globalThis.__nativeStatusTest={connect:connectNativeHost,status:()=>nativeConnectionStatus};`,
    context,
  );
  assert.equal(context.__nativeStatusTest.connect(), "waiting");
  assert.equal(context.__nativeStatusTest.status(), "waiting");
  assert.equal(connects, 1);
  assert.equal(posted.length, 0);
  runtime.lastError = {
    message: "Specified native messaging host not found. sensitive-detail",
  };
  disconnect.emit();
  delete runtime.lastError;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.__nativeStatusTest.status(), "missing");
  assert.equal(connects, 1);
  assert.equal(posted.length, 0);
  assert.deepEqual(
    notifications.map((value: any) => value.status),
    ["waiting", "missing"],
  );
  assert.deepEqual(
    notifications.map((value: any) => value.revision),
    [1, 2],
  );
  assert.equal(JSON.stringify(notifications).includes("sensitive-detail"), false);
});

test("native host is connected only after a request and reports a later disconnect", async () => {
  const background = await readFile(join(source, "background.js"), "utf8");
  const disconnect = extensionEvent();
  const nativeMessages = extensionEvent();
  const notifications: any[] = [];
  const posted: any[] = [];
  let connects = 0;
  const context: Record<string, any> = {
    chrome: {
      runtime: {
        onMessage: extensionEvent(),
        connectNative() {
          connects += 1;
          return {
            onDisconnect: disconnect,
            onMessage: nativeMessages,
            postMessage(value: unknown) {
              posted.push(value);
            },
          };
        },
        sendMessage(value: unknown) {
          notifications.push(value);
          return Promise.resolve();
        },
      },
      tabs: {
        onRemoved: extensionEvent(),
        onReplaced: extensionEvent(),
        onUpdated: extensionEvent(),
      },
      windows: { get: async () => ({ id: 1, focused: true }) },
    },
    AbortController,
    URL,
    Promise,
    Set,
    Map,
    Date,
    Error,
    Object,
    Array,
    String,
    Number,
    RegExp,
    crypto,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(
    `${background}\n;globalThis.__nativeStatusTest={connect:connectNativeHost,status:()=>nativeConnectionStatus};`,
    context,
  );
  assert.equal(context.__nativeStatusTest.connect(), "waiting");
  assert.equal(context.__nativeStatusTest.status(), "waiting");
  nativeMessages.emit({ protocol: "invalid", id: "request-1", type: "binding.status" });
  assert.equal(context.__nativeStatusTest.status(), "waiting");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 1);
  nativeMessages.emit({
    protocol: "ellie.browser-webmcp.v1",
    id: "request-2",
    type: "binding.status",
  });
  assert.equal(context.__nativeStatusTest.status(), "connected");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posted.length, 2);
  assert.deepEqual(
    posted.map((value) => value.status),
    ["unavailable", "unbound"],
  );
  disconnect.emit();
  assert.equal(context.__nativeStatusTest.status(), "disconnected");
  assert.equal(connects, 1);
  assert.deepEqual(
    notifications.map((value) => value.status),
    ["waiting", "connected", "disconnected"],
  );
});

test("explicit refresh renews only the retained same-page selection authority", async () => {
  const background = await readFile(join(source, "background.js"), "utf8");
  const disconnect = extensionEvent();
  const removed = extensionEvent();
  const replaced = extensionEvent();
  const updated = extensionEvent();
  let now = 1_000;
  let documentId = "document-1";
  let injectionCount = 0;
  let focused = true;
  let pendingTools = false;
  let pendingRefresh = false;
  let armWindowReadAfterInjection = false;
  let pauseNextWindowRead = false;
  let settleTools: ((value: unknown) => void) | undefined;
  let settleRefresh: ((value: unknown) => void) | undefined;
  let settleWindowRead: ((value: unknown) => void) | undefined;
  const tab = {
    id: 7,
    windowId: 3,
    active: true,
    status: "complete",
    url: "https://www.youtube.com/watch?v=abcdefghijk",
  };
  class FixtureDate extends Date {
    static override now() {
      return now;
    }
  }
  const context: Record<string, any> = {
    chrome: {
      runtime: {
        onMessage: extensionEvent(),
        connectNative() {
          return {
            onDisconnect: disconnect,
            onMessage: extensionEvent(),
            postMessage() {},
          };
        },
        sendMessage() {
          return Promise.resolve();
        },
      },
      tabs: {
        get: async () => ({ ...tab }),
        onRemoved: removed,
        onReplaced: replaced,
        onUpdated: updated,
      },
      windows: {
        get: async () => {
          if (pauseNextWindowRead) {
            pauseNextWindowRead = false;
            return new Promise((resolve) => {
              settleWindowRead = resolve;
            });
          }
          return { id: 3, focused };
        },
      },
      scripting: {
        executeScript(options: { files?: string[] }) {
          if (options.files && pendingRefresh) {
            return new Promise((resolve) => {
              settleRefresh = resolve;
            });
          }
          if (!options.files && pendingTools) {
            return new Promise((resolve) => {
              settleTools = resolve;
            });
          }
          injectionCount += 1;
          if (options.files && armWindowReadAfterInjection) {
            armWindowReadAfterInjection = false;
            pauseNextWindowRead = true;
          }
          return Promise.resolve([{ documentId }]);
        },
      },
    },
    AbortController,
    URL,
    Promise,
    Set,
    Map,
    Date: FixtureDate,
    Error,
    Object,
    Array,
    String,
    Number,
    RegExp,
    crypto,
    setTimeout,
    clearTimeout,
  };
  runInNewContext(
    `${background}\n;globalThis.__refreshTest={bind:bindWebMCP,request:handleNativeRequest,state:()=>({binding:webMCPBinding,selection:webMCPSelection})};`,
    context,
  );
  const request = (type: string, id: string) =>
    context.__refreshTest.request({ protocol: "ellie.browser-webmcp.v1", id, type });

  const initialExecute = context.chrome.scripting.executeScript;
  context.chrome.scripting.executeScript = (options: { files?: string[] }) => {
    const result = initialExecute(options);
    if (options.files) {
      tab.status = "loading";
      updated.emit(7, { status: "loading" });
      tab.status = "complete";
    }
    return result;
  };
  await assert.rejects(context.__refreshTest.bind(7), /page_changed/);
  assert.equal(injectionCount, 1);
  assert.equal(context.__refreshTest.state().binding, undefined);
  assert.equal(context.__refreshTest.state().selection, undefined);
  context.chrome.scripting.executeScript = initialExecute;
  injectionCount = 0;

  focused = false;
  await assert.rejects(context.__refreshTest.bind(7), /unsupported_page/);
  assert.equal(injectionCount, 0, "an unfocused popup selection injected a document");
  assert.equal(context.__refreshTest.state().selection, undefined);
  focused = true;

  const initial = await context.__refreshTest.bind(7);
  assert.equal(initial.expiresAt, 901_000);
  assert.equal(injectionCount, 1);
  const first = context.__refreshTest.state().binding;

  tab.url = "https://www.youtube.com/results?search_query=public";
  documentId = "document-2";
  updated.emit(7, { url: tab.url });
  assert.equal(context.__refreshTest.state().binding, undefined);
  assert.ok(context.__refreshTest.state().selection);
  await assert.rejects(request("binding.status", "ordinary-status"), /unbound/);
  assert.equal(injectionCount, 1, "ordinary status injected a fresh document");

  const refreshed = await request("binding.refresh", "explicit-refresh");
  assert.equal(refreshed.expiresAt, initial.expiresAt);
  assert.notEqual(refreshed.bindingId, first.bindingId);
  assert.notEqual(refreshed.documentId, first.documentId);
  assert.equal(refreshed.url, tab.url);
  assert.equal(injectionCount, 2);
  await assert.rejects(
    context.__refreshTest.request({
      protocol: "ellie.browser-webmcp.v1",
      id: "stale-tool",
      type: "tool.execute",
      bindingId: first.bindingId,
      documentId: first.documentId,
      toolHandle: "old-handle",
      args: {},
    }),
    /stale_tool/,
  );
  assert.equal(injectionCount, 2, "stale action was replayed");

  tab.status = "loading";
  updated.emit(7, { status: "loading" });
  assert.equal(context.__refreshTest.state().binding, undefined);
  assert.ok(context.__refreshTest.state().selection);
  await assert.rejects(request("binding.status", "same-url-reload-status"), /unbound/);
  await assert.rejects(request("binding.refresh", "same-url-reload-loading"), /page_changed/);
  assert.equal(injectionCount, 2, "loading same-URL reload injected a document");
  tab.status = "complete";
  documentId = "document-after-same-url-reload";
  const afterSameURLReload = await request("binding.refresh", "same-url-reload-complete");
  assert.equal(afterSameURLReload.documentId, documentId);

  tab.url = "https://www.youtube.com/results?search_query=next";
  documentId = "document-3";
  updated.emit(7, { url: tab.url });
  focused = false;
  await assert.rejects(request("binding.refresh", "unfocused"), /page_changed/);
  assert.equal(injectionCount, 3, "unfocused refresh injected a document");
  assert.equal(context.__refreshTest.state().binding, undefined);
  focused = true;

  const afterFocus = await request("binding.refresh", "after-focus");
  assert.equal(afterFocus.documentId, documentId);
  pendingTools = true;
  const active = request("tools.list", "pending-read");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const beforeBusy = injectionCount;
  await assert.rejects(request("binding.refresh", "while-active"), /busy/);
  assert.equal(injectionCount, beforeBusy, "busy refresh replayed work");
  settleTools?.([{ documentId, result: [] }]);
  await active;
  pendingTools = false;

  tab.url = "https://www.youtube.com/results?search_query=cancelled";
  documentId = "document-cancelled";
  updated.emit(7, { url: tab.url });
  pendingRefresh = true;
  const cancelled = request("binding.refresh", "cancelled-refresh");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cancellation = await context.__refreshTest.request({
    protocol: "ellie.browser-webmcp.v1",
    id: "cancel-request",
    type: "cancel",
    targetId: "cancelled-refresh",
  });
  assert.equal(cancellation.cancelled, true);
  await assert.rejects(cancelled, /cancelled/);
  settleRefresh?.([{ documentId }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.__refreshTest.state().binding, undefined);
  pendingRefresh = false;

  tab.url = "https://www.youtube.com/results?search_query=cancel-final-check";
  documentId = "document-cancel-final-check";
  updated.emit(7, { url: tab.url });
  armWindowReadAfterInjection = true;
  const cancelledFinalCheck = request("binding.refresh", "cancel-final-check");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const finalCheckCancellation = await context.__refreshTest.request({
    protocol: "ellie.browser-webmcp.v1",
    id: "cancel-final-check-request",
    type: "cancel",
    targetId: "cancel-final-check",
  });
  assert.equal(finalCheckCancellation.cancelled, true);
  settleWindowRead?.({ id: 3, focused: true });
  await assert.rejects(cancelledFinalCheck, /cancelled/);
  assert.equal(context.__refreshTest.state().binding, undefined);
  settleWindowRead = undefined;

  tab.url = "https://www.youtube.com/results?search_query=race";
  documentId = "document-4";
  updated.emit(7, { url: tab.url });
  const execute = context.chrome.scripting.executeScript;
  context.chrome.scripting.executeScript = (options: { files?: string[] }) => {
    const result = execute(options);
    if (options.files) tab.active = false;
    return result;
  };
  await assert.rejects(request("binding.refresh", "focus-race"), /page_changed/);
  assert.equal(context.__refreshTest.state().binding, undefined);
  tab.active = true;
  context.chrome.scripting.executeScript = execute;

  tab.status = "complete";
  context.chrome.scripting.executeScript = (options: { files?: string[] }) => {
    const result = execute(options);
    if (options.files) {
      tab.status = "loading";
      updated.emit(7, { status: "loading" });
    }
    return result;
  };
  await assert.rejects(request("binding.refresh", "reload-race"), /cancelled/);
  assert.equal(context.__refreshTest.state().binding, undefined);
  tab.status = "complete";
  context.chrome.scripting.executeScript = execute;

  tab.url = "https://www.youtube.com/results?search_query=navigation-race";
  updated.emit(7, { url: tab.url });
  context.chrome.scripting.executeScript = (options: { files?: string[] }) => {
    const result = execute(options);
    if (options.files) {
      tab.url = "https://www.youtube.com/results?search_query=navigated-during-refresh";
      updated.emit(7, { url: tab.url });
    }
    return result;
  };
  await assert.rejects(request("binding.refresh", "navigation-race"), /cancelled/);
  assert.equal(context.__refreshTest.state().binding, undefined);
  context.chrome.scripting.executeScript = execute;

  tab.url = "https://example.test/other";
  updated.emit(7, { url: tab.url });
  const beforeCrossOrigin = injectionCount;
  tab.url = "https://www.youtube.com/returned";
  await assert.rejects(request("binding.refresh", "cross-origin-return"), /unbound/);
  assert.equal(injectionCount, beforeCrossOrigin);

  documentId = "document-5";
  const removal = await context.__refreshTest.bind(7);
  removed.emit(7);
  await assert.rejects(request("binding.refresh", "removed"), /unbound/);
  assert.equal(removal.expiresAt, initial.expiresAt);

  await context.__refreshTest.bind(7);
  replaced.emit(8, 7);
  await assert.rejects(request("binding.refresh", "replaced"), /unbound/);

  const expiring = await context.__refreshTest.bind(7);
  now = expiring.expiresAt;
  const beforeExpiry = injectionCount;
  await assert.rejects(request("binding.refresh", "expired"), /unbound/);
  assert.equal(injectionCount, beforeExpiry);

  now = 2_000;
  await context.__refreshTest.bind(7);
  disconnect.emit();
  const beforeDisconnect = injectionCount;
  await assert.rejects(request("binding.refresh", "disconnected"), /unbound/);
  assert.equal(injectionCount, beforeDisconnect);
});

test("popup reports a failed native connection without claiming page selection", async () => {
  const popup = await readFile(join(source, "popup.js"), "utf8");
  const html = await readFile(join(source, "popup.html"), "utf8");
  assert.match(html, />Select this page</);
  assert.doesNotMatch(html, />Connect WebMCP tab</);
  const runtimeMessages = extensionEvent();
  const sent: any[] = [];
  const elements = new Map<string, any>();
  for (const id of [
    "status",
    "connection-status",
    "titles",
    "stop",
    "inspect",
    "up",
    "down",
    "play",
    "pause",
    "back",
    "forward",
    "webmcp",
    "bind-webmcp",
  ]) {
    elements.set(id, {
      disabled: id === "stop",
      textContent: id === "status" ? "Ready" : "",
      replaceChildren() {},
    });
  }
  const context: Record<string, any> = {
    chrome: {
      tabs: { query: async () => [{ id: 7 }] },
      runtime: {
        onMessage: runtimeMessages,
        sendMessage(value: unknown) {
          sent.push(value);
          return new Promise((resolve) => {
            context.resolveBind = () =>
              resolve({
                ok: false,
                error: "page_changed",
              });
          });
        },
      },
    },
    document: {
      querySelector(selector: string) {
        return elements.get(selector.slice(1));
      },
      createElement() {
        return { append() {} };
      },
    },
    crypto,
    Error,
    Object,
    Array,
    Promise,
  };
  runInNewContext(popup, context);
  const binding = elements.get("bind-webmcp").onclick();
  for (let attempt = 0; attempt < 5 && !context.resolveBind; attempt += 1) await Promise.resolve();
  assert.equal(typeof context.resolveBind, "function");
  runtimeMessages.emit({
    protocol: "ellie.browser-native-status.v1",
    status: "missing",
    revision: 2,
  });
  context.resolveBind();
  await binding;
  assert.equal(
    elements.get("connection-status").textContent,
    "Ellie’s Mac connection could not be found. Check browser setup.",
  );
  assert.equal(elements.get("status").textContent, "The action could not be verified.");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command.type, "bindWebMCP");
  elements.get("status").textContent = "The result is unknown. Check the Mac before trying again.";
  runtimeMessages.emit({
    protocol: "ellie.browser-native-status.v1",
    status: "missing",
    revision: 3,
  });
  assert.equal(
    elements.get("connection-status").textContent,
    "Ellie’s Mac connection could not be found. Check browser setup.",
  );
  runtimeMessages.emit({
    protocol: "ellie.browser-native-status.v1",
    status: "disconnected",
    revision: 4,
  });
  assert.equal(elements.get("connection-status").textContent, "The Mac connection was lost.");
  assert.equal(
    elements.get("status").textContent,
    "The result is unknown. Check the Mac before trying again.",
  );
  runtimeMessages.emit({
    protocol: "ellie.browser-native-status.v1",
    status: "missing",
    revision: 3,
  });
  assert.equal(elements.get("connection-status").textContent, "The Mac connection was lost.");
  runtimeMessages.emit({
    protocol: "ellie.browser-native-status.v1",
    status: "missing",
    revision: 5,
    error: "sensitive-detail",
  });
  assert.equal(elements.get("connection-status").textContent, "The Mac connection was lost.");
  assert.equal(sent.length, 1);
});

async function fixture(
  options: {
    accessibilityOnly?: boolean;
    argumentEncoding?: "object" | "json-string";
    stableNativePort?: boolean;
    companionOnly?: boolean;
    companionArming?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ellie-media-test-"));
  const extension = join(root, "extension");
  await cp(source, extension, { recursive: true });
  for (const name of ["background.js", "media-controller.js"]) {
    const path = join(extension, name);
    const value = await readFile(path, "utf8");
    const needle = '"https://www.netflix.com", "https://www.youtube.com"';
    assert.equal(value.split(needle).length - 1, 1);
    await writeFile(path, value.replace(needle, '"http://127.0.0.1:PORT"'));
  }
  const backgroundPath = join(extension, "background.js");
  const background = await readFile(backgroundPath, "utf8");
  const reviewedNeedle = "const reviewedWebMCPBindings = Object.freeze({});";
  assert.equal(background.split(reviewedNeedle).length - 1, 1);
  const accessibilityNeedle =
    'const accessibilityBindingOrigins = new Set(["https://www.youtube.com"]);';
  const companionNeedle = 'const companionBindingOrigins = new Set(["https://www.netflix.com"]);';
  assert.equal(background.split(accessibilityNeedle).length - 1, 1);
  const tabGetNeedle = `async function executeWebMCP(request, controller) {
  const binding = liveBinding();
  const before = await chrome.tabs.get(binding.tabId);`;
  assert.equal(background.split(tabGetNeedle).length - 1, 1);
  const effectNeedle = "  authorizeEffect?.();";
  assert.equal(background.split(effectNeedle).length - 1, 1);
  await writeFile(
    backgroundPath,
    background
      .replace(
        reviewedNeedle,
        options.accessibilityOnly || options.companionOnly
          ? reviewedNeedle
          : `const reviewedWebMCPBindings = Object.freeze({"http://127.0.0.1:PORT":[{name:"ellie_fixture_action",inputSchema:{type:"object",additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false,consequentialHint:false},argumentEncoding:${JSON.stringify(options.argumentEncoding ?? "object")}}]});`,
      )
      .replace(
        accessibilityNeedle,
        options.accessibilityOnly
          ? 'const accessibilityBindingOrigins = new Set(["http://127.0.0.1:PORT"]);'
          : accessibilityNeedle,
      )
      .replace(
        companionNeedle,
        options.companionOnly
          ? 'const companionBindingOrigins = new Set(["http://127.0.0.1:PORT"]);'
          : companionNeedle,
      )
      .replace(
        'binding.origin !== "https://www.netflix.com"',
        options.companionOnly
          ? 'binding.origin !== "http://127.0.0.1:PORT"'
          : 'binding.origin !== "https://www.netflix.com"',
      )
      .replace(
        'binding.origin !== "https://www.youtube.com"',
        options.accessibilityOnly
          ? 'binding.origin !== "http://127.0.0.1:PORT"'
          : 'binding.origin !== "https://www.youtube.com"',
      )
      .replace(
        tabGetNeedle,
        `${tabGetNeedle.split("\n  const before")[0]}
  if (globalThis.__ellieTestBeforeTabGet) await globalThis.__ellieTestBeforeTabGet;
  const before = await chrome.tabs.get(binding.tabId);`,
      )
      .replace(
        effectNeedle,
        options.companionArming
          ? `  if (globalThis.__ellieTestCompanionArming) {
    globalThis.__ellieTestCompanionArming.enter();
    await globalThis.__ellieTestCompanionArming.gate;
  }
${effectNeedle}`
          : effectNeedle,
      ) +
      (options.stableNativePort
        ? `
// Loaded-extension fixture only: keep the native transport stable while exercising WebMCP semantics.
connectNativeHost = () => {
  if (!nativePort) {
    nativePort = { postMessage() {} };
    nativePortGeneration += 1;
    publishNativeConnectionStatus("connected");
  }
  return nativeConnectionStatus;
};
`
        : "") +
      `
globalThis.__ellieTestWebMCP = {
  bind: bindWebMCP, request: handleNativeRequest,
  nativeStatus: () => nativeConnectionStatus,
  drop: () => { nativePort = undefined; nativePortGeneration += 1; clearWebMCPSelection(); },
  abortActive: () => activeWebMCP?.controller.abort(),
  replaceSelection: () => { webMCPSelection = undefined; },
  arm: () => {
    let enter, release;
    const entered = new Promise((resolve) => { enter = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    globalThis.__ellieTestCompanionArming = { enter, release, gate, entered };
  },
  entered: () => globalThis.__ellieTestCompanionArming.entered,
  release: () => globalThis.__ellieTestCompanionArming.release(),
};
`,
  );
  const controllerPath = join(extension, "media-controller.js");
  const controller = await readFile(controllerPath, "utf8");
  const youtubeNeedle = 'new Set(["https://www.youtube.com"])';
  assert.equal(controller.split(youtubeNeedle).length - 1, 1);
  const netflixNeedle = 'new Set(["https://www.netflix.com"])';
  assert.equal(controller.split(netflixNeedle).length - 1, 1);
  await writeFile(
    controllerPath,
    controller
      .replace(
        youtubeNeedle,
        options.companionOnly ? "new Set([])" : 'new Set(["http://127.0.0.1:PORT"])',
      )
      .replace(
        netflixNeedle,
        options.companionOnly ? 'new Set(["http://127.0.0.1:PORT"])' : netflixNeedle,
      ),
  );
  const manifestPath = join(extension, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://127.0.0.1/*"];
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, extension };
}

test(
  "missing native host leaves reviewed-origin status and refresh unbound",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ accessibilityOnly: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      const initial = await launched.worker.evaluate(async (tabId) => {
        try {
          await globalThis["__ellieTestWebMCP"].bind(tabId);
          return "bound";
        } catch (error) {
          return error instanceof Error ? error.message : "failed";
        }
      }, tab.id);
      assert.ok(["bound", "page_changed"].includes(initial));
      let nativeStatus = "waiting";
      for (let attempt = 0; attempt < 50 && nativeStatus === "waiting"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        nativeStatus = await launched.worker.evaluate(() =>
          globalThis["__ellieTestWebMCP"].nativeStatus(),
        );
      }
      assert.equal(nativeStatus, "missing");
      for (const type of ["binding.status", "binding.refresh"]) {
        const result = await launched.worker.evaluate(async (requestType) => {
          try {
            await globalThis["__ellieTestWebMCP"].request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: requestType,
            });
            return "bound";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        }, type);
        assert.equal(result, "unbound");
      }
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "loaded companion observes only the selected document and treats uncertain player state conservatively",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ accessibilityOnly: true, stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      async function observe(selected: { bindingId: string; documentId: string }) {
        return launched.worker.evaluate(
          async (value) =>
            globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "page.inspect",
              ...value,
            }),
          selected,
        );
      }
      const status = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.status",
        }),
      );
      assert.equal(status.availability, "accessibility");
      const home = await observe({ bindingId: binding.bindingId, documentId: status.documentId });
      assert.deepEqual(home.site, { provider: "youtube", page: "home", playback: "unavailable" });
      await assert.rejects(observe({ bindingId: binding.bindingId, documentId: "wrong-document" }));
      await launched.page.goto(`${new URL(launched.page.url()).origin}/watch?v=iTHUUjTA-LI`);
      await launched.page.bringToFront();
      await assert.rejects(
        observe({ bindingId: binding.bindingId, documentId: status.documentId }),
      );
      const watchBinding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      const watchStatus = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.status",
        }),
      );
      const watch = { bindingId: watchBinding.bindingId, documentId: watchStatus.documentId };
      assert.deepEqual((await observe(watch)).site, {
        provider: "youtube",
        page: "watch",
        playback: "unavailable",
      });
      await launched.page.evaluate(() => {
        const first = document.createElement("video");
        first.style.cssText = "position:fixed;top:10px;left:10px;width:200px;height:100px";
        const second = first.cloneNode() as HTMLVideoElement;
        document.body.append(first, second);
      });
      assert.deepEqual((await observe(watch)).site, {
        provider: "youtube",
        page: "watch",
        playback: "ambiguous",
      });
      await launched.page.evaluate(() => {
        const videos = document.querySelectorAll("video");
        videos[1]?.remove();
        videos[2]?.remove();
      });
      await launched.page.evaluate(() => (globalThis as any).showPlayer());
      await launched.page
        .locator("video")
        .evaluate((video: HTMLVideoElement) =>
          video.readyState >= 2
            ? undefined
            : new Promise<void>((resolve) =>
                video.addEventListener("loadeddata", () => resolve(), { once: true }),
              ),
        );
      assert.deepEqual((await observe(watch)).site, {
        provider: "youtube",
        page: "watch",
        playback: "paused",
        currentTimeSeconds: 0,
      });
      await launched.page.locator("video").evaluate((video: HTMLVideoElement) => video.play());
      const playing = (await observe(watch)).site;
      assert.equal(playing.playback, "playing");
      assert.equal(typeof playing.currentTimeSeconds, "number");
      for (const [path, expectedPage] of [
        ["/signin", "login"],
        ["/channel/not-a-supported-page", "unsupported"],
      ]) {
        await launched.page.goto(`${new URL(launched.page.url()).origin}${path}`);
        await launched.page.bringToFront();
        const selected = await launched.worker.evaluate(
          (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
          tab.id,
        );
        const latest = await launched.worker.evaluate(() =>
          globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "binding.status",
          }),
        );
        assert.deepEqual(
          (
            await observe({
              bindingId: selected.bindingId,
              documentId: latest.documentId,
            })
          ).site,
          { provider: "youtube", page: expectedPage, playback: "unavailable" },
        );
      }
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

const html = `<!doctype html><style>
body{margin:0}.spacer{height:760px}.row{display:flex;gap:12px;width:360px;overflow-x:auto}.card{flex:0 0 260px;height:120px;background:#ddd}.player{display:none}video{width:320px;height:180px}
</style><div id="catalog"><div class="spacer"></div><div class="row">
<a class="card" href="/watch?v=one" aria-label="First title">First</a><a class="card" href="/watch?v=two" aria-label="Second title">Second</a>
</div><div class="spacer"></div></div><div class="player"><video muted></video></div><script>
async function showPlayer(){
 document.querySelector('#catalog').style.display='none'; document.querySelector('.player').style.display='block';
 const canvas=document.createElement('canvas'); canvas.width=32; canvas.height=32;
 const ctx=canvas.getContext('2d'); let n=0; const timer=setInterval(()=>{ctx.fillStyle=n++%2?'red':'blue';ctx.fillRect(0,0,32,32)},40);
 const recorder=new MediaRecorder(canvas.captureStream(25)); const chunks=[]; recorder.ondataavailable=e=>chunks.push(e.data); recorder.start();
 await new Promise(r=>setTimeout(r,1200)); recorder.stop(); await new Promise(r=>recorder.onstop=r); clearInterval(timer);
 document.querySelector('video').src=URL.createObjectURL(new Blob(chunks,{type:recorder.mimeType}));
}
addEventListener('click',e=>{const a=e.target.closest('a');if(a){e.preventDefault();history.pushState({},'',a.href);showPlayer()}});
</script>`;

async function launch(extension: string, root: string) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_server_failed");
  for (const name of ["background.js", "media-controller.js"]) {
    const path = join(extension, name);
    const value = await readFile(path, "utf8");
    await writeFile(
      path,
      value.replaceAll("http://127.0.0.1:PORT", `http://127.0.0.1:${address.port}`),
    );
  }
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(join(root, "profile"), {
      headless: true,
      channel: "chromium",
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 10_000 });
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const harness = await context.newPage();
    await harness.goto(`chrome-extension://${extensionId}/popup.html`);
    await page.bringToFront();
    const selected = await worker.evaluate(async (expectedUrl) => {
      const tabs = await globalThis["chrome"].tabs.query({});
      const tab = tabs.find((item: any) => item.url === expectedUrl);
      if (!tab?.id || !Number.isInteger(tab.windowId)) return undefined;
      const browserWindow = await globalThis["chrome"].windows.get(tab.windowId);
      return {
        active: tab.active,
        focused: browserWindow.focused,
        status: tab.status,
      };
    }, page.url());
    assert.deepEqual(selected, { active: true, focused: true, status: "complete" });
    return { context, worker, harness, page, server };
  } catch (error) {
    await context?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}

async function command(harness: Page, tabId: number, value: Record<string, unknown>) {
  return harness.evaluate(
    async ({ tabId, value }) =>
      globalThis["chrome"].runtime.sendMessage({
        protocol: "ellie.media.v1",
        tabId,
        command: { actionId: crypto.randomUUID(), ...value },
      }),
    { tabId, value },
  );
}

test(
  "native Netflix companion binds one observed synthetic document and consumes mutations",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ companionOnly: true, stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const port = new URL(launched.page.url()).port;
      await launched.page.goto(`http://127.0.0.1:${port}/browse`);
      await launched.page.setContent(`<!doctype html><style>
      body{margin:0;min-height:1800px}.row{display:flex;overflow-x:auto;width:320px;height:150px}
      .card{display:block;flex:0 0 260px;height:120px;background:#ddd}
      </style><h2>Featured titles</h2><div class="row"><a class="card" href="/watch/123" aria-label="Synthetic first title">One</a>
      <a class="card" href="/watch/456" aria-label="Synthetic second title">Two</a></div>`);
      await launched.page.evaluate(() => {
        const credentialBearing = document.createElement("a");
        credentialBearing.href = `${location.protocol}//user:pass@${location.host}/watch/789`;
        credentialBearing.setAttribute("aria-label", "Credential-bearing title");
        credentialBearing.className = "card";
        document.querySelector(".row")!.append(credentialBearing);
      });
      await launched.page.bringToFront();
      const tab = await launched.worker.evaluate(
        async (url) =>
          (await globalThis["chrome"].tabs.query({})).find((item: any) => item.url === url),
        launched.page.url(),
      );
      assert.ok(tab?.id);
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      assert.equal(binding.availability, "companion");
      let status = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.status",
        }),
      );
      assert.equal(status.availability, "companion");
      const native = (request: Record<string, unknown>) =>
        launched.worker.evaluate((value) => globalThis.__ellieTestWebMCP.request(value), request);
      let inspect = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: status.bindingId,
        documentId: status.documentId,
        command: { type: "inspect", actionId: crypto.randomUUID() },
      });
      assert.deepEqual(inspect.site, undefined);
      assert.equal(inspect.value.site.provider, "netflix");
      assert.equal(inspect.value.site.page, "browse");
      assert.equal(inspect.value.site.horizontalScrollAvailable, true);
      assert.equal(inspect.value.candidates.length, 2);
      assert.equal(inspect.value.rowCandidateId, inspect.value.candidates[0].id);
      assert.equal(inspect.value.site.rows.length, 1);
      assert.equal(inspect.value.site.rows[0].label, "Row 1: Featured titles");
      const rowBefore = await launched.page.locator(".row").evaluate((row) => row.scrollLeft);
      const denied = await launched.worker.evaluate(
        async ({ bindingId, documentId, rowId, snapshotId }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "media.execute",
              bindingId,
              documentId: `${documentId}-stale`,
              command: {
                type: "scrollSelectedRow",
                actionId: crypto.randomUUID(),
                snapshotId,
                rowId,
                direction: "right",
              },
            });
            return "accepted";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        {
          bindingId: status.bindingId,
          documentId: status.documentId,
          rowId: inspect.value.site.rows[0].id,
          snapshotId: inspect.value.snapshotId,
        },
      );
      assert.equal(denied, "page_changed");
      assert.equal(
        await launched.page.locator(".row").evaluate((row) => row.scrollLeft),
        rowBefore,
      );
      const popupScroll = await command(launched.harness, tab.id, {
        type: "scrollRow",
        snapshotId: inspect.value.snapshotId,
        candidateId: inspect.value.rowCandidateId,
        direction: "right",
      });
      assert.equal(
        popupScroll.value.outcome,
        "scrolled",
        "the existing popup row control remains usable",
      );
      status = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.refresh",
        }),
      );
      inspect = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: status.bindingId,
        documentId: status.documentId,
        command: { type: "inspect", actionId: crypto.randomUUID() },
      });
      const explicitBefore = await launched.page.locator(".row").evaluate((row) => row.scrollLeft);
      const scrolled = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: status.bindingId,
        documentId: status.documentId,
        command: {
          type: "scrollSelectedRow",
          actionId: crypto.randomUUID(),
          snapshotId: inspect.value.snapshotId,
          rowId: inspect.value.site.rows[0].id,
          direction: "right",
        },
      });
      assert.equal(scrolled.value.outcome, "scrolled");
      assert.ok(
        (await launched.page.locator(".row").evaluate((row) => row.scrollLeft)) > explicitBefore,
      );
      const stale = await launched.worker.evaluate(async () => {
        try {
          await globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "binding.status",
          });
          return "bound";
        } catch (error) {
          return error instanceof Error ? error.message : "failed";
        }
      });
      assert.equal(stale, "unbound", "one mutation consumes the document binding");
      const renewed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.refresh",
        }),
      );
      const beforeAddedRow = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: renewed.bindingId,
        documentId: renewed.documentId,
        command: { type: "inspect", actionId: crypto.randomUUID() },
      });
      assert.ok(beforeAddedRow.value.rowCandidateId);
      await launched.page.locator("h2").evaluate((heading) => {
        heading.textContent = "Changed titles";
      });
      const headingBefore = await launched.page.locator(".row").evaluate((row) => row.scrollLeft);
      const staleHeading = await launched.worker.evaluate(
        async ({ bindingId, documentId, snapshotId, rowId }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "media.execute",
              bindingId,
              documentId,
              command: {
                type: "scrollSelectedRow",
                actionId: crypto.randomUUID(),
                snapshotId,
                rowId,
                direction: "left",
              },
            });
            return "scrolled";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        {
          bindingId: renewed.bindingId,
          documentId: renewed.documentId,
          snapshotId: beforeAddedRow.value.snapshotId,
          rowId: beforeAddedRow.value.site.rows[0].id,
        },
      );
      assert.equal(staleHeading, "unknown");
      assert.equal(
        await launched.page.locator(".row").evaluate((row) => row.scrollLeft),
        headingBefore,
      );
      const renewedAfterHeading = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.refresh",
        }),
      );
      const beforeAddedRowAgain = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: renewedAfterHeading.bindingId,
        documentId: renewedAfterHeading.documentId,
        command: { type: "inspect", actionId: crypto.randomUUID() },
      });
      assert.equal(beforeAddedRowAgain.value.site.rows[0].label, "Row 1: Changed titles");
      await launched.page.evaluate(() => {
        const second = document.querySelector(".row")!.cloneNode(true) as HTMLElement;
        second.classList.add("second-row");
        for (const [index, anchor] of [...second.querySelectorAll("a")].entries()) {
          anchor.href = `/watch/${789 + index}`;
          anchor.setAttribute("aria-label", `Synthetic other title ${index + 1}`);
        }
        document.querySelector(".row")!.after(second);
      });
      const lateRowBefore = await launched.page
        .locator(".row")
        .first()
        .evaluate((row) => row.scrollLeft);
      const lateRowResult = await launched.worker.evaluate(
        async ({ bindingId, documentId, snapshotId, rowId }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "media.execute",
              bindingId,
              documentId,
              command: {
                type: "scrollSelectedRow",
                actionId: crypto.randomUUID(),
                snapshotId,
                rowId,
                direction: "left",
              },
            });
            return "scrolled";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        {
          bindingId: renewedAfterHeading.bindingId,
          documentId: renewedAfterHeading.documentId,
          snapshotId: beforeAddedRowAgain.value.snapshotId,
          rowId: beforeAddedRowAgain.value.site.rows[0].id,
        },
      );
      assert.equal(lateRowResult, "unknown");
      assert.equal(
        await launched.page
          .locator(".row")
          .first()
          .evaluate((row) => row.scrollLeft),
        lateRowBefore,
      );
      const renewedAfterLateRow = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.refresh",
        }),
      );
      const multiple = await native({
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: renewedAfterLateRow.bindingId,
        documentId: renewedAfterLateRow.documentId,
        command: { type: "inspect", actionId: crypto.randomUUID() },
      });
      assert.equal(multiple.value.site.horizontalScrollAvailable, false);
      assert.equal(multiple.value.rowCandidateId, undefined);
      assert.equal(multiple.value.site.rows.length, 2);
      assert.deepEqual(
        multiple.value.site.rows.map((row: any) => row.label),
        ["Row 1: Changed titles", "Row 2"],
      );
      const secondBefore = await launched.page
        .locator(".second-row")
        .evaluate((row) => row.scrollLeft);
      const selectedSecond = await launched.worker.evaluate(
        async ({ bindingId, documentId, snapshotId, rowId }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "media.execute",
              bindingId,
              documentId,
              command: {
                type: "scrollSelectedRow",
                actionId: crypto.randomUUID(),
                snapshotId,
                rowId,
                direction: "right",
              },
            });
            return "scrolled";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        {
          bindingId: renewedAfterLateRow.bindingId,
          documentId: renewedAfterLateRow.documentId,
          snapshotId: multiple.value.snapshotId,
          rowId: multiple.value.site.rows[1].id,
        },
      );
      assert.equal(selectedSecond, "scrolled");
      assert.ok(
        (await launched.page.locator(".second-row").evaluate((row) => row.scrollLeft)) >
          secondBefore,
      );
      await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.drop());
      const disconnected = await launched.worker.evaluate(async () => {
        try {
          await globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "binding.refresh",
          });
          return "connected";
        } catch (error) {
          return error instanceof Error ? error.message : "failed";
        }
      });
      assert.equal(disconnected, "unbound");
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "Netflix companion arming rechecks cancellation, selection, and native generation before effect",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({
      companionOnly: true,
      stableNativePort: true,
      companionArming: true,
    });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const port = new URL(launched.page.url()).port;
      await launched.page.goto(`http://127.0.0.1:${port}/browse`);
      await launched.page.setContent("<body style='height:2000px'><p>synthetic catalog</p></body>");
      await launched.page.bringToFront();
      const tab = await launched.worker.evaluate(
        async (url) =>
          (await globalThis["chrome"].tabs.query({})).find((item: any) => item.url === url),
        launched.page.url(),
      );
      assert.ok(tab?.id);
      for (const replacement of ["cancel", "selection", "native"] as const) {
        await launched.worker.evaluate((tabId) => globalThis.__ellieTestWebMCP.bind(tabId), tab.id);
        const binding = await launched.worker.evaluate(() =>
          globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "binding.status",
          }),
        );
        await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.arm());
        const request = {
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "media.execute",
          bindingId: binding.bindingId,
          documentId: binding.documentId,
          command: { type: "scrollViewport", actionId: crypto.randomUUID(), direction: "down" },
        };
        const pending = launched.worker.evaluate(async (value) => {
          try {
            await globalThis.__ellieTestWebMCP.request(value);
            return "effect";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        }, request);
        try {
          await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.entered());
          await launched.worker.evaluate((kind) => {
            if (kind === "cancel") globalThis.__ellieTestWebMCP.abortActive();
            else if (kind === "selection") globalThis.__ellieTestWebMCP.replaceSelection();
            else globalThis.__ellieTestWebMCP.drop();
          }, replacement);
        } finally {
          await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.release());
        }
        assert.equal(await pending, replacement === "cancel" ? "cancelled" : "page_changed");
        assert.equal(
          await launched.page.evaluate(() => scrollY),
          0,
          `${replacement} must dispatch no effect`,
        );
      }
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "Netflix observed search pins one accessible field and sends escaped text once",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ companionOnly: true, stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const port = new URL(launched.page.url()).port;
      await launched.page.goto(`http://127.0.0.1:${port}/browse`);
      await launched.page.setContent(`<label for="site-search">Search</label>
        <input id="site-search" type="search" style="width:240px;height:40px">
        <p id="observed-result"></p>`);
      await launched.page.evaluate(() => {
        globalThis.__searchEvents = 0;
        document.querySelector("input")!.addEventListener("input", () => {
          globalThis.__searchEvents += 1;
          document.querySelector("#observed-result")!.textContent = (
            document.querySelector("input") as HTMLInputElement
          ).value;
        });
      });
      await launched.page.bringToFront();
      const tab = await launched.worker.evaluate(
        async (url) =>
          (await globalThis["chrome"].tabs.query({})).find((item: any) => item.url === url),
        launched.page.url(),
      );
      assert.ok(tab?.id);
      await launched.worker.evaluate((tabId) => globalThis.__ellieTestWebMCP.bind(tabId), tab.id);
      const native = (request: Record<string, unknown>) =>
        launched.worker.evaluate((value) => globalThis.__ellieTestWebMCP.request(value), request);
      const read = async () => {
        const selected = await launched.worker.evaluate(() =>
          globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "binding.refresh",
          }),
        );
        const observed = await native({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "media.execute",
          bindingId: selected.bindingId,
          documentId: selected.documentId,
          command: { type: "inspect", actionId: crypto.randomUUID() },
        });
        return { selected, observed };
      };
      const attempt = async (selected: any, observed: any, query: string) =>
        launched.worker.evaluate(
          async ({ bindingId, documentId, snapshotId, controlId, query }) => {
            try {
              return await globalThis.__ellieTestWebMCP.request({
                protocol: "ellie.browser-webmcp.v1",
                id: crypto.randomUUID(),
                type: "media.execute",
                bindingId,
                documentId,
                command: {
                  type: "searchObserved",
                  actionId: crypto.randomUUID(),
                  snapshotId,
                  controlId,
                  query,
                },
              });
            } catch (error) {
              return error instanceof Error ? error.message : "failed";
            }
          },
          {
            bindingId: selected.bindingId,
            documentId: selected.documentId,
            snapshotId: observed.value.snapshotId,
            controlId: observed.value.site.searchControl.id,
            query,
          },
        );
      let { selected, observed } = await read();
      assert.equal(observed.value.site.searchControl.label, "Search");
      await launched.page.locator("label").evaluate((label) => {
        label.textContent = "Search profiles";
      });
      assert.equal(await attempt(selected, observed, "title"), "unknown");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 0);
      await launched.page.locator("label").evaluate((label) => {
        label.textContent = "Search";
      });

      ({ selected, observed } = await read());
      await launched.page.locator("input").evaluate((input) => {
        input.type = "text";
        input.setAttribute("role", "searchbox");
      });
      assert.equal(await attempt(selected, observed, "title"), "unknown");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 0);
      await launched.page.locator("input").evaluate((input) => {
        input.type = "search";
        input.removeAttribute("role");
      });

      ({ selected, observed } = await read());
      await launched.page.locator("input").evaluate((input) => {
        input.value = "person typed meanwhile";
      });
      assert.equal(await attempt(selected, observed, "title"), "unknown");
      assert.equal(await launched.page.locator("input").inputValue(), "person typed meanwhile");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 0);
      await launched.page.locator("input").evaluate((input) => {
        input.value = "";
      });

      ({ selected, observed } = await read());
      await launched.page.locator("input").evaluate((input) => {
        const replacement = input.cloneNode(true);
        input.replaceWith(replacement);
      });
      assert.equal(await attempt(selected, observed, "title"), "unknown");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 0);
      await launched.page.evaluate(() => {
        document.querySelector("input")!.addEventListener("input", () => {
          globalThis.__searchEvents += 1;
          document.querySelector("#observed-result")!.textContent = (
            document.querySelector("input") as HTMLInputElement
          ).value;
        });
      });

      ({ selected, observed } = await read());
      await launched.page.evaluate(() => {
        const extra = document.createElement("input");
        extra.type = "search";
        extra.setAttribute("aria-label", "Search");
        extra.style.cssText = "width:240px;height:40px";
        document.body.append(extra);
      });
      assert.equal(await attempt(selected, observed, "title"), "unknown");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 0);
      await launched.page
        .locator("input")
        .last()
        .evaluate((input) => input.remove());

      ({ selected, observed } = await read());
      await launched.page.evaluate(() => {
        document.querySelector("input")!.addEventListener("input", () => {
          const query = (document.querySelector("input") as HTMLInputElement).value;
          history.pushState({}, "", `/search?q=${encodeURIComponent(query)}`);
          const title = document.createElement("a");
          title.href = "/watch/123";
          title.textContent = "Synthetic search result";
          title.setAttribute("aria-label", "Synthetic search result");
          title.style.cssText = "display:block;width:240px;height:40px";
          document.body.append(title);
        });
      });
      const query = `Space " & < 🌙`;
      const result = await attempt(selected, observed, query);
      assert.equal(
        result,
        "unknown",
        "a search-triggered SPA navigation has an unverified action outcome",
      );
      assert.equal(await launched.page.locator("input").inputValue(), query);
      assert.equal(await launched.page.locator("#observed-result").textContent(), query);
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 1);
      assert.equal(await attempt(selected, observed, query), "unbound");
      assert.equal(await launched.page.evaluate(() => globalThis.__searchEvents), 1);
      const results = await read();
      assert.equal(results.observed.value.site.page, "results");
      assert.equal(results.observed.value.candidates.length, 1);
      assert.equal(results.observed.value.candidates[0].title, "Synthetic search result");
      const selectRequest = {
        protocol: "ellie.browser-webmcp.v1",
        id: crypto.randomUUID(),
        type: "media.execute",
        bindingId: results.selected.bindingId,
        documentId: results.selected.documentId,
        command: {
          type: "open",
          actionId: crypto.randomUUID(),
          snapshotId: results.observed.value.snapshotId,
          candidateId: results.observed.value.candidates[0].id,
        },
      };
      const selectedResult = await launched.worker.evaluate(async (request) => {
        try {
          return await globalThis.__ellieTestWebMCP.request(request);
        } catch (error) {
          return error instanceof Error ? error.message : "failed";
        }
      }, selectRequest);
      assert.equal(
        selectedResult,
        "unknown",
        "selection navigation is not a verified command reply",
      );
      await launched.page.waitForURL(/\/watch\/123$/, { timeout: 3_000 });
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "cancelled Netflix search arming leaves the observed field unchanged",
  { timeout: 20_000 },
  async () => {
    const owned = await fixture({
      companionOnly: true,
      stableNativePort: true,
      companionArming: true,
    });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const port = new URL(launched.page.url()).port;
      await launched.page.goto(`http://127.0.0.1:${port}/browse`);
      await launched.page.setContent(
        '<label for="search">Search</label><input id="search" type="search" style="width:240px;height:40px">',
      );
      await launched.page.bringToFront();
      const tab = await launched.worker.evaluate(
        async (url) =>
          (await globalThis["chrome"].tabs.query({})).find((item: any) => item.url === url),
        launched.page.url(),
      );
      assert.ok(tab?.id);
      await launched.worker.evaluate((tabId) => globalThis.__ellieTestWebMCP.bind(tabId), tab.id);
      const selected = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.status",
        }),
      );
      const observed = await launched.worker.evaluate(
        (binding) =>
          globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: crypto.randomUUID(),
            type: "media.execute",
            bindingId: binding.bindingId,
            documentId: binding.documentId,
            command: { type: "inspect", actionId: crypto.randomUUID() },
          }),
        selected,
      );
      assert.equal(observed.value.site.searchControl.label, "Search");
      await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.arm());
      const pending = launched.worker.evaluate(
        async ({ bindingId, documentId, snapshotId, controlId }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: crypto.randomUUID(),
              type: "media.execute",
              bindingId,
              documentId,
              command: {
                type: "searchObserved",
                actionId: crypto.randomUUID(),
                snapshotId,
                controlId,
                query: "cancelled query",
              },
            });
            return "effect";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        {
          bindingId: selected.bindingId,
          documentId: selected.documentId,
          snapshotId: observed.value.snapshotId,
          controlId: observed.value.site.searchControl.id,
        },
      );
      try {
        await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.entered());
        await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.abortActive());
      } finally {
        await launched.worker.evaluate(() => globalThis.__ellieTestWebMCP.release());
      }
      assert.equal(await pending, "cancelled");
      assert.equal(await launched.page.locator("input").inputValue(), "");
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "Netflix row uniqueness scans beyond the 40 returned titles",
  { timeout: 20_000 },
  async () => {
    const owned = await fixture({ companionOnly: true, stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const port = new URL(launched.page.url()).port;
      await launched.page.goto(`http://127.0.0.1:${port}/browse`);
      await launched.page.setContent(`<!doctype html><style>
      .row{display:flex;overflow-x:auto;width:320px;height:100px}
      .small{flex:0 0 5px;height:80px;background:#ddd}
      .large{display:block;flex:0 0 260px;height:80px;background:#ccc}
      </style><div class="row first"></div><div class="row second">
      <a class="large" href="/watch/999" aria-label="Second row title">Second</a>
      <span style="flex:0 0 500px"></span></div>`);
      await launched.page.evaluate(() => {
        const row = document.querySelector(".first")!;
        for (let index = 0; index < 40; index += 1) {
          const anchor = document.createElement("a");
          anchor.className = "small";
          anchor.href = `/watch/${index + 1}`;
          anchor.setAttribute("aria-label", `Title ${index + 1}`);
          row.append(anchor);
        }
        const spacer = document.createElement("span");
        spacer.style.flex = "0 0 500px";
        row.append(spacer);
      });
      await launched.page.bringToFront();
      const tab = await launched.worker.evaluate(
        async (url) =>
          (await globalThis["chrome"].tabs.query({})).find((item: any) => item.url === url),
        launched.page.url(),
      );
      assert.ok(tab?.id);
      await launched.worker.evaluate((tabId) => globalThis.__ellieTestWebMCP.bind(tabId), tab.id);
      const binding = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "binding.status",
        }),
      );
      const read = await launched.worker.evaluate(
        (value) => globalThis.__ellieTestWebMCP.request(value),
        {
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "media.execute",
          bindingId: binding.bindingId,
          documentId: binding.documentId,
          command: { type: "inspect", actionId: crypto.randomUUID() },
        },
      );
      assert.equal(read.value.candidates.length, 40);
      assert.equal(read.value.site.horizontalScrollAvailable, false);
      assert.equal(read.value.rowCandidateId, undefined);
      assert.equal(read.value.site.rows.length, 2, "row choice is independent of the title cap");
      const firstBefore = await launched.page.locator(".first").evaluate((row) => row.scrollLeft);
      const oldPopupChoice = await command(launched.harness, tab.id, {
        type: "scrollRow",
        snapshotId: read.value.snapshotId,
        candidateId: read.value.candidates[0].id,
        direction: "right",
      });
      assert.equal(oldPopupChoice.error, "row_scroll_unavailable");
      assert.equal(
        await launched.page.locator(".first").evaluate((row) => row.scrollLeft),
        firstBefore,
      );
      await launched.page.evaluate(() => {
        for (const row of document.querySelectorAll(".row"))
          (row as HTMLElement).style.height = "55px";
        for (let index = 0; index < 7; index += 1) {
          const row = document.createElement("div");
          row.className = "row";
          row.style.height = "55px";
          row.innerHTML = `<a class="large" href="/watch/${1000 + index}" aria-label="Extra title ${index}">Extra</a><span style="flex:0 0 500px"></span>`;
          document.body.append(row);
        }
      });
      const capped = await launched.worker.evaluate(
        (value) => globalThis.__ellieTestWebMCP.request(value),
        {
          protocol: "ellie.browser-webmcp.v1",
          id: crypto.randomUUID(),
          type: "media.execute",
          bindingId: binding.bindingId,
          documentId: binding.documentId,
          command: { type: "inspect", actionId: crypto.randomUUID() },
        },
      );
      assert.deepEqual(
        capped.value.site.rows,
        [],
        "an over-cap row scan must expose no partial choice",
      );
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "loaded extension performs explicit catalogue and verified video controls",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      assert.equal(
        (await command(launched.harness, tab.id, { type: "scrollViewport", direction: "down" }))
          .value.outcome,
        "scrolled",
      );
      const inspected = await command(launched.harness, tab.id, { type: "inspect" });
      assert.equal(inspected.value.candidates.length, 2);
      const first = inspected.value.candidates[0];
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "scrollRow",
            direction: "right",
            snapshotId: inspected.value.snapshotId,
            candidateId: first.id,
          })
        ).value.outcome,
        "scrolled",
      );
      const afterRow = await command(launched.harness, tab.id, { type: "inspect" });
      const second = afterRow.value.candidates.find(
        (candidate: any) => candidate.title === "Second title",
      );
      assert.ok(second);
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "open",
            snapshotId: afterRow.value.snapshotId,
            candidateId: second.id,
          })
        ).value.outcome,
        "navigation_observed",
      );
      await launched.page
        .locator("video")
        .evaluate(
          (video: any) =>
            new Promise<void>((resolve) =>
              video.addEventListener("loadedmetadata", () => resolve(), { once: true }),
            ),
        );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "play" })).value.outcome,
        "playing",
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause" })).value.outcome,
        "paused",
      );
    } finally {
      await context?.close();
      if (server) {
        const ownedServer = server;
        await new Promise<void>((resolve) => ownedServer.close(() => resolve()));
      }
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "connected WebMCP tab aborts a stale history action and blocks rebinding",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const tool = {
          name: "ellie_fixture_action",
          description: "Synthetic action",
          inputSchema: { type: "object", additionalProperties: false },
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => [tool],
            executeTool: async () => {
              (globalThis as any).__ellieHistoryMutation = true;
              return { applied: true };
            },
          },
        });
      });
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      const listed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: "list-1",
          type: "tools.list",
        }),
      );
      await launched.worker.evaluate(() => {
        globalThis.__ellieTestBeforeTabGet = new Promise<void>((resolve) => {
          globalThis.__ellieReleaseTabGet = resolve;
        });
      });
      const pending = launched.worker.evaluate(
        async ({ binding, listed }) => {
          try {
            await globalThis.__ellieTestWebMCP.request({
              protocol: "ellie.browser-webmcp.v1",
              id: "execute-history",
              type: "tool.execute",
              bindingId: binding.bindingId,
              documentId: listed.documentId,
              toolHandle: listed.tools[0].handle,
              args: {},
            });
            return "completed";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        },
        { binding, listed },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        await launched.worker.evaluate(async (tabId) => {
          try {
            await globalThis.__ellieTestWebMCP.bind(tabId);
            return "rebound";
          } catch (error) {
            return error instanceof Error ? error.message : "failed";
          }
        }, tab.id),
        "busy",
      );
      await launched.page.evaluate(() => history.pushState({}, "", "/fresh-view"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await launched.worker.evaluate(() => globalThis.__ellieReleaseTabGet());
      assert.equal(await pending, "cancelled");
      assert.equal(
        await launched.page.evaluate(() => Boolean((globalThis as any).__ellieHistoryMutation)),
        false,
      );
      const invalidated = await launched.worker.evaluate(async () => {
        try {
          await globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: "status-fresh",
            type: "binding.status",
          });
          return "retained";
        } catch (error) {
          return error instanceof Error ? error.message : "failed";
        }
      });
      assert.equal(invalidated, "unbound");
      const rebound = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      assert.notEqual(rebound.bindingId, binding.bindingId);
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "serialized schema uses the reviewed object argument dialect",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const schema = { type: "object", additionalProperties: false };
        const tool = {
          name: "ellie_fixture_action",
          description: "Synthetic action",
          inputSchema: JSON.stringify(schema),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => [tool],
            executeTool: async (_tool: unknown, args: unknown) => {
              if (
                !args ||
                typeof args !== "object" ||
                Array.isArray(args) ||
                JSON.stringify(args) !== "{}"
              )
                throw new Error("unexpected_arguments");
              return JSON.stringify({ applied: true });
            },
          },
        });
      });
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      const listed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: "list-string-schema",
          type: "tools.list",
        }),
      );
      assert.deepEqual(listed.tools[0].inputSchema, {
        type: "object",
        additionalProperties: false,
      });
      const executed = await launched.worker.evaluate(
        ({ binding, listed }) =>
          globalThis.__ellieTestWebMCP.request({
            protocol: "ellie.browser-webmcp.v1",
            id: "execute-string-schema",
            type: "tool.execute",
            bindingId: binding.bindingId,
            documentId: listed.documentId,
            toolHandle: listed.tools[0].handle,
            args: {},
          }),
        { binding, listed },
      );
      assert.deepEqual(executed, { applied: true });
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "JSON-string tool results are bounded before parsing and never retried",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture({ argumentEncoding: "json-string", stableNativePort: true });
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const tool = {
          name: "ellie_fixture_action",
          description: "Synthetic action",
          inputSchema: JSON.stringify({ type: "object", additionalProperties: false }),
          annotations: {
            readOnlyHint: false,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        let result = "{";
        let invocations = 0;
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => [tool],
            executeTool: async (_tool: unknown, args: unknown) => {
              invocations += 1;
              if (typeof args !== "string" || JSON.stringify(JSON.parse(args)) !== "{}")
                throw new Error("unexpected_arguments");
              return result;
            },
          },
        });
        globalThis["__ellieStringResultTest"] = {
          invocations: () => invocations,
          oversized: () => {
            result = JSON.stringify({ value: "💥".repeat(5_000) });
          },
        };
      });
      const binding = await launched.worker.evaluate(
        (tabId) => globalThis.__ellieTestWebMCP.bind(tabId),
        tab.id,
      );
      const listed = await launched.worker.evaluate(() =>
        globalThis.__ellieTestWebMCP.request({
          protocol: "ellie.browser-webmcp.v1",
          id: "list-string-result-bounds",
          type: "tools.list",
        }),
      );
      const { handle, ...expected } = listed.tools[0];
      const execute = (executionId: string) =>
        launched.page.evaluate(
          async ({ handle, expected, executionId }) => {
            try {
              await globalThis["__ellieWebMCPControllerV1"].execute(
                handle,
                expected,
                {},
                executionId,
              );
              return "resolved";
            } catch (error) {
              return error instanceof Error ? error.message : "failed";
            }
          },
          { handle, expected, executionId },
        );

      assert.equal(await execute("invalid-string-result"), "invalid_result");
      assert.equal(
        await launched.page.evaluate(() => globalThis["__ellieStringResultTest"].invocations()),
        1,
      );
      await launched.page.evaluate(() => globalThis["__ellieStringResultTest"].oversized());
      assert.equal(await execute("oversized-string-result"), "result_too_large");
      assert.equal(
        await launched.page.evaluate(() => globalThis["__ellieStringResultTest"].invocations()),
        2,
      );
      assert.equal(binding.availability, "webmcp");
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "rejects unsupported origins, stale candidates, and ambiguous videos",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await command(launched.harness, tab.id, { type: "scrollViewport", direction: "down" });

      const beforeExpired = await launched.page.evaluate(() => scrollY);
      const expired = await launched.harness.evaluate(
        async ({ tabId, expectedUrl }) => {
          await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            files: ["media-controller.js"],
          });
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            func: async (url) => {
              try {
                await globalThis.__ellieMediaController.dispatch(
                  { type: "scrollViewport", direction: "down", actionId: crypto.randomUUID() },
                  url,
                  Date.now() - 1,
                );
                return "mutated";
              } catch (error) {
                return error instanceof Error ? error.message : "failed";
              }
            },
            args: [expectedUrl],
          });
          return result.result;
        },
        { tabId: tab.id, expectedUrl: launched.page.url() },
      );
      assert.equal(expired, "command_timeout");
      assert.equal(await launched.page.evaluate(() => scrollY), beforeExpired);

      await launched.page.evaluate(() => {
        const download = document.createElement("a");
        download.href = "/watch?v=download";
        download.download = "media";
        download.textContent = "Download title";
        download.style.cssText =
          "position:fixed;left:500px;top:20px;width:120px;height:40px;z-index:20";
        const blank = document.createElement("a");
        blank.href = "/watch?v=blank";
        blank.target = "_blank";
        blank.textContent = "New tab title";
        blank.style.cssText =
          "position:fixed;left:500px;top:80px;width:120px;height:40px;z-index:20";
        document.querySelector(".row")?.append(download, blank);
      });
      const inspected = await command(launched.harness, tab.id, { type: "inspect" });
      assert.equal(
        inspected.value.candidates.some((candidate: any) =>
          ["Download title", "New tab title"].includes(candidate.title),
        ),
        false,
      );
      const pageCount = context.pages().length;
      await launched.page
        .locator("a")
        .first()
        .evaluate((element: any) => {
          element.target = "_blank";
        });
      const stale = await command(launched.harness, tab.id, {
        type: "open",
        snapshotId: inspected.value.snapshotId,
        candidateId: inspected.value.candidates[0].id,
      });
      assert.equal(stale.ok, false);
      assert.match(stale.error, /stale_candidate|command_failed/);
      assert.equal(context.pages().length, pageCount);

      await launched.page.reload();
      const afterReload = await command(launched.harness, tab.id, {
        type: "open",
        snapshotId: inspected.value.snapshotId,
        candidateId: inspected.value.candidates[0].id,
      });
      assert.equal(afterReload.ok, false);
      await launched.page.setContent(
        "<video style='width:100px;height:100px'></video><video style='width:100px;height:100px'></video>",
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause" })).error,
        "ambiguous_video",
      );

      const reloadDedup = crypto.randomUUID();
      await launched.page.setContent("<video muted style='width:100px;height:100px'></video>");
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: reloadDedup })).ok,
        true,
      );
      await launched.page.reload();
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: reloadDedup })).error,
        "duplicate_action",
      );

      await launched.page.setContent("<video muted style='width:100px;height:100px'></video>");
      await launched.page.locator("video").evaluate((video: any) => {
        video.play = () => new Promise(() => {});
      });
      const preCancelled = crypto.randomUUID();
      await command(launched.harness, tab.id, {
        type: "cancel",
        targetActionId: preCancelled,
      });
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "play",
            actionId: preCancelled,
          })
        ).error,
        "cancelled",
      );
      const blocked = await command(launched.harness, tab.id, { type: "play" });
      assert.equal(blocked.error, "playback_unknown");

      const pendingId = crypto.randomUUID();
      const pendingPlay = command(launched.harness, tab.id, {
        type: "play",
        actionId: pendingId,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal((await command(launched.harness, tab.id, { type: "pause" })).error, "busy");
      assert.equal(
        (
          await command(launched.harness, tab.id, {
            type: "cancel",
            targetActionId: pendingId,
          })
        ).value.outcome,
        "cancelled",
      );
      assert.equal((await pendingPlay).error, "cancelled");

      const duplicateId = crypto.randomUUID();
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: duplicateId })).ok,
        true,
      );
      assert.equal(
        (await command(launched.harness, tab.id, { type: "pause", actionId: duplicateId })).error,
        "duplicate_action",
      );

      await launched.page.evaluate(() => {
        Object.defineProperty(document, "modelContext", {
          value: { getTools: () => new Promise(() => {}) },
          configurable: true,
        });
      });
      const webmcp = await command(launched.harness, tab.id, { type: "discoverWebMCP" });
      assert.equal(webmcp.value.status, "timeout");
      const current = new URL(launched.page.url());
      await launched.page.goto(`http://localhost:${current.port}/`);
      assert.equal(
        (await command(launched.harness, tab.id, { type: "inspect" })).error,
        "unsupported_page",
      );
    } finally {
      await context?.close();
      if (server) {
        const ownedServer = server;
        await new Promise<void>((resolve) => ownedServer.close(() => resolve()));
      }
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);

test(
  "WebMCP controller executes the exact discovered tool and aborts by signal",
  { timeout: 30_000 },
  async () => {
    const owned = await fixture();
    let context: BrowserContext | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const launched = await launch(owned.extension, owned.root);
      ({ context, server } = launched);
      const tabs = await launched.worker.evaluate(async () => globalThis["chrome"].tabs.query({}));
      const tab = tabs.find((item: any) => item.url?.startsWith("http://127.0.0.1:"));
      assert.ok(tab?.id);
      await launched.page.evaluate(() => {
        const tool = {
          name: "ellie_fixture_search",
          description: "Search the synthetic fixture",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
            consequentialHint: false,
          },
        };
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          value: {
            getTools: async () => {
              if ((globalThis as any).__ellieDelayTools)
                await new Promise<void>((resolve) => {
                  (globalThis as any).__ellieReleaseDelayedTools = resolve;
                });
              return [tool];
            },
            executeTool: async (candidate, args, options) => {
              if (candidate !== tool) throw new Error("wrong_tool_identity");
              (globalThis as any).__ellieWebMCPMutations =
                ((globalThis as any).__ellieWebMCPMutations || 0) + 1;
              if (args.query === "wait")
                return await new Promise((_resolve, reject) =>
                  options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                    once: true,
                  }),
                );
              return { items: [{ id: "one", label: String(args.query) }] };
            },
          },
        });
      });
      await launched.harness.evaluate(async (tabId) => {
        await globalThis["chrome"].scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          files: ["webmcp-controller.js"],
        });
      }, tab.id);
      const reviewed = [
        {
          name: "ellie_fixture_search",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["query"],
            properties: { query: { type: "string" } },
          },
          annotations: {
            readOnlyHint: true,
            untrustedContentHint: false,
            consequentialHint: false,
          },
          argumentEncoding: "object",
        },
      ];
      const tools = await launched.harness.evaluate(
        async ({ tabId, reviewed }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (policy) => globalThis.__ellieWebMCPControllerV1.list(policy),
            args: [reviewed],
          });
          return result.result;
        },
        { tabId: tab.id, reviewed },
      );
      assert.equal(tools.length, 1);
      const { handle, ...metadata } = tools[0];
      const completed = await launched.harness.evaluate(
        async ({ tabId, handle, metadata }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (handle, metadata) =>
              globalThis.__ellieWebMCPControllerV1.execute(
                handle,
                metadata,
                { query: "cats" },
                "execution-1",
              ),
            args: [handle, metadata],
          });
          return result.result;
        },
        { tabId: tab.id, handle, metadata },
      );
      assert.deepEqual(completed, {
        navigation: false,
        value: { items: [{ id: "one", label: "cats" }] },
      });

      assert.equal(
        await launched.harness.evaluate(async (tabId) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => globalThis.__ellieWebMCPControllerV1.cancel("execution-before-register"),
          });
          return result.result;
        }, tab.id),
        true,
      );
      assert.equal(
        await launched.harness.evaluate(
          async ({ tabId, handle, metadata }) => {
            const [result] = await globalThis["chrome"].scripting.executeScript({
              target: { tabId },
              world: "MAIN",
              func: async (handle, metadata) => {
                try {
                  await globalThis.__ellieWebMCPControllerV1.execute(
                    handle,
                    metadata,
                    { query: "late" },
                    "execution-before-register",
                  );
                  return "mutated";
                } catch {
                  return "cancelled";
                }
              },
              args: [handle, metadata],
            });
            return result.result;
          },
          { tabId: tab.id, handle, metadata },
        ),
        "cancelled",
      );

      await launched.page.evaluate(() => {
        (globalThis as any).__ellieDelayTools = true;
      });

      const waiting = launched.harness.evaluate(
        async ({ tabId, handle, metadata }) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (handle, metadata) => {
              try {
                await globalThis.__ellieWebMCPControllerV1.execute(
                  handle,
                  metadata,
                  { query: "wait" },
                  "execution-2",
                );
                return "completed";
              } catch {
                return "aborted";
              }
            },
            args: [handle, metadata],
          });
          return result.result;
        },
        { tabId: tab.id, handle, metadata },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        await launched.harness.evaluate(async (tabId) => {
          const [result] = await globalThis["chrome"].scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: () => globalThis.__ellieWebMCPControllerV1.cancel("execution-2"),
          });
          return result.result;
        }, tab.id),
        true,
      );
      await launched.page.evaluate(() => (globalThis as any).__ellieReleaseDelayedTools());
      assert.equal(await waiting, "aborted");
      assert.equal(
        await launched.page.evaluate(() => (globalThis as any).__ellieWebMCPMutations),
        1,
      );
    } finally {
      await context?.close();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned.root, { recursive: true, force: true });
    }
  },
);
