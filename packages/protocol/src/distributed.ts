import { identifier, record, string } from "./index.ts";

export interface DistributedMlxPlan {
  mode: "distributed-mlx";
  id: string;
  planId: string;
  nodeIds: string[]; // Ordered: one process per Mac; first member returns the text.
  model: string;
  backend: "ring" | "jaccl";
  strategy: "pipeline" | "tensor";
  explicitlyEnabled: true;
}
export interface DistributedMlxGroup extends DistributedMlxPlan {
  timeoutMs: number;
  qualification: {
    measuredAt: number;
    expiresAt: number;
    bandwidthBytesPerSecond: number; // Slowest measured member-to-member link.
    latencyMs: number; // Worst measured member-to-member latency.
    minBandwidthBytesPerSecond: number;
    maxLatencyMs: number;
  };
}
export interface DistributedMlxCapability {
  plan: DistributedMlxPlan;
  rank: number;
  requiredFreeMemoryBytes: number;
}
export interface DistributedAssignment {
  plan: DistributedMlxPlan;
  rank: number;
  leaseId: string;
}
export function computeNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error("Invalid distributed compute number.");
  return value;
}
export function distributedMlxPlan(value: unknown): DistributedMlxPlan {
  const v = record(value);
  if (v.mode !== "distributed-mlx" || v.explicitlyEnabled !== true)
    throw new Error("Distributed MLX requires explicit opt-in for each group and model.");
  if (!Array.isArray(v.nodeIds) || v.nodeIds.length < 2 || v.nodeIds.length > 8)
    throw new Error("A distributed group requires two to eight Macs.");
  const nodeIds = v.nodeIds.map(identifier);
  if (new Set(nodeIds).size !== nodeIds.length) throw new Error("Duplicate distributed member.");
  if (v.backend !== "ring" && v.backend !== "jaccl") throw new Error("Unsupported MLX backend.");
  if (v.strategy !== "pipeline" && v.strategy !== "tensor")
    throw new Error("Unsupported MLX shard strategy.");
  if (v.strategy === "tensor" && v.backend !== "jaccl")
    throw new Error("Tensor parallelism requires the qualified JACCL backend.");
  return {
    mode: "distributed-mlx",
    id: identifier(v.id),
    planId: identifier(v.planId),
    nodeIds,
    model: string(v.model, 200),
    backend: v.backend,
    strategy: v.strategy,
    explicitlyEnabled: true,
  };
}
export function distributedMlxGroup(value: unknown): DistributedMlxGroup {
  const v = record(value);
  const q = record(v.qualification);
  const measuredAt = computeNumber(q.measuredAt, 1, Number.MAX_SAFE_INTEGER);
  const expiresAt = computeNumber(q.expiresAt, measuredAt + 1, measuredAt + 86_400_000);
  const timeoutMs = computeNumber(v.timeoutMs, 1000, 120_000);
  if (!Number.isInteger(timeoutMs)) throw new Error("Invalid distributed deadline.");
  return {
    ...distributedMlxPlan(v),
    timeoutMs,
    qualification: {
      measuredAt,
      expiresAt,
      bandwidthBytesPerSecond: computeNumber(q.bandwidthBytesPerSecond, 1, Number.MAX_SAFE_INTEGER),
      latencyMs: computeNumber(q.latencyMs, 0, 60_000),
      minBandwidthBytesPerSecond: computeNumber(
        q.minBandwidthBytesPerSecond,
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      maxLatencyMs: computeNumber(q.maxLatencyMs, 0.001, 60_000),
    },
  };
}
export function distributedMlxGroups(value: unknown): DistributedMlxGroup[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("Invalid distributed groups.");
  const groups = value.map(distributedMlxGroup);
  if (new Set(groups.map((g) => g.id)).size !== groups.length)
    throw new Error("Duplicate distributed group.");
  return groups;
}
export function distributedCapabilities(value: unknown): DistributedMlxCapability[] {
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Invalid distributed capabilities.");
  const capabilities = value.map((item) => {
    const v = record(item);
    const plan = distributedMlxPlan(v.plan);
    const rank = computeNumber(v.rank, 0, plan.nodeIds.length - 1);
    if (!Number.isInteger(rank)) throw new Error("Invalid MLX rank.");
    return {
      plan,
      rank,
      requiredFreeMemoryBytes: computeNumber(v.requiredFreeMemoryBytes, 1, Number.MAX_SAFE_INTEGER),
    };
  });
  if (new Set(capabilities.map((c) => c.plan.id)).size !== capabilities.length)
    throw new Error("Duplicate distributed capability.");
  return capabilities;
}
export function distributedAssignment(value: unknown): DistributedAssignment {
  const v = record(value);
  const [cap] = distributedCapabilities([{ ...v, requiredFreeMemoryBytes: 1 }]);
  return { plan: cap!.plan, rank: cap!.rank, leaseId: identifier(v.leaseId) };
}
export function sameMlxPlan(a: DistributedMlxPlan, b: DistributedMlxPlan): boolean {
  return JSON.stringify(distributedMlxPlan(a)) === JSON.stringify(distributedMlxPlan(b));
}
