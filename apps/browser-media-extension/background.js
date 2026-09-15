const productionOrigins = new Set(["https://www.netflix.com", "https://www.youtube.com"]);
const accessibilityBindingOrigins = new Set(["https://www.youtube.com"]);
const mutationLedgers = new Map();
const mutationTypes = new Set(["scrollViewport", "scrollRow", "open", "play", "pause", "seek"]);
const actionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const nativeProtocol = "ellie.browser-webmcp.v1";
const nativeHost = "org.ellie.browser_webmcp";
const bindingLifetimeMs = 15 * 60 * 1000;
// Shipping execution remains closed until a provider origin and exact schema receive review.
const reviewedWebMCPBindings = Object.freeze({});
let webMCPBinding;
let nativePort;
let activeWebMCP;

function allowedOrigin(url) {
  try {
    return productionOrigins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

async function dispatch(tabId, command) {
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
  const installed = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["media-controller.js"],
  });
  const documentId = installed[0]?.documentId;
  if (!documentId) throw new Error("page_changed");
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
      : undefined;
}

async function currentWebMCPDocument(binding) {
  const tab = await chrome.tabs.get(binding.tabId);
  if (!tab.url) throw new Error("page_changed");
  const url = new URL(tab.url);
  if (url.origin !== binding.origin) {
    webMCPBinding = undefined;
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
  if (activeWebMCP) throw new Error("busy");
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) throw new Error("unsupported_page");
  const origin = new URL(tab.url).origin;
  const availability = bindingAvailability(origin);
  if (!availability) throw new Error("unsupported_origin");
  const binding = await currentWebMCPDocument({
    bindingId: crypto.randomUUID(),
    tabId,
    documentId: "pending",
    origin,
    url: tab.url,
    expiresAt: Date.now() + bindingLifetimeMs,
    availability,
    tools: new Map(),
  });
  webMCPBinding = binding;
  connectNativeHost();
  return {
    bindingId: binding.bindingId,
    origin,
    expiresAt: binding.expiresAt,
    availability: binding.availability,
  };
}

function liveBinding() {
  if (!webMCPBinding || Date.now() >= webMCPBinding.expiresAt) {
    webMCPBinding = undefined;
    throw new Error("unbound");
  }
  return webMCPBinding;
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
    if (request.type === "tools.list") return await listWebMCPTools();
    if (request.type === "tool.execute") return await executeWebMCP(request, controller);
    throw new Error("unavailable");
  } finally {
    if (activeWebMCP?.id === request.id && !activeWebMCP.retain) activeWebMCP = undefined;
  }
}

function connectNativeHost() {
  if (nativePort) return;
  nativePort = chrome.runtime.connectNative(nativeHost);
  nativePort.onDisconnect.addListener(() => {
    nativePort = undefined;
    activeWebMCP?.controller.abort();
  });
  nativePort.onMessage.addListener((request) => {
    Promise.resolve()
      .then(() => handleNativeRequest(request))
      .then((value) =>
        nativePort?.postMessage({
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
        nativePort?.postMessage({
          protocol: nativeProtocol,
          id: request?.id || "invalid",
          type: "result",
          status,
        });
      });
  });
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
  if (webMCPBinding?.tabId === tabId) {
    activeWebMCP?.controller.abort();
    webMCPBinding = undefined;
  }
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!webMCPBinding || webMCPBinding.tabId !== tabId || !change.url) return;
  activeWebMCP?.controller.abort();
  webMCPBinding = undefined;
});
