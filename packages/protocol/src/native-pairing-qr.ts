import { NATIVE_SESSION_CONTRACT } from "./native-session-contract.ts";
import type { Capability } from "./operations.ts";

export const NATIVE_PAIRING_QR_PREFIX = "ellie-native:v1:";
export const MAX_NATIVE_PAIRING_QR_BYTES = 2300;
export const NATIVE_INVITATION_TTL_MS = NATIVE_SESSION_CONTRACT.invitationLifetimeMs;
const TOKEN = /^[a-f0-9]{64}$/;
const PIN = /^[a-f0-9]{64}$/;

export interface NativeGrant {
  target: string;
  capabilities: Capability[];
}

export interface NativePairingPayload {
  version: 1;
  origin: string;
  certificateSha256: string;
  invitation: string;
  expiresAt: number;
  label: string;
  grants: NativeGrant[];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value))
    throw new Error();
  return value;
}

export function nativeOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid native origin.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  )
    throw new Error("Invalid native origin.");
  return url.origin;
}

export function nativeLabel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    [...value].length < 1 ||
    [...value].length > 64 ||
    /\p{C}/u.test(value)
  )
    throw new Error("Invalid native label.");
  return value;
}

export function nativeGrants(value: unknown): NativeGrant[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16)
    throw new Error("Invalid native grants.");
  const grants = value.map((item) => {
    const grant = record(item);
    if (!exactKeys(grant, ["target", "capabilities"])) throw new Error("Invalid native grant.");
    const checked = Array.isArray(grant.capabilities)
      ? ([...new Set(grant.capabilities)] as unknown[])
      : [];
    const allowed: Capability[] = ["app.open", "browser.read", "browser.control"];
    if (
      checked.length < 1 ||
      checked.length > allowed.length ||
      checked.some((capability) => !allowed.includes(capability as Capability)) ||
      !Array.isArray(grant.capabilities) ||
      grant.capabilities.length !== checked.length
    )
      throw new Error("Invalid native grant.");
    return { target: identifier(grant.target), capabilities: checked as Capability[] };
  });
  if (new Set(grants.map((grant) => grant.target)).size !== grants.length)
    throw new Error("Invalid native grants.");
  return grants;
}

export function nativePairingPayload(value: unknown): NativePairingPayload {
  const payload = record(value);
  if (
    !exactKeys(payload, [
      "version",
      "origin",
      "certificateSha256",
      "invitation",
      "expiresAt",
      "label",
      "grants",
    ]) ||
    payload.version !== 1 ||
    typeof payload.certificateSha256 !== "string" ||
    !PIN.test(payload.certificateSha256) ||
    typeof payload.invitation !== "string" ||
    !TOKEN.test(payload.invitation) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    Number(payload.expiresAt) < 0
  )
    throw new Error("Invalid native pairing payload.");
  return {
    version: 1,
    origin: nativeOrigin(payload.origin),
    certificateSha256: payload.certificateSha256,
    invitation: payload.invitation,
    expiresAt: payload.expiresAt as number,
    label: nativeLabel(payload.label),
    grants: nativeGrants(payload.grants),
  };
}

export function nativePairingQr(value: unknown): string {
  const payload = nativePairingPayload(value);
  const canonical = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(canonical);
  const encoded =
    NATIVE_PAIRING_QR_PREFIX +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  if (encoded.length > MAX_NATIVE_PAIRING_QR_BYTES)
    throw new Error("Native pairing payload is too large.");
  return encoded;
}

export function parseNativePairingQr(value: unknown): NativePairingPayload | undefined {
  if (
    typeof value !== "string" ||
    value.length > MAX_NATIVE_PAIRING_QR_BYTES ||
    !value.startsWith(NATIVE_PAIRING_QR_PREFIX)
  )
    return undefined;
  try {
    const encoded = value.slice(NATIVE_PAIRING_QR_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (decoded.length > 4096) return undefined;
    const payload = nativePairingPayload(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded)),
    );
    if (nativePairingQr(payload).slice(NATIVE_PAIRING_QR_PREFIX.length) !== encoded)
      return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
