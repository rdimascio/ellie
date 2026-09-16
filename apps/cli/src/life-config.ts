import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { identifier, record } from "@ellie/protocol";
import { loadGoogleClient } from "../../life/src/google-client.ts";
import { validateLocalModelConfiguration } from "../../life/src/model-status.ts";
import type { HostLifeApplication } from "../../server/src/native-life.ts";

const MAX = 64 * 1024;
const CHECKOUT = realpathSync(resolve(fileURLToPath(new URL("../../..", import.meta.url))));
const within = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
function isPrivateConfigFile(value: Stats): boolean {
  return (
    !value.isSymbolicLink() &&
    value.isFile() &&
    value.nlink === 1 &&
    (value.mode & 0o777) === 0o600 &&
    (!process.getuid || value.uid === process.getuid()) &&
    value.size >= 2 &&
    value.size <= MAX
  );
}
function canonicalCandidate(path: string): string {
  let ancestor = path;
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  return join(realpathSync(ancestor), path.slice(ancestor.length).replace(/^[/\\]+/, ""));
}
export interface LifeHostConfig {
  version: 1;
  stateDir: string;
  actorId: string;
  modelUrl?: string;
  model?: string;
  googleOAuthClientFile?: string;
}

export function createLifeActivationGate() {
  let active: HostLifeApplication | undefined;
  return {
    application: {
      async handle(request, response, context) {
        if (active) return active.handle(request, response, context);
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ error: "Ellie Life is starting." }));
        return true;
      },
      async openOwnerSettings() {
        return active ? active.openOwnerSettings() : "unavailable";
      },
    } satisfies HostLifeApplication,
    activate(application: HostLifeApplication) {
      if (active) throw new Error("Ellie Life is already active.");
      active = application;
    },
  };
}

export function lifeConfigPath(args: string[], environment: NodeJS.ProcessEnv): string | undefined {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--life-config"))
    throw new Error(
      "Use: bun run ellie server start [--life-config /absolute/private/config.json]",
    );
  const index = args.indexOf("--life-config"),
    fromFlag = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!fromFlag || !isAbsolute(fromFlag)))
    throw new Error("Life config path must be absolute.");
  const fromEnvironment = environment.ELLIE_LIFE_CONFIG;
  if (fromFlag && fromEnvironment !== undefined)
    throw new Error("Choose either --life-config or ELLIE_LIFE_CONFIG, not both.");
  const selected = fromFlag ?? fromEnvironment;
  if (selected !== undefined && (!selected || !isAbsolute(selected)))
    throw new Error("Life config path must be absolute.");
  return selected;
}

export function loadLifeHostConfig(
  path: string,
): LifeHostConfig & { googleOAuth?: { clientId: string; clientSecret?: string } } {
  const absolute = resolve(path),
    before = lstatSync(absolute);
  const privateService = canonicalCandidate(resolve(homedir(), ".ellie"));
  const canonical = realpathSync(absolute);
  if (within(canonical, CHECKOUT) || within(canonical, privateService))
    throw new Error("Life config must be outside the source checkout and ~/.ellie.");
  if (!isPrivateConfigFile(before))
    throw new Error("Life config must be a private 0600 host file.");
  const descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (!isPrivateConfigFile(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Life config changed while opening.");
    const bounded = Buffer.allocUnsafe(MAX + 1),
      count = readSync(descriptor, bounded, 0, bounded.length, 0);
    if (count > MAX) throw new Error("Life config exceeds 64 KiB.");
    bytes = bounded.subarray(0, count);
    const after = fstatSync(descriptor);
    const rebound = lstatSync(absolute);
    if (
      !isPrivateConfigFile(after) ||
      !isPrivateConfigFile(rebound) ||
      after.size !== bytes.length ||
      after.mtimeMs !== opened.mtimeMs ||
      rebound.dev !== opened.dev ||
      rebound.ino !== opened.ino
    )
      throw new Error("Life config changed while reading.");
  } finally {
    closeSync(descriptor);
  }
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new Error("Life config is invalid.");
  }
  const keys = ["version", "stateDir", "actorId", "modelUrl", "model", "googleOAuthClientFile"];
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.version !== 1 ||
    typeof value.stateDir !== "string" ||
    !isAbsolute(value.stateDir) ||
    typeof value.actorId !== "string"
  )
    throw new Error("Life config is invalid.");
  const result: LifeHostConfig & { googleOAuth?: { clientId: string; clientSecret?: string } } = {
    version: 1,
    stateDir: value.stateDir,
    actorId: identifier(value.actorId),
  };
  if (within(canonicalCandidate(result.stateDir), privateService))
    throw new Error("Life state must not use ~/.ellie.");
  if (value.modelUrl !== undefined || value.model !== undefined) {
    if (typeof value.modelUrl !== "string" || typeof value.model !== "string")
      throw new Error("Life model config is invalid.");
    validateLocalModelConfiguration({ endpoint: value.modelUrl, model: value.model });
    result.modelUrl = value.modelUrl;
    result.model = value.model;
  }
  if (value.googleOAuthClientFile !== undefined) {
    if (typeof value.googleOAuthClientFile !== "string" || !isAbsolute(value.googleOAuthClientFile))
      throw new Error("Google OAuth client path must be absolute.");
    result.googleOAuthClientFile = value.googleOAuthClientFile;
    result.googleOAuth = loadGoogleClient(value.googleOAuthClientFile);
  }
  return result;
}
