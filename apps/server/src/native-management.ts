import type { IncomingMessage } from "node:http";
import { readJson } from "@ellie/transport";
import {
  identifier,
  nativeGrants,
  nativeLabel,
  nativePairingPayload,
  nativePairingQr,
  record,
} from "@ellie/protocol";
import type { BrowserControl } from "./browser-management.ts";

const paths = new Set(["/v1/native/invitations", "/v1/native/clients", "/v1/native/revoke"]);
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));
function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  return values;
}
const isJson = (request: IncomingMessage): boolean => {
  const values = rawHeaderValues(request, "content-type");
  return (
    values.length === 1 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(values[0]!)
  );
};

export async function handleNativeManagement(
  request: IncomingMessage,
  path: string,
  identityRole: "controller" | "node",
  control?: BrowserControl,
): Promise<{ status: number; body: unknown } | undefined> {
  if (!paths.has(path)) return undefined;
  if (identityRole !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };
  let current: ReturnType<BrowserControl["current"]> | undefined;
  try {
    current = control?.current();
  } catch {
    return { status: 503, body: { error: "Native enrollment unavailable." } };
  }
  if (current?.status !== "ready" || !current.nativeAuth || !current.certificateSha256)
    return { status: 503, body: { error: "Native enrollment unavailable." } };

  if (request.method === "GET" && path === "/v1/native/clients") {
    try {
      return { status: 200, body: current.nativeAuth.listClients() };
    } catch {
      return { status: 503, body: { error: "Native enrollment unavailable." } };
    }
  }
  if (request.method === "POST" && !isJson(request))
    return { status: 415, body: { error: "JSON required." } };
  if (request.method === "POST" && path === "/v1/native/invitations") {
    let invitation: { label: string; grants: ReturnType<typeof nativeGrants> };
    try {
      const body = record(await readJson(request, 4096));
      if (!exactKeys(body, ["label", "grants"])) throw new Error();
      invitation = { label: nativeLabel(body.label), grants: nativeGrants(body.grants) };
      nativePairingQr({
        version: 1,
        origin: current.origin,
        certificateSha256: current.certificateSha256,
        invitation: "0".repeat(64),
        expiresAt: Number.MAX_SAFE_INTEGER,
        label: invitation.label,
        grants: invitation.grants,
      });
    } catch {
      return { status: 400, body: { error: "Native invitation rejected." } };
    }
    try {
      const issued = await current.nativeAuth.invite(invitation);
      return {
        status: 200,
        body: nativePairingPayload({
          version: 1,
          origin: current.origin,
          certificateSha256: current.certificateSha256,
          invitation: issued.code,
          expiresAt: issued.expiresAt,
          label: issued.label,
          grants: issued.grants,
        }),
      };
    } catch {
      return { status: 503, body: { error: "Native enrollment unavailable." } };
    }
  }
  if (request.method === "POST" && path === "/v1/native/revoke") {
    let id: string;
    try {
      const body = record(await readJson(request, 4096));
      if (!exactKeys(body, ["id"])) throw new Error();
      id = identifier(body.id);
    } catch {
      return { status: 400, body: { error: "Native revocation rejected." } };
    }
    try {
      return { status: 200, body: { ok: true, revoked: await current.nativeAuth.revoke(id) } };
    } catch {
      return { status: 503, body: { error: "Native enrollment unavailable." } };
    }
  }
  return { status: 404, body: { error: "Native management route not found." } };
}
