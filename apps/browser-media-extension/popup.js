let snapshot;
let searchControl;
let observedProvider;
let selectedTab;
let pending;
let nativeConnectionStatus = "idle";
let nativeConnectionRevision = 0;
const status = document.querySelector("#status");
const connectionStatus = document.querySelector("#connection-status");
const titles = document.querySelector("#titles");
const stop = document.querySelector("#stop");
const observedSearch = document.querySelector("#observed-search");
const searchQuery = document.querySelector("#search-query");
const actionId = () => crypto.randomUUID();
async function send(command, selectedWindowId) {
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
      ...(command.type === "searchObserved" ? { windowId: selectedWindowId } : {}),
    });
    if (!response?.ok) throw new Error(response?.error || "command_failed");
    status.textContent = response.value?.outcome || "Done";
    return response.value;
  } finally {
    if (pending === own) pending = undefined;
    stop.disabled = !pending;
  }
}
async function run(command, selectedWindowId) {
  try {
    return await send(command, selectedWindowId);
  } catch (error) {
    const friendly = {
      unsupported_page: "Open a supported Netflix, YouTube, YouTube TV, or Disney+ tab first.",
      stale_snapshot: "Inspect titles again.",
      ambiguous_video: "More than one visible video.",
      busy: "Another action is still running.",
    };
    status.textContent =
      command.type === "searchObserved"
        ? "Search outcome unverified. Inspect the current page before another action."
        : friendly[error.message] || "The action could not be verified.";
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
  searchControl = result.searchControl?.id;
  observedProvider = result.site?.provider;
  observedSearch.hidden = !searchControl;
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
document.querySelector("#search-submit").onclick = async () => {
  if (!snapshot || !searchControl) return;
  const focusedAtClick = document.hasFocus();
  const [tab] = focusedAtClick
    ? await chrome.tabs.query({ active: true, currentWindow: true })
    : [];
  if (
    !focusedAtClick ||
    !document.hasFocus() ||
    !tab ||
    tab.id !== selectedTab ||
    !Number.isInteger(tab.windowId) ||
    tab.windowId < 0 ||
    tab.active !== true ||
    tab.status !== "complete"
  ) {
    snapshot = undefined;
    searchControl = undefined;
    observedSearch.hidden = true;
    titles.replaceChildren();
    status.textContent = "Page selection changed. Inspect the current page before another action.";
    return;
  }
  const command = {
    type: "searchObserved",
    snapshotId: snapshot,
    controlId: searchControl,
    query: searchQuery.value,
  };
  snapshot = undefined;
  searchControl = undefined;
  observedSearch.hidden = true;
  titles.replaceChildren();
  await run(command, tab.windowId);
};
const scrollViewport = async (direction) => {
  const observedSnapshot = snapshot;
  if (["netflix", "disneyplus"].includes(observedProvider)) {
    snapshot = undefined;
    searchControl = undefined;
    observedSearch.hidden = true;
    titles.replaceChildren();
  }
  await run({
    type: "scrollViewport",
    direction,
    ...(["netflix", "youtube_tv", "disneyplus"].includes(observedProvider) && observedSnapshot
      ? { snapshotId: observedSnapshot }
      : {}),
  });
};
document.querySelector("#up").onclick = () => scrollViewport("up");
document.querySelector("#down").onclick = () => scrollViewport("down");
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
  recordNativeConnection(value.nativeConnection);
  showNativeConnection(nativeConnectionStatus);
  status.textContent = "Page selected.";
};

function showNativeConnection(value) {
  const messages = {
    waiting: "Waiting for Mac connection…",
    connected: "Mac connected.",
    missing: "Ellie’s Mac connection could not be found. Check browser setup.",
    disconnected: "The Mac connection was lost.",
  };
  connectionStatus.textContent = messages[value] || "Mac connection unavailable.";
}

function recordNativeConnection(value) {
  if (
    !value ||
    !["waiting", "connected", "missing", "disconnected"].includes(value.status) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision <= nativeConnectionRevision
  )
    return;
  nativeConnectionStatus = value.status;
  nativeConnectionRevision = value.revision;
  showNativeConnection(nativeConnectionStatus);
}

chrome.runtime.onMessage.addListener((message) => {
  if (
    !message ||
    Object.keys(message).sort().join() !== "protocol,revision,status" ||
    message.protocol !== "ellie.browser-native-status.v1"
  )
    return;
  recordNativeConnection(message);
});
