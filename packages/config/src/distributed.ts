import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { computeNumber, distributedMlxPlan, record, string } from "@ellie/protocol";
import type { DistributedMlxPlan } from "@ellie/protocol";

export interface LocalMlxGroup {
  plan: DistributedMlxPlan;
  modelPath: string;
  communicationFile: string;
  coordinator?: string;
  requiredFreeMemoryBytes: number;
}
export interface DistributedWorkerConfig {
  python: string;
  groups: LocalMlxGroup[];
}
function absolute(value: unknown): string {
  const path = string(value);
  if (!isAbsolute(path) || path.includes("\0"))
    throw new Error("MLX paths must be absolute local paths.");
  return path;
}
export function distributedWorkerConfig(value: unknown, nodeId: string): DistributedWorkerConfig {
  const v = record(value);
  if (!Array.isArray(v.groups) || !v.groups.length || v.groups.length > 8)
    throw new Error("Configure one to eight local MLX groups.");
  const groups = v.groups.map((item) => {
    const g = record(item);
    const plan = distributedMlxPlan(g.plan);
    if (!plan.nodeIds.includes(nodeId)) throw new Error("This Mac is not in the shard plan.");
    let coordinator: string | undefined;
    if (plan.backend === "jaccl") {
      coordinator = string(g.coordinator, 100);
      const parts = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(coordinator);
      if (!parts || !isIP(parts[1]!) || Number(parts[2]) < 1024 || Number(parts[2]) > 65535)
        throw new Error("JACCL coordinator must be a literal IPv4 address and unprivileged port.");
    }
    return {
      plan,
      modelPath: absolute(g.modelPath),
      communicationFile: absolute(g.communicationFile),
      ...(coordinator ? { coordinator } : {}),
      requiredFreeMemoryBytes: computeNumber(g.requiredFreeMemoryBytes, 1, Number.MAX_SAFE_INTEGER),
    };
  });
  if (new Set(groups.map((g) => g.plan.id)).size !== groups.length)
    throw new Error("Duplicate local MLX group.");
  return { python: absolute(v.python), groups };
}
