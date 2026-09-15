const productionOrigins = new Set(["https://www.netflix.com", "https://www.youtube.com"]);
const mutationLedgers = new Map();
const mutationTypes = new Set(["scrollViewport", "scrollRow", "open", "play", "pause", "seek"]);
const actionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  if (message.command?.type === "discoverWebMCP") {
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
    message.command?.type === "discoverWebMCP"
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

chrome.tabs.onRemoved.addListener((tabId) => mutationLedgers.delete(tabId));
