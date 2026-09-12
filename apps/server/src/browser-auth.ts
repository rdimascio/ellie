import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { stateDir } from "@ellie/config";
import { capabilities, identifier, record } from "@ellie/protocol";
import type { Capability } from "@ellie/protocol";

export const BROWSER_AUTH_FILE = "browser-auth.json";
export const BROWSER_AUTH_VERSION = 1;
export const BROWSER_INVITATION_TTL_MS = 10 * 60_000;
export const BROWSER_SESSION_TTL_MS = 14 * 24 * 60 * 60_000;
export const MAX_BROWSER_INVITATIONS = 32;
export const MAX_BROWSER_SESSIONS = 128;
export const MAX_BROWSER_AUTH_BYTES = 1024 * 1024;
export const BROWSER_SESSION_COOKIE = "__Host-ellie-session";

export type BrowserRole = "phone_controller" | "tv_viewer";

export interface BrowserGrant {
  target: string;
  capabilities: Capability[];
}

export interface BrowserClient {
  id: string;
  role: BrowserRole;
  label: string;
  grants: BrowserGrant[];
  createdAt: number;
  expiresAt: number;
}

interface StoredBrowserCredential extends BrowserClient {
  tokenHash: string;
}

export interface BrowserAuthState {
  version: typeof BROWSER_AUTH_VERSION;
  invitations: StoredBrowserCredential[];
  sessions: StoredBrowserCredential[];
}

export interface BrowserInvitationSpec {
  role: BrowserRole;
  label: string;
  grants: BrowserGrant[];
}

export interface BrowserInvitation extends BrowserClient {
  code: string;
}

export interface BrowserSessionIssue {
  token: string;
  client: BrowserClient;
}

interface BrowserAuthOptions {
  now?: () => number;
  token?: () => string;
  id?: () => string;
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_LABEL_CODE_POINTS = 64;
const MAX_GRANTS = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });

const newToken = (): string => randomBytes(32).toString("hex");
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
const equal = (left: string, right: string): boolean =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function finiteTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("Invalid browser authorization state.");
  return value as number;
}

export function browserLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid browser client label.");
  const length = [...value].length;
  if (
    length < 1 ||
    length > MAX_LABEL_CODE_POINTS ||
    value !== value.trim() ||
    /\p{C}/u.test(value)
  )
    throw new Error("Invalid browser client label.");
  return value;
}

function browserRole(value: unknown): BrowserRole {
  if (value !== "phone_controller" && value !== "tv_viewer")
    throw new Error("Invalid browser client role.");
  return value;
}

function browserGrant(value: unknown): BrowserGrant {
  const grant = record(value);
  if (!exactKeys(grant, ["target", "capabilities"]))
    throw new Error("Invalid browser client grant.");
  const rawCapabilities = grant.capabilities;
  const checked = capabilities(rawCapabilities);
  if (
    checked.length < 1 ||
    !Array.isArray(rawCapabilities) ||
    checked.length !== rawCapabilities.length
  )
    throw new Error("Invalid browser client grant.");
  return { target: identifier(grant.target), capabilities: checked };
}

function browserGrants(value: unknown): BrowserGrant[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS)
    throw new Error("Invalid browser client grants.");
  const grants = value.map(browserGrant);
  if (new Set(grants.map((grant) => grant.target)).size !== grants.length)
    throw new Error("Invalid browser client grants.");
  return grants;
}

export function browserInvitationSpec(value: unknown): BrowserInvitationSpec {
  const input = record(value);
  if (!exactKeys(input, ["role", "label", "grants"]))
    throw new Error("Invalid browser invitation.");
  const role = browserRole(input.role);
  const grants = browserGrants(input.grants);
  if (
    (role === "tv_viewer" && grants.length !== 0) ||
    (role === "phone_controller" && grants.length === 0)
  )
    throw new Error("Invalid browser invitation grants for this role.");
  return { role, label: browserLabel(input.label), grants };
}

function storedCredential(value: unknown, ttl: number): StoredBrowserCredential {
  const input = record(value);
  if (
    !exactKeys(input, ["id", "role", "label", "grants", "createdAt", "expiresAt", "tokenHash"]) ||
    typeof input.tokenHash !== "string" ||
    !HASH_PATTERN.test(input.tokenHash)
  )
    throw new Error("Invalid browser authorization state.");
  const role = browserRole(input.role);
  const grants = browserGrants(input.grants);
  if (
    (role === "tv_viewer" && grants.length !== 0) ||
    (role === "phone_controller" && grants.length === 0)
  )
    throw new Error("Invalid browser authorization state.");
  const createdAt = finiteTimestamp(input.createdAt);
  const expiresAt = finiteTimestamp(input.expiresAt);
  if (expiresAt - createdAt !== ttl) throw new Error("Invalid browser authorization state.");
  return {
    id: identifier(input.id),
    role,
    label: browserLabel(input.label),
    grants,
    createdAt,
    expiresAt,
    tokenHash: input.tokenHash,
  };
}

export function browserAuthState(value: unknown): BrowserAuthState {
  const input = record(value);
  if (
    !exactKeys(input, ["version", "invitations", "sessions"]) ||
    input.version !== BROWSER_AUTH_VERSION ||
    !Array.isArray(input.invitations) ||
    !Array.isArray(input.sessions) ||
    input.invitations.length > MAX_BROWSER_INVITATIONS ||
    input.sessions.length > MAX_BROWSER_SESSIONS
  )
    throw new Error("Unsupported or invalid browser authorization state.");
  const invitations = input.invitations.map((item) =>
    storedCredential(item, BROWSER_INVITATION_TTL_MS),
  );
  const sessions = input.sessions.map((item) => storedCredential(item, BROWSER_SESSION_TTL_MS));
  const credentials = [...invitations, ...sessions];
  if (
    new Set(credentials.map((item) => item.id)).size !== credentials.length ||
    new Set(credentials.map((item) => item.tokenHash)).size !== credentials.length
  )
    throw new Error("Invalid browser authorization state.");
  return { version: BROWSER_AUTH_VERSION, invitations, sessions };
}

function browserStateError(action: "opened" | "saved"): Error {
  return new Error(
    `Browser authorization state could not be ${action} safely. Stop Ellie, preserve the file for diagnosis, and restore a supported private copy or move it aside before restarting.`,
  );
}

function assertPrivateStat(stat: Stats, kind: "directory" | "file"): void {
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== expectedMode ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (kind === "file" && stat.nlink !== 1)
  )
    throw new Error("private state check failed");
}

async function privateStatePath(
  dir: string,
): Promise<{ directory: Stats; path: string; file: Stats }> {
  const directory = await lstat(dir);
  assertPrivateStat(directory, "directory");
  const path = join(dir, BROWSER_AUTH_FILE);
  const file = await lstat(path);
  assertPrivateStat(file, "file");
  if (file.size > MAX_BROWSER_AUTH_BYTES) throw new Error("private state is oversized");
  return { directory, path, file };
}

async function boundedRead(path: string, expected: Stats): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    assertPrivateStat(actual, "file");
    if (
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      actual.size > MAX_BROWSER_AUTH_BYTES
    )
      throw new Error("private state changed while opening");
    const bytes = Buffer.allocUnsafe(MAX_BROWSER_AUTH_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_BROWSER_AUTH_BYTES) throw new Error("private state is oversized");
    return decoder.decode(bytes.subarray(0, offset));
  } finally {
    await handle.close();
  }
}

export async function readBrowserAuthState(dir = stateDir): Promise<BrowserAuthState> {
  try {
    const checked = await privateStatePath(dir);
    return browserAuthState(JSON.parse(await boundedRead(checked.path, checked.file)));
  } catch {
    throw browserStateError("opened");
  }
}

export async function writeBrowserAuthState(
  value: BrowserAuthState,
  dir = stateDir,
): Promise<void> {
  let temp: string | undefined;
  try {
    const state = browserAuthState(value);
    const checked = await privateStatePath(dir);
    const encoded = Buffer.from(`${JSON.stringify(state, null, 2)}\n`);
    if (encoded.length > MAX_BROWSER_AUTH_BYTES) throw new Error("private state is oversized");
    temp = join(dir, `.${BROWSER_AUTH_FILE}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, checked.path);
    temp = undefined;
    const published = await lstat(checked.path);
    assertPrivateStat(published, "file");
    const directoryHandle = await open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const actualDirectory = await directoryHandle.stat();
      assertPrivateStat(actualDirectory, "directory");
      if (
        actualDirectory.dev !== checked.directory.dev ||
        actualDirectory.ino !== checked.directory.ino
      )
        throw new Error("private directory changed while saving");
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    throw browserStateError("saved");
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}

function publicClient(value: StoredBrowserCredential): BrowserClient {
  return {
    id: value.id,
    role: value.role,
    label: value.label,
    grants: value.grants.map((grant) => ({
      target: grant.target,
      capabilities: [...grant.capabilities],
    })),
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function pruned(state: BrowserAuthState, now: number): BrowserAuthState {
  return {
    ...state,
    invitations: state.invitations.filter((item) => item.expiresAt > now),
    sessions: state.sessions.filter((item) => item.expiresAt > now),
  };
}

function pairingCode(value: unknown): string {
  try {
    const input = record(value);
    if (
      !exactKeys(input, ["code"]) ||
      typeof input.code !== "string" ||
      !TOKEN_PATTERN.test(input.code)
    )
      throw new Error();
    return input.code;
  } catch {
    throw new Error("Browser invitation is invalid or expired.");
  }
}

export class BrowserAuth {
  private state: BrowserAuthState;
  private readonly persist: (state: BrowserAuthState) => Promise<void>;
  private readonly now: () => number;
  private readonly token: () => string;
  private readonly id: () => string;
  private poisoned = false;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    state: unknown,
    persist: (state: BrowserAuthState) => Promise<void>,
    options: BrowserAuthOptions = {},
  ) {
    this.state = browserAuthState(state);
    this.persist = persist;
    this.now = options.now ?? Date.now;
    this.token = options.token ?? newToken;
    this.id = options.id ?? randomUUID;
  }

  static empty(): BrowserAuthState {
    return { version: BROWSER_AUTH_VERSION, invitations: [], sessions: [] };
  }

  static async open(dir?: string): Promise<BrowserAuth> {
    return new BrowserAuth(await readBrowserAuthState(dir), (state) =>
      writeBrowserAuthState(state, dir),
    );
  }

  private assertUsable(): void {
    if (this.poisoned)
      throw new Error("Browser authorization state must be reopened after a failed save.");
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertUsable();
      return await fn();
    } finally {
      release();
    }
  }

  private async commit(state: BrowserAuthState): Promise<void> {
    try {
      await this.persist(state);
    } catch {
      this.poisoned = true;
      throw new Error("Browser authorization state could not be saved.");
    }
  }

  private uniqueToken(state: BrowserAuthState): string {
    for (let attempt = 0; attempt < 4; attempt++) {
      const token = this.token();
      if (!TOKEN_PATTERN.test(token)) throw new Error("Browser credential generation failed.");
      const tokenHash = hash(token);
      if (
        ![...state.invitations, ...state.sessions].some((item) => equal(item.tokenHash, tokenHash))
      )
        return token;
    }
    throw new Error("Browser credential generation failed.");
  }

  private uniqueId(state: BrowserAuthState): string {
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = identifier(this.id());
      if (![...state.invitations, ...state.sessions].some((item) => item.id === id)) return id;
    }
    throw new Error("Browser identity generation failed.");
  }

  async invite(value: unknown): Promise<BrowserInvitation> {
    this.assertUsable();
    const spec = browserInvitationSpec(value);
    return this.mutate(async () => {
      const now = this.now();
      const current = pruned(this.state, now);
      if (current.invitations.length >= MAX_BROWSER_INVITATIONS)
        throw new Error("Too many active browser invitations.");
      const code = this.uniqueToken(current);
      const stored: StoredBrowserCredential = {
        id: this.uniqueId(current),
        ...spec,
        createdAt: now,
        expiresAt: now + BROWSER_INVITATION_TTL_MS,
        tokenHash: hash(code),
      };
      const next = { ...current, invitations: [...current.invitations, stored] };
      await this.commit(next);
      this.state = next;
      return { ...publicClient(stored), code };
    });
  }

  async pair(value: unknown): Promise<BrowserSessionIssue> {
    this.assertUsable();
    const code = pairingCode(value);
    return this.mutate(async () => {
      const now = this.now();
      const current = pruned(this.state, now);
      const codeHash = hash(code);
      const invitation = current.invitations.find((item) => equal(item.tokenHash, codeHash));
      if (!invitation) throw new Error("Browser invitation is invalid or expired.");
      if (current.sessions.length >= MAX_BROWSER_SESSIONS)
        throw new Error("Too many active browser sessions.");
      const token = this.uniqueToken(current);
      const stored: StoredBrowserCredential = {
        ...publicClient(invitation),
        id: this.uniqueId(current),
        createdAt: now,
        expiresAt: now + BROWSER_SESSION_TTL_MS,
        tokenHash: hash(token),
      };
      const next = {
        ...current,
        invitations: current.invitations.filter((item) => item.id !== invitation.id),
        sessions: [...current.sessions, stored],
      };
      await this.commit(next);
      this.state = next;
      return { token, client: publicClient(stored) };
    });
  }

  authenticate(token: unknown): BrowserClient | undefined {
    this.assertUsable();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return undefined;
    const tokenHash = hash(token);
    const now = this.now();
    const session = this.state.sessions.find(
      (item) => item.expiresAt > now && equal(item.tokenHash, tokenHash),
    );
    return session ? publicClient(session) : undefined;
  }

  authenticateCookie(header?: string | string[]): BrowserClient | undefined {
    this.assertUsable();
    return this.authenticate(browserSessionToken(header));
  }

  listClients(): BrowserClient[] {
    this.assertUsable();
    const now = this.now();
    return this.state.sessions.filter((item) => item.expiresAt > now).map(publicClient);
  }

  async revoke(id: unknown): Promise<boolean> {
    this.assertUsable();
    const checkedId = identifier(id);
    return this.mutate(async () => {
      const current = pruned(this.state, this.now());
      const sessions = current.sessions.filter((item) => item.id !== checkedId);
      const removed = sessions.length !== current.sessions.length;
      if (!removed) return false;
      const next = { ...current, sessions };
      await this.commit(next);
      this.state = next;
      return true;
    });
  }

  async logout(token: unknown): Promise<boolean> {
    this.assertUsable();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
    return this.mutate(async () => {
      const current = pruned(this.state, this.now());
      const tokenHash = hash(token);
      const sessions = current.sessions.filter((item) => !equal(item.tokenHash, tokenHash));
      const removed = sessions.length !== current.sessions.length;
      if (!removed) return false;
      const next = { ...current, sessions };
      await this.commit(next);
      this.state = next;
      return true;
    });
  }
}

function checkedSessionToken(value: unknown): string {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value))
    throw new Error("Invalid browser session token.");
  return value;
}

export function browserSessionCookie(token: unknown): string {
  return `${BROWSER_SESSION_COOKIE}=${checkedSessionToken(token)}; Path=/; Max-Age=${BROWSER_SESSION_TTL_MS / 1000}; Secure; HttpOnly; SameSite=Strict`;
}

export function clearBrowserSessionCookie(): string {
  return `${BROWSER_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function browserSessionToken(header?: string | string[]): string | undefined {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const matches: string[] = [];
  for (const value of values) {
    for (const part of value.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === BROWSER_SESSION_COOKIE) matches.push(rest.join("="));
    }
  }
  if (matches.length !== 1 || !TOKEN_PATTERN.test(matches[0]!)) return undefined;
  return matches[0];
}

function exactBrowserOrigin(value: string): URL {
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
    throw new Error("Invalid browser origin configuration.");
  return url;
}

/** Pure request-boundary guard for a future same-origin browser listener. */
export function browserRequestMatchesOrigin(
  expectedOrigin: string,
  request: { method: string; host?: string; origin?: string },
): boolean {
  const expected = exactBrowserOrigin(expectedOrigin);
  if (request.host !== expected.host) return false;
  if (request.origin !== undefined && request.origin !== expected.origin) return false;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && request.origin !== expected.origin) return false;
  return true;
}
