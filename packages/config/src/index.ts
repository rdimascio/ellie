import { mkdir, readFile, writeFile, rename, lstat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { record, identifier, string, installedModels } from "@ellie/protocol";
import type { InstalledModel } from "@ellie/protocol";
import { defaults } from "./defaults.ts";
import type { Preferences } from "./defaults.ts";

export { defaults } from "./defaults.ts";
export type { Preferences } from "./defaults.ts";
export const stateDir = join(homedir(), ".ellie");
export interface ServerConfig {
  version: 1;
  host: string;
  port: number;
  preferences: Preferences;
}
export interface InferenceWorkerConfig {
  endpoint: string;
  models: InstalledModel[];
}
export interface NodeConfig {
  version: 1;
  id: string;
  serverUrl: string;
  preferences: Preferences;
  executionEnabled: boolean;
  inferenceWorker?: InferenceWorkerConfig;
}
export function inferenceWorkerConfig(value: unknown): InferenceWorkerConfig {
  const v = record(value);
  const endpoint = new URL(string(v.endpoint));
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Inference endpoint must be a literal loopback HTTP(S) origin.");
  return { endpoint: endpoint.origin, models: installedModels(v.models) };
}

export async function ensureState(dir = stateDir): Promise<void> {
  // Never let a private state directory resolve inside the source checkout.
  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const rel = relative(resolve(checkout), resolve(dir));
  if (!rel.startsWith("..") && !rel.startsWith("/"))
    throw new Error("Private state must live outside the checkout.");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error("Private state cannot be a symlink.");
  await chmod(dir, 0o700);
}
export async function save(name: string, value: unknown, dir = stateDir): Promise<void> {
  identifier(name);
  await ensureState(dir);
  const temp = join(dir, `${name}.${randomBytes(8).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temp, join(dir, name));
}
export async function load<T>(name: string, dir = stateDir): Promise<T> {
  identifier(name);
  return JSON.parse(await readFile(join(dir, name), "utf8")) as T;
}
export function preferences(value: unknown): Preferences {
  const v = record(value);
  const apps = record(v.apps);
  const sites = record(v.sites);
  for (const [name, bundle] of Object.entries(apps)) {
    if (!/^[a-z0-9 -]{1,50}$/.test(name)) throw new Error("Invalid app alias.");
    identifier(bundle);
  }
  for (const [name, address] of Object.entries(sites)) {
    if (!/^[a-z0-9 -]{1,50}$/.test(name)) throw new Error("Invalid site alias.");
    const url = new URL(string(address));
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Invalid site URL.");
  }
  return {
    personality: identifier(v.personality),
    browser: identifier(v.browser),
    apps: { ...apps } as Record<string, string>,
    sites: { ...sites } as Record<string, string>,
  };
}
export function serverConfig(value: unknown): ServerConfig {
  const v = record(value);
  if (v.version !== 1 || !Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535)
    throw new Error("Invalid server configuration.");
  return {
    version: 1,
    host: string(v.host, 255),
    port: v.port as number,
    preferences: preferences(v.preferences),
  };
}
export function serverUrl(value: unknown): string {
  const url = new URL(string(value));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use an HTTPS server origin, without credentials or a path.");
  return url.origin;
}
export function nodeConfig(value: unknown): NodeConfig {
  const v = record(value);
  if (v.version !== 1) throw new Error("Unsupported configuration version.");
  if (v.executionEnabled !== undefined && typeof v.executionEnabled !== "boolean")
    throw new Error("Invalid execution setting.");
  return {
    version: 1,
    id: identifier(v.id),
    serverUrl: serverUrl(v.serverUrl),
    preferences: preferences(v.preferences),
    executionEnabled: v.executionEnabled !== false,
    ...(v.inferenceWorker === undefined
      ? {}
      : { inferenceWorker: inferenceWorkerConfig(v.inferenceWorker) }),
  };
}
export interface SecretStore {
  get(account: string): Promise<string>;
  set(account: string, value: string): Promise<void>;
}
export class Keychain implements SecretStore {
  async call(request: Record<string, string>): Promise<string> {
    if (process.platform !== "darwin")
      throw new Error("Keychain requires macOS. Tests use an explicit in-memory store.");
    return new Promise((resolve, reject) => {
      const child = spawn(join(stateDir, "bin", "ellie-macos"), [], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Keychain request timed out."));
      }, 60_000);
      child.stdout.on("data", (data) => {
        output += String(data);
        if (output.length > 65536) child.kill();
      });
      child.stderr.resume();
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("Build the macOS helper first: bun run build:macos"));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        try {
          if (code !== 0)
            throw new Error(
              "Keychain access failed. Unlock the login keychain and allow the helper.",
            );
          resolve(String(record(JSON.parse(output)).value ?? ""));
        } catch {
          reject(
            new Error("Keychain access failed. Unlock the login keychain and allow the helper."),
          );
        }
      });
      child.stdin.on("error", () => {});
      // Secrets are passed over stdin, never shell arguments or environment variables.
      child.stdin.end(JSON.stringify(request));
    });
  }
  get(account: string): Promise<string> {
    return this.call({ command: "keychain.get", account });
  }
  async set(account: string, value: string): Promise<void> {
    await this.call({ command: "keychain.set", account, value });
  }
}
