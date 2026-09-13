import type { IncomingMessage, ServerResponse } from "node:http";
import {
  householdDocument,
  householdKind,
  householdProfile,
  HOUSEHOLD_CONTRACT,
  record,
} from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import type { NativeAuth } from "./native-auth.ts";
import { HouseholdState, HouseholdStateError } from "./household-state.ts";

type Reply = (status: number, body: unknown, headers?: Record<string, string>) => void;
const raw = (request: IncomingMessage, name: string) => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name)
      values.push(request.rawHeaders[index + 1] ?? "");
  return values;
};
const projection = (value: {
  profile: string;
  kind: string;
  revision: number;
  value: unknown;
}) => ({ profile: value.profile, kind: value.kind, revision: value.revision, value: value.value });
export async function handleNativeHousehold(
  request: IncomingMessage,
  _response: ServerResponse,
  path: string,
  auth: NativeAuth,
  state: HouseholdState,
  bearer: string,
  reply: Reply,
): Promise<boolean> {
  if (path === "/native/v1/household/authority" && request.method === "GET") {
    try {
      const result = await auth.withAuthenticated(bearer, (client) => state.list(client.id));
      if (!result) reply(401, { error: "Native session required." });
      else reply(200, { grants: result });
    } catch {
      reply(503, { error: "Household state unavailable." });
    }
    return true;
  }
  const match = /^\/native\/v1\/household\/(shared|private)\/(dashboards|chores)$/.exec(path);
  if (!match) return false;
  const profile = householdProfile(match[1]);
  const kind = householdKind(match[2]);
  try {
    if (request.method === "GET") {
      const result = await state.read(auth, bearer, profile, kind);
      if (!result.client) reply(401, { error: "Native session required." });
      else if (!result.document) reply(503, { error: "Household state unavailable." });
      else
        reply(200, projection(result.document), {
          etag: `"ellie-revision-${result.document.revision}"`,
        });
      return true;
    }
    if (request.method !== "PUT") return false;
    const matches = raw(request, "if-match");
    if (matches.length === 0) {
      reply(428, { error: "Household revision required." });
      return true;
    }
    if (matches.length !== 1) {
      reply(400, { error: "Invalid household revision." });
      return true;
    }
    const revision = /^"ellie-revision-(0|[1-9][0-9]*)"$/.exec(matches[0]!);
    if (!revision || !Number.isSafeInteger(Number(revision[1]))) {
      reply(400, { error: "Invalid household revision." });
      return true;
    }
    const maximum =
      kind === "dashboards"
        ? HOUSEHOLD_CONTRACT.maximumDashboardBytes
        : HOUSEHOLD_CONTRACT.maximumChoresBytes;
    let body: Record<string, unknown>;
    try {
      body = record(await readJson(request, maximum + 1024));
    } catch {
      throw new HouseholdStateError("invalid");
    }
    if (Object.keys(body).length !== 1 || !("value" in body))
      throw new HouseholdStateError("invalid");
    let value: unknown;
    try {
      value = householdDocument(kind, body.value);
    } catch {
      throw new HouseholdStateError("invalid");
    }
    const result = await state.write(auth, bearer, profile, kind, Number(revision[1]), value);
    if (!result.client) reply(401, { error: "Native session required." });
    else if (result.conflictRevision !== undefined)
      reply(412, { profile, kind, revision: result.conflictRevision });
    else if (result.document)
      reply(200, projection(result.document), {
        etag: `"ellie-revision-${result.document.revision}"`,
      });
    return true;
  } catch (error) {
    if (error instanceof HouseholdStateError && error.kind === "forbidden")
      reply(403, { error: "Household data access is not allowed." });
    else if (error instanceof HouseholdStateError && error.kind === "exhausted")
      reply(409, { error: "Household revision is exhausted." });
    else if (error instanceof HouseholdStateError && error.kind === "invalid")
      reply(400, { error: "Invalid household document." });
    else reply(503, { error: "Household state unavailable." });
    return true;
  }
}
