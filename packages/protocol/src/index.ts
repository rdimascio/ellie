export const VERSION = OPERATION_REGISTRY.version;
export {
  OPERATION_REGISTRY,
  CAPABILITIES,
  LAYOUTS,
  MONITORS,
  operationDefinition,
  action,
  actions,
} from "./operations.ts";
export type {
  Action,
  Capability,
  Layout,
  Monitor,
  OperationId,
  OperationResult,
} from "./operations.ts";
import { CAPABILITIES, OPERATION_REGISTRY, actions } from "./operations.ts";
import type { Action, Capability, OperationResult } from "./operations.ts";
export interface Job {
  version: typeof VERSION;
  id: string;
  expiresAt: number;
  actions: Action[];
}
export type Result = OperationResult;
export interface Context {
  lastApp?: string;
}
export interface Plan {
  actions: Action[];
  nextContext: Context;
}
export interface NodeInfo {
  id: string;
  /** Legacy execution capabilities; retained for V1 clients. */
  capabilities: Capability[];
  executionCapabilities: Capability[];
  computeCapabilities?: import("./compute.ts").ComputeCapabilities;
  telemetry?: import("./compute.ts").Telemetry;
  telemetryReceivedAt?: number;
  lastSeen: number;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid string.");
  return value;
}
export function identifier(value: unknown): string {
  const result = string(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new Error("Invalid identifier.");
  return result;
}
export function capabilities(value: unknown): Capability[] {
  if (
    !Array.isArray(value) ||
    value.length > CAPABILITIES.length ||
    value.some((x) => !CAPABILITIES.includes(x as Capability))
  )
    throw new Error("Invalid capabilities.");
  return [...new Set(value)] as Capability[];
}
export function job(value: unknown): Job {
  const v = record(value);
  if (v.version !== VERSION || !Number.isFinite(v.expiresAt)) throw new Error("Invalid job.");
  return {
    version: VERSION,
    id: identifier(v.id),
    expiresAt: v.expiresAt as number,
    actions: actions(v.actions),
  };
}
export function result(value: unknown): Result {
  const v = record(value);
  if (typeof v.ok !== "boolean") throw new Error("Invalid result.");
  return { ok: v.ok, message: string(v.message, OPERATION_REGISTRY.limits.maxResultMessageLength) };
}

export * from "./compute.ts";
