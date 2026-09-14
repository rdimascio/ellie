import type { IncomingMessage } from "node:http";
import { identifier, record } from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import type { BrowserControl } from "./browser-management.ts";
import { nativeLifeGrant, NativeLifeError } from "./native-life.ts";

const paths = new Set(["/v1/life/authorities", "/v1/life/authorities/revoke"]);
const header = (request: IncomingMessage, name: string) =>
  request.rawHeaders.filter(
    (_value, index) => index % 2 === 1 && request.rawHeaders[index - 1]!.toLowerCase() === name,
  );
const json = (request: IncomingMessage) => {
  const values = header(request, "content-type");
  return (
    values.length === 1 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(values[0]!)
  );
};

export async function handleLifeManagement(
  request: IncomingMessage,
  path: string,
  role: "controller" | "node",
  control?: BrowserControl,
): Promise<{ status: number; body: unknown } | undefined> {
  if (!paths.has(path)) return;
  const authorization = header(request, "authorization"),
    versions = header(request, "x-ellie-version"),
    forbiddenBrowserHeader = request.rawHeaders.some(
      (value, index) =>
        index % 2 === 0 &&
        (value.toLowerCase() === "origin" ||
          value.toLowerCase() === "cookie" ||
          value.toLowerCase().startsWith("sec-fetch-")),
    );
  if (authorization.length !== 1 || versions.length !== 1 || forbiddenBrowserHeader)
    return { status: 403, body: { error: "Life authority request rejected." } };
  if (role !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };
  let current;
  try {
    current = control?.current();
  } catch {
    current = undefined;
  }
  if (current?.status !== "ready" || !current.nativeAuth || !current.nativeLife)
    return { status: 503, body: { error: "Native Life authority unavailable." } };
  if (request.method === "GET" && path === "/v1/life/authorities")
    return { status: 200, body: { grants: current.nativeLife.list() } };
  if (request.method !== "POST")
    return { status: 404, body: { error: "Life authority route not found." } };
  if (!json(request)) return { status: 415, body: { error: "JSON required." } };
  try {
    const body = record(await readJson(request, 4096));
    if (path === "/v1/life/authorities") {
      const grant = nativeLifeGrant(body);
      if (!(await current.nativeLife.grant(grant)))
        return { status: 404, body: { error: "Native client not found." } };
      const saved = current.nativeLife.list(grant.clientId)[0];
      if (!saved) throw new NativeLifeError("unavailable");
      return { status: 200, body: { ok: true, grant: saved } };
    }
    if (Object.keys(body).length !== 1) throw new NativeLifeError("invalid");
    return {
      status: 200,
      body: { ok: true, revoked: await current.nativeLife.revoke(identifier(body.clientId)) },
    };
  } catch (error) {
    if (error instanceof NativeLifeError && error.kind === "forbidden")
      return { status: 403, body: { error: "Life actor is not configured on this host." } };
    if (error instanceof NativeLifeError && error.kind === "unavailable")
      return { status: 503, body: { error: "Native Life authority unavailable." } };
    return { status: 400, body: { error: "Life authority request rejected." } };
  }
}
