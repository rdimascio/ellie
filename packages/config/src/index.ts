import { mkdir, readFile, writeFile, rename, lstat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { record, identifier, string, installedModels } from "@ellie/protocol";
import type { InstalledModel } from "@ellie/protocol";
import { distributedMlxGroups } from "@ellie/protocol";
import type { DistributedMlxGroup } from "@ellie/protocol";
import { distributedWorkerConfig } from "./distributed.ts";
import type { DistributedWorkerConfig } from "./distributed.ts";
export { distributedWorkerConfig } from "./distributed.ts";
export type { DistributedWorkerConfig, LocalMlxGroup } from "./distributed.ts";
import { defaults } from "./defaults.ts";
import type { Preferences } from "./defaults.ts";

export { defaults } from "./defaults.ts";
export type { Preferences } from "./defaults.ts";
export const stateDir = join(homedir(), ".ellie");
export function nativeHelperPath(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackStateDir = stateDir,
): string {
  const packaged = environment.ELLIE_MACOS_HELPER;
  if (packaged !== undefined) {
    if (!isAbsolute(packaged)) throw new Error("The packaged native helper path is invalid.");
    return packaged;
  }
  return join(fallbackStateDir, "bin", "ellie-macos");
}
export interface ServerConfig {
  version: 1;
  host: string;
  port: number;
  preferences: Preferences;
  decisionRouting?: DecisionRoutingConfig;
  distributedGroups?: DistributedMlxGroup[];
}
export type DecisionRoutingConfig = {
  mode: "shadow" | "execute";
  timeoutMs: number;
  minProbability: number;
  minMargin: number;
} & (
  | { provider: "typesafe"; model: string; cloudDisclosure: true }
  | { provider: "gateway"; model: "typesafe-ai/jev"; cloudDisclosure: true }
  | { provider: "local"; model: string; endpoint: string }
);

/** Enabling a hosted provider explicitly permits disclosure of unmatched commands and routing context. */
export function decisionRoutingConfig(value: unknown): DecisionRoutingConfig {
  const v = record(value);
  if (v.mode !== "shadow" && v.mode !== "execute")
    throw new Error("Decision routing mode must be shadow or execute.");
  const timeoutMs = v.timeoutMs ?? 3000;
  const minProbability = v.minProbability ?? 0.98;
  const minMargin = v.minMargin ?? 0.2;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 10000)
    throw new Error("Decision routing timeout must be between 100 and 10000 milliseconds.");
  for (const threshold of [minProbability, minMargin])
    if (
      typeof threshold !== "number" ||
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1
    )
      throw new Error("Decision routing thresholds must be finite numbers between zero and one.");
  const common: Pick<DecisionRoutingConfig, "mode" | "timeoutMs" | "minProbability" | "minMargin"> =
    {
      mode: v.mode,
      timeoutMs: Number(timeoutMs),
      minProbability: Number(minProbability),
      minMargin: Number(minMargin),
    };
  if (v.provider === "typesafe") {
    if (v.cloudDisclosure !== true)
      throw new Error("TypeSafe decision routing requires explicit cloud disclosure opt-in.");
    return {
      ...common,
      provider: "typesafe",
      model: string(v.model ?? "jev-latest", 200),
      cloudDisclosure: true,
    };
  }
  if (v.provider === "gateway") {
    if (v.cloudDisclosure !== true)
      throw new Error("Gateway decision routing requires explicit cloud disclosure opt-in.");
    if (v.model !== undefined && v.model !== "typesafe-ai/jev")
      throw new Error("Gateway decision model must be typesafe-ai/jev.");
    return { ...common, provider: "gateway", model: "typesafe-ai/jev", cloudDisclosure: true };
  }
  if (v.provider === "local") {
    const rawEndpoint = string(v.endpoint);
    if (!/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/.test(rawEndpoint))
      throw new Error("Decision endpoint must be a literal loopback HTTP(S) origin.");
    const endpoint = new URL(rawEndpoint);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Decision endpoint must be a literal loopback HTTP(S) origin.");
    return { ...common, provider: "local", model: string(v.model, 200), endpoint: endpoint.origin };
  }
  throw new Error("Unsupported decision provider.");
}
export interface BrowserConfig {
  version: 1;
  hostname: string;
  port: 8444;
  createdAt: string;
  caFingerprint: string;
}
export function browserConfig(value: unknown): BrowserConfig {
  const v = record(value);
  const hostname = string(v.hostname, 69);
  if (
    v.version !== 1 ||
    v.port !== 8444 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.local$/.test(hostname) ||
    typeof v.createdAt !== "string" ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    typeof v.caFingerprint !== "string" ||
    !/^([A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(v.caFingerprint)
  )
    throw new Error("Invalid browser configuration.");
  return {
    version: 1,
    hostname,
    port: 8444,
    createdAt: v.createdAt,
    caFingerprint: v.caFingerprint,
  };
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
  distributedWorker?: DistributedWorkerConfig;
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
  const browser = identifier(v.browser);
  const siteBrowsers = v.siteBrowsers === undefined ? undefined : record(v.siteBrowsers);
  if (siteBrowsers)
    for (const [name, bundle] of Object.entries(siteBrowsers)) {
      if (!Object.hasOwn(sites, name)) throw new Error("Unknown site alias for a site browser.");
      // Only an already-configured application may be targeted, so a site override
      // cannot introduce a new bundle identifier.
      if (identifier(bundle) !== browser && !Object.values(apps).includes(bundle))
        throw new Error("Site browser must be a configured application.");
    }
  return {
    personality: identifier(v.personality),
    browser,
    apps: { ...apps } as Record<string, string>,
    sites: { ...sites } as Record<string, string>,
    ...(siteBrowsers ? { siteBrowsers: { ...siteBrowsers } as Record<string, string> } : {}),
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
    ...(v.distributedGroups === undefined
      ? {}
      : { distributedGroups: distributedMlxGroups(v.distributedGroups) }),
    ...(v.decisionRouting === undefined
      ? {}
      : { decisionRouting: decisionRoutingConfig(v.decisionRouting) }),
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
    ...(v.distributedWorker === undefined
      ? {}
      : { distributedWorker: distributedWorkerConfig(v.distributedWorker, identifier(v.id)) }),
    ...(v.inferenceWorker === undefined
      ? {}
      : { inferenceWorker: inferenceWorkerConfig(v.inferenceWorker) }),
  };
}
export interface SecretStore {
  get(account: string): Promise<string>;
  set(account: string, value: string): Promise<void>;
}
export interface MutableSecretStore extends SecretStore {
  has(account: string): Promise<boolean>;
  add(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}
export type KeychainFailureReason =
  | "timeout"
  | "helper_unavailable"
  | "access_unavailable"
  | "cleanup_uncertain";
export class KeychainFailure extends Error {
  readonly reason: KeychainFailureReason;
  constructor(reason: KeychainFailureReason) {
    super(
      reason === "timeout"
        ? "Keychain request timed out."
        : reason === "helper_unavailable"
          ? "Build the macOS helper first: bun run build:macos"
          : reason === "cleanup_uncertain"
            ? "Keychain helper cleanup could not be confirmed."
            : "Keychain access failed. Unlock the login keychain and allow the helper.",
    );
    this.name = "KeychainFailure";
    this.reason = reason;
  }
}
export class Keychain implements MutableSecretStore {
  protected spawnHelper(): ChildProcessWithoutNullStreams {
    return spawn(nativeHelperPath(), [], { stdio: ["pipe", "pipe", "pipe"] });
  }
  async call(request: Record<string, string>): Promise<string> {
    if (process.platform !== "darwin")
      throw new Error("Keychain requires macOS. Tests use an explicit in-memory store.");
    return new Promise((resolve, reject) => {
      const child = this.spawnHelper();
      const output: Buffer[] = [];
      let outputBytes = 0;
      let failure: KeychainFailureReason | undefined;
      let closed = false;
      let grace: NodeJS.Timeout | undefined;
      let reap: NodeJS.Timeout | undefined;
      const clearTimers = () => {
        clearTimeout(deadline);
        if (grace) clearTimeout(grace);
        if (reap) clearTimeout(reap);
      };
      const stop = (reason: KeychainFailureReason) => {
        if (closed || failure) return;
        failure = reason;
        clearTimeout(deadline);
        child.stdin.destroy();
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined)
          child.kill("SIGTERM");
        grace = setTimeout(() => {
          if (
            !closed &&
            child.exitCode === null &&
            child.signalCode === null &&
            child.pid !== undefined
          )
            child.kill("SIGKILL");
        }, 250);
        reap = setTimeout(() => {
          if (closed) return;
          // Keep the exact child and its close listener until it eventually closes.
          // A caller must never mistake an unreaped helper for a successful request.
          reject(new KeychainFailure("cleanup_uncertain"));
        }, 3_000);
      };
      const deadline = setTimeout(() => stop("timeout"), 60_000);
      child.stdout.on("data", (data: Buffer) => {
        if (closed || failure) return;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (outputBytes + chunk.length > 65_536) {
          stop("access_unavailable");
          return;
        }
        outputBytes += chunk.length;
        output.push(chunk);
      });
      child.stderr.resume();
      child.on("error", () => {
        stop("helper_unavailable");
      });
      child.on("close", (code) => {
        closed = true;
        clearTimers();
        if (failure) {
          reject(new KeychainFailure(failure));
          return;
        }
        try {
          if (code !== 0) throw new KeychainFailure("access_unavailable");
          resolve(
            String(
              record(JSON.parse(Buffer.concat(output, outputBytes).toString("utf8"))).value ?? "",
            ),
          );
        } catch {
          reject(new KeychainFailure("access_unavailable"));
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
  async has(account: string): Promise<boolean> {
    const value = await this.call({ command: "keychain.has", account });
    if (value !== "true" && value !== "false")
      throw new Error("Keychain returned an invalid presence response.");
    return value === "true";
  }
  async add(account: string, value: string): Promise<void> {
    await this.call({ command: "keychain.add", account, value });
  }
  async delete(account: string): Promise<void> {
    await this.call({ command: "keychain.delete", account });
  }
}
