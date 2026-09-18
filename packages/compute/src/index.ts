import type { NodeInfo } from "@ellie/protocol";
export { distributedMemberEligible, distributedGroupProblem } from "./distributed.ts";

export const TELEMETRY_MAX_AGE_MS = 35_000;
/** Pure admission policy shared with workers. Missing power/thermal metrics are explicit unknowns. */
export function computeEligible(info: NodeInfo, model: string, now = Date.now()): boolean {
  const compute = info.computeCapabilities;
  const t = info.telemetry;
  const installed = compute?.models.find((item) => item.id === model);
  return Boolean(
    compute?.mode === "independent" &&
    installed &&
    t &&
    info.telemetryReceivedAt !== undefined &&
    now - info.telemetryReceivedAt <= TELEMETRY_MAX_AGE_MS &&
    now - info.lastSeen <= TELEMETRY_MAX_AGE_MS &&
    t.activeJobs === 0 &&
    t.load < 1.5 &&
    t.freeMemoryBytes >= installed.requiredFreeMemoryBytes &&
    t.thermal !== "serious" &&
    t.thermal !== "critical" &&
    t.power.lowPowerMode !== true &&
    (t.power.source !== "battery" ||
      (t.power.batteryPercent !== null && t.power.batteryPercent >= 30)) &&
    t.network.quality !== "poor" &&
    (t.network.roundTripMs === null || t.network.roundTripMs <= 500),
  );
}
export function selectWorker(
  nodes: NodeInfo[],
  model: string,
  busy: ReadonlySet<string>,
  now = Date.now(),
): NodeInfo | undefined {
  const score = (n: NodeInfo): number => {
    const t = n.telemetry!;
    return (
      (t.power.source === "ac" ? 100 : 0) +
      (t.thermal === "nominal" ? 20 : 0) -
      t.load * 30 +
      Math.min(t.freeMemoryBytes / 1024 ** 3, 64) -
      (t.network.roundTripMs ?? 250) / 25
    );
  };
  return nodes
    .filter((n) => !busy.has(n.id) && computeEligible(n, model, now))
    .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))[0];
}
