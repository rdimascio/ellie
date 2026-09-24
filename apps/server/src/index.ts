import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { Preferences } from "@ellie/config";
import {
  VERSION,
  record,
  string,
  identifier,
  capabilities,
  actions,
  result,
  computeCapabilities,
  telemetry,
  inferenceRequest,
  distributedCapabilities,
} from "@ellie/protocol";
import type { Context, Job, InferenceJob, Result, NodeInfo } from "@ellie/protocol";
import type { DistributedMlxGroup } from "@ellie/protocol";
import { DistributedScheduler } from "./distributed.ts";
import { route } from "@ellie/router";
import { decideDesktop } from "@ellie/router/decision";
import type { DecisionProvider } from "@ellie/decisions";
import { authorize } from "@ellie/permissions";
import { readJson } from "@ellie/transport";
import { selectWorker } from "@ellie/compute";
import type { Auth, Identity } from "./auth.ts";
import { handleBrowserManagement } from "./browser-management.ts";
import { handleBrowserStepDecision } from "./browser-step.ts";
import { handleNativeManagement } from "./native-management.ts";
import { handleHouseholdManagement } from "./household-management.ts";
import { handleSpeechManagement } from "./speech-management.ts";
import { handleLifeManagement } from "./life-management.ts";
import type { BrowserControl } from "./browser-management.ts";
import type { JobMetadata, JobOutcomeCode, JobState, JobStore } from "./jobs.ts";

const cancellationMessage =
  "Cancelled. A native side effect that already started may still finish; cancellation does not undo it.";

interface Pending {
  job: Job | InferenceJob;
  delivered: boolean;
  running: boolean;
  cancelRequested: boolean;
  response?: ServerResponse;
  finish: (
    outcome: Result,
    terminal?: {
      state: Extract<JobState, "completed" | "failed" | "cancelled" | "expired" | "unknown">;
      code: JobOutcomeCode;
    },
  ) => boolean;
  cancel: () => JobMetadata;
}
interface Session {
  info: NodeInfo;
  context: Context;
  poll?: { response: ServerResponse; timer: NodeJS.Timeout };
  pending?: Pending;
  routing?: AbortController;
}

export interface DecisionRoutingOptions {
  provider: DecisionProvider;
  mode: "shadow" | "execute";
  timeoutMs?: number;
  minProbability?: number;
  minMargin?: number;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  if (!res.destroyed && !res.writableEnded)
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(body));
}
function canAccess(identity: Identity, stored: JobMetadata): boolean {
  return identity.role === "controller" || stored.target === identity.id;
}

export function createEllieServer(options: {
  key: string;
  cert: string;
  auth: Auth;
  preferences: Preferences;
  jobStore: JobStore;
  browser?: BrowserControl;
  commandTimeout?: number;
  decisionRouting?: DecisionRoutingOptions;
  distributedGroups?: DistributedMlxGroup[];
}) {
  const sessions = new Map<string, Session>();
  const auth = options.auth;
  const distributed = new DistributedScheduler({
    groups: options.distributedGroups ?? [],
    store: options.jobStore,
    nodes: () => [...sessions.values()].map((s) => s.info),
    invalidate: (id) => {
      const info = sessions.get(id)?.info;
      if (info) delete info.telemetryReceivedAt;
    },
  });
  const busyNodes = () =>
    new Set([
      ...distributed.busy(),
      ...[...sessions.values()].filter((s) => s.pending || s.routing).map((s) => s.info.id),
    ]);

  const deliver = (session: Session): void => {
    if (session.poll && distributed.member(session.info.id)) {
      const task = distributed.deliver(session.info.id);
      if (task) {
        clearTimeout(session.poll.timer);
        send(session.poll.response, 200, { job: task });
        delete session.poll;
      }
      return;
    }
    if (!session.poll || !session.pending || session.pending.delivered) return;
    const pending = session.pending;
    if (pending.cancelRequested) {
      clearTimeout(session.poll.timer);
      send(session.poll.response, 503, { error: "Cancellation state could not be committed." });
      delete session.poll;
      return;
    }
    if (pending.job.expiresAt <= Date.now()) {
      pending.finish(
        { ok: false, message: "Job expired before delivery." },
        { state: "expired", code: "expired_before_delivery" },
      );
      return;
    }
    // Delivery is committed before a payload is written to the network.
    try {
      options.jobStore.markDelivered(pending.job.id);
    } catch {
      clearTimeout(session.poll.timer);
      send(session.poll.response, 503, { error: "Job delivery could not be committed." });
      delete session.poll;
      pending.finish(
        { ok: false, message: "Coordinator storage failed; no action was sent." },
        { state: "failed", code: "operation_failed" },
      );
      return;
    }
    pending.delivered = true;
    clearTimeout(session.poll.timer);
    send(session.poll.response, 200, { job: pending.job });
    delete session.poll;
  };

  const makePending = (
    session: Session,
    wireJob: Job | InferenceJob,
    kind: "desktop" | "inference",
    response: ServerResponse,
    onFinished?: (state: JobState) => void,
  ): Pending => {
    const now = Date.now();
    options.jobStore.create({
      id: wireJob.id,
      kind,
      target: session.info.id,
      createdAt: now,
      expiresAt: wireJob.expiresAt,
    });
    let timer: NodeJS.Timeout;
    const pending: Pending = {
      job: wireJob,
      delivered: false,
      running: false,
      cancelRequested: false,
      response,
      finish: (outcome, terminal) => {
        if (session.pending !== pending) return false;
        const resolved =
          terminal ??
          (pending.cancelRequested
            ? { state: "cancelled" as const, code: "cancelled_by_caller" as const }
            : outcome.ok
              ? { state: "completed" as const, code: "succeeded" as const }
              : { state: "failed" as const, code: "operation_failed" as const });
        try {
          options.jobStore.finish(
            wireJob.id,
            resolved.state,
            resolved.code,
            outcome.ok && !pending.cancelRequested,
          );
        } catch {
          clearTimeout(timer);
          if (pending.response)
            send(pending.response, 503, { error: "Job outcome could not be committed." });
          pending.response = undefined;
          return false;
        }
        clearTimeout(timer);
        delete session.pending;
        onFinished?.(resolved.state);
        if (pending.response)
          send(
            pending.response,
            200,
            pending.cancelRequested
              ? { ok: false, message: cancellationMessage }
              : kind === "inference"
                ? { ...outcome, workerId: session.info.id }
                : outcome,
          );
        pending.response = undefined;
        return true;
      },
      cancel: () => {
        pending.cancelRequested = true;
        let stored: JobMetadata | undefined;
        try {
          stored = options.jobStore.requestCancellation(wireJob.id);
        } catch (error) {
          if (pending.response)
            send(pending.response, 503, { error: "Cancellation state could not be committed." });
          pending.response = undefined;
          throw error;
        }
        if (!stored) throw new Error("Job no longer exists.");
        if (!pending.delivered) {
          clearTimeout(timer);
          delete session.pending;
        }
        if (pending.response)
          send(pending.response, 200, { ok: false, message: cancellationMessage });
        pending.response = undefined;
        return stored;
      },
    };
    timer = setTimeout(
      () => {
        const terminal = pending.cancelRequested
          ? { state: "cancelled" as const, code: "cancelled_by_caller" as const }
          : !pending.delivered
            ? { state: "expired" as const, code: "expired_before_delivery" as const }
            : kind === "desktop"
              ? { state: "unknown" as const, code: "timed_out" as const }
              : { state: "failed" as const, code: "timed_out" as const };
        pending.finish(
          {
            ok: false,
            message:
              kind === "inference"
                ? "Inference timed out. It was not retried on another Mac."
                : "Command timed out; completion is unknown. Check the Mac before repeating it.",
          },
          terminal,
        );
      },
      Math.max(1, wireJob.expiresAt - now),
    );
    session.pending = pending;
    response.once("close", () => {
      if (!response.writableEnded && session.pending === pending) {
        try {
          pending.cancel();
        } catch {}
      }
    });
    if (response.destroyed && !response.writableEnded) {
      try {
        pending.cancel();
      } catch {}
    }
    return pending;
  };

  const server = createServer(
    { key: options.key, cert: options.cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 },
    (req, res) => {
      void (async () => {
        if (
          req.rawHeaders.some(
            (header, index) => index % 2 === 0 && header.toLowerCase() === "origin",
          )
        )
          return send(res, 403, { error: "Browser clients are not enabled." });
        if (req.headers["x-ellie-version"] !== String(VERSION))
          return send(res, 400, { error: "Unsupported protocol version." });
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return send(res, 415, { error: "JSON required." });
        const path = new URL(req.url ?? "/", "https://ellie.local").pathname;
        if (req.method === "POST" && path === "/v1/pair") {
          const body = record(await readJson(req));
          const token = await auth.pair(string(body.code, 64), identifier(body.id));
          return send(res, 200, { token });
        }
        const identity = auth.authenticate(req.headers.authorization);
        if (!identity)
          return send(res, 401, { error: "Authentication required. Pair this node first." });
        const browserManagement = await handleBrowserManagement(
          req,
          path,
          identity.role,
          options.browser,
        );
        if (browserManagement) return send(res, browserManagement.status, browserManagement.body);
        const nativeManagement = await handleNativeManagement(
          req,
          path,
          identity.role,
          options.browser,
        );
        if (nativeManagement) return send(res, nativeManagement.status, nativeManagement.body);
        const householdManagement = await handleHouseholdManagement(
          req,
          path,
          identity.role,
          options.browser,
        );
        if (householdManagement)
          return send(res, householdManagement.status, householdManagement.body);
        const speechManagement = await handleSpeechManagement(
          req,
          path,
          identity.role,
          options.browser,
        );
        if (speechManagement) return send(res, speechManagement.status, speechManagement.body);
        const lifeManagement = await handleLifeManagement(
          req,
          path,
          identity.role,
          options.browser,
        );
        if (lifeManagement) return send(res, lifeManagement.status, lifeManagement.body);
        if (path === "/v1/decisions/browser-step") {
          const abort = new AbortController();
          const onClose = () => {
            if (!res.writableEnded) abort.abort();
          };
          res.once("close", onClose);
          const timer = setTimeout(() => abort.abort(), options.decisionRouting?.timeoutMs ?? 3000);
          try {
            const step = await handleBrowserStepDecision(req, path, identity.role, {
              routing: options.decisionRouting,
              node: (id) => {
                const target = sessions.get(id);
                return target
                  ? {
                      capabilities: target.info.capabilities,
                      stale: Date.now() - target.info.lastSeen > 60_000,
                    }
                  : undefined;
              },
              signal: abort.signal,
            });
            if (step) return send(res, step.status, step.body);
          } finally {
            clearTimeout(timer);
            res.off("close", onClose);
          }
        }
        if (req.method === "POST" && path === "/v1/invite" && identity.role === "controller")
          return send(res, 200, await auth.invite());
        if (req.method === "POST" && path === "/v1/revoke" && identity.role === "controller") {
          const id = identifier(record(await readJson(req)).id);
          await auth.revoke(id);
          distributed.changed(id, "node_revoked");
          const session = sessions.get(id);
          session?.routing?.abort();
          if (session?.poll) {
            clearTimeout(session.poll.timer);
            send(session.poll.response, 403, { error: "Node revoked." });
          }
          session?.pending?.finish(
            {
              ok: false,
              message: "Node revoked. An already running native action may have completed.",
            },
            session.pending.delivered
              ? { state: "unknown", code: "node_revoked" }
              : { state: "cancelled", code: "node_revoked" },
          );
          sessions.delete(id);
          return send(res, 200, { ok: true });
        }
        if (req.method === "GET" && path === "/v1/jobs")
          return send(
            res,
            200,
            options.jobStore.list(identity.role === "node" ? identity.id : undefined),
          );
        const jobRoute = /^\/v1\/jobs\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(path);
        if (jobRoute) {
          const id = identifier(jobRoute[1]);
          const stored = options.jobStore.get(id);
          if (!stored || !canAccess(identity, stored))
            return send(res, 404, { error: "Job not found." });
          if (req.method === "GET") return send(res, 200, stored);
          if (req.method === "POST") {
            await readJson(req);
            const session = sessions.get(stored.target);
            if (distributed.member(stored.target)?.task.id === id) {
              distributed.cancelJob(stored.target, id);
              return send(res, 200, options.jobStore.get(id));
            }
            if (session?.pending?.job.id === id) return send(res, 200, session.pending.cancel());
            return send(res, 200, options.jobStore.requestCancellation(id) ?? stored);
          }
        }
        if (req.method === "GET" && path === "/v1/groups" && identity.role === "controller")
          return send(res, 200, distributed.status(busyNodes()));
        if (req.method === "GET" && path === "/v1/nodes")
          return send(
            res,
            200,
            [...sessions.values()]
              .filter((s) => identity.role === "controller" || s.info.id === identity.id)
              .map((s) => ({
                ...s.info,
                ...(s.pending?.delivered &&
                s.pending.cancelRequested &&
                options.jobStore.get(s.pending.job.id)?.state === "cancellation_requested"
                  ? { cancellationSettling: true as const }
                  : {}),
              })),
          );
        if (req.method === "POST" && path === "/v1/register" && identity.role === "node") {
          const body = record(await readJson(req));
          const granted = capabilities(body.executionCapabilities ?? body.capabilities ?? []);
          const compute =
            body.computeCapabilities === undefined
              ? undefined
              : computeCapabilities(body.computeCapabilities);
          const metrics = body.telemetry === undefined ? undefined : telemetry(body.telemetry);
          const shards =
            body.distributedCapabilities === undefined
              ? []
              : distributedCapabilities(body.distributedCapabilities);
          if (
            (body.distributedCapabilities !== undefined && !metrics) ||
            shards.some((c) => c.plan.nodeIds[c.rank] !== identity.id)
          )
            throw new Error("Distributed registration requires local membership and telemetry.");
          if (compute && !metrics) throw new Error("Compute registration requires telemetry.");
          let session = sessions.get(identity.id);
          if (!session) {
            session = {
              info: {
                id: identity.id,
                capabilities: granted,
                executionCapabilities: granted,
                lastSeen: Date.now(),
              },
              context: {},
            };
            sessions.set(identity.id, session);
          } else {
            distributed.changed(identity.id);
            // A reconnect may change capabilities and invalidate the context used by a decision.
            session.routing?.abort();
            session.info.capabilities = granted;
            session.info.lastSeen = Date.now();
          }
          session.info.executionCapabilities = granted;
          session.info.computeCapabilities = compute;
          session.info.distributedCapabilities = shards;
          session.info.telemetry = metrics;
          session.info.telemetryReceivedAt = metrics ? Date.now() : undefined;
          return send(res, 200, { ok: true });
        }
        const session = sessions.get(identity.id);
        if (
          req.method === "POST" &&
          path === "/v1/heartbeat" &&
          identity.role === "node" &&
          session
        ) {
          const body = record(await readJson(req));
          const metrics = body.telemetry === undefined ? undefined : telemetry(body.telemetry);
          const compute =
            body.computeCapabilities === undefined
              ? undefined
              : computeCapabilities(body.computeCapabilities);
          if (compute && !metrics) throw new Error("Compute heartbeat requires telemetry.");
          const shards =
            body.distributedCapabilities === undefined
              ? []
              : distributedCapabilities(body.distributedCapabilities);
          if (
            (body.distributedCapabilities !== undefined && !metrics) ||
            shards.some((c) => c.plan.nodeIds[c.rank] !== identity.id)
          )
            throw new Error("Distributed heartbeat requires local membership and telemetry.");
          session.info.telemetry = metrics;
          session.info.computeCapabilities = compute;
          session.info.distributedCapabilities = shards;
          session.info.telemetryReceivedAt = metrics ? Date.now() : undefined;
          session.info.lastSeen = Date.now();
          distributed.checkNode(identity.id);
          const member = distributed.member(identity.id);
          return send(res, 200, {
            ok: true,
            cancelJobIds: session.pending?.cancelRequested
              ? [session.pending.job.id]
              : member?.lease.cancelled && !member.stopped
                ? [member.task.id]
                : [],
          });
        }
        if (req.method === "GET" && path === "/v1/poll" && identity.role === "node" && session) {
          if (session.poll)
            return send(res, 409, { error: "A node agent is already polling with this identity." });
          session.info.lastSeen = Date.now();
          const timer = setTimeout(() => {
            if (session.poll?.response === res) {
              delete session.poll;
              send(res, 200, { job: null });
            }
          }, 25_000);
          session.poll = { response: res, timer };
          res.on("close", () => {
            if (session.poll?.response === res) {
              clearTimeout(timer);
              delete session.poll;
            }
          });
          deliver(session);
          return;
        }
        if (req.method === "POST" && path === "/v1/start" && identity.role === "node" && session) {
          const id = identifier(record(await readJson(req)).id);
          if (distributed.member(identity.id)?.task.id === id)
            return send(res, 200, distributed.start(identity.id, id));
          if (!session.pending || !session.pending.delivered || id !== session.pending.job.id)
            return send(res, 409, { error: "No matching delivered job." });
          if (!session.pending.cancelRequested)
            session.pending.running = options.jobStore.markRunning(id);
          return send(res, 200, { cancel: session.pending.cancelRequested });
        }
        if (req.method === "POST" && path === "/v1/result" && identity.role === "node" && session) {
          const body = record(await readJson(req));
          if (distributed.member(identity.id)?.task.id === body.id) {
            distributed.report(identity.id, identifier(body.id), result(body.result));
            return send(res, 200, { ok: true });
          }
          // A lost teardown acknowledgement may be retried after the entire lease was released.
          const completedRank =
            typeof body.id === "string" && /-[0-7]$/.test(body.id)
              ? options.jobStore.get(body.id)
              : undefined;
          if (
            completedRank?.target === identity.id &&
            completedRank.kind === "inference" &&
            ["completed", "failed", "cancelled", "unknown"].includes(completedRank.state)
          )
            return send(res, 200, { ok: true });
          if (
            !session.pending ||
            !session.pending.delivered ||
            identifier(body.id) !== session.pending.job.id
          )
            return send(res, 409, { error: "No matching in-flight command." });
          const outcome = result(body.result);
          const browserStatus =
            "browser" in outcome && outcome.browser.operation === "command"
              ? outcome.browser.status
              : undefined;
          const terminal =
            browserStatus === "unknown"
              ? ({ state: "unknown", code: "operation_failed" } as const)
              : browserStatus === "timed_out"
                ? ({ state: "unknown", code: "timed_out" } as const)
                : undefined;
          if (!session.pending.finish(outcome, terminal))
            return send(res, 503, { error: "Job outcome could not be committed." });
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST" && path === "/v1/inference" && identity.role === "controller") {
          const request = inferenceRequest(await readJson(req));
          if (request.mode === "distributed-mlx") {
            try {
              const cancel = distributed.submit(request, busyNodes(), (outcome) =>
                send(res, 200, outcome),
              );
              res.once("close", () => {
                if (!res.writableEnded) cancel();
              });
              if (res.destroyed) cancel();
              for (const node of sessions.values()) deliver(node);
            } catch (error) {
              send(res, 409, {
                error: error instanceof Error ? error.message : "Distributed placement failed.",
              });
            }
            return;
          }
          const selected = selectWorker(
            [...sessions.values()].map((s) => s.info),
            request.model,
            busyNodes(),
          );
          if (!selected)
            return send(res, 409, {
              error:
                "No eligible independent worker has this model and enough free memory. Check nodes, power, load, and model configuration.",
            });
          const node = sessions.get(selected.id)!;
          const timeout = options.commandTimeout ?? 30_000;
          const task: InferenceJob = {
            version: VERSION,
            kind: "inference",
            id: randomUUID(),
            expiresAt: Date.now() + timeout,
            request,
          };
          makePending(node, task, "inference", res, () => {
            delete node.info.telemetryReceivedAt;
          });
          deliver(node);
          return;
        }
        if (req.method === "POST" && path === "/v1/commands") {
          const body = record(await readJson(req));
          const target = identifier(body.nodeId);
          if (identity.role === "node" && identity.id !== target)
            return send(res, 403, { error: "Nodes can only control themselves." });
          const node = sessions.get(target);
          if (!node) {
            const paired = auth.hasNode(target);
            return send(res, paired ? 409 : 404, {
              error: paired
                ? "Node is paired but offline. Start its node service."
                : "Unknown node ID. Run `bun run ellie nodes` and use the exact ID shown there.",
            });
          }
          if (Date.now() - node.info.lastSeen > 60_000)
            return send(res, 409, {
              error: "Node is registered but offline or stale. Start its node service.",
            });
          if (busyNodes().has(target))
            return send(res, 409, { error: "Node is busy. Wait for the current command." });
          const suppliedAction = Object.hasOwn(body, "action") ? actions([body.action]) : undefined;
          if (suppliedAction && !suppliedAction[0]!.tool.startsWith("browser."))
            return send(res, 400, { error: "Command request rejected." });
          if (
            (suppliedAction && (Object.keys(body).length !== 2 || Object.hasOwn(body, "text"))) ||
            (!suppliedAction && (Object.keys(body).length !== 2 || Object.hasOwn(body, "action")))
          )
            return send(res, 400, { error: "Command request rejected." });
          const text = suppliedAction ? "" : string(body.text, 500);
          let plan = suppliedAction
            ? { actions: suppliedAction, nextContext: node.context }
            : route(text, node.context, options.preferences);
          const routing = options.decisionRouting;
          if (!plan && routing) {
            const abort = new AbortController();
            node.routing = abort;
            const cancel = () => abort.abort();
            const onClose = () => {
              if (!res.writableEnded) cancel();
            };
            res.once("close", onClose);
            const timer = setTimeout(cancel, routing.timeoutMs ?? 3000);
            let rejectAbort: (() => void) | undefined;
            try {
              if (res.destroyed || stopped) abort.abort();
              abort.signal.throwIfAborted();
              const decision = await Promise.race([
                decideDesktop(text, { ...node.context }, options.preferences, routing.provider, {
                  signal: abort.signal,
                  minProbability: routing.minProbability,
                  minMargin: routing.minMargin,
                }),
                new Promise<never>((_resolve, reject) => {
                  rejectAbort = () => reject(new Error("Decision cancelled."));
                  abort.signal.addEventListener("abort", rejectAbort, { once: true });
                  if (abort.signal.aborted) rejectAbort();
                }),
              ]);
              abort.signal.throwIfAborted();
              if (res.destroyed || stopped) return;
              if (
                sessions.get(target) !== node ||
                !auth.authenticate(req.headers.authorization) ||
                Date.now() - node.info.lastSeen > 60_000
              )
                return send(res, 409, {
                  error:
                    "Node changed or disconnected while interpreting the request. No action was sent.",
                });
              if (decision.kind !== "plan")
                return send(res, 200, { ok: false, message: decision.message });
              const proposed = actions(decision.plan.actions);
              authorize(proposed, node.info.capabilities, options.preferences);
              if (routing.mode === "shadow")
                return send(res, 200, {
                  ok: false,
                  message: `Shadow mode proposed ${JSON.stringify(proposed)}. No action was executed.`,
                });
              plan = decision.plan;
            } catch {
              return send(res, 200, {
                ok: false,
                message:
                  "Decision routing was unavailable, cancelled, or could not produce an allowed action. No action was sent. Try an explicit command such as “open Arc”.",
              });
            } finally {
              clearTimeout(timer);
              res.off("close", onClose);
              if (rejectAbort) abort.signal.removeEventListener("abort", rejectAbort);
              if (node.routing === abort) delete node.routing;
            }
          }
          if (!plan)
            return send(res, 200, {
              ok: false,
              message:
                "I do not have a deterministic command for that yet. Try “open Arc” or “put it in the top-left”.",
            });
          const validatedActions = actions(plan.actions);
          authorize(validatedActions, node.info.capabilities, options.preferences);
          const timeout = options.commandTimeout ?? 30_000;
          const task: Job = {
            version: VERSION,
            id: randomUUID(),
            expiresAt: Date.now() + timeout,
            actions: validatedActions,
          };
          makePending(node, task, "desktop", res, (state) => {
            if (state === "completed") node.context = plan.nextContext;
          });
          deliver(node);
          return;
        }
        send(res, 404, {
          error:
            "Endpoint unavailable for this identity. Restart the node if the server was restarted.",
        });
      })().catch(() =>
        send(res, 400, {
          error: "Request rejected. Check input, pairing, and granted capabilities.",
        }),
      );
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  server.on("error", () => {});
  let stopped = false;
  const shutdown = (): void => {
    if (stopped) return;
    stopped = true;
    distributed.shutdown();
    for (const session of sessions.values()) {
      session.routing?.abort();
      if (session.poll) {
        clearTimeout(session.poll.timer);
        send(session.poll.response, 503, { error: "Server stopping." });
      }
      session.pending?.finish(
        { ok: false, message: "Server stopping; check the Mac before repeating the command." },
        session.pending.delivered
          ? { state: "unknown", code: "coordinator_stopped" }
          : { state: "cancelled", code: "coordinator_stopped" },
      );
    }
    if (server.listening) server.close();
    server.closeAllConnections();
    options.jobStore.close();
  };
  return { server, shutdown };
}
