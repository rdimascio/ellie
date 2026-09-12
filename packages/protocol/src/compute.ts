import { record, string, identifier, VERSION } from "./index.ts";

export interface InstalledModel {
  id: string;
  requiredFreeMemoryBytes: number;
}
export interface ComputeCapabilities {
  kind: "inference-worker";
  backend: "local-openai";
  mode: "independent";
  models: InstalledModel[];
}
export interface Telemetry {
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  activeJobs: number;
  load: number; // One-minute OS load divided by logical CPU count; may exceed 1.
  power: {
    source: "ac" | "battery" | "unknown";
    batteryPercent: number | null;
    lowPowerMode: boolean | null;
  };
  thermal: "nominal" | "fair" | "serious" | "critical" | "unknown";
  network: { roundTripMs: number | null; quality: "good" | "poor" | "unknown" };
}
export interface InferenceRequest {
  model: string;
  prompt: string;
  maxTokens: number;
  mode: "independent";
}
export interface InferenceJob {
  version: typeof VERSION;
  kind: "inference";
  id: string;
  expiresAt: number;
  request: InferenceRequest;
}
/** Advanced extension contract only; V1 does not launch or schedule shard groups. */
export interface DistributedMlxGroup {
  mode: "distributed-mlx";
  id: string;
  nodeIds: string[];
  model: string;
  explicitlyEnabled: true;
}

function number(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error("Invalid compute metric.");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error("Invalid compute state.");
  return value as T;
}
export function installedModels(value: unknown): InstalledModel[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid installed models.");
  const models = value.map((item) => {
    const v = record(item);
    return {
      id: string(v.id, 200),
      requiredFreeMemoryBytes: number(v.requiredFreeMemoryBytes, 1, Number.MAX_SAFE_INTEGER),
    };
  });
  if (new Set(models.map((m) => m.id)).size !== models.length)
    throw new Error("Duplicate installed model.");
  return models;
}
export function computeCapabilities(value: unknown): ComputeCapabilities {
  const v = record(value);
  if (v.kind !== "inference-worker" || v.backend !== "local-openai" || v.mode !== "independent")
    throw new Error("Unsupported compute capability.");
  return { kind: v.kind, backend: v.backend, mode: v.mode, models: installedModels(v.models) };
}
export function telemetry(value: unknown): Telemetry {
  const v = record(value);
  const p = record(v.power);
  const n = record(v.network);
  const totalMemoryBytes = number(v.totalMemoryBytes, 1, Number.MAX_SAFE_INTEGER);
  if (p.lowPowerMode !== null && typeof p.lowPowerMode !== "boolean")
    throw new Error("Invalid low-power state.");
  const activeJobs = number(v.activeJobs, 0, 1024);
  if (!Number.isInteger(activeJobs)) throw new Error("Invalid job count.");
  return {
    freeMemoryBytes: number(v.freeMemoryBytes, 0, totalMemoryBytes),
    totalMemoryBytes,
    activeJobs,
    load: number(v.load, 0, 10000),
    power: {
      source: oneOf(p.source, ["ac", "battery", "unknown"]),
      batteryPercent: p.batteryPercent === null ? null : number(p.batteryPercent, 0, 100),
      lowPowerMode: p.lowPowerMode,
    },
    thermal: oneOf(v.thermal, ["nominal", "fair", "serious", "critical", "unknown"]),
    network: {
      roundTripMs: n.roundTripMs === null ? null : number(n.roundTripMs, 0, 3_600_000),
      quality: oneOf(n.quality, ["good", "poor", "unknown"]),
    },
  };
}
export function inferenceRequest(value: unknown): InferenceRequest {
  const v = record(value);
  if (v.mode !== undefined && v.mode !== "independent")
    throw new Error("Distributed MLX is an advanced extension; no shard-group runner is enabled.");
  const maxTokens = v.maxTokens === undefined ? 256 : number(v.maxTokens, 1, 2048);
  if (!Number.isInteger(maxTokens)) throw new Error("Invalid token limit.");
  return {
    mode: "independent",
    model: string(v.model, 200),
    prompt: string(v.prompt, 4000),
    maxTokens,
  };
}
export function inferenceJob(value: unknown): InferenceJob {
  const v = record(value);
  if (v.version !== VERSION || v.kind !== "inference") throw new Error("Invalid inference job.");
  return {
    version: VERSION,
    kind: "inference",
    id: identifier(v.id),
    expiresAt: number(v.expiresAt, 0, Number.MAX_SAFE_INTEGER),
    request: inferenceRequest(v.request),
  };
}
