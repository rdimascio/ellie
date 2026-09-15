import type { IncomingMessage, ServerResponse } from "node:http";
import {
  browserWebMCPOperationResult,
  identifier,
  nativeLabel,
  nativeCommand,
  nativeCommandCapability,
  NATIVE_CONTROL_CONTRACT,
} from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import type { NativeAuth, NativeClient } from "./native-auth.ts";
import type { BrowserRemote, BrowserRemoteNode } from "./browser-remote.ts";

type Reply = (status: number, body: unknown) => void;
const allowed = (client: NativeClient, id: string, capability = "app.open") =>
  client.role === "native_phone_controller" &&
  client.grants.some(
    (grant) => grant.target === id && grant.capabilities.includes(capability as never),
  );

function projectNodes(nodes: BrowserRemoteNode[]): BrowserRemoteNode[] {
  if (!Array.isArray(nodes) || nodes.length > NATIVE_CONTROL_CONTRACT.maximumNodes)
    throw new Error();
  const seen = new Set<string>();
  const result = nodes.map((node) => {
    const id = identifier(node.id);
    if (seen.has(id) || typeof node.online !== "boolean" || !Array.isArray(node.capabilities))
      throw new Error();
    seen.add(id);
    return {
      id,
      label: nativeLabel(node.label),
      online: node.online,
      capabilities: (["app.open", "browser.read", "browser.control"] as const).filter(
        (capability) => node.capabilities.includes(capability),
      ),
    };
  });
  if (
    Buffer.byteLength(JSON.stringify({ nodes: result })) >
    NATIVE_CONTROL_CONTRACT.maximumResponseBytes
  )
    throw new Error();
  return result;
}

async function bounded<T>(
  work: () => Promise<T>,
  controller: AbortController,
  milliseconds: number,
): Promise<T> {
  controller.signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("Native request interrupted."));
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    return await Promise.race([work(), interrupted]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}

/** Shares node reservations with browser requests; authority always comes from native auth. */
export class NativeControls {
  private readonly active = new Set<AbortController>();
  private stopped = false;
  private readonly remote: BrowserRemote | undefined;
  private readonly busy: Set<string>;
  constructor(remote: BrowserRemote | undefined, busy: Set<string>) {
    this.remote = remote;
    this.busy = busy;
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
    auth: NativeAuth,
    bearer: string,
    reply: Reply,
  ): Promise<boolean> {
    const routes = NATIVE_CONTROL_CONTRACT.routes;
    const listing = request.method === routes.nodes.method && path === routes.nodes.path;
    const commanding = request.method === routes.commands.method && path === routes.commands.path;
    if (!listing && !commanding) return false;
    const remote = this.remote;
    if (!remote || this.stopped) {
      reply(503, { error: "Phone controls are not configured or available." });
      return true;
    }
    const controller = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", onClose);
    response.once("close", onClose);
    this.active.add(controller);
    let reservation: string | undefined;
    let dispatched = false,
      settled = false,
      retainReservation = false;
    const current = () => {
      const client = auth.authenticateBearer(bearer);
      if (!client) reply(401, { error: "Native session required." });
      return client;
    };
    try {
      if (listing) {
        const nodes = projectNodes(
          await bounded(
            () => remote.nodes({ signal: controller.signal }),
            controller,
            NATIVE_CONTROL_CONTRACT.discoveryDeadlineMs,
          ),
        );
        const client = current();
        if (client && !controller.signal.aborted) {
          const visible = nodes.flatMap((node) => {
            const grant = client.grants.find((item) => item.target === node.id);
            if (!grant) return [];
            const capabilities = node.capabilities.filter((capability) =>
              grant.capabilities.includes(capability),
            );
            return capabilities.length ? [{ ...node, capabilities }] : [];
          });
          reply(200, { nodes: visible });
        }
        return true;
      }
      let command;
      try {
        command = nativeCommand(await readJson(request, 4096));
      } catch {
        reply(400, { error: "Native app request rejected." });
        return true;
      }
      const client = current();
      if (!client) return true;
      const capability = nativeCommandCapability(command.action);
      if (!allowed(client, command.nodeId, capability)) {
        reply(403, {
          error:
            capability === "app.open"
              ? "App opening is not allowed on this device."
              : "This browser action is not allowed on this device.",
        });
        return true;
      }
      if (this.busy.has(command.nodeId)) {
        reply(409, { error: "This device has an unfinished command." });
        return true;
      }
      reservation = command.nodeId;
      this.busy.add(reservation);
      const nodes = projectNodes(
        await bounded(
          () => remote.nodes({ signal: controller.signal }),
          controller,
          NATIVE_CONTROL_CONTRACT.discoveryDeadlineMs,
        ),
      );
      const target = nodes.find((node) => node.id === command.nodeId);
      if (!target) {
        reply(404, { error: "The granted device is not configured." });
        return true;
      }
      if (!target.online || !target.capabilities.includes(capability)) {
        reply(409, { error: "This device is offline or cannot perform this action." });
        return true;
      }
      if (controller.signal.aborted || response.destroyed || this.stopped) return true;
      const nodeId = command.nodeId;
      const admitted = await bounded(
        () => auth.withAuthenticated(bearer, (fresh) => allowed(fresh, nodeId, capability)),
        controller,
        NATIVE_CONTROL_CONTRACT.discoveryDeadlineMs,
      );
      if (admitted !== true) {
        reply(401, { error: "Native session required." });
        return true;
      }
      if (controller.signal.aborted || response.destroyed || this.stopped) return true;
      response.setTimeout(40_000);
      dispatched = true;
      const operation = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return command.action.tool === "app.open"
          ? remote.openApp(nodeId, command.action.app as "arc" | "safari" | "messages", {
              signal: controller.signal,
            })
          : remote.execute
            ? remote.execute(nodeId, command.action, { signal: controller.signal })
            : Promise.reject(new Error("Browser execution is unavailable."));
      });
      operation.then(
        () => {
          settled = true;
          if (retainReservation) this.busy.delete(nodeId);
        },
        () => {
          settled = true;
          if (retainReservation) this.busy.delete(nodeId);
        },
      );
      const result = await bounded(
        () => operation,
        controller,
        NATIVE_CONTROL_CONTRACT.commandDeadlineMs,
      );
      if (!result || typeof result.ok !== "boolean") throw new Error();
      if (Object.hasOwn(result, "browser")) {
        const checked = browserWebMCPOperationResult(result);
        const status = checked.browser.status;
        reply(200, {
          outcome:
            status === "completed" || status === "connected"
              ? "completed"
              : status === "unknown" || status === "timed_out"
                ? "unknown"
                : "failed",
          result: checked,
        });
      } else reply(200, { outcome: result.ok ? "completed" : "failed" });
    } catch {
      if (!response.destroyed && !this.stopped) {
        if (dispatched) reply(502, { outcome: "unknown" });
        else reply(503, { error: "Phone controls are unavailable." });
      }
    } finally {
      request.removeListener("aborted", onClose);
      response.removeListener("close", onClose);
      this.active.delete(controller);
      if (reservation) {
        // An upstream that ignores cancellation cannot admit overlapping commands.
        if (dispatched && !settled) retainReservation = true;
        else this.busy.delete(reservation);
      }
    }
    return true;
  }
}
