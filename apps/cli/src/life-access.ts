import { identifier, record } from "@ellie/protocol";
import { nativeLifeAuthorityGrants, nativeLifeGrant } from "../../server/src/native-life.ts";

interface Client {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}
export type LifeAccessCommand =
  | { action: "list" }
  | { action: "grant"; clientId: string; actorId: string }
  | { action: "revoke"; clientId: string };
const usage = "Use: bun run ellie life-access grants | grant CLIENT ACTOR | revoke CLIENT";
export function parseLifeAccessCommand(args: string[]): LifeAccessCommand {
  try {
    if (args.length === 1 && args[0] === "grants") return { action: "list" };
    if (args.length === 3 && args[0] === "grant")
      return { action: "grant", clientId: identifier(args[1]), actorId: identifier(args[2]) };
    if (args.length === 2 && args[0] === "revoke")
      return { action: "revoke", clientId: identifier(args[1]) };
  } catch {}
  throw new Error(usage);
}
export async function runLifeAccessCommand(
  client: Client,
  command: LifeAccessCommand,
): Promise<string> {
  if (command.action === "list") {
    const result = record(await client.call("GET", "/v1/life/authorities"));
    if (Object.keys(result).length !== 1) throw new Error("Invalid Life authority list.");
    return JSON.stringify(nativeLifeAuthorityGrants(result.grants), null, 2);
  }
  if (command.action === "grant") {
    const grant = nativeLifeGrant({
      clientId: command.clientId,
      actorId: command.actorId,
      capability: "life.account",
    });
    try {
      const result = record(await client.call("POST", "/v1/life/authorities", grant));
      if (Object.keys(result).length !== 2 || result.ok !== true) {
        throw new Error();
      }
      const saved = nativeLifeAuthorityGrants([result.grant])[0]!;
      if (
        saved.clientId !== grant.clientId ||
        saved.actorId !== grant.actorId ||
        saved.capability !== grant.capability
      )
        throw new Error();
      return "Life account access granted.";
    } catch {
      throw new Error(
        "Life access grant was not confirmed. Run life-access grants before retrying.",
      );
    }
  }
  try {
    const result = record(
      await client.call("POST", "/v1/life/authorities/revoke", { clientId: command.clientId }),
    );
    if (
      Object.keys(result).length !== 2 ||
      result.ok !== true ||
      typeof result.revoked !== "boolean"
    )
      throw new Error();
    return result.revoked ? "Life account access revoked." : "Life account access was not active.";
  } catch {
    throw new Error(
      "Life access revocation was not confirmed. Run life-access grants before retrying.",
    );
  }
}
