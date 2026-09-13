import { identifier } from "@ellie/protocol";
import type { BrowserClient } from "./browser-auth.ts";

export const PHONE_APPS = { arc: "Arc", safari: "Safari", messages: "Messages" } as const;
export type PhoneApp = keyof typeof PHONE_APPS;
export interface BrowserRemoteNode {
  id: string;
  label: string;
  online: boolean;
  capabilities: "app.open"[];
}
export interface BrowserRemote {
  nodes(): Promise<BrowserRemoteNode[]>;
  openApp(nodeId: string, app: PhoneApp): Promise<{ ok: boolean; message: string }>;
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
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
}

/** Opt-in bridge to an existing pinned coordinator; secrets never enter browser responses. */
export function createBrowserRemote(
  upstream: Upstream,
  configured: readonly { id: string; label: string }[],
): BrowserRemote {
  if (
    configured.length < 1 ||
    configured.length > 16 ||
    new Set(configured.map((node) => node.id)).size !== configured.length
  )
    throw new Error("Invalid remote targets.");
  const targets = configured.map((node) => {
    identifier(node.id);
    if (!node.label || [...node.label].length > 64 || /\p{C}/u.test(node.label))
      throw new Error("Invalid remote label.");
    return { ...node };
  });
  return {
    async nodes() {
      const response = await upstream.call("GET", "/v1/nodes", undefined, { timeoutMs: 5000 });
      if (!Array.isArray(response) || response.length > 128) throw new Error("Nodes unavailable.");
      return targets.map((target) => {
        const node = response.find((item) => item?.id === target.id);
        const available =
          Array.isArray(node?.executionCapabilities ?? node?.capabilities) &&
          (node.executionCapabilities ?? node.capabilities).includes("app.open");
        return {
          ...target,
          online: Boolean(
            available &&
            Number.isFinite(node?.lastSeen) &&
            node.lastSeen <= Date.now() + 5000 &&
            Date.now() - node.lastSeen <= 60_000,
          ),
          capabilities: available ? ["app.open"] : [],
        };
      });
    },
    async openApp(nodeId, app) {
      if (!targets.some((node) => node.id === nodeId) || !Object.hasOwn(PHONE_APPS, app))
        throw new Error("Unknown target or app.");
      const response = await upstream.call(
        "POST",
        "/v1/commands",
        { nodeId, text: `open app ${app}` },
        { timeoutMs: 35_000 },
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
  };
}
