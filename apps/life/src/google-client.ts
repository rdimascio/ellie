import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_CONFIG_BYTES = 64 * 1024;
const REPOSITORY_ROOT = realpathSync(resolve(fileURLToPath(new URL("../../..", import.meta.url))));
const MINIMAL_KEYS = new Set(["clientId", "clientSecret"]);
const INSTALLED_KEYS = new Set([
  "auth_provider_x509_cert_url",
  "auth_uri",
  "client_id",
  "client_secret",
  "project_id",
  "redirect_uris",
  "token_uri",
  "universe_domain",
]);

export interface GoogleClientConfig {
  clientId: string;
  clientSecret?: string;
}

function bounded(value: unknown, name: string, limit: number): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > limit ||
    value.trim() !== value
  )
    throw new Error(`${name} is invalid.`);
  return value;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function canonicalCoreStateRoot(): string {
  const root = resolve(homedir(), ".ellie");
  try {
    return realpathSync(root);
  } catch {
    return join(realpathSync(homedir()), ".ellie");
  }
}

/** Reads only a private host configuration. OAuth endpoints remain fixed in the OAuth helper. */
export function loadGoogleClient(path: string): GoogleClientConfig {
  if (!path || path.includes("\0")) throw new Error("Google OAuth client path is invalid.");
  const absolute = resolve(path);
  const coreStateRoot = resolve(homedir(), ".ellie");
  if (isWithin(coreStateRoot, absolute))
    throw new Error("Google OAuth client configuration must be stored outside ~/.ellie.");
  const canonical = join(realpathSync(dirname(absolute)), basename(absolute));
  if (isWithin(REPOSITORY_ROOT, canonical))
    throw new Error("Google OAuth client configuration must be stored outside the repository.");
  if (isWithin(canonicalCoreStateRoot(), canonical))
    throw new Error("Google OAuth client configuration must be stored outside ~/.ellie.");
  const pathStat = lstatSync(absolute);
  if (pathStat.isSymbolicLink())
    throw new Error("Google OAuth client configuration may not use symlinks.");

  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.dev !== pathStat.dev ||
      stat.ino !== pathStat.ino ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      stat.size < 2 ||
      stat.size > MAX_CONFIG_BYTES
    )
      throw new Error("Google OAuth client configuration must be a private 0600 host file.");
    bytes = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Google OAuth client configuration is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Google OAuth client configuration shape is invalid.");
  const root = parsed as Record<string, unknown>;
  let clientId: string | undefined, clientSecret: string | undefined;
  if ("installed" in root) {
    if (Object.keys(root).some((key) => key !== "installed"))
      throw new Error("Google OAuth client configuration must contain one installed client.");
    if (!root.installed || typeof root.installed !== "object" || Array.isArray(root.installed))
      throw new Error("Google OAuth installed client is invalid.");
    const installed = root.installed as Record<string, unknown>;
    if (Object.keys(installed).some((key) => !INSTALLED_KEYS.has(key)))
      throw new Error("Google OAuth installed client contains unsupported fields.");
    clientId = bounded(installed.client_id, "Google client id", 1_000);
    clientSecret = bounded(installed.client_secret, "Google client secret", 16_384);
  } else {
    if (Object.keys(root).some((key) => !MINIMAL_KEYS.has(key)))
      throw new Error("Google OAuth client configuration contains unsupported fields.");
    clientId = bounded(root.clientId, "Google client id", 1_000);
    clientSecret = bounded(root.clientSecret, "Google client secret", 16_384);
  }
  if (!clientId) throw new Error("Google OAuth client configuration has no client id.");
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}
