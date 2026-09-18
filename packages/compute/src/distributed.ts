import { sameMlxPlan } from "@ellie/protocol";
import type { DistributedMlxGroup, DistributedMlxPlan, NodeInfo } from "@ellie/protocol";
import { TELEMETRY_MAX_AGE_MS } from "./index.ts";

export function distributedMemberEligible(
  node: NodeInfo,
  plan: DistributedMlxPlan,
  now = Date.now(),
  running = false,
): boolean {
  const capability = node.distributedCapabilities?.find((c) => sameMlxPlan(c.plan, plan));
  const t = node.telemetry;
  return Boolean(
    capability &&
    plan.nodeIds[capability.rank] === node.id &&
    t &&
    node.telemetryReceivedAt !== undefined &&
    now >= node.telemetryReceivedAt &&
    now - node.telemetryReceivedAt <= TELEMETRY_MAX_AGE_MS &&
    now - node.lastSeen <= TELEMETRY_MAX_AGE_MS &&
    (running ||
      (t.activeJobs === 0 &&
        t.freeMemoryBytes >= capability.requiredFreeMemoryBytes &&
        t.load < 1.5)) &&
    t.power.source === "ac" &&
    t.power.lowPowerMode === false &&
    (t.thermal === "nominal" || t.thermal === "fair") &&
    t.network.quality === "good" &&
    t.network.roundTripMs !== null &&
    t.network.roundTripMs <= 500,
  );
}
/** Qualification comes from explicit interconnect measurements, never heartbeat RTT. */
export function distributedGroupProblem(
  group: DistributedMlxGroup,
  nodes: NodeInfo[],
  busy: ReadonlySet<string>,
  now = Date.now(),
): string | undefined {
  const q = group.qualification;
  if (
    q.measuredAt > now ||
    q.expiresAt < now + group.timeoutMs ||
    q.bandwidthBytesPerSecond < q.minBandwidthBytesPerSecond ||
    q.latencyMs > q.maxLatencyMs
  )
    return "The group's interconnect qualification is missing, expired, or below its measured thresholds.";
  for (const id of group.nodeIds) {
    if (busy.has(id)) return `Distributed member ${id} is busy or awaiting teardown.`;
    const node = nodes.find((n) => n.id === id);
    if (!node || !distributedMemberEligible(node, group, now))
      return `Distributed member ${id} is unavailable, has a different plan, or failed local resource policy.`;
  }
  return undefined;
}
