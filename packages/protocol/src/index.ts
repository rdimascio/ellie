export const VERSION = OPERATION_REGISTRY.version;
export {
  OPERATION_REGISTRY,
  CAPABILITIES,
  BROWSER_CAPABILITIES,
  DESKTOP_CAPABILITIES,
  LAYOUTS,
  MONITORS,
  operationDefinition,
  action,
  actions,
  browserWebMCPAction,
  browserWebMCPOperationResult,
} from "./operations.ts";
export type {
  Action,
  Capability,
  Layout,
  Monitor,
  OperationId,
  OperationResult,
  BrowserWebMCPAction,
  BrowserAction,
  BrowserCapability,
  BrowserExecutionSource,
  BrowserWebMCPCapability,
  BrowserWebMCPOperationResult,
  BrowserWebMCPStructuredResult,
  BrowserView,
} from "./operations.ts";
import {
  CAPABILITIES,
  DESKTOP_CAPABILITIES,
  OPERATION_REGISTRY,
  actions,
  browserWebMCPOperationResult,
} from "./operations.ts";
import type {
  Action,
  BrowserWebMCPOperationResult,
  Capability,
  OperationResult,
} from "./operations.ts";
export interface Job {
  version: typeof VERSION;
  id: string;
  expiresAt: number;
  actions: Action[];
}
export type Result = OperationResult | BrowserWebMCPOperationResult;
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
export const JOB_STATES = [
  "queued",
  "delivered",
  "running",
  "cancellation_requested",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "unknown",
] as const;
export const JOB_OUTCOME_CODES = [
  "succeeded",
  "operation_failed",
  "timed_out",
  "cancelled_by_caller",
  "expired_before_delivery",
  "abandoned_after_restart",
  "unknown_after_restart",
  "node_revoked",
  "coordinator_stopped",
] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobOutcomeCode = (typeof JOB_OUTCOME_CODES)[number];
export interface JobMetadata {
  id: string;
  kind: "desktop" | "inference";
  target: string;
  state: JobState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  outcomeOk?: boolean;
  outcomeCode?: JobOutcomeCode;
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
  if (Object.hasOwn(v, "browser")) return browserWebMCPOperationResult(v);
  if (typeof v.ok !== "boolean") throw new Error("Invalid result.");
  return { ok: v.ok, message: string(v.message, OPERATION_REGISTRY.limits.maxResultMessageLength) };
}
export function jobMetadata(value: unknown): JobMetadata {
  const v = record(value);
  if (
    (v.kind !== "desktop" && v.kind !== "inference") ||
    !JOB_STATES.includes(v.state as JobState) ||
    !Number.isFinite(v.createdAt) ||
    !Number.isFinite(v.updatedAt) ||
    !Number.isFinite(v.expiresAt) ||
    (v.outcomeOk !== undefined && typeof v.outcomeOk !== "boolean") ||
    (v.outcomeCode !== undefined && !JOB_OUTCOME_CODES.includes(v.outcomeCode as JobOutcomeCode))
  )
    throw new Error("Invalid job metadata.");
  return {
    id: identifier(v.id),
    kind: v.kind,
    target: identifier(v.target),
    state: v.state as JobState,
    createdAt: v.createdAt as number,
    updatedAt: v.updatedAt as number,
    expiresAt: v.expiresAt as number,
    ...(v.outcomeOk === undefined ? {} : { outcomeOk: v.outcomeOk }),
    ...(v.outcomeCode === undefined ? {} : { outcomeCode: v.outcomeCode as JobOutcomeCode }),
  };
}

export * from "./compute.ts";
export * from "./browser-pairing-qr.ts";
export * from "./browser-webmcp.ts";
export * from "./native-pairing-qr.ts";

export * from "./native-session-contract.ts";
export * from "./native-controls.ts";
export * from "./household-state.ts";
