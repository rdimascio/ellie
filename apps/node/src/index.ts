import { setTimeout as delay } from "node:timers/promises";
import { job, record, inferenceJob, result } from "@ellie/protocol";
import type { Result, ComputeCapabilities, Telemetry } from "@ellie/protocol";
import type { Preferences } from "@ellie/config";
import type { Executor } from "@ellie/macos";
import { authorize } from "@ellie/permissions";
import { computeEligible } from "@ellie/compute";
import type { Client } from "@ellie/transport";
import type { InferenceWorker } from "./inference.ts";
import { collectTelemetry } from "./telemetry.ts";

export async function runNode(options: {
  client: Client;
  executor?: Executor;
  worker?: InferenceWorker;
  preferences: Preferences;
  signal: AbortSignal;
  health?: () => Promise<unknown>;
  collect?: (activeJobs: number, roundTripMs: number | null) => Promise<Telemetry>;
  heartbeatMs?: number;
  onStatus?: (message: string) => void;
}): Promise<void> {
  const { client, executor, worker, signal } = options;
  const seen = new Set<string>();
  let activeJobs = 0;
  let roundTripMs: number | null = null;
  let backoff = 250;
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
    const connected = new AbortController();
    const connectionSignal = AbortSignal.any([signal, connected.signal]);
    let heartbeat: Promise<void> | undefined;
    try {
      const granted = (await executor?.capabilities()) ?? [];
      await client.call("POST", "/v1/register", {
        capabilities: granted,
        executionCapabilities: granted,
        computeCapabilities: await advertise(),
        telemetry: worker ? await metrics() : undefined,
      });
      const beat = async () => {
        const computeCapabilities = await advertise();
        const telemetry = worker ? await metrics() : undefined;
        const start = performance.now();
        await client.call("POST", "/v1/heartbeat", { computeCapabilities, telemetry });
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
      options.onStatus?.("Node connected. Ready for commands and enabled compute work.");
      while (!connectionSignal.aborted) {
        const reply = record(await client.call("GET", "/v1/poll"));
        if (!reply.job) continue;
        const wire = record(reply.job);
        const task = wire.kind === "inference" ? inferenceJob(wire) : job(wire);
        let outcome: Result;
        try {
          if (connectionSignal.aborted || task.expiresAt <= Date.now())
            throw new Error("Job expired or connection was lost before execution.");
          if (seen.has(task.id)) throw new Error("Duplicate job blocked.");
          seen.add(task.id);
          if (seen.size > 1024) seen.delete(seen.values().next().value!);
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
              AbortSignal.timeout(Math.min(remaining, 30_000)),
            ]);
            outcome = result(await worker.execute(task.request, deadline));
          } else {
            if (!executor) throw new Error("Desktop execution is disabled on this node.");
            authorize(task.actions, granted, options.preferences);
            activeJobs = 1;
            outcome = { ok: true, message: "Done." };
            for (const action of task.actions) {
              if (connectionSignal.aborted || Date.now() >= task.expiresAt)
                throw new Error("Command cancelled or expired.");
              outcome = await executor.execute(action);
              if (!outcome.ok) break;
            }
          }
        } catch (error) {
          outcome = {
            ok: false,
            message:
              "kind" in task
                ? "Inference failed or was cancelled. Check the local runner and worker status."
                : error instanceof Error
                  ? error.message
                  : "Native action failed.",
          };
        } finally {
          activeJobs = 0;
        }
        await client.call("POST", "/v1/result", { id: task.id, result: outcome });
        await beat();
        backoff = 250;
      }
    } catch {
      if (!signal.aborted)
        options.onStatus?.(
          "Connection interrupted. Reconnecting; delivered jobs will not be replayed.",
        );
    } finally {
      connected.abort();
      await heartbeat;
    }
    if (!signal.aborted) {
      await delay(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 5000);
    }
  }
}
