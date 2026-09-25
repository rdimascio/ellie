import { setTimeout as delay } from "node:timers/promises";
import { job, record, inferenceJob, result, string, OPERATION_REGISTRY } from "@ellie/protocol";
import type { Result, ComputeCapabilities, Telemetry } from "@ellie/protocol";
import type { Preferences } from "@ellie/config";
import type { Executor } from "@ellie/macos";
import { authorize } from "@ellie/permissions";
import { computeEligible, distributedMemberEligible } from "@ellie/compute";
import type { Client } from "@ellie/transport";
import type { InferenceWorker } from "./inference.ts";
import { collectTelemetry } from "./telemetry.ts";
import type { DistributedWorker } from "./distributed.ts";

export function reconnectDelay(
  attempt: number,
  random: () => number = Math.random,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = options.baseMs ?? 250;
  const maximum = options.maxMs ?? 10_000;
  const exponential = Math.min(maximum, base * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.min(maximum, Math.max(base, Math.round(exponential * (0.75 + random() * 0.5))));
}

export function reconnectAttemptAfterDisconnect(
  attempt: number,
  connectedAt: number,
  lastSuccessfulTrafficAt: number,
  stableConnectionMs: number,
): number {
  return connectedAt > 0 && lastSuccessfulTrafficAt - connectedAt >= stableConnectionMs
    ? 0
    : attempt;
}

function desktopFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Native action failed.";
  try {
    return string(error.message, OPERATION_REGISTRY.limits.maxResultMessageLength);
  } catch {
    return "Native action failed.";
  }
}

export async function runNode(options: {
  client: Client;
  executor?: Executor;
  worker?: InferenceWorker;
  distributedWorker?: DistributedWorker;
  preferences: Preferences;
  signal: AbortSignal;
  health?: () => Promise<unknown>;
  collect?: (activeJobs: number, roundTripMs: number | null) => Promise<Telemetry>;
  heartbeatMs?: number;
  stableConnectionMs?: number;
  reconnect?: { baseMs?: number; maxMs?: number; random?: () => number };
  onStatus?: (message: string) => void;
  onEvent?: (event: "connected" | "reconnecting") => void;
}): Promise<void> {
  const { client, executor, worker, distributedWorker, signal } = options;
  const stoppedResults = new Map<string, Result>();
  const flushStoppedResults = async () => {
    for (const [id, outcome] of stoppedResults) {
      // Execution is complete. Retain its outcome until one bounded acknowledgement succeeds,
      // including during shutdown, so reconnect never needs to execute the job again.
      try {
        await client.call("POST", "/v1/result", { id, result: outcome }, { timeoutMs: 5000 });
      } catch (error) {
        let stored: Record<string, unknown> | undefined;
        try {
          stored = record(
            await client.call("GET", `/v1/jobs/${encodeURIComponent(id)}`, undefined, {
              timeoutMs: 5000,
            }),
          );
        } catch {}
        if (
          stored?.id !== id ||
          !["completed", "failed", "cancelled", "expired", "unknown"].includes(
            String(stored?.state),
          )
        )
          throw error;
      }
      stoppedResults.delete(id);
    }
  };
  const advertiseDistributed = async () => {
    if (!distributedWorker) return undefined;
    try {
      return await distributedWorker.advertise(signal);
    } catch {
      return [];
    }
  };
  const seen = new Set<string>();
  let activeJobs = 0;
  let roundTripMs: number | null = null;
  let reconnectAttempt = 0;
  let connectionState: "connected" | "reconnecting" | undefined;
  let currentJob: { id: string; abort: AbortController } | undefined;
  const metrics = () =>
    (options.collect ?? ((active, rtt) => collectTelemetry(active, rtt, options.health)))(
      activeJobs,
      roundTripMs,
    );
  const advertise = async (): Promise<ComputeCapabilities | undefined> => {
    try {
      return await worker?.advertise(signal);
    } catch {
      return undefined;
    } // Unavailable runner withdraws compute only.
  };
  while (!signal.aborted) {
    let connectedAt = 0;
    let lastSuccessfulTrafficAt = 0;
    const connected = new AbortController();
    const connectionSignal = AbortSignal.any([signal, connected.signal]);
    let heartbeat: Promise<void> | undefined;
    try {
      const granted = (await executor?.capabilities()) ?? [];
      await client.call(
        "POST",
        "/v1/register",
        {
          capabilities: granted,
          executionCapabilities: granted,
          computeCapabilities: await advertise(),
          distributedCapabilities: await advertiseDistributed(),
          telemetry: worker || distributedWorker ? await metrics() : undefined,
        },
        { signal: connectionSignal },
      );
      await flushStoppedResults();
      const beat = async () => {
        const computeCapabilities = await advertise();
        const distributedCapabilities = await advertiseDistributed();
        const telemetry = worker || distributedWorker ? await metrics() : undefined;
        const start = performance.now();
        const reply = record(
          await client.call(
            "POST",
            "/v1/heartbeat",
            { computeCapabilities, distributedCapabilities, telemetry },
            { signal: connectionSignal },
          ),
        );
        if (connectedAt) lastSuccessfulTrafficAt = Date.now();
        const cancellations = Array.isArray(reply.cancelJobIds)
          ? reply.cancelJobIds.map((id) => String(id))
          : [];
        if (currentJob && cancellations.includes(currentJob.id)) currentJob.abort.abort();
        roundTripMs = performance.now() - start;
      };
      await beat();
      heartbeat = (async () => {
        try {
          while (!connectionSignal.aborted) {
            await delay(options.heartbeatMs ?? 10_000, undefined, { signal: connectionSignal });
            await beat();
          }
        } catch {
          connected.abort();
        }
      })();
      connectedAt = Date.now();
      lastSuccessfulTrafficAt = connectedAt;
      if (connectionState !== "connected") {
        options.onStatus?.("Node connected. Ready for commands and enabled compute work.");
        options.onEvent?.("connected");
        connectionState = "connected";
      }
      while (!connectionSignal.aborted) {
        const reply = record(
          await client.call("GET", "/v1/poll", undefined, { signal: connectionSignal }),
        );
        lastSuccessfulTrafficAt = Date.now();
        if (!reply.job) continue;
        const wire = record(reply.job);
        const task = wire.kind === "inference" ? inferenceJob(wire) : job(wire);
        let outcome: Result;
        const jobAbort = new AbortController();
        currentJob = { id: task.id, abort: jobAbort };
        try {
          if (connectionSignal.aborted || task.expiresAt <= Date.now())
            throw new Error("Job expired or connection was lost before execution.");
          if (seen.has(task.id)) throw new Error("Duplicate job blocked.");
          seen.add(task.id);
          if (seen.size > 1024) seen.delete(seen.values().next().value!);
          if ("kind" in task && task.assignment) {
            if (!distributedWorker) throw new Error("Distributed compute is disabled locally.");
            const a = task.assignment;
            const local = {
              id: a.plan.nodeIds[a.rank]!,
              capabilities: granted,
              executionCapabilities: granted,
              distributedCapabilities: await advertiseDistributed(),
              telemetry: await metrics(),
              telemetryReceivedAt: Date.now(),
              lastSeen: Date.now(),
            };
            if (!distributedMemberEligible(local, a.plan))
              throw new Error("Local shard policy rejected the job.");
            activeJobs = 1;
            const deadline = AbortSignal.any([
              connectionSignal,
              jobAbort.signal,
              AbortSignal.timeout(Math.max(1, Math.min(120_000, task.expiresAt - Date.now()))),
            ]);
            await distributedWorker.prepare(task, deadline);
            while (true) {
              const start = record(
                await client.call("POST", "/v1/start", { id: task.id }, { signal: deadline }),
              );
              if (start.cancel === true) throw new Error("Distributed job cancelled before start.");
              if (start.ready === true) break;
              await delay(100, undefined, { signal: deadline });
            }
            local.telemetry = await metrics();
            local.telemetryReceivedAt = local.lastSeen = Date.now();
            if (!distributedMemberEligible(local, a.plan, Date.now(), true))
              throw new Error("Local shard policy changed at the start barrier.");
            outcome = result(await distributedWorker.execute(task, deadline));
          } else {
            const start = record(
              await client.call("POST", "/v1/start", { id: task.id }, { signal: connectionSignal }),
            );
            if (start.cancel === true) jobAbort.abort();
            if (jobAbort.signal.aborted) throw new Error("Command cancelled before execution.");
            if ("kind" in task) {
              if (!worker) throw new Error("Inference is not enabled on this node.");
              const compute = await advertise();
              const telemetry = await metrics();
              if (
                !computeEligible(
                  {
                    id: "self",
                    capabilities: granted,
                    executionCapabilities: granted,
                    computeCapabilities: compute,
                    telemetry,
                    telemetryReceivedAt: Date.now(),
                    lastSeen: Date.now(),
                  },
                  task.request.model,
                )
              )
                throw new Error("Local compute policy rejected this job.");
              activeJobs = 1;
              const remaining = task.expiresAt - Date.now();
              if (remaining <= 0) throw new Error("Inference expired before execution.");
              const deadline = AbortSignal.any([
                connectionSignal,
                jobAbort.signal,
                AbortSignal.timeout(Math.min(remaining, 30_000)),
              ]);
              outcome = result(await worker.execute(task.request, deadline));
            } else {
              if (!executor) throw new Error("Desktop execution is disabled on this node.");
              authorize(task.actions, granted, options.preferences);
              activeJobs = 1;
              outcome = { ok: true, message: "Done." };
              const executionSignal = AbortSignal.any([
                connectionSignal,
                jobAbort.signal,
                AbortSignal.timeout(Math.max(1, Math.ceil(task.expiresAt - Date.now()))),
              ]);
              for (const action of task.actions) {
                if (executionSignal.aborted || Date.now() >= task.expiresAt)
                  throw new Error("Command cancelled or expired.");
                outcome = await executor.execute(action, executionSignal);
                if (!outcome.ok) break;
              }
            }
          }
        } catch (error) {
          outcome = {
            ok: false,
            message:
              "kind" in task
                ? "Inference failed or was cancelled. Check the local runner and worker status."
                : desktopFailureMessage(error),
          };
        } finally {
          activeJobs = 0;
          if (currentJob?.id === task.id) currentJob = undefined;
        }
        stoppedResults.set(task.id, outcome);
        await flushStoppedResults();
        await beat();
        reconnectAttempt = 0;
      }
    } catch {
      if (!signal.aborted && connectionState !== "reconnecting") {
        options.onStatus?.(
          "Connection interrupted. Reconnecting; delivered jobs will not be replayed.",
        );
        options.onEvent?.("reconnecting");
        connectionState = "reconnecting";
      }
    } finally {
      connected.abort();
      await heartbeat;
    }
    if (!signal.aborted) {
      reconnectAttempt = reconnectAttemptAfterDisconnect(
        reconnectAttempt,
        connectedAt,
        lastSuccessfulTrafficAt,
        options.stableConnectionMs ?? 30_000,
      );
      const wait = reconnectDelay(reconnectAttempt, options.reconnect?.random, options.reconnect);
      reconnectAttempt++;
      await delay(wait, undefined, { signal }).catch(() => {});
    }
  }
}
