import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  emptyHouseholdDocument,
  householdDocument,
  householdGrant,
  HOUSEHOLD_CONTRACT,
} from "@ellie/protocol";
import type { HouseholdGrant, HouseholdKind, HouseholdProfile } from "@ellie/protocol";
import type { NativeAuth, NativeClient } from "./native-auth.ts";

export const DATA_AUTHORITY_FILE = "data-authority.json";
export const HOUSEHOLD_DOCUMENTS_FILE = "household-documents.json";
const decoder = new TextDecoder("utf-8", { fatal: true });
export class HouseholdStateError extends Error {
  readonly kind: "unavailable" | "forbidden" | "conflict" | "exhausted" | "invalid";
  constructor(kind: HouseholdStateError["kind"]) {
    super(`Household state ${kind}.`);
    this.kind = kind;
  }
}
export interface StoredHouseholdDocument {
  profile: HouseholdProfile;
  ownerClientId?: string;
  kind: HouseholdKind;
  revision: number;
  value: unknown;
}
interface AuthorityState {
  version: 1;
  grants: HouseholdGrant[];
}
interface DocumentState {
  version: 1;
  documents: StoredHouseholdDocument[];
}

const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as Record<string, unknown>;
};
const authorityState = (value: unknown): AuthorityState => {
  const state = record(value);
  if (
    !exact(state, ["version", "grants"]) ||
    state.version !== 1 ||
    !Array.isArray(state.grants) ||
    state.grants.length > HOUSEHOLD_CONTRACT.maximumAuthorities
  )
    throw new Error();
  const grants = state.grants.map(householdGrant);
  const keys = grants.map(keyGrant);
  if (new Set(keys).size !== keys.length) throw new Error();
  return { version: 1, grants };
};
const documentState = (value: unknown): DocumentState => {
  const state = record(value);
  if (
    !exact(state, ["version", "documents"]) ||
    state.version !== 1 ||
    !Array.isArray(state.documents) ||
    state.documents.length > HOUSEHOLD_CONTRACT.maximumDocuments
  )
    throw new Error();
  const documents = state.documents.map((raw) => {
    const item = record(raw);
    const profile = item.profile;
    const keys =
      profile === "shared"
        ? ["profile", "kind", "revision", "value"]
        : ["profile", "ownerClientId", "kind", "revision", "value"];
    if (
      !exact(item, keys) ||
      (profile !== "shared" && profile !== "private") ||
      (profile === "private" && typeof item.ownerClientId !== "string") ||
      !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 1
    )
      throw new Error();
    const grant = householdGrant({
      clientId: profile === "private" ? item.ownerClientId : "shared",
      profile,
      kind: item.kind,
      access: "read",
    });
    return {
      profile: grant.profile,
      ...(profile === "private" ? { ownerClientId: grant.clientId } : {}),
      kind: grant.kind,
      revision: item.revision as number,
      value: householdDocument(grant.kind, item.value),
    };
  });
  const keys = documents.map(keyDocument);
  if (new Set(keys).size !== keys.length) throw new Error();
  return { version: 1, documents };
};
const keyGrant = (value: Pick<HouseholdGrant, "clientId" | "profile" | "kind">) =>
  `${value.clientId}\0${value.profile}\0${value.kind}`;
const keyDocument = (value: Pick<StoredHouseholdDocument, "profile" | "ownerClientId" | "kind">) =>
  `${value.profile}\0${value.ownerClientId ?? ""}\0${value.kind}`;

class PrivateState<T> {
  private poisoned = false;
  private value: T;
  private readonly persist: (value: T) => Promise<void>;
  private readonly validate: (value: unknown) => T;
  constructor(value: T, persist: (value: T) => Promise<void>, validate: (value: unknown) => T) {
    this.value = value;
    this.persist = persist;
    this.validate = validate;
  }
  get(): T {
    if (this.poisoned) throw new HouseholdStateError("unavailable");
    return structuredClone(this.value);
  }
  async set(value: T): Promise<void> {
    if (this.poisoned) throw new HouseholdStateError("unavailable");
    let checked: T;
    try {
      checked = this.validate(value);
    } catch {
      throw new HouseholdStateError("invalid");
    }
    try {
      await this.persist(checked);
    } catch {
      this.poisoned = true;
      throw new HouseholdStateError("unavailable");
    }
    this.value = checked;
  }
}

export class HouseholdState {
  private lock: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly authority: PrivateState<AuthorityState>;
  private readonly documents: PrivateState<DocumentState>;
  private constructor(
    authority: PrivateState<AuthorityState>,
    documents: PrivateState<DocumentState>,
  ) {
    this.authority = authority;
    this.documents = documents;
  }
  static async openOrInitialize(directory: string): Promise<HouseholdState> {
    const authority = await openPrivate(
      directory,
      DATA_AUTHORITY_FILE,
      HOUSEHOLD_CONTRACT.maximumAuthorityFileBytes,
      { version: 1, grants: [] },
      authorityState,
    );
    const documents = await openPrivate(
      directory,
      HOUSEHOLD_DOCUMENTS_FILE,
      HOUSEHOLD_CONTRACT.maximumDocumentFileBytes,
      { version: 1, documents: [] },
      documentState,
    );
    return new HouseholdState(authority, documents);
  }
  static memory(
    options: {
      authorityPersist?: () => Promise<void>;
      documentPersist?: () => Promise<void>;
      authorityFileBytes?: number;
      documentFileBytes?: number;
    } = {},
  ): HouseholdState {
    return new HouseholdState(
      new PrivateState(
        { version: 1, grants: [] },
        async () => options.authorityPersist?.(),
        boundedState(
          authorityState,
          options.authorityFileBytes ?? HOUSEHOLD_CONTRACT.maximumAuthorityFileBytes,
        ),
      ),
      new PrivateState(
        { version: 1, documents: [] },
        async () => options.documentPersist?.(),
        boundedState(
          documentState,
          options.documentFileBytes ?? HOUSEHOLD_CONTRACT.maximumDocumentFileBytes,
        ),
      ),
    );
  }
  private async serialized<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new HouseholdStateError("unavailable");
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    if (this.closed) {
      release();
      throw new HouseholdStateError("unavailable");
    }
    try {
      return await work();
    } finally {
      release();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.lock;
  }
  list(clientId?: string): HouseholdGrant[] {
    if (this.closed) throw new HouseholdStateError("unavailable");
    return this.authority.get().grants.filter((grant) => !clientId || grant.clientId === clientId);
  }
  async grant(auth: NativeAuth, value: unknown): Promise<boolean> {
    const grant = householdGrant(value);
    const result = await auth.withActiveClient(grant.clientId, () =>
      this.serialized(async () => {
        if (!auth.listClients().some((client) => client.id === grant.clientId)) return false;
        const state = this.authority.get();
        const others = state.grants.filter((item) => keyGrant(item) !== keyGrant(grant));
        const grants = [...others, grant];
        if (grants.length > HOUSEHOLD_CONTRACT.maximumAuthorities)
          throw new HouseholdStateError("invalid");
        await this.authority.set({ version: 1, grants });
        return true;
      }),
    );
    return result === true;
  }
  async revoke(value: unknown): Promise<boolean> {
    const raw = record(value);
    if (!exact(raw, ["clientId", "profile", "kind"])) throw new HouseholdStateError("invalid");
    const grant = householdGrant({ ...raw, access: "read" });
    return this.serialized(async () => {
      const state = this.authority.get();
      const grants = state.grants.filter((item) => keyGrant(item) !== keyGrant(grant));
      if (grants.length === state.grants.length) return false;
      await this.authority.set({ version: 1, grants });
      return true;
    });
  }
  async read(
    auth: NativeAuth,
    bearer: string,
    profile: HouseholdProfile,
    kind: HouseholdKind,
  ): Promise<{ client?: NativeClient; document?: StoredHouseholdDocument }> {
    const result = await auth.withAuthenticated(bearer, () =>
      this.serialized(async () => {
        const client = auth.authenticateBearer(bearer);
        return client
          ? { client, document: this.readAuthorized(client, profile, kind, false) }
          : {};
      }),
    );
    return result ?? {};
  }
  async write(
    auth: NativeAuth,
    bearer: string,
    profile: HouseholdProfile,
    kind: HouseholdKind,
    expected: number,
    value: unknown,
  ): Promise<{
    client?: NativeClient;
    document?: StoredHouseholdDocument;
    conflictRevision?: number;
  }> {
    const result = await auth.withAuthenticated(bearer, () =>
      this.serialized(async () => {
        const client = auth.authenticateBearer(bearer);
        if (!client) return {};
        const current = this.readAuthorized(client, profile, kind, true);
        if (current.revision !== expected) return { client, conflictRevision: current.revision };
        if (current.revision === HOUSEHOLD_CONTRACT.maximumSafeRevision)
          throw new HouseholdStateError("exhausted");
        const checked = householdDocument(kind, value);
        const state = this.documents.get();
        const key = keyDocument(current);
        const next = { ...current, revision: current.revision + 1, value: checked };
        const documents = [...state.documents.filter((item) => keyDocument(item) !== key), next];
        if (documents.length > HOUSEHOLD_CONTRACT.maximumDocuments)
          throw new HouseholdStateError("invalid");
        await this.documents.set({ version: 1, documents });
        return { client, document: next };
      }),
    );
    return result ?? {};
  }
  private readAuthorized(
    client: NativeClient,
    profile: HouseholdProfile,
    kind: HouseholdKind,
    write: boolean,
  ): StoredHouseholdDocument {
    const grant = this.authority
      .get()
      .grants.find(
        (item) =>
          item.clientId === client.id &&
          item.profile === profile &&
          item.kind === kind &&
          (!write || item.access === "write"),
      );
    if (!grant) throw new HouseholdStateError("forbidden");
    const ownerClientId = profile === "private" ? client.id : undefined;
    return (
      this.documents
        .get()
        .documents.find(
          (item) =>
            item.profile === profile && item.ownerClientId === ownerClientId && item.kind === kind,
        ) ?? {
        profile,
        ...(ownerClientId ? { ownerClientId } : {}),
        kind,
        revision: 0,
        value: emptyHouseholdDocument(kind),
      }
    );
  }
}

async function openPrivate<T>(
  directory: string,
  file: string,
  maximum: number,
  empty: T,
  validate: (value: unknown) => T,
): Promise<PrivateState<T>> {
  try {
    const checkedState = boundedState(validate, maximum);
    try {
      await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const dir = await lstat(directory);
    assertPrivate(dir, "directory");
    const path = join(directory, file);
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temp = join(directory, `.${file}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        const handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.chmod(0o600);
          await handle.writeFile(`${JSON.stringify(empty, null, 2)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temp, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await syncDirectory(directory, dir);
      } finally {
        await rm(temp, { force: true });
      }
    }
    const read = async (): Promise<T> => {
      const before = await lstat(path);
      assertPrivate(before, "file");
      if (before.size > maximum) throw new Error();
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const actual = await handle.stat();
        assertPrivate(actual, "file");
        if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error();
        const data = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < data.length) {
          const part = await handle.read(data, length, data.length - length, null);
          if (!part.bytesRead) break;
          length += part.bytesRead;
        }
        if (length > maximum) throw new Error();
        return checkedState(JSON.parse(decoder.decode(data.subarray(0, length))));
      } finally {
        await handle.close();
      }
    };
    const persist = async (value: T): Promise<void> => {
      const beforeDir = await lstat(directory);
      assertPrivate(beforeDir, "directory");
      const before = await lstat(path);
      assertPrivate(before, "file");
      const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      const temp = join(directory, `.${file}.${randomBytes(8).toString("hex")}.tmp`);
      try {
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
        const current = await lstat(path);
        assertPrivate(current, "file");
        if (current.dev !== before.dev || current.ino !== before.ino) throw new Error();
        await rename(temp, path);
        assertPrivate(await lstat(path), "file");
        await syncDirectory(directory, beforeDir);
      } finally {
        await rm(temp, { force: true });
      }
    };
    return new PrivateState(await read(), persist, checkedState);
  } catch {
    throw new HouseholdStateError("unavailable");
  }
}
function boundedState<T>(validate: (value: unknown) => T, maximum: number): (value: unknown) => T {
  return (value) => {
    const checked = validate(value);
    if (Buffer.byteLength(`${JSON.stringify(checked, null, 2)}\n`) > maximum) throw new Error();
    return checked;
  };
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
async function syncDirectory(directory: string, expected: Stats): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    assertPrivate(actual, "directory");
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error();
    await handle.sync();
  } finally {
    await handle.close();
  }
}
