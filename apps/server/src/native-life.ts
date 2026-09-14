import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { identifier, record } from "@ellie/protocol";
import type { NativeAuth } from "./native-auth.ts";

export const NATIVE_LIFE_AUTHORITY_FILE = "native-life-authority.json";
export const NATIVE_LIFE_CAPABILITY = "life.account" as const;
export const NATIVE_LIFE_SESSION_MS = 30 * 60_000;
const MAX_AUTHORITY_BYTES = 1024 * 1024;
const MAX_GRANTS = 128;
const MAX_SESSIONS = 64;
const MAX_SESSIONS_PER_CLIENT = 4;
const MAX_ACTIVE = 32;
const MAX_ACTIVE_PER_CLIENT = 4;
const TOKEN = /^[a-f0-9]{64}$/;

export interface NativeLifeGrant {
  clientId: string;
  actorId: string;
  capability: typeof NATIVE_LIFE_CAPABILITY;
  revision: number;
}
export type NativeLifeGrantSpec = Omit<NativeLifeGrant, "revision">;
interface AuthorityState {
  version: 1;
  grants: NativeLifeGrant[];
  revisions: Record<string, number>;
}
interface WebSession {
  tokenHash: string;
  clientId: string;
  actorId: string;
  authorityRevision: number;
  expiresAt: number;
  createdAt: number;
}
export type NativeLifeAdmission =
  | {
      status: "admitted";
      session: WebSession;
      controller: AbortController;
      isCurrent(): boolean;
    }
  | { status: "busy" };
export interface NativeLifeApplication {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      actorId: string;
      clientId: string;
      origin: string;
      signal: AbortSignal;
      isCurrent(): boolean;
    },
  ): Promise<boolean>;
}
export class NativeLifeError extends Error {
  readonly kind: "unavailable" | "forbidden" | "invalid" | "busy" | "cancelled";
  constructor(kind: NativeLifeError["kind"]) {
    super(`Native Life ${kind}.`);
    this.kind = kind;
  }
}

const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const hash = (token: string) =>
  createHash("sha256").update("ellie-native-life-session-v1\0").update(token).digest("hex");
function checkedGrant(value: unknown): NativeLifeGrant {
  const item = record(value);
  if (
    !exact(item, ["clientId", "actorId", "capability", "revision"]) ||
    item.capability !== NATIVE_LIFE_CAPABILITY ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 1
  )
    throw new NativeLifeError("invalid");
  return {
    clientId: identifier(item.clientId),
    actorId: identifier(item.actorId),
    capability: NATIVE_LIFE_CAPABILITY,
    revision: item.revision as number,
  };
}
export function nativeLifeGrant(value: unknown): NativeLifeGrantSpec {
  const item = record(value);
  if (
    !exact(item, ["clientId", "actorId", "capability"]) ||
    item.capability !== NATIVE_LIFE_CAPABILITY
  )
    throw new NativeLifeError("invalid");
  return {
    clientId: identifier(item.clientId),
    actorId: identifier(item.actorId),
    capability: NATIVE_LIFE_CAPABILITY,
  };
}
export function nativeLifeAuthorityGrants(value: unknown): NativeLifeGrant[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) throw new NativeLifeError("invalid");
  const grants = value.map(checkedGrant);
  if (new Set(grants.map((grant) => grant.clientId)).size !== grants.length)
    throw new NativeLifeError("invalid");
  return grants;
}
function checkedState(value: unknown): AuthorityState {
  const item = record(value);
  if (
    !exact(item, ["version", "grants", "revisions"]) ||
    item.version !== 1 ||
    !Array.isArray(item.grants) ||
    item.grants.length > MAX_GRANTS
  )
    throw new Error("Invalid Native Life authority state.");
  const grants = item.grants.map(checkedGrant);
  if (!item.revisions || typeof item.revisions !== "object" || Array.isArray(item.revisions))
    throw new Error("Invalid Native Life authority state.");
  const revisions: Record<string, number> = {};
  for (const [clientId, revision] of Object.entries(item.revisions)) {
    const checked = identifier(clientId);
    if (!Number.isSafeInteger(revision) || Number(revision) < 1 || checked !== clientId)
      throw new Error("Invalid Native Life authority state.");
    revisions[clientId] = revision as number;
  }
  if (new Set(grants.map((grant) => grant.clientId)).size !== grants.length)
    throw new Error("Invalid Native Life authority state.");
  if (grants.some((grant) => revisions[grant.clientId] !== grant.revision))
    throw new Error("Invalid Native Life authority state.");
  return { version: 1, grants, revisions };
}

/** Explicit Life-account authority plus short, memory-only WebView sessions. */
export class NativeLifeAuthority {
  private value: AuthorityState;
  private readonly auth: NativeAuth;
  private readonly actors: Set<string>;
  private readonly persist: (value: AuthorityState) => Promise<void>;
  private readonly now: () => number;
  private readonly tokens: () => string;
  private readonly sessions = new Map<string, WebSession>();
  private readonly active = new Map<
    string,
    Map<AbortController, { tokenHash: string; expiryTimer: NodeJS.Timeout }>
  >();
  private readonly unsubscribe: () => void;
  private lock: Promise<void> = Promise.resolve();
  private poisoned = false;
  private closed = false;

  constructor(
    auth: NativeAuth,
    actorIds: readonly string[],
    value: unknown,
    persist: (value: AuthorityState) => Promise<void>,
    options: { now?: () => number; token?: () => string } = {},
  ) {
    if (!Array.isArray(actorIds) || actorIds.length !== 1) throw new NativeLifeError("invalid");
    this.actors = new Set(actorIds.map((actor) => identifier(actor)));
    this.auth = auth;
    this.value = checkedState(value);
    if (this.value.grants.some((grant) => !this.actors.has(grant.actorId)))
      throw new Error("Invalid Native Life authority state.");
    this.persist = persist;
    this.now = options.now ?? Date.now;
    this.tokens = options.token ?? (() => randomBytes(32).toString("hex"));
    this.unsubscribe = auth.onRevoke((clientId) => this.cancelClient(clientId));
  }
  static memory(
    auth: NativeAuth,
    actorIds: readonly string[],
    options: { now?: () => number; token?: () => string } = {},
  ): NativeLifeAuthority {
    return new NativeLifeAuthority(
      auth,
      actorIds,
      { version: 1, grants: [], revisions: {} },
      async () => {},
      options,
    );
  }
  static async open(
    auth: NativeAuth,
    actorIds: readonly string[],
    directory: string,
  ): Promise<NativeLifeAuthority> {
    const stored = await openAuthority(directory);
    return new NativeLifeAuthority(auth, actorIds, stored.value, stored.persist);
  }
  private assertUsable(): void {
    if (this.closed || this.poisoned) throw new NativeLifeError("unavailable");
  }
  private async serialized<T>(work: () => Promise<T> | T): Promise<T> {
    this.assertUsable();
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => (release = resolve));
    await prior;
    try {
      this.assertUsable();
      return await work();
    } finally {
      release();
    }
  }
  list(clientId?: string): NativeLifeGrant[] {
    this.assertUsable();
    return this.value.grants
      .filter((grant) => !clientId || grant.clientId === clientId)
      .map((grant) => ({ ...grant }));
  }
  async grant(value: unknown): Promise<boolean> {
    const { clientId, actorId } = nativeLifeGrant(value);
    if (!this.actors.has(actorId)) throw new NativeLifeError("forbidden");
    const active = await this.auth.withActiveClient(clientId, () =>
      this.serialized(async () => {
        const previous = this.value.grants.find((grant) => grant.clientId === clientId);
        if (previous?.actorId === actorId) return true;
        const revision = (this.value.revisions[clientId] ?? 0) + 1;
        const grants = [
          ...this.value.grants.filter((grant) => grant.clientId !== clientId),
          { clientId, actorId, capability: NATIVE_LIFE_CAPABILITY, revision },
        ];
        if (grants.length > MAX_GRANTS) throw new NativeLifeError("invalid");
        await this.commit({
          version: 1,
          grants,
          revisions: { ...this.value.revisions, [clientId]: revision },
        });
        this.cancelClient(clientId);
        return true;
      }),
    );
    return active === true;
  }
  async revoke(clientIdInput: unknown): Promise<boolean> {
    const clientId = identifier(clientIdInput);
    return this.serialized(async () => {
      const grants = this.value.grants.filter((grant) => grant.clientId !== clientId);
      if (grants.length === this.value.grants.length) return false;
      await this.commit({
        version: 1,
        grants,
        revisions: {
          ...this.value.revisions,
          [clientId]: (this.value.revisions[clientId] ?? 0) + 1,
        },
      });
      this.cancelClient(clientId);
      return true;
    });
  }
  async session(
    bearer: string,
  ): Promise<{ sessionToken: string; expiresAt: number; entryPath: "/life/" }> {
    const result = await this.auth.withAuthenticated(bearer, (client) =>
      this.serialized(() => {
        this.prune();
        const grant = this.value.grants.find((item) => item.clientId === client.id);
        if (!grant) throw new NativeLifeError("forbidden");
        if (this.sessions.size >= MAX_SESSIONS) throw new NativeLifeError("busy");
        const owned = [...this.sessions.values()]
          .filter((item) => item.clientId === client.id)
          .sort((left, right) => left.createdAt - right.createdAt);
        if (owned.length >= MAX_SESSIONS_PER_CLIENT) this.retire(owned[0]!);
        const token = this.tokens();
        if (!TOKEN.test(token) || this.sessions.has(hash(token)))
          throw new NativeLifeError("unavailable");
        const createdAt = this.now(),
          expiresAt = Math.min(client.expiresAt, createdAt + NATIVE_LIFE_SESSION_MS);
        if (expiresAt <= createdAt) throw new NativeLifeError("forbidden");
        this.sessions.set(hash(token), {
          tokenHash: hash(token),
          clientId: client.id,
          actorId: grant.actorId,
          authorityRevision: grant.revision,
          expiresAt,
          createdAt,
        });
        return { sessionToken: token, expiresAt, entryPath: "/life/" as const };
      }),
    );
    if (!result) throw new NativeLifeError("forbidden");
    return result;
  }
  async allowed(bearer: string): Promise<boolean> {
    const result = await this.auth.withAuthenticated(bearer, (client) =>
      this.serialized(() => {
        const grant = this.value.grants.find((item) => item.clientId === client.id);
        return !!grant && this.actors.has(grant.actorId);
      }),
    );
    return result === true;
  }
  admit(token: string): Extract<NativeLifeAdmission, { status: "admitted" }> | undefined {
    const result = this.admission(token);
    return result?.status === "admitted" ? result : undefined;
  }
  admission(token: string): NativeLifeAdmission | undefined {
    this.assertUsable();
    if (!TOKEN.test(token)) return;
    this.prune();
    const session = this.sessions.get(hash(token));
    if (!session || !this.current(session)) return;
    if (
      [...this.active.values()].reduce((count, items) => count + items.size, 0) >= MAX_ACTIVE ||
      (this.active.get(session.clientId)?.size ?? 0) >= MAX_ACTIVE_PER_CLIENT
    )
      return { status: "busy" };
    const controller = new AbortController();
    const active =
      this.active.get(session.clientId) ??
      new Map<AbortController, { tokenHash: string; expiryTimer: NodeJS.Timeout }>();
    const expiryTimer = setTimeout(
      () => controller.abort(),
      Math.max(0, session.expiresAt - this.now()),
    );
    active.set(controller, { tokenHash: session.tokenHash, expiryTimer });
    this.active.set(session.clientId, active);
    return {
      status: "admitted",
      session: { ...session },
      controller,
      isCurrent: () => !controller.signal.aborted && this.current(session),
    };
  }
  finish(clientId: string, controller: AbortController): void {
    const active = this.active.get(clientId);
    const item = active?.get(controller);
    if (item) clearTimeout(item.expiryTimer);
    active?.delete(controller);
    if (active?.size === 0) this.active.delete(clientId);
  }
  private current(session: WebSession): boolean {
    if (this.closed || this.poisoned || session.expiresAt <= this.now()) return false;
    if (this.sessions.get(session.tokenHash) !== session) return false;
    const client = this.auth.listClients().find((item) => item.id === session.clientId);
    const grant = this.value.grants.find((item) => item.clientId === session.clientId);
    return (
      !!client &&
      client.expiresAt > this.now() &&
      grant?.actorId === session.actorId &&
      grant.revision === session.authorityRevision
    );
  }
  private prune(): void {
    const now = this.now();
    for (const session of this.sessions.values())
      if (session.expiresAt <= now) this.retire(session);
  }
  private retire(session: WebSession): void {
    this.sessions.delete(session.tokenHash);
    for (const [controller, item] of this.active.get(session.clientId) ?? [])
      if (item.tokenHash === session.tokenHash) controller.abort();
  }
  private cancelClient(clientId: string): void {
    for (const [key, session] of this.sessions)
      if (session.clientId === clientId) this.sessions.delete(key);
    for (const [controller, item] of this.active.get(clientId) ?? []) {
      clearTimeout(item.expiryTimer);
      controller.abort();
    }
    this.active.delete(clientId);
  }
  private async commit(value: AuthorityState): Promise<void> {
    try {
      await this.persist(checkedState(value));
      this.value = value;
    } catch (error) {
      if (error instanceof NativeLifeError) throw error;
      this.poisoned = true;
      throw new NativeLifeError("unavailable");
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controllers of this.active.values())
      for (const [controller, item] of controllers) {
        clearTimeout(item.expiryTimer);
        controller.abort();
      }
    this.sessions.clear();
    await this.lock;
    this.unsubscribe();
  }
}

async function openAuthority(
  directory: string,
): Promise<{ value: AuthorityState; persist(value: AuthorityState): Promise<void> }> {
  const directoryState = await lstat(directory);
  if (
    !directoryState.isDirectory() ||
    directoryState.isSymbolicLink() ||
    (directoryState.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && directoryState.uid !== process.getuid())
  )
    throw new Error("Native Life authority directory must be private.");
  const path = join(directory, NATIVE_LIFE_AUTHORITY_FILE);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, grants: [], revisions: {} })}\n`);
      await handle.sync();
      try {
        await link(temporary, path);
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
      }
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }
  const read = async () => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (process.getuid !== undefined && stat.uid !== process.getuid()) ||
        stat.size > MAX_AUTHORITY_BYTES
      )
        throw new Error("Native Life authority unavailable.");
      return checkedState(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  };
  const persist = async (value: AuthorityState) => {
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(`${JSON.stringify(checkedState(value))}\n`);
      await handle.sync();
      await rename(temporary, path);
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  };
  return { value: await read(), persist };
}
