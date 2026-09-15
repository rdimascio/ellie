import { browserWebMCPOperationResult, identifier, nativeLabel, result } from "@ellie/protocol";
import type { Action, BrowserAction, Capability, Result } from "@ellie/protocol";
import type { BrowserClient } from "./browser-auth.ts";

export const PHONE_APPS = { arc: "Arc", safari: "Safari", messages: "Messages" } as const;
export type PhoneApp = keyof typeof PHONE_APPS;
export interface BrowserRemoteNode {
  id: string;
  label: string;
  online: boolean;
  capabilities: Capability[];
}
export interface BrowserRemote {
  nodes(options?: { signal?: AbortSignal }): Promise<BrowserRemoteNode[]>;
  openApp(
    nodeId: string,
    app: PhoneApp,
    options?: { signal?: AbortSignal },
  ): Promise<{ ok: boolean; message: string }>;
  execute?(
    nodeId: string,
    action: BrowserAction,
    options?: { signal?: AbortSignal },
  ): Promise<Result>;
}

export function canOpenApps(client: BrowserClient, nodeId: string): boolean {
  return (
    client.role === "phone_controller" &&
    client.grants.some(
      (grant) => grant.target === nodeId && grant.capabilities.includes("app.open"),
    )
  );
}

/** Deliberately finite demo grammar: never forward arbitrary browser text upstream. */
export function phoneAppCommand(body: unknown): { nodeId: string; app: PhoneApp } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "nodeId") ||
    !Object.hasOwn(value, "text") ||
    typeof value.text !== "string" ||
    value.text.length > 500
  )
    throw new Error();
  const text = value.text
    .trim()
    .toLowerCase()
    .replace(/^ellie[,!]?\s+/, "")
    .replace(/[.!?]+$/, "")
    .replace(/\s+/g, " ");
  const match = /^(?:open|launch|start) (?:app )?(arc|safari|messages)$/.exec(text);
  if (!match) throw new Error();
  return { nodeId: identifier(value.nodeId), app: match[1] as PhoneApp };
}

interface Upstream {
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Opt-in bridge to an existing pinned coordinator; secrets never enter browser responses. */
export function createBrowserRemote(
  upstream: Upstream,
  configured?: readonly { id: string; label: string }[],
): BrowserRemote {
  if (configured && (configured.length < 1 || configured.length > 16))
    throw new Error("Invalid remote targets.");
  const targets = configured?.map((node) => {
    identifier(node.id);
    try {
      nativeLabel(node.label);
    } catch {
      throw new Error("Invalid remote label.");
    }
    return { ...node };
  });
  if (targets && new Set(targets.map((node) => node.id)).size !== targets.length)
    throw new Error("Invalid remote targets.");
  return {
    async nodes(options) {
      const response = await upstream.call("GET", "/v1/nodes", undefined, {
        timeoutMs: 5000,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (!Array.isArray(response) || response.length > (targets ? 128 : 16))
        throw new Error("Nodes unavailable.");
      const registered = response.map((item) => {
        if (!item || typeof item !== "object") throw new Error("Nodes unavailable.");
        const id = identifier((item as { id?: unknown }).id);
        return { id, label: `Mac · ${[...id].slice(0, 58).join("")}`, item };
      });
      if (new Set(registered.map((node) => node.id)).size !== registered.length)
        throw new Error("Nodes unavailable.");
      const projected = targets ?? registered;
      return projected.map((target) => {
        const node = targets
          ? response.find((item) => item?.id === target.id)
          : registered.find((item) => item.id === target.id)?.item;
        const advertised = Array.isArray(node?.executionCapabilities ?? node?.capabilities)
          ? (node.executionCapabilities ?? node.capabilities)
          : [];
        const available = advertised.some((item: unknown) =>
          ["app.open", "browser.read", "browser.control"].includes(String(item)),
        );
        return {
          id: target.id,
          label: target.label,
          online: Boolean(
            available &&
            Number.isFinite(node?.lastSeen) &&
            node.lastSeen <= Date.now() + 5000 &&
            Date.now() - node.lastSeen <= 60_000,
          ),
          capabilities: (["app.open", "browser.read", "browser.control"] as Capability[]).filter(
            (capability) => advertised.includes(capability),
          ),
        };
      });
    },
    async openApp(nodeId, app, options) {
      if (
        (targets && !targets.some((node) => node.id === nodeId)) ||
        !Object.hasOwn(PHONE_APPS, app)
      )
        throw new Error("Unknown target or app.");
      identifier(nodeId);
      const response = await upstream.call(
        "POST",
        "/v1/commands",
        { nodeId, text: `open app ${app}` },
        { timeoutMs: 35_000, ...(options?.signal ? { signal: options.signal } : {}) },
      );
      if (
        typeof response !== "object" ||
        response === null ||
        typeof (response as { ok?: unknown }).ok !== "boolean"
      )
        throw new Error("Command outcome unknown.");
      const ok = (response as { ok: boolean }).ok;
      return {
        ok,
        message: ok
          ? `Opened ${PHONE_APPS[app]}.`
          : "The app could not be opened. Check the selected Mac.",
      };
    },
    async execute(nodeId, browserAction, options) {
      if (targets && !targets.some((node) => node.id === nodeId))
        throw new Error("Unknown target.");
      identifier(nodeId);
      const response = await upstream.call(
        "POST",
        "/v1/commands",
        { nodeId, action: browserAction },
        { timeoutMs: 35_000, ...(options?.signal ? { signal: options.signal } : {}) },
      );
      const parsed = result(response);
      if (!Object.hasOwn(parsed, "browser")) throw new Error("Browser command outcome unknown.");
      const checked = browserWebMCPOperationResult(parsed);
      const expected =
        browserAction.tool === "browser.status"
          ? "status"
          : browserAction.tool === "browser.read"
            ? "read"
            : "command";
      if (checked.browser.operation !== expected)
        throw new Error("Browser command outcome unknown.");
      if (
        browserAction.tool !== "browser.status" &&
        checked.browser.revision !== browserAction.revision
      )
        throw new Error("Browser command outcome unknown.");
      return checked;
    },
  };
}
