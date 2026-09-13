import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "@ellie/config";
import {
  identifier,
  nativeGrants,
  nativeLabel,
  record,
  NATIVE_SESSION_CONTRACT,
} from "@ellie/protocol";
import type { NativeGrant } from "@ellie/protocol";
import { TextDecoder } from "node:util";

export const NATIVE_AUTH_FILE = "native-auth.json";
export const NATIVE_AUTH_VERSION = 1;
export const NATIVE_INVITATION_TTL_MS = NATIVE_SESSION_CONTRACT.invitationLifetimeMs;
export const NATIVE_SESSION_TTL_MS = NATIVE_SESSION_CONTRACT.sessionLifetimeMs;
export const MAX_NATIVE_INVITATIONS = 32;
export const MAX_NATIVE_SESSIONS = 128;
const MAX_NATIVE_AUTH_BYTES = 1024 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

export class NativeAuthError extends Error {
  readonly kind: "rejected" | "unavailable";
  constructor(kind: "rejected" | "unavailable") {
    super(`Native authorization ${kind}.`);
    this.kind = kind;
  }
}

export interface NativeClient {
  id: string;
  role: "native_phone_controller";
  label: string;
  grants: NativeGrant[];
  createdAt: number;
  expiresAt: number;
}

interface StoredNativeCredential extends NativeClient {
  tokenHash: string;
}
export interface NativeAuthState {
  version: 1;
  invitations: StoredNativeCredential[];
  sessions: StoredNativeCredential[];
}
export interface NativeInvitation extends NativeClient {
  code: string;
}

const hash = (domain: "invitation" | "session", value: string): string =>
  createHash("sha256").update(`ellie-native-${domain}-v1\0`).update(value).digest("hex");
const equal = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key));
const publicClient = (value: StoredNativeCredential): NativeClient => ({
  id: value.id,
  role: value.role,
  label: value.label,
  grants: value.grants.map((grant) => ({
    target: grant.target,
    capabilities: [...grant.capabilities],
  })),
  createdAt: value.createdAt,
  expiresAt: value.expiresAt,
});

function stored(value: unknown, ttl: number): StoredNativeCredential {
  const item = record(value);
  if (
    !exactKeys(item, ["id", "role", "label", "grants", "createdAt", "expiresAt", "tokenHash"]) ||
    item.role !== "native_phone_controller" ||
    typeof item.tokenHash !== "string" ||
    !HASH.test(item.tokenHash) ||
    !Number.isSafeInteger(item.createdAt) ||
    !Number.isSafeInteger(item.expiresAt) ||
    Number(item.createdAt) < 0 ||
    Number(item.expiresAt) - Number(item.createdAt) !== ttl
  )
    throw new Error("Invalid native authorization state.");
  return {
    id: identifier(item.id),
    role: "native_phone_controller",
    label: nativeLabel(item.label),
    grants: nativeGrants(item.grants),
    createdAt: item.createdAt as number,
    expiresAt: item.expiresAt as number,
    tokenHash: item.tokenHash,
  };
}

export function nativeAuthState(value: unknown): NativeAuthState {
  const state = record(value);
  if (
    !exactKeys(state, ["version", "invitations", "sessions"]) ||
    state.version !== 1 ||
    !Array.isArray(state.invitations) ||
    state.invitations.length > MAX_NATIVE_INVITATIONS ||
    !Array.isArray(state.sessions) ||
    state.sessions.length > MAX_NATIVE_SESSIONS
  )
    throw new Error("Invalid native authorization state.");
  const invitations = state.invitations.map((item) => stored(item, NATIVE_INVITATION_TTL_MS));
  const sessions = state.sessions.map((item) => stored(item, NATIVE_SESSION_TTL_MS));
  const all = [...invitations, ...sessions];
  if (
    new Set(all.map((item) => item.id)).size !== all.length ||
    new Set(all.map((item) => item.tokenHash)).size !== all.length
  )
    throw new Error("Invalid native authorization state.");
  return { version: 1, invitations, sessions };
}

function prune(state: NativeAuthState, now: number): NativeAuthState {
  return {
    version: 1,
    invitations: state.invitations.filter((x) => x.expiresAt > now),
    sessions: state.sessions.filter((x) => x.expiresAt > now),
  };
}

export class NativeAuth {
  private state: NativeAuthState;
  private readonly persist: (state: NativeAuthState) => Promise<void>;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly id: () => string;
  private lock: Promise<void> = Promise.resolve();
  private poisoned = false;
  private closed = false;

  constructor(
    state: unknown,
    persist: (state: NativeAuthState) => Promise<void>,
    options: {
      now?: () => number;
      token?: () => string;
      id?: () => string;
    } = {},
  ) {
    this.state = nativeAuthState(state);
    this.persist = persist;
    this.now = options.now ?? Date.now;
    this.token = options.token ?? (() => randomBytes(32).toString("hex"));
    this.id = options.id ?? randomUUID;
  }

  static empty(): NativeAuthState {
    return { version: 1, invitations: [], sessions: [] };
  }
  static async openOrInitialize(dir = stateDir): Promise<NativeAuth> {
    await initializeNativeAuthState(dir);
    return new NativeAuth(await readNativeAuthState(dir), (state) =>
      writeNativeAuthState(state, dir),
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.lock;
  }
  private assertUsable(): void {
    if (this.closed || this.poisoned) throw new NativeAuthError("unavailable");
  }
  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      this.assertUsable();
      return await work();
    } finally {
      release();
    }
  }
  private async commit(next: NativeAuthState): Promise<void> {
    try {
      await this.persist(next);
    } catch {
      this.poisoned = true;
      throw new NativeAuthError("unavailable");
    }
  }
  private uniqueId(state: NativeAuthState): string {
    for (let i = 0; i < 4; i++) {
      const id = identifier(this.id());
      if (![...state.invitations, ...state.sessions].some((x) => x.id === id)) return id;
    }
    throw new Error("Native credential generation failed.");
  }
  private uniqueInvitation(state: NativeAuthState): string {
    for (let i = 0; i < 4; i++) {
      const token = this.token();
      if (!TOKEN.test(token)) throw new Error("Native credential generation failed.");
      if (
        ![...state.invitations].some((x) => equal(x.tokenHash, hash("invitation", token))) &&
        ![...state.sessions].some((x) => equal(x.tokenHash, hash("session", token)))
      )
        return token;
    }
    throw new Error("Native credential generation failed.");
  }

  async invite(value: unknown): Promise<NativeInvitation> {
    const spec = record(value);
    if (!exactKeys(spec, ["label", "grants"])) throw new Error("Invalid native invitation.");
    const label = nativeLabel(spec.label);
    const grants = nativeGrants(spec.grants);
    return this.mutate(async () => {
      const now = this.now();
      const current = prune(this.state, now);
      if (current.invitations.length >= MAX_NATIVE_INVITATIONS)
        throw new Error("Too many native invitations.");
      const code = this.uniqueInvitation(current);
      const item: StoredNativeCredential = {
        id: this.uniqueId(current),
        role: "native_phone_controller",
        label,
        grants,
        createdAt: now,
        expiresAt: now + NATIVE_INVITATION_TTL_MS,
        tokenHash: hash("invitation", code),
      };
      const next = { ...current, invitations: [...current.invitations, item] };
      await this.commit(next);
      this.state = next;
      return { ...publicClient(item), code };
    });
  }

  async pair(invitation: unknown, token: unknown): Promise<NativeClient> {
    if (
      typeof invitation !== "string" ||
      !TOKEN.test(invitation) ||
      typeof token !== "string" ||
      !TOKEN.test(token)
    )
      throw new NativeAuthError("rejected");
    return this.mutate(async () => {
      const now = this.now();
      const current = prune(this.state, now);
      const found = current.invitations.find((x) =>
        equal(x.tokenHash, hash("invitation", invitation)),
      );
      if (
        !found ||
        current.sessions.length >= MAX_NATIVE_SESSIONS ||
        current.invitations.some((x) => equal(x.tokenHash, hash("invitation", token))) ||
        current.sessions.some((x) => equal(x.tokenHash, hash("session", token)))
      )
        throw new NativeAuthError("rejected");
      const item: StoredNativeCredential = {
        ...publicClient(found),
        id: this.uniqueId(current),
        createdAt: now,
        expiresAt: now + NATIVE_SESSION_TTL_MS,
        tokenHash: hash("session", token),
      };
      const next = {
        version: 1 as const,
        invitations: current.invitations.filter((x) => x.id !== found.id),
        sessions: [...current.sessions, item],
      };
      await this.commit(next);
      this.state = next;
      return publicClient(item);
    });
  }

  authenticateBearer(header: unknown): NativeClient | undefined {
    this.assertUsable();
    if (typeof header !== "string" || !/^Bearer [a-f0-9]{64}$/.test(header)) return undefined;
    const token = header.slice(7);
    const now = this.now();
    const item = this.state.sessions.find(
      (x) => x.expiresAt > now && equal(x.tokenHash, hash("session", token)),
    );
    return item ? publicClient(item) : undefined;
  }
  listClients(): NativeClient[] {
    this.assertUsable();
    return prune(this.state, this.now()).sessions.map(publicClient);
  }
  async revoke(id: unknown): Promise<boolean> {
    const checked = identifier(id);
    return this.mutate(async () => {
      const current = prune(this.state, this.now());
      const sessions = current.sessions.filter((x) => x.id !== checked);
      if (sessions.length === current.sessions.length) return false;
      const next = { ...current, sessions };
      await this.commit(next);
      this.state = next;
      return true;
    });
  }
  async logout(header: unknown): Promise<boolean> {
    if (typeof header !== "string" || !/^Bearer [a-f0-9]{64}$/.test(header)) return false;
    const tokenHash = hash("session", header.slice(7));
    return this.mutate(async () => {
      const current = prune(this.state, this.now());
      const sessions = current.sessions.filter((x) => !equal(x.tokenHash, tokenHash));
      if (sessions.length === current.sessions.length) return false;
      const next = { ...current, sessions };
      await this.commit(next);
      this.state = next;
      return true;
    });
  }
}

async function initializeNativeAuthState(dir: string): Promise<void> {
  let temp: string | undefined;
  try {
    try {
      await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }
    const directory = await lstat(dir);
    assertPrivate(directory, "directory");
    const path = join(dir, NATIVE_AUTH_FILE);
    temp = join(dir, `.${NATIVE_AUTH_FILE}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(NativeAuth.empty(), null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await rm(temp);
    temp = undefined;
    assertPrivate(await lstat(path), "file");
    await syncDirectory(dir, directory);
  } catch {
    throw new NativeAuthError("unavailable");
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}

function assertPrivate(value: Stats, kind: "directory" | "file"): void {
  if (
    value.isSymbolicLink() ||
    (kind === "directory" ? !value.isDirectory() : !value.isFile()) ||
    (value.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600) ||
    (process.getuid && value.uid !== process.getuid()) ||
    (kind === "file" && value.nlink !== 1)
  )
    throw new Error();
}
async function checkedPath(dir: string): Promise<{ directory: Stats; file: Stats; path: string }> {
  const directory = await lstat(dir);
  assertPrivate(directory, "directory");
  const path = join(dir, NATIVE_AUTH_FILE);
  const file = await lstat(path);
  assertPrivate(file, "file");
  if (file.size > MAX_NATIVE_AUTH_BYTES) throw new Error();
  return { directory, file, path };
}
async function syncDirectory(dir: string, expected: Stats): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    assertPrivate(actual, "directory");
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error();
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function readNativeAuthState(dir: string): Promise<NativeAuthState> {
  try {
    const checked = await checkedPath(dir);
    const handle = await open(
      checked.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      assertPrivate(stat, "file");
      if (stat.dev !== checked.file.dev || stat.ino !== checked.file.ino) throw new Error();
      const data = Buffer.allocUnsafe(MAX_NATIVE_AUTH_BYTES + 1);
      let length = 0;
      while (length < data.length) {
        const read = await handle.read(data, length, data.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_NATIVE_AUTH_BYTES) throw new Error();
      return nativeAuthState(JSON.parse(decoder.decode(data.subarray(0, length))));
    } finally {
      await handle.close();
    }
  } catch {
    throw new NativeAuthError("unavailable");
  }
}
async function writeNativeAuthState(state: NativeAuthState, dir: string): Promise<void> {
  let temp: string | undefined;
  try {
    const checked = await checkedPath(dir);
    const data = Buffer.from(JSON.stringify(nativeAuthState(state), null, 2) + "\n");
    if (data.length > MAX_NATIVE_AUTH_BYTES) throw new Error();
    temp = join(dir, `.${NATIVE_AUTH_FILE}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, checked.path);
    temp = undefined;
    assertPrivate(await lstat(checked.path), "file");
    await syncDirectory(dir, checked.directory);
  } catch {
    throw new NativeAuthError("unavailable");
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}
