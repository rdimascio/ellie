import type { IncomingMessage } from "node:http";
import { householdGrant, record } from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import type { BrowserControl } from "./browser-management.ts";
import { HouseholdStateError } from "./household-state.ts";

const paths = new Set(["/v1/household/authorities", "/v1/household/authorities/revoke"]);
const rawHeaderValues = (request: IncomingMessage, name: string) =>
  request.rawHeaders.filter(
    (_value, index) => index % 2 === 1 && request.rawHeaders[index - 1]!.toLowerCase() === name,
  );
const isJson = (request: IncomingMessage) => {
  const values = rawHeaderValues(request, "content-type");
  return (
    values.length === 1 && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(values[0]!)
  );
};
export async function handleHouseholdManagement(
  request: IncomingMessage,
  path: string,
  role: "controller" | "node",
  control?: BrowserControl,
): Promise<{ status: number; body: unknown } | undefined> {
  if (!paths.has(path)) return undefined;
  const authorization = rawHeaderValues(request, "authorization");
  const versions = rawHeaderValues(request, "x-ellie-version");
  const hasForbiddenBrowserHeader = request.rawHeaders.some(
    (header, index) =>
      index % 2 === 0 &&
      (header.toLowerCase() === "origin" ||
        header.toLowerCase() === "cookie" ||
        header.toLowerCase().startsWith("sec-fetch-")),
  );
  if (authorization.length !== 1 || versions.length !== 1 || hasForbiddenBrowserHeader)
    return { status: 403, body: { error: "Household management request rejected." } };
  if (role !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };
  let current;
  try {
    current = control?.current();
  } catch {
    current = undefined;
  }
  if (current?.status !== "ready" || !current.nativeAuth || !current.household)
    return { status: 503, body: { error: "Household state unavailable." } };
  if (request.method === "GET" && path === "/v1/household/authorities") {
    try {
      return { status: 200, body: { grants: current.household.list() } };
    } catch {
      return { status: 503, body: { error: "Household state unavailable." } };
    }
  }
  if (request.method !== "POST")
    return { status: 404, body: { error: "Household route not found." } };
  if (!isJson(request)) return { status: 415, body: { error: "JSON required." } };
  try {
    const body = record(await readJson(request, 4096));
    if (path === "/v1/household/authorities") {
      const grant = householdGrant(body);
      const granted = await current.household.grant(current.nativeAuth, grant);
      return granted
        ? { status: 200, body: { ok: true, grant } }
        : { status: 404, body: { error: "Native client not found." } };
    }
    const keys = Object.keys(body);
    if (keys.length !== 3 || !keys.every((key) => ["clientId", "profile", "kind"].includes(key)))
      throw new Error();
    return { status: 200, body: { ok: true, revoked: await current.household.revoke(body) } };
  } catch (error) {
    if (error instanceof HouseholdStateError && error.kind === "unavailable")
      return { status: 503, body: { error: "Household state unavailable." } };
    return { status: 400, body: { error: "Household authority request rejected." } };
  }
}
