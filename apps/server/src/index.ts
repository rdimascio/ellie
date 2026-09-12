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
} from "@ellie/protocol";
import type { Context, Job, InferenceJob, Result, NodeInfo } from "@ellie/protocol";
import { route } from "@ellie/router";
import { authorize } from "@ellie/permissions";
import { readJson } from "@ellie/transport";
import { selectWorker } from "@ellie/compute";
import type { Auth } from "./auth.ts";

interface Pending {
  job: Job | InferenceJob;
  delivered: boolean;
  finish: (result: Result) => void;
}
interface Session {
  info: NodeInfo;
  context: Context;
  poll?: { response: ServerResponse; timer: NodeJS.Timeout };
  pending?: Pending;
}
function send(res: ServerResponse, status: number, body: unknown): void {
  if (!res.destroyed && !res.writableEnded)
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(body));
}
export function createEllieServer(options: {
  key: string;
  cert: string;
  auth: Auth;
  preferences: Preferences;
  commandTimeout?: number;
}) {
  const sessions = new Map<string, Session>();
  const auth = options.auth;
  const deliver = (session: Session): void => {
    if (session.poll && session.pending && !session.pending.delivered) {
      session.pending.delivered = true;
      clearTimeout(session.poll.timer);
      send(session.poll.response, 200, { job: session.pending.job });
      delete session.poll;
    }
  };
  const server = createServer(
    { key: options.key, cert: options.cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 },
    (req, res) => {
      void (async () => {
        if (req.headers.origin)
          return send(res, 403, { error: "Browser clients are not enabled." });
        if (req.headers["x-ellie-version"] !== String(VERSION))
          return send(res, 400, { error: "Unsupported protocol version." });
        if (req.method === "POST" && !req.headers["content-type"]?.startsWith("application/json"))
          return send(res, 415, { error: "JSON required." });
        const path = req.url;
        if (req.method === "POST" && path === "/v1/pair") {
          const body = record(await readJson(req));
          const token = await auth.pair(string(body.code, 64), identifier(body.id));
          return send(res, 200, { token });
        }
        const identity = auth.authenticate(req.headers.authorization);
        if (!identity)
          return send(res, 401, { error: "Authentication required. Pair this node first." });
        if (req.method === "POST" && path === "/v1/invite" && identity.role === "controller")
          return send(res, 200, await auth.invite());
        if (req.method === "POST" && path === "/v1/revoke" && identity.role === "controller") {
          const id = identifier(record(await readJson(req)).id);
          await auth.revoke(id);
          const session = sessions.get(id);
          if (session?.poll) {
            clearTimeout(session.poll.timer);
            send(session.poll.response, 403, { error: "Node revoked." });
          }
          session?.pending?.finish({
            ok: false,
            message: "Node revoked. An already running native action may have completed.",
          });
          sessions.delete(id);
          return send(res, 200, { ok: true });
        }
        if (req.method === "GET" && path === "/v1/nodes")
          return send(
            res,
            200,
            [...sessions.values()]
              .filter((s) => identity.role === "controller" || s.info.id === identity.id)
              .map((s) => s.info),
          );
        if (req.method === "POST" && path === "/v1/register" && identity.role === "node") {
          const body = record(await readJson(req));
          const granted = capabilities(body.executionCapabilities ?? body.capabilities ?? []);
          const compute =
            body.computeCapabilities === undefined
              ? undefined
              : computeCapabilities(body.computeCapabilities);
          const metrics = body.telemetry === undefined ? undefined : telemetry(body.telemetry);
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
            session.info.capabilities = granted;
            session.info.lastSeen = Date.now();
          }
          session.info.executionCapabilities = granted;
          session.info.computeCapabilities = compute;
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
          session.info.telemetry = metrics;
          session.info.computeCapabilities = compute;
          session.info.telemetryReceivedAt = metrics ? Date.now() : undefined;
          session.info.lastSeen = Date.now();
          return send(res, 200, { ok: true });
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
        if (req.method === "POST" && path === "/v1/result" && identity.role === "node" && session) {
          const body = record(await readJson(req));
          if (
            !session.pending ||
            !session.pending.delivered ||
            identifier(body.id) !== session.pending.job.id
          )
            return send(res, 409, { error: "No matching in-flight command." });
          session.pending.finish(result(body.result));
          return send(res, 200, { ok: true });
        }
        if (req.method === "POST" && path === "/v1/inference" && identity.role === "controller") {
          const request = inferenceRequest(await readJson(req));
          const selected = selectWorker(
            [...sessions.values()].map((s) => s.info),
            request.model,
            new Set([...sessions.values()].filter((s) => s.pending).map((s) => s.info.id)),
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
          const timer = setTimeout(
            () =>
              node.pending?.finish({
                ok: false,
                message: "Inference timed out. It was not retried on another Mac.",
              }),
            timeout,
          );
          // Reservation happens synchronously before another request can select this worker.
          node.pending = {
            job: task,
            delivered: false,
            finish: (outcome) => {
              clearTimeout(timer);
              delete node.pending;
              // Require a fresh heartbeat before reusing a worker after completion/timeout.
              delete node.info.telemetryReceivedAt;
              send(res, 200, { ...outcome, workerId: node.info.id });
            },
          };
          deliver(node);
          return;
        }
        if (req.method === "POST" && path === "/v1/commands") {
          const body = record(await readJson(req));
          const target = identifier(body.nodeId);
          if (identity.role === "node" && identity.id !== target)
            return send(res, 403, { error: "Nodes can only control themselves." });
          const node = sessions.get(target);
          if (!node || Date.now() - node.info.lastSeen > 60_000)
            return send(res, 409, { error: "Node is offline. Start its agent." });
          if (node.pending)
            return send(res, 409, { error: "Node is busy. Wait for the current command." });
          const plan = route(string(body.text, 500), node.context, options.preferences);
          if (!plan)
            return send(res, 200, {
              ok: false,
              message:
                "I do not have a deterministic command for that yet. Try “open Arc” or “put it in the top-left”.",
            });
          const validatedActions = actions(plan.actions);
          authorize(validatedActions, node.info.capabilities, options.preferences);
          const timeout = options.commandTimeout ?? 30_000;
          const job: Job = {
            version: VERSION,
            id: randomUUID(),
            expiresAt: Date.now() + timeout,
            actions: validatedActions,
          };
          const timer = setTimeout(
            () =>
              node.pending?.finish({
                ok: false,
                message:
                  "Command timed out; completion is unknown. Check the Mac before repeating it.",
              }),
            timeout,
          );
          node.pending = {
            job,
            delivered: false,
            finish: (outcome) => {
              clearTimeout(timer);
              delete node.pending;
              if (outcome.ok) node.context = plan.nextContext;
              send(res, 200, outcome);
            },
          };
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
  const shutdown = (): void => {
    for (const session of sessions.values()) {
      if (session.poll) {
        clearTimeout(session.poll.timer);
        send(session.poll.response, 503, { error: "Server stopping." });
      }
      session.pending?.finish({
        ok: false,
        message: "Server stopping; check the Mac before repeating the command.",
      });
    }
    server.close();
    server.closeAllConnections();
  };
  return { server, shutdown };
}
