let snapshot;
let selectedTab;
let pending;
let selectedBinding = false;
const status = document.querySelector("#status");
const titles = document.querySelector("#titles");
const stop = document.querySelector("#stop");
const actionId = () => crypto.randomUUID();
async function send(command) {
  if (pending) throw new Error("busy");
  const own = actionId();
  pending = own;
  stop.disabled = false;
  status.textContent = "Working…";
  try {
    if (!selectedTab) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      selectedTab = tab?.id;
    }
    if (!selectedTab) throw new Error("tab_unavailable");
    const response = await chrome.runtime.sendMessage({
      protocol: "ellie.media.v1",
      tabId: selectedTab,
      command: { actionId: own, ...command },
    });
    if (!response?.ok) throw new Error(response?.error || "command_failed");
    status.textContent = response.value?.outcome || "Done";
    return response.value;
  } finally {
    if (pending === own) pending = undefined;
    stop.disabled = !pending;
  }
}
async function run(command) {
  try {
    return await send(command);
  } catch (error) {
    const friendly = {
      unsupported_page: "Open Netflix or YouTube first.",
      stale_snapshot: "Inspect titles again.",
      ambiguous_video: "More than one visible video.",
      busy: "Another action is still running.",
    };
    status.textContent = friendly[error.message] || "The action could not be verified.";
  }
}
stop.onclick = async () => {
  if (!pending || !selectedTab) return;
  const targetActionId = pending;
  stop.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      protocol: "ellie.media.v1",
      tabId: selectedTab,
      command: { type: "cancel", actionId: actionId(), targetActionId },
    });
  } catch {
    status.textContent = "Cancellation could not be confirmed.";
  }
};
document.querySelector("#inspect").onclick = async () => {
  const result = await run({ type: "inspect" });
  if (!result) return;
  snapshot = result.snapshotId;
  titles.replaceChildren(
    ...result.candidates.map((candidate) => {
      const item = document.createElement("li");
      const open = document.createElement("button");
      open.textContent = candidate.title;
      open.onclick = () => run({ type: "open", snapshotId: snapshot, candidateId: candidate.id });
      const row = document.createElement("button");
      row.textContent = "Row →";
      row.ariaLabel = `Scroll row containing ${candidate.title}`;
      row.onclick = () =>
        run({
          type: "scrollRow",
          direction: "right",
          snapshotId: snapshot,
          candidateId: candidate.id,
        });
      item.append(open, row);
      return item;
    }),
  );
};
document.querySelector("#up").onclick = () => run({ type: "scrollViewport", direction: "up" });
document.querySelector("#down").onclick = () => run({ type: "scrollViewport", direction: "down" });
document.querySelector("#play").onclick = () => run({ type: "play" });
document.querySelector("#pause").onclick = () => run({ type: "pause" });
document.querySelector("#back").onclick = () => run({ type: "seek", offsetSeconds: -10 });
document.querySelector("#forward").onclick = () => run({ type: "seek", offsetSeconds: 10 });
document.querySelector("#webmcp").onclick = async () => {
  const value = await run({ type: "discoverWebMCP" });
  if (value) {
    if (!value.primary)
      status.textContent = value.legacy ? "Legacy API only" : "WebMCP unavailable";
    else if (value.status === "timeout") status.textContent = "WebMCP discovery timed out";
    else if (value.status === "error") status.textContent = "WebMCP discovery failed";
    else status.textContent = `WebMCP: ${value.tools.length} tools (read only)`;
  }
};

document.querySelector("#bind-webmcp").onclick = async () => {
  const value = await run({ type: "bindWebMCP", actionId: crypto.randomUUID() });
  if (!value) return;
  selectedBinding = true;
  showNativeConnection(value.nativeConnectionStatus);
};

function showNativeConnection(value) {
  const messages = {
    waiting: "Page selected. Waiting for Mac connection…",
    connected: "Page selected. Mac connected.",
    missing: "Page selected. Ellie’s Mac connection is not installed.",
    disconnected: "Page selected. The Mac connection was lost.",
  };
  status.textContent = messages[value] || "Page selected. Mac connection unavailable.";
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    !selectedBinding ||
    !message ||
    Object.keys(message).sort().join() !== "protocol,status" ||
    message.protocol !== "ellie.browser-native-status.v1" ||
    !["waiting", "connected", "missing", "disconnected"].includes(message.status)
  )
    return;
  showNativeConnection(message.status);
});
