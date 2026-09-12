import { capabilities, identifier, record } from "@ellie/protocol";
import type { Capability } from "@ellie/protocol";
import {
  BROWSER_INVITATION_TTL_MS,
  BROWSER_SESSION_TTL_MS,
  browserInvitationSpec,
  browserLabel,
  browserOrigin,
} from "../../server/src/browser-auth.ts";
import type {
  BrowserClient,
  BrowserInvitation,
  BrowserInvitationSpec,
} from "../../server/src/browser-auth.ts";
import type { BrowserUnavailableReason } from "../../server/src/browser-management.ts";

interface BrowserCommandClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}

export type BrowserCommand =
  | { action: "invite"; invitation: BrowserInvitationSpec }
  | { action: "clients" }
  | { action: "revoke"; id: string }
  | { action: "connection" };

type PublicBrowserStatus =
  | { status: "ready"; origin: string }
  | { status: "disabled" }
  | { status: "unavailable"; reason: BrowserUnavailableReason };

const reasons = new Set<BrowserUnavailableReason>([
  "identity_unavailable",
  "assets_unavailable",
  "auth_unavailable",
  "listener_unavailable",
]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function invitationCommand(args: string[]): BrowserCommand {
  const requestedRole = args[1];
  if (requestedRole !== "phone" && requestedRole !== "tv")
    throw new Error(
      "Use: bun run ellie browser invite phone|tv --label NAME [--node ID --allow CAPABILITIES]",
    );
  let label: string | undefined;
  let node: string | undefined;
  let allow: Capability[] | undefined;
  for (let index = 2; index < args.length; index++) {
    const option = args[index];
    if (option === "--label") {
      if (label !== undefined) throw new Error("Use --label only once.");
      label = browserLabel(optionValue(args, index, "--label"));
      index += 1;
    } else if (option === "--node") {
      if (node !== undefined) throw new Error("Use --node only once.");
      node = identifier(optionValue(args, index, "--node"));
      index += 1;
    } else if (option === "--allow") {
      if (allow !== undefined) throw new Error("Use --allow only once.");
      const values = optionValue(args, index, "--allow")
        .split(",")
        .map((value) => value.trim());
      allow = capabilities(values);
      if (allow.length !== values.length) throw new Error("Capabilities cannot be duplicated.");
      index += 1;
    } else {
      throw new Error(
        "Use: bun run ellie browser invite phone|tv --label NAME [--node ID --allow CAPABILITIES]",
      );
    }
  }
  if (!label) throw new Error("Browser invitations require --label NAME.");
  if (requestedRole === "tv") {
    if (node !== undefined || allow !== undefined)
      throw new Error("TV invitations are read-only and do not accept --node or --allow.");
    return {
      action: "invite",
      invitation: browserInvitationSpec({ role: "tv_viewer", label, grants: [] }),
    };
  }
  if (!node || !allow?.length)
    throw new Error("Phone invitations require explicit --node ID and --allow CAPABILITIES.");
  return {
    action: "invite",
    invitation: browserInvitationSpec({
      role: "phone_controller",
      label,
      grants: [{ target: node, capabilities: allow }],
    }),
  };
}

export function parseBrowserCommand(args: string[]): BrowserCommand {
  if (args[0] === "invite") return invitationCommand(args);
  if (args[0] === "clients" && args.length === 1) return { action: "clients" };
  if (args[0] === "revoke" && args.length === 2)
    return { action: "revoke", id: identifier(args[1]) };
  if (args[0] === "connection" && args.length === 1) return { action: "connection" };
  throw new Error(
    "Use: bun run ellie browser invite phone|tv --label NAME [--node ID --allow CAPABILITIES] | clients | revoke ID | connection",
  );
}

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 8_640_000_000_000_000)
    throw new Error("The coordinator returned invalid browser management data.");
  return value as number;
}

function publicClient(value: unknown): BrowserClient {
  const item = record(value);
  if (!exactKeys(item, ["id", "role", "label", "grants", "createdAt", "expiresAt"]))
    throw new Error("The coordinator returned invalid browser management data.");
  const authority = browserInvitationSpec({
    role: item.role,
    label: item.label,
    grants: item.grants,
  });
  const createdAt = timestamp(item.createdAt);
  const expiresAt = timestamp(item.expiresAt);
  if (expiresAt - createdAt !== BROWSER_SESSION_TTL_MS)
    throw new Error("The coordinator returned invalid browser management data.");
  return { id: identifier(item.id), ...authority, createdAt, expiresAt };
}

function invitation(value: unknown): BrowserInvitation {
  const item = record(value);
  if (
    !exactKeys(item, ["id", "role", "label", "grants", "createdAt", "expiresAt", "code"]) ||
    typeof item.code !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.code)
  )
    throw new Error("The coordinator returned an invalid browser invitation.");
  const authority = browserInvitationSpec({
    role: item.role,
    label: item.label,
    grants: item.grants,
  });
  const createdAt = timestamp(item.createdAt);
  const expiresAt = timestamp(item.expiresAt);
  if (expiresAt - createdAt !== BROWSER_INVITATION_TTL_MS)
    throw new Error("The coordinator returned an invalid browser invitation.");
  return { id: identifier(item.id), ...authority, createdAt, expiresAt, code: item.code };
}

function browserStatus(value: unknown): PublicBrowserStatus {
  const status = record(value);
  if (
    status.status === "ready" &&
    exactKeys(status, ["status", "origin"]) &&
    typeof status.origin === "string"
  )
    return { status: "ready", origin: browserOrigin(status.origin).origin };
  if (status.status === "disabled" && exactKeys(status, ["status"])) return { status: "disabled" };
  if (
    status.status === "unavailable" &&
    exactKeys(status, ["status", "reason"]) &&
    reasons.has(status.reason as BrowserUnavailableReason)
  )
    return { status: "unavailable", reason: status.reason as BrowserUnavailableReason };
  throw new Error("The coordinator returned invalid browser connection status.");
}

const recovery: Record<BrowserUnavailableReason, string> = {
  identity_unavailable:
    "Browser connection unavailable: run `bun run ellie browser status`, preserve the existing identity, and repair it before restarting the coordinator.",
  assets_unavailable:
    "Browser connection unavailable: run `bun run demo:build`, then restart the coordinator.",
  auth_unavailable:
    "Browser connection unavailable: stop the coordinator and preserve or recover its private browser authorization file before restarting.",
  listener_unavailable:
    "Browser connection unavailable: check whether port 8444 is available, then restart the coordinator.",
};

export async function runBrowserCommand(
  client: BrowserCommandClient,
  command: BrowserCommand,
): Promise<string[]> {
  if (command.action === "connection") {
    const status = browserStatus(await client.call("GET", "/v1/browser"));
    if (status.status === "ready") return [`Browser listener ready at ${status.origin}.`];
    if (status.status === "disabled")
      return [
        "Browser listener is disabled. Initialize browser setup, then restart the coordinator.",
      ];
    return [recovery[status.reason]];
  }
  if (command.action === "invite") {
    try {
      const issued = invitation(
        await client.call("POST", "/v1/browser/invitations", command.invitation),
      );
      if (
        issued.role !== command.invitation.role ||
        issued.label !== command.invitation.label ||
        JSON.stringify(issued.grants) !== JSON.stringify(command.invitation.grants)
      )
        throw new Error();
      return [
        `Browser invitation code: ${issued.code}`,
        `Role: ${issued.role}`,
        `Label: ${issued.label}`,
        `Expires: ${new Date(issued.expiresAt).toISOString()}`,
      ];
    } catch {
      throw new Error(
        "Browser invitation creation was not confirmed. Do not retry for 10 minutes; any unreceived invitation will have expired by then.",
      );
    }
  }
  if (command.action === "clients") {
    const value = await client.call("GET", "/v1/browser/clients");
    if (!Array.isArray(value) || value.length > 128)
      throw new Error("The coordinator returned invalid browser management data.");
    return [JSON.stringify(value.map(publicClient), null, 2)];
  }
  try {
    const response = record(await client.call("POST", "/v1/browser/revoke", { id: command.id }));
    if (
      !exactKeys(response, ["ok", "revoked"]) ||
      response.ok !== true ||
      typeof response.revoked !== "boolean"
    )
      throw new Error();
    return [
      response.revoked
        ? `Browser client ${command.id} revoked.`
        : `Browser client ${command.id} was not active.`,
    ];
  } catch {
    throw new Error(
      "Browser revocation was not confirmed. Run `bun run ellie browser clients` to inspect the active sessions before retrying.",
    );
  }
}
