import {
  householdAccess,
  householdGrant,
  householdKind,
  householdProfile,
  HOUSEHOLD_CONTRACT,
  identifier,
  record,
} from "@ellie/protocol";

interface Client {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}
export type HouseholdCommand =
  | { action: "list" }
  | {
      action: "grant";
      clientId: string;
      profile: "shared" | "private";
      kind: "dashboards" | "chores";
      access: "read" | "write";
    }
  | {
      action: "revoke";
      clientId: string;
      profile: "shared" | "private";
      kind: "dashboards" | "chores";
    };
const usage =
  "Use: bun run ellie household grants | grant CLIENT PROFILE KIND ACCESS | revoke CLIENT PROFILE KIND";
export function parseHouseholdCommand(args: string[]): HouseholdCommand {
  try {
    if (args.length === 1 && args[0] === "grants") return { action: "list" };
    if (args.length === 5 && args[0] === "grant")
      return {
        action: "grant",
        clientId: identifier(args[1]),
        profile: householdProfile(args[2]),
        kind: householdKind(args[3]),
        access: householdAccess(args[4]),
      };
    if (args.length === 4 && args[0] === "revoke")
      return {
        action: "revoke",
        clientId: identifier(args[1]),
        profile: householdProfile(args[2]),
        kind: householdKind(args[3]),
      };
  } catch {}
  throw new Error(usage);
}
export async function runHouseholdCommand(
  client: Client,
  command: HouseholdCommand,
): Promise<string> {
  if (command.action === "list") {
    const result = record(await client.call("GET", "/v1/household/authorities"));
    if (
      Object.keys(result).length !== 1 ||
      !Array.isArray(result.grants) ||
      result.grants.length > HOUSEHOLD_CONTRACT.maximumAuthorities
    )
      throw new Error("Invalid household authority list.");
    const grants = result.grants.map(householdGrant);
    const keys = grants.map(({ clientId, profile, kind }) => `${clientId}\0${profile}\0${kind}`);
    if (new Set(keys).size !== keys.length) throw new Error("Invalid household authority list.");
    return JSON.stringify(grants, null, 2);
  }
  if (command.action === "grant") {
    const { action: _action, ...grant } = command;
    const checked = householdGrant(grant);
    try {
      const result = record(await client.call("POST", "/v1/household/authorities", checked));
      if (
        Object.keys(result).length !== 2 ||
        result.ok !== true ||
        JSON.stringify(householdGrant(result.grant)) !== JSON.stringify(checked)
      )
        throw new Error();
      return "Household data grant saved.";
    } catch {
      throw new Error(
        "Household data grant was not confirmed. Run household grants before retrying.",
      );
    }
  }
  try {
    const result = record(
      await client.call("POST", "/v1/household/authorities/revoke", {
        clientId: command.clientId,
        profile: command.profile,
        kind: command.kind,
      }),
    );
    if (
      Object.keys(result).length !== 2 ||
      result.ok !== true ||
      typeof result.revoked !== "boolean"
    )
      throw new Error();
    return result.revoked
      ? "Household data grant revoked."
      : "Household data grant was not active.";
  } catch {
    throw new Error(
      "Household revocation was not confirmed. Run household grants before retrying.",
    );
  }
}
