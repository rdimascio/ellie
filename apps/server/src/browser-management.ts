import type { IncomingMessage } from "node:http";
import { readJson } from "@ellie/transport";
import { identifier, record } from "@ellie/protocol";
import { BrowserAuth, browserInvitationSpec, browserOrigin } from "./browser-auth.ts";
import type { NativeAuth } from "./native-auth.ts";
import type { HouseholdState } from "./household-state.ts";
import type { NativeSpeech } from "./native-speech.ts";
import type { NativeLifeAuthority } from "./native-life.ts";

const MAX_BROWSER_MANAGEMENT_BODY_BYTES = 4096;
const paths = new Set([
  "/v1/browser",
  "/v1/browser/invitations",
  "/v1/browser/clients",
  "/v1/browser/revoke",
]);
const unavailableReasons = new Set<BrowserUnavailableReason>([
  "identity_unavailable",
  "assets_unavailable",
  "auth_unavailable",
  "listener_unavailable",
]);

export type BrowserUnavailableReason =
  | "identity_unavailable"
  | "assets_unavailable"
  | "auth_unavailable"
  | "listener_unavailable";

export type BrowserControlSnapshot =
  | {
      status: "ready";
      origin: string;
      auth: BrowserAuth;
      nativeAuth?: NativeAuth;
      household?: HouseholdState;
      speech?: NativeSpeech;
      nativeLife?: NativeLifeAuthority;
      certificateSha256?: string;
    }
  | { status: "disabled" }
  | { status: "unavailable"; reason: BrowserUnavailableReason };

export interface BrowserControl {
  current(): BrowserControlSnapshot;
}

export interface BrowserManagementResponse {
  status: number;
  body: unknown;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  }
  return values;
}

function isJson(request: IncomingMessage): boolean {
  const values = rawHeaderValues(request, "content-type");
  return (
    values.length === 1 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(values[0]!)
  );
}

function unavailable(): BrowserManagementResponse {
  return { status: 503, body: { error: "Browser management is unavailable." } };
}

function snapshot(control?: BrowserControl): BrowserControlSnapshot {
  if (!control) return { status: "disabled" };
  try {
    const current = control.current();
    if (current.status === "disabled") return { status: "disabled" };
    if (current.status === "unavailable")
      return unavailableReasons.has(current.reason)
        ? { status: "unavailable", reason: current.reason }
        : { status: "unavailable", reason: "listener_unavailable" };
    return { ...current, origin: browserOrigin(current.origin).origin };
  } catch {
    return { status: "unavailable", reason: "listener_unavailable" };
  }
}

async function body(
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; response: BrowserManagementResponse }> {
  if (!isJson(request))
    return { ok: false, response: { status: 415, body: { error: "JSON required." } } };
  try {
    return { ok: true, value: await readJson(request, MAX_BROWSER_MANAGEMENT_BODY_BYTES) };
  } catch {
    return {
      ok: false,
      response: { status: 400, body: { error: "Invalid browser management request." } },
    };
  }
}

export async function handleBrowserManagement(
  request: IncomingMessage,
  path: string,
  identityRole: "controller" | "node",
  control?: BrowserControl,
): Promise<BrowserManagementResponse | undefined> {
  if (!paths.has(path)) return undefined;
  if (identityRole !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };

  const current = snapshot(control);
  if (request.method === "GET" && path === "/v1/browser") {
    if (current.status === "ready") {
      try {
        current.auth.listClients();
      } catch {
        return { status: 200, body: { status: "unavailable", reason: "auth_unavailable" } };
      }
      return { status: 200, body: { status: "ready", origin: current.origin } };
    }
    return { status: 200, body: current };
  }
  if (current.status !== "ready") return unavailable();

  if (request.method === "GET" && path === "/v1/browser/clients") {
    try {
      return { status: 200, body: current.auth.listClients() };
    } catch {
      return unavailable();
    }
  }

  if (request.method === "POST" && path === "/v1/browser/invitations") {
    const parsed = await body(request);
    if (!parsed.ok) return parsed.response;
    let invitation;
    try {
      invitation = browserInvitationSpec(parsed.value);
    } catch {
      return { status: 400, body: { error: "Invalid browser invitation." } };
    }
    try {
      return { status: 200, body: await current.auth.invite(invitation) };
    } catch {
      return unavailable();
    }
  }

  if (request.method === "POST" && path === "/v1/browser/revoke") {
    const parsed = await body(request);
    if (!parsed.ok) return parsed.response;
    let id: string;
    try {
      const value = record(parsed.value);
      if (!exactKeys(value, ["id"])) throw new Error();
      id = identifier(value.id);
    } catch {
      return { status: 400, body: { error: "Invalid browser client ID." } };
    }
    try {
      return { status: 200, body: { ok: true, revoked: await current.auth.revoke(id) } };
    } catch {
      return unavailable();
    }
  }

  return { status: 404, body: { error: "Browser management route not found." } };
}
