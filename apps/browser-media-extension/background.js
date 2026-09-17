const productionOrigins = new Set([
  "https://www.netflix.com",
  "https://www.youtube.com",
  "https://tv.youtube.com",
  "https://www.disneyplus.com",
]);
const accessibilityBindingOrigins = new Set(["https://www.youtube.com"]);
const companionBindingOrigins = new Set([
  "https://www.netflix.com",
  "https://tv.youtube.com",
  "https://www.disneyplus.com",
]);
const mutationLedgers = new Map();
const mutationTypes = new Set([
  "scrollViewport",
  "scrollRow",
  "scrollSelectedRow",
  "searchObserved",
  "open",
  "play",
  "pause",
  "seek",
]);
const actionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nativeProtocol = "ellie.browser-webmcp.v1";
const nativeHost = "org.ellie.browser_webmcp";
const bindingLifetimeMs = 15 * 60 * 1000;
// Shipping execution remains closed until a provider origin and exact schema receive review.
const reviewedWebMCPBindings = Object.freeze({});
let webMCPBinding;
let webMCPSelection;
let pendingWebMCPBind;
let nativePort;
let nativePortGeneration = 0;
let nativeConnectionStatus = "idle";
let nativeConnectionRevision = 0;
let activeWebMCP;

const nativeConnectionStatuses = new Set([
  "idle",
  "waiting",
  "connected",
  "missing",
  "disconnected",
]);

function publishNativeConnectionStatus(value) {
  if (!nativeConnectionStatuses.has(value)) return;
  nativeConnectionStatus = value;
  nativeConnectionRevision += 1;
  try {
    const sent = chrome.runtime.sendMessage({
      protocol: "ellie.browser-native-status.v1",
      status: value,
      revision: nativeConnectionRevision,
    });
    sent?.catch(() => {});
  } catch {
    // The popup is usually closed. Connection state remains available in the bind response.
  }
}

function nativeConnectionSnapshot() {
  return { status: nativeConnectionStatus, revision: nativeConnectionRevision };
}

function supportedNativeRequest(request) {
  return (
    request?.protocol === nativeProtocol &&
    typeof request.id === "string" &&
    [
      "cancel",
      "binding.status",
      "binding.refresh",
      "page.inspect",
      "media.execute",
      "tools.list",
      "tool.execute",
    ].includes(request.type)
  );
}

function nativeHostMissing(message) {
  return (
    typeof message === "string" &&
    (/specified native messaging host not found/i.test(message) ||
      /native messaging host .* not found/i.test(message))
  );
}

function allowedOrigin(url) {
  try {
    const parsed = new URL(url);
    return !parsed.username && !parsed.password && productionOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

async function dispatch(tabId, command, expectedBinding, authorizeEffect, effectStarted) {
  const deadline = Date.now() + 2000;
  if (mutationTypes.has(command?.type)) {
    if (!actionPattern.test(command?.actionId)) throw new Error("invalid_command");
    let ledger = mutationLedgers.get(tabId);
    if (!ledger) mutationLedgers.set(tabId, (ledger = new Set()));
    if (ledger.has(command.actionId)) throw new Error("duplicate_action");
    if (ledger.size >= 256) throw new Error("action_ledger_full");
    ledger.add(command.actionId);
  }
  const before = await chrome.tabs.get(tabId);
  if (!before.url || !allowedOrigin(before.url)) throw new Error("unsupported_page");
  const controllerFile =
    new URL(before.url).origin === "https://tv.youtube.com"
      ? "youtube-tv-controller.js"
      : new URL(before.url).origin === "https://www.disneyplus.com"
        ? "disneyplus-controller.js"
        : "media-controller.js";
  if (
    expectedBinding &&
    (before.url !== expectedBinding.url ||
      before.windowId !== expectedBinding.windowId ||
      before.active !== true ||
      before.status !== "complete" ||
      !(await chrome.windows.get(expectedBinding.windowId)).focused)
  )
    throw new Error("page_changed");
  const installed = await chrome.scripting.executeScript({
    target: { tabId },
    files: [controllerFile],
  });
  const documentId = installed[0]?.documentId;
  if (!documentId) throw new Error("page_changed");
  if (expectedBinding && documentId !== expectedBinding.documentId) throw new Error("page_changed");
  if (expectedBinding) {
    const armed = await chrome.tabs.get(tabId);
    if (
      armed.url !== expectedBinding.url ||
      armed.windowId !== expectedBinding.windowId ||
      armed.active !== true ||
      armed.status !== "complete" ||
      !(await chrome.windows.get(expectedBinding.windowId)).focused
    )
      throw new Error("page_changed");
  }
  // All arming awaits are complete. No asynchronous work may separate this check
  // from the effect request: cancellation or replacement must stop pre-dispatch.
  authorizeEffect?.();
  effectStarted?.();
  const execution = chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    func: async (value, expectedUrl, deadline) => {
      try {
        return {
          ok: true,
          value: await globalThis.__ellieMediaController.dispatch(value, expectedUrl, deadline),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "command_failed" };
      }
    },
    args: [command, before.url, deadline],
  });
  const [{ result }] = await Promise.race([
    execution,
    new Promise((_, reject) => setTimeout(() => reject(new Error("command_timeout")), 2500)),
  ]);
  const after = await chrome.tabs.get(tabId);
  if (
    !after.url ||
    !allowedOrigin(after.url) ||
    (command.type !== "open" && after.url !== before.url)
  )
    throw new Error("page_changed");
  if (command.type === "open" && new URL(after.url).origin !== new URL(before.url).origin)
    throw new Error("page_changed");
  if (!result?.ok) throw new Error(result?.error || "command_failed");
  return result.value;
}

async function discoverWebMCP(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !allowedOrigin(tab.url)) throw new Error("unsupported_page");
  const discovery = chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const primary = document.modelContext;
      const legacy = navigator.modelContext;
      if (!primary || typeof primary.getTools !== "function") {
        return { primary: false, legacy: Boolean(legacy), tools: [] };
      }
      try {
        const values = await Promise.race([
          Promise.resolve(primary.getTools()).then((tools) => ({ kind: "tools", tools })),
          new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 500)),
        ]);
        if (values.kind === "timeout")
          return { primary: true, legacy: Boolean(legacy), status: "timeout", tools: [] };
        const tools = Array.isArray(values.tools)
          ? values.tools.slice(0, 16).map((tool) => ({
              name: typeof tool?.name === "string" ? tool.name.slice(0, 100) : "",
              description:
                typeof tool?.description === "string" ? tool.description.slice(0, 300) : "",
            }))
          : [];
        return { primary: true, legacy: Boolean(legacy), status: "available", tools };
      } catch {
        return { primary: true, legacy: Boolean(legacy), status: "error", tools: [] };
      }
    },
  });
  const [{ result, documentId }] = await Promise.race([
    discovery,
    new Promise((_, reject) => setTimeout(() => reject(new Error("command_timeout")), 1000)),
  ]);
  const after = await chrome.tabs.get(tabId);
  if (!documentId || after.url !== tab.url) throw new Error("page_changed");
  return result;
}

function reviewedTools(origin) {
  return Object.hasOwn(reviewedWebMCPBindings, origin) ? reviewedWebMCPBindings[origin] : undefined;
}

function bindingAvailability(origin) {
  const tools = reviewedTools(origin);
  return Array.isArray(tools) && tools.length > 0
    ? "webmcp"
    : accessibilityBindingOrigins.has(origin)
      ? "accessibility"
      : companionBindingOrigins.has(origin)
        ? "companion"
        : undefined;
}

function clearWebMCPSelection() {
  webMCPBinding = undefined;
  webMCPSelection = undefined;
}

function liveSelection() {
  if (!webMCPSelection) throw new Error("unbound");
  if (Date.now() >= webMCPSelection.expiresAt) {
    clearWebMCPSelection();
    throw new Error("unbound");
  }
  return webMCPSelection;
}

async function selectedAnchorTab(selection) {
  if (!nativePort || selection.nativePortGeneration !== nativePortGeneration)
    throw new Error("unbound");
  const tab = await chrome.tabs.get(selection.tabId);
  if (tab.id !== selection.tabId || tab.windowId !== selection.windowId) {
    clearWebMCPSelection();
    throw new Error("page_changed");
  }
  if (!tab.url) {
    clearWebMCPSelection();
    throw new Error("page_changed");
  }
  if (tab.active !== true || tab.status !== "complete") throw new Error("page_changed");
  const browserWindow = await chrome.windows.get(selection.windowId);
  if (browserWindow.id !== selection.windowId || browserWindow.focused !== true)
    throw new Error("page_changed");
  let origin;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    clearWebMCPSelection();
    throw new Error("unsupported_origin");
  }
  if (origin !== selection.origin) {
    clearWebMCPSelection();
    throw new Error("unsupported_origin");
  }
  return tab;
}

async function currentWebMCPDocument(binding) {
  const tab = await chrome.tabs.get(binding.tabId);
  if (!tab.url) throw new Error("page_changed");
  const url = new URL(tab.url);
  if (url.origin !== binding.origin) {
    clearWebMCPSelection();
    throw new Error("unsupported_origin");
  }
  if (binding.documentId !== "pending" && tab.url !== binding.url) {
    webMCPBinding = undefined;
    throw new Error("page_changed");
  }
  const installed = await chrome.scripting.executeScript({
    target: { tabId: binding.tabId },
    world: "MAIN",
    files: ["webmcp-controller.js"],
  });
  const documentId = installed[0]?.documentId;
  if (!documentId) throw new Error("page_changed");
  if (binding.documentId !== "pending" && binding.documentId !== documentId) {
    webMCPBinding = undefined;
    throw new Error("page_changed");
  }
  binding.documentId = documentId;
  binding.url = tab.url;
  return binding;
}

async function bindWebMCP(tabId) {
  if (activeWebMCP || pendingWebMCPBind) throw new Error("busy");
  const initial = await chrome.tabs.get(tabId);
  if (
    !initial.url ||
    initial.id !== tabId ||
    !Number.isInteger(initial.windowId) ||
    initial.active !== true ||
    initial.status !== "complete"
  ) {
    throw new Error("unsupported_page");
  }
  const browserWindow = await chrome.windows.get(initial.windowId);
  if (browserWindow.id !== initial.windowId || browserWindow.focused !== true) {
    throw new Error("unsupported_page");
  }
  const tab = initial;
  const origin = new URL(tab.url).origin;
  const availability = bindingAvailability(origin);
  if (!availability) throw new Error("unsupported_origin");
  const pending = { tabId, navigationGeneration: 0 };
  pendingWebMCPBind = pending;
  try {
    connectNativeHost();
    const generation = nativePortGeneration;
    const binding = await currentWebMCPDocument({
      bindingId: crypto.randomUUID(),
      tabId,
      windowId: tab.windowId,
      documentId: "pending",
      origin,
      url: tab.url,
      expiresAt: Date.now() + bindingLifetimeMs,
      availability,
      tools: new Map(),
    });
    const after = await chrome.tabs.get(tabId);
    const afterWindow = await chrome.windows.get(tab.windowId);
    if (
      activeWebMCP ||
      pendingWebMCPBind !== pending ||
      pending.navigationGeneration !== 0 ||
      !nativePort ||
      generation !== nativePortGeneration ||
      after.id !== tabId ||
      after.windowId !== tab.windowId ||
      after.active !== true ||
      after.status !== "complete" ||
      after.url !== binding.url ||
      afterWindow.id !== tab.windowId ||
      afterWindow.focused !== true
    )
      throw new Error("page_changed");
    webMCPSelection = {
      tabId,
      windowId: tab.windowId,
      origin,
      expiresAt: binding.expiresAt,
      availability,
      nativePortGeneration: generation,
      navigationGeneration: 0,
    };
    webMCPBinding = binding;
    return {
      bindingId: binding.bindingId,
      origin,
      expiresAt: binding.expiresAt,
      availability: binding.availability,
      nativeConnection: nativeConnectionSnapshot(),
    };
  } finally {
    if (pendingWebMCPBind === pending) pendingWebMCPBind = undefined;
  }
}

function liveBinding() {
  if (!webMCPBinding) throw new Error("unbound");
  if (Date.now() >= webMCPBinding.expiresAt) {
    clearWebMCPSelection();
    throw new Error("unbound");
  }
  return webMCPBinding;
}

async function refreshWebMCPBinding(controller) {
  const selection = liveSelection();
  const navigationGeneration = selection.navigationGeneration;
  webMCPBinding = undefined;
  if (controller.signal.aborted) throw new Error("cancelled");
  const before = await selectedAnchorTab(selection);
  if (controller.signal.aborted) throw new Error("cancelled");
  const injection = chrome.scripting.executeScript({
    target: { tabId: selection.tabId },
    world: "MAIN",
    files: ["webmcp-controller.js"],
  });
  let timer;
  let cancel;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed_out")), 2000);
    cancel = () => reject(new Error("cancelled"));
    controller.signal.addEventListener("abort", cancel, { once: true });
  });
  let installed;
  try {
    installed = await Promise.race([injection, interrupted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", cancel);
  }
  if (controller.signal.aborted) throw new Error("cancelled");
  const documentId = installed[0]?.documentId;
  const after = await selectedAnchorTab(selection);
  if (controller.signal.aborted) throw new Error("cancelled");
  if (
    !documentId ||
    webMCPSelection !== selection ||
    selection.navigationGeneration !== navigationGeneration ||
    Date.now() >= selection.expiresAt ||
    before.url !== after.url
  )
    throw new Error("page_changed");
  const binding = {
    bindingId: crypto.randomUUID(),
    tabId: selection.tabId,
    windowId: selection.windowId,
    documentId,
    origin: selection.origin,
    url: after.url,
    expiresAt: selection.expiresAt,
    availability: selection.availability,
    tools: new Map(),
  };
  webMCPBinding = binding;
  return binding;
}

async function listWebMCPTools() {
  const binding = await currentWebMCPDocument(liveBinding());
  const [{ result, documentId }] = await Promise.race([
    chrome.scripting.executeScript({
      target: { tabId: binding.tabId, documentIds: [binding.documentId] },
      world: "MAIN",
      func: (reviewed) => globalThis.__ellieWebMCPControllerV1.list(reviewed),
      args: [reviewedTools(binding.origin)],
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed_out")), 2000)),
  ]);
  if (documentId !== binding.documentId || !Array.isArray(result)) throw new Error("page_changed");
  binding.tools = new Map(result.map((tool) => [tool.handle, tool]));
  return {
    bindingId: binding.bindingId,
    documentId: binding.documentId,
    tools: result,
  };
}

async function inspectSelectedPage(request, controller) {
  if (
    Object.keys(request).sort().join() !== "bindingId,documentId,id,protocol,type" ||
    typeof request.bindingId !== "string" ||
    typeof request.documentId !== "string"
  )
    throw new Error("invalid_arguments");
  const binding = liveBinding();
  const selection = liveSelection();
  if (
    selection.tabId !== binding.tabId ||
    selection.windowId !== binding.windowId ||
    binding.availability !== "accessibility" ||
    binding.origin !== "https://www.youtube.com" ||
    request.bindingId !== binding.bindingId ||
    request.documentId !== binding.documentId
  )
    throw new Error("page_changed");
  const navigationGeneration = selection.navigationGeneration;
  if (controller.signal.aborted) throw new Error("cancelled");
  const before = await selectedAnchorTab(selection);
  await currentWebMCPDocument(binding);
  if (before.url !== binding.url || controller.signal.aborted) throw new Error("page_changed");
  const site = await dispatch(binding.tabId, { type: "observe", actionId: crypto.randomUUID() });
  if (controller.signal.aborted) throw new Error("cancelled");
  const after = await selectedAnchorTab(selection);
  await currentWebMCPDocument(binding);
  if (
    webMCPSelection !== selection ||
    webMCPBinding !== binding ||
    selection.navigationGeneration !== navigationGeneration ||
    after.url !== before.url ||
    Date.now() >= binding.expiresAt ||
    request.bindingId !== binding.bindingId ||
    request.documentId !== binding.documentId
  )
    throw new Error("page_changed");
  return { bindingId: binding.bindingId, documentId: binding.documentId, url: binding.url, site };
}

async function executeCompanion(request, controller) {
  if (
    Object.keys(request).sort().join() !== "bindingId,command,documentId,id,protocol,type" ||
    typeof request.bindingId !== "string" ||
    typeof request.documentId !== "string" ||
    !request.command ||
    typeof request.command !== "object" ||
    ![
      "inspect",
      "scrollViewport",
      "scrollSelectedRow",
      "searchObserved",
      "open",
      "play",
      "pause",
    ].includes(request.command.type)
  )
    throw new Error("invalid_arguments");
  const binding = liveBinding();
  const selection = liveSelection();
  if (
    binding.availability !== "companion" ||
    !companionBindingOrigins.has(binding.origin) ||
    selection.tabId !== binding.tabId ||
    selection.windowId !== binding.windowId ||
    request.bindingId !== binding.bindingId ||
    request.documentId !== binding.documentId
  )
    throw new Error("page_changed");
  const navigationGeneration = selection.navigationGeneration;
  const nativeGeneration = nativePortGeneration;
  if (controller.signal.aborted) throw new Error("cancelled");
  const before = await selectedAnchorTab(selection);
  await currentWebMCPDocument(binding);
  if (
    controller.signal.aborted ||
    before.url !== binding.url ||
    webMCPSelection !== selection ||
    webMCPBinding !== binding ||
    selection.navigationGeneration !== navigationGeneration
  )
    throw new Error("page_changed");
  const mutates = request.command.type !== "inspect";
  // Once a mutation is admitted, the old binding cannot authorize another operation.
  if (mutates) webMCPBinding = undefined;
  let effectStarted = false;
  const authorizeEffect = () => {
    if (controller.signal.aborted) throw new Error("cancelled");
    if (
      !nativePort ||
      nativePortGeneration !== nativeGeneration ||
      webMCPSelection !== selection ||
      selection.navigationGeneration !== navigationGeneration ||
      (mutates ? webMCPBinding !== undefined : webMCPBinding !== binding) ||
      activeWebMCP?.controller !== controller ||
      Date.now() >= binding.expiresAt
    )
      throw new Error("page_changed");
  };
  let value;
  try {
    value = await dispatch(binding.tabId, request.command, binding, authorizeEffect, () => {
      effectStarted = true;
    });
  } catch (error) {
    if (mutates && effectStarted) throw new Error("unknown");
    throw error;
  }
  if (controller.signal.aborted) throw new Error(mutates ? "unknown" : "cancelled");
  if (!mutates) {
    const after = await selectedAnchorTab(selection);
    await currentWebMCPDocument(binding);
    if (
      webMCPSelection !== selection ||
      webMCPBinding !== binding ||
      selection.navigationGeneration !== navigationGeneration ||
      before.url !== after.url ||
      after.url !== binding.url
    )
      throw new Error("page_changed");
  }
  return { bindingId: binding.bindingId, documentId: binding.documentId, url: binding.url, value };
}

async function executeWebMCP(request, controller) {
  const binding = liveBinding();
  const before = await chrome.tabs.get(binding.tabId);
  if (controller.signal.aborted) throw new Error("cancelled");
  if (
    before.url !== binding.url ||
    request.bindingId !== binding.bindingId ||
    request.documentId !== binding.documentId ||
    !binding.tools.has(request.toolHandle)
  )
    throw new Error("stale_tool");
  const tool = binding.tools.get(request.toolHandle);
  const executionDocumentId = binding.documentId;
  const executionId = crypto.randomUUID();
  const execution = chrome.scripting.executeScript({
    target: { tabId: binding.tabId, documentIds: [executionDocumentId] },
    world: "MAIN",
    func: async (handle, expected, args, id) => {
      try {
        const { handle: _handle, ...metadata } = expected;
        return {
          ok: true,
          value: await globalThis.__ellieWebMCPControllerV1.execute(handle, metadata, args, id),
        };
      } catch (error) {
        return { ok: false, error: "unknown" };
      }
    },
    args: [request.toolHandle, tool, request.args, executionId],
  });
  let timer;
  const interrupted = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed_out")), 15000);
    controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
      once: true,
    });
  });
  let response;
  try {
    response = await Promise.race([execution, interrupted]);
  } catch (error) {
    const cancellation = chrome.scripting
      .executeScript({
        target: { tabId: binding.tabId, documentIds: [executionDocumentId] },
        world: "MAIN",
        func: (id) => globalThis.__ellieWebMCPControllerV1.cancel(id),
        args: [executionId],
      })
      .catch(() => {});
    await Promise.race([cancellation, new Promise((resolve) => setTimeout(resolve, 500))]);
    if (activeWebMCP?.id === request.id) activeWebMCP.retain = true;
    const release = () => {
      if (activeWebMCP?.id === request.id) activeWebMCP = undefined;
    };
    void execution.then(release, release);
    throw new Error("unknown");
  } finally {
    clearTimeout(timer);
  }
  const [{ result, documentId }] = response;
  const after = await chrome.tabs.get(binding.tabId);
  if (
    documentId !== executionDocumentId ||
    binding.documentId !== executionDocumentId ||
    !result?.ok
  )
    throw new Error(result?.error || "unavailable");
  if (result.value?.navigation === true || after.url !== binding.url) throw new Error("unknown");
  return result.value?.value;
}

const nativeErrors = new Set([
  "unbound",
  "unsupported_origin",
  "page_changed",
  "stale_tool",
  "invalid_arguments",
  "busy",
  "cancelled",
  "timed_out",
  "unknown",
  "unavailable",
]);

async function handleNativeRequest(request) {
  if (request?.protocol !== nativeProtocol || typeof request.id !== "string")
    throw new Error("unavailable");
  if (request.type === "cancel") {
    const cancelled = activeWebMCP?.id === request.targetId;
    if (cancelled) activeWebMCP.controller.abort();
    return { cancelled };
  }
  if (activeWebMCP) throw new Error("busy");
  const controller = new AbortController();
  activeWebMCP = { id: request.id, controller };
  try {
    if (request.type === "binding.status") {
      const binding = await currentWebMCPDocument(liveBinding());
      return {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        origin: binding.origin,
        url: binding.url,
        expiresAt: binding.expiresAt,
        availability: binding.availability,
      };
    }
    if (request.type === "binding.refresh") {
      const binding = await refreshWebMCPBinding(controller);
      return {
        bindingId: binding.bindingId,
        documentId: binding.documentId,
        origin: binding.origin,
        url: binding.url,
        expiresAt: binding.expiresAt,
        availability: binding.availability,
      };
    }
    if (request.type === "tools.list") return await listWebMCPTools();
    if (request.type === "page.inspect") return await inspectSelectedPage(request, controller);
    if (request.type === "media.execute") return await executeCompanion(request, controller);
    if (request.type === "tool.execute") return await executeWebMCP(request, controller);
    throw new Error("unavailable");
  } finally {
    if (activeWebMCP?.id === request.id && !activeWebMCP.retain) activeWebMCP = undefined;
  }
}

function connectNativeHost() {
  if (nativePort) return nativeConnectionStatus;
  const port = chrome.runtime.connectNative(nativeHost);
  nativePort = port;
  nativePortGeneration += 1;
  publishNativeConnectionStatus("waiting");
  port.onDisconnect.addListener(() => {
    const missing = nativeHostMissing(chrome.runtime.lastError?.message);
    if (nativePort === port) {
      nativePort = undefined;
      clearWebMCPSelection();
    }
    activeWebMCP?.controller.abort();
    publishNativeConnectionStatus(missing ? "missing" : "disconnected");
  });
  port.onMessage.addListener((request) => {
    if (nativePort !== port) return;
    if (supportedNativeRequest(request)) publishNativeConnectionStatus("connected");
    Promise.resolve()
      .then(() => handleNativeRequest(request))
      .then(
        (value) =>
          nativePort === port &&
          port.postMessage({
            protocol: nativeProtocol,
            id: request.id,
            type: "result",
            status: "ok",
            value,
          }),
      )
      .catch((error) => {
        const status =
          error instanceof Error && nativeErrors.has(error.message) ? error.message : "unavailable";
        if (nativePort !== port) return;
        port.postMessage({
          protocol: nativeProtocol,
          id: request?.id || "invalid",
          type: "result",
          status,
        });
      });
  });
  return nativeConnectionStatus;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const messageKeys =
    message && typeof message === "object" ? Object.keys(message).sort().join() : "";
  if (
    messageKeys !== "command,protocol,tabId" ||
    message.protocol !== "ellie.media.v1" ||
    !Number.isInteger(message.tabId) ||
    message.tabId < 0
  )
    return;
  if (message.command?.type === "discoverWebMCP" || message.command?.type === "bindWebMCP") {
    const keys = Object.keys(message.command).sort().join();
    if (
      keys !== "actionId,type" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        message.command.actionId,
      )
    ) {
      sendResponse({ ok: false, error: "invalid_command" });
      return;
    }
  }
  const operation =
    message.command?.type === "bindWebMCP"
      ? bindWebMCP(message.tabId)
      : message.command?.type === "discoverWebMCP"
        ? discoverWebMCP(message.tabId)
        : dispatch(message.tabId, message.command);
  const fixed = new Set([
    "unsupported_page",
    "page_changed",
    "command_timeout",
    "invalid_command",
    "cancelled",
    "duplicate_action",
    "busy",
    "stale_snapshot",
    "stale_candidate",
    "scroll_unavailable",
    "row_scroll_unavailable",
    "navigation_not_observed",
    "playback_unknown",
    "video_not_found",
    "ambiguous_video",
    "pause_not_verified",
    "seek_unavailable",
    "seek_not_verified",
    "action_ledger_full",
    "unsupported_origin",
    "unbound",
  ]);
  operation
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error) => {
      const code =
        error instanceof Error && fixed.has(error.message) ? error.message : "command_failed";
      sendResponse({ ok: false, error: code });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mutationLedgers.delete(tabId);
  if (pendingWebMCPBind?.tabId === tabId) pendingWebMCPBind.navigationGeneration += 1;
  if (webMCPSelection?.tabId === tabId) {
    activeWebMCP?.controller.abort();
    clearWebMCPSelection();
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url || change.status === "loading") {
    if (pendingWebMCPBind?.tabId === tabId) pendingWebMCPBind.navigationGeneration += 1;
  } else {
    return;
  }
  if (!webMCPSelection || webMCPSelection.tabId !== tabId) return;
  activeWebMCP?.controller.abort();
  webMCPBinding = undefined;
  webMCPSelection.navigationGeneration += 1;
  if (Date.now() >= webMCPSelection.expiresAt) {
    clearWebMCPSelection();
    return;
  }
  try {
    if (change.url && new URL(change.url).origin !== webMCPSelection.origin) clearWebMCPSelection();
  } catch {
    clearWebMCPSelection();
  }
});
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  if (pendingWebMCPBind?.tabId === removedTabId) pendingWebMCPBind.navigationGeneration += 1;
  if (webMCPSelection?.tabId !== removedTabId) return;
  activeWebMCP?.controller.abort();
  clearWebMCPSelection();
});
