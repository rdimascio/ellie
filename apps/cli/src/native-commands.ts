import {
  type Capability,
  identifier,
  nativeGrants,
  nativeLabel,
  nativePairingPayload,
  nativePairingQr,
  record,
} from "@ellie/protocol";
import { terminalPairingQr } from "./browser-qr.ts";
import { NATIVE_SESSION_TTL_MS } from "../../server/src/native-auth.ts";

interface Client {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}
export type NativeCommand =
  | { action: "invite"; label: string; node: string; capabilities: Capability[] }
  | { action: "clients" }
  | { action: "revoke"; id: string };
const NATIVE_USAGE =
  "Use: bun run ellie native invite --label NAME --node ID --allow app.open[,browser.read,browser.control] | clients | revoke ID";
const NATIVE_CAPABILITY_ORDER: Capability[] = ["app.open", "browser.read", "browser.control"];
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
function publicClient(value: unknown) {
  const item = record(value);
  if (
    !exactKeys(item, ["id", "role", "label", "grants", "createdAt", "expiresAt"]) ||
    item.role !== "native_phone_controller" ||
    !Number.isSafeInteger(item.createdAt) ||
    !Number.isSafeInteger(item.expiresAt) ||
    Number(item.expiresAt) - Number(item.createdAt) !== NATIVE_SESSION_TTL_MS
  )
    throw new Error("Invalid native client list.");
  return {
    id: identifier(item.id),
    role: "native_phone_controller" as const,
    label: nativeLabel(item.label),
    grants: nativeGrants(item.grants),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

export function parseNativeCommand(args: string[]): NativeCommand {
  try {
    if (args[0] === "clients" && args.length === 1) return { action: "clients" };
    if (args[0] === "revoke" && args.length === 2)
      return { action: "revoke", id: identifier(args[1]) };
    if (args[0] === "invite") {
      let label: string | undefined;
      let node: string | undefined;
      let allow: Capability[] | undefined;
      for (let i = 1; i < args.length; i += 2) {
        const value = args[i + 1];
        if (!value) throw new Error();
        if (args[i] === "--label" && !label) label = nativeLabel(value);
        else if (args[i] === "--node" && !node) node = identifier(value);
        else if (args[i] === "--allow" && !allow) {
          const requested = value.split(",").map((capability) => capability.trim());
          const checked = nativeGrants([
            { target: node ?? "pending", capabilities: requested },
          ])[0]!;
          allow = NATIVE_CAPABILITY_ORDER.filter((capability) =>
            checked.capabilities.includes(capability),
          );
        } else throw new Error();
      }
      if (label && node && allow?.length)
        return { action: "invite", label, node, capabilities: allow };
    }
  } catch {
    // All command-shape and value failures use the same actionable local guidance.
  }
  throw new Error(NATIVE_USAGE);
}

export async function runNativeCommand(client: Client, command: NativeCommand): Promise<string[]> {
  if (command.action === "invite") {
    const requested = nativeGrants([
      { target: command.node, capabilities: command.capabilities },
    ])[0]!;
    const capabilities = NATIVE_CAPABILITY_ORDER.filter((capability) =>
      requested.capabilities.includes(capability),
    );
    if (capabilities.length !== requested.capabilities.length)
      throw new Error("Invalid native grants.");
    const grants = nativeGrants([{ target: command.node, capabilities }]);
    const label = nativeLabel(command.label);
    try {
      const payload = nativePairingPayload(
        await client.call("POST", "/v1/native/invitations", { label, grants }),
      );
      if (payload.label !== label || JSON.stringify(payload.grants) !== JSON.stringify(grants))
        throw new Error();
      return [
        "On the iPhone, confirm this coordinator origin and requested access before pairing:",
        await terminalPairingQr(nativePairingQr(payload)),
        `Origin: ${payload.origin}`,
        `Certificate SHA-256: ${payload.certificateSha256}`,
        `Label: ${payload.label}`,
        `Access: ${capabilities.join(", ")} on ${command.node}`,
        `Expires: ${new Date(payload.expiresAt).toISOString()}`,
      ];
    } catch {
      throw new Error(
        "Native invitation creation was not confirmed. Do not retry for 10 minutes; an unreceived invitation must expire first.",
      );
    }
  }
  if (command.action === "clients") {
    const value = await client.call("GET", "/v1/native/clients");
    if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid native client list.");
    return [JSON.stringify(value.map(publicClient), null, 2)];
  }
  try {
    const response = record(await client.call("POST", "/v1/native/revoke", { id: command.id }));
    if (
      response.ok !== true ||
      typeof response.revoked !== "boolean" ||
      Object.keys(response).length !== 2
    )
      throw new Error();
    return [
      response.revoked
        ? `Native client ${command.id} revoked.`
        : `Native client ${command.id} was not active.`,
    ];
  } catch {
    throw new Error("Native revocation was not confirmed. Run native clients before retrying.");
  }
}
