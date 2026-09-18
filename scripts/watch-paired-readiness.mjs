import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const keys = [
  "activation",
  "enabledTarget",
  "foreground",
  "lastReplyState",
  "messagesDecoded",
  "messagesReceived",
  "paired",
  "reachable",
  "recordedAtMilliseconds",
  "replyHandlersInvoked",
  "version",
  "watchAppInstalled",
];
const targets = new Set(["", "watch-fixture-mac-a", "watch-fixture-mac-b"]);
const replyStates = new Set(["none", "observed", "unknown", "unavailable", "blocked", "stale"]);

export function parsePhoneReadiness(value) {
  const row = JSON.parse(value);
  if (
    !row ||
    typeof row !== "object" ||
    Array.isArray(row) ||
    Object.keys(row).sort().join() !== keys.slice().sort().join() ||
    row.version !== 2 ||
    !["activated", "inactive", "not_activated", "unknown"].includes(row.activation) ||
    !targets.has(row.enabledTarget) ||
    !["paired", "watchAppInstalled", "reachable", "foreground"].every(
      (key) => typeof row[key] === "boolean",
    ) ||
    !Number.isSafeInteger(row.recordedAtMilliseconds) ||
    row.recordedAtMilliseconds <= 0 ||
    !["messagesReceived", "messagesDecoded", "replyHandlersInvoked"].every(
      (key) => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 128,
    ) ||
    row.messagesDecoded > row.messagesReceived ||
    row.replyHandlersInvoked > row.messagesReceived ||
    !replyStates.has(row.lastReplyState) ||
    (row.replyHandlersInvoked === 0) !== (row.lastReplyState === "none")
  ) {
    throw new Error("Malformed paired phone readiness evidence.");
  }
  return row;
}

export function phoneReady(row, target) {
  if (!targets.has(target) || !target) throw new Error("Invalid expected Watch fixture target.");
  return (
    row.activation === "activated" &&
    row.paired &&
    row.watchAppInstalled &&
    row.foreground &&
    row.enabledTarget === target
  );
}

export function phoneReadinessSummary(row) {
  if (!row) return "missing";
  return `activation=${row.activation} paired=${row.paired} watchAppInstalled=${row.watchAppInstalled} reachable=${row.reachable} foreground=${row.foreground} enabledTarget=${row.enabledTarget || "none"}`;
}

export async function waitForPhoneReadiness(
  path,
  target,
  {
    timeoutMs = 15_000,
    now = () => performance.now(),
    read = (file) => readFile(file, "utf8"),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) {
    throw new Error("Invalid paired phone readiness deadline.");
  }
  const deadline = now() + timeoutMs;
  let latest;
  while (now() < deadline) {
    try {
      latest = parsePhoneReadiness(await read(path));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (latest && phoneReady(latest, target)) return latest;
    await wait(Math.min(100, Math.max(1, deadline - now())));
  }
  throw new Error(`Paired phone was not ready by deadline: ${phoneReadinessSummary(latest)}.`);
}
