import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { identifier, record } from "@ellie/protocol";
import type { NativeAuth, NativeClient } from "./native-auth.ts";
import { SpeechInputError } from "@ellie/speech";
import type { SpeechInput } from "@ellie/speech";

export const SPEECH_AUTHORITY_FILE = "speech-authority.json";
export const SPEECH_CONFIGURATION_FILE = "native-speech.json";
export const SPEECH_CAPABILITY = "speech.transcribe" as const;
export const MAX_SPEECH_AUDIO_BYTES = 1_100_000;
export const MAX_SPEECH_AUDIO_DURATION_MS = 30_000;
export const MAX_SPEECH_TRANSCRIPT_BYTES = 16_384;
export const MAX_SPEECH_TRANSCRIPT_UNITS = 2_000;
const MAX_AUTHORITY_BYTES = 1024 * 1024;
const MAX_GRANTS = 128;
const MAX_ACTIVE = 4;
const decoder = new TextDecoder("utf-8", { fatal: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class NativeSpeechError extends Error {
  readonly kind: "unavailable" | "forbidden" | "busy" | "invalid" | "cancelled";
  constructor(kind: NativeSpeechError["kind"]) {
    super(`Native speech ${kind}.`);
    this.kind = kind;
  }
}
export interface SpeechGrant {
  clientId: string;
  capability: typeof SPEECH_CAPABILITY;
}
interface AuthorityState {
  version: 1;
  grants: SpeechGrant[];
}
export interface NativeSpeechConfiguration {
  executable: string;
  model: string;
}
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));
const grant = (value: unknown): SpeechGrant => {
  const row = record(value);
  if (!exact(row, ["clientId", "capability"]) || row.capability !== SPEECH_CAPABILITY)
    throw new NativeSpeechError("invalid");
  return { clientId: identifier(row.clientId), capability: SPEECH_CAPABILITY };
};
const state = (value: unknown): AuthorityState => {
  const raw = record(value);
  if (
    !exact(raw, ["version", "grants"]) ||
    raw.version !== 1 ||
    !Array.isArray(raw.grants) ||
    raw.grants.length > MAX_GRANTS
  )
    throw new Error();
  const grants = raw.grants.map(grant);
  if (new Set(grants.map((item) => item.clientId)).size !== grants.length) throw new Error();
  return { version: 1, grants };
};

export class NativeSpeech {
  private readonly auth: NativeAuth;
  private readonly createInput: () => SpeechInput;
  private readonly persist: (value: AuthorityState) => Promise<void>;
  private readonly probe: () => Promise<boolean>;
  private value: AuthorityState;
  private lock: Promise<void> = Promise.resolve();
  private poisoned = false;
  private closed = false;
  private readonly turns = new Map<
    string,
    { clientId: string; abort: AbortController; done: Promise<void>; finish: () => void }
  >();
  private readonly unsubscribe: () => void;
  constructor(
    auth: NativeAuth,
    input: SpeechInput | (() => SpeechInput),
    value: unknown,
    persist: (value: AuthorityState) => Promise<void>,
    probe: () => Promise<boolean> = async () => true,
  ) {
    this.auth = auth;
    this.createInput = typeof input === "function" ? input : () => input;
    this.persist = persist;
    this.probe = probe;
    this.value = state(value);
    this.unsubscribe = auth.onRevoke((clientId) => this.cancelClient(clientId));
  }
  static memory(
    auth: NativeAuth,
    input: SpeechInput | (() => SpeechInput),
    persist: (value: AuthorityState) => Promise<void> = async () => {},
  ): NativeSpeech {
    return new NativeSpeech(auth, input, { version: 1, grants: [] }, persist);
  }
  static async open(
    auth: NativeAuth,
    input: SpeechInput | (() => SpeechInput),
    directory: string,
    probe: () => Promise<boolean> = async () => true,
  ): Promise<NativeSpeech> {
    const store = await openAuthority(directory);
    return new NativeSpeech(auth, input, store.value, store.persist, probe);
  }
  private async serialized<T>(work: () => Promise<T> | T): Promise<T> {
    if (this.closed || this.poisoned) throw new NativeSpeechError("unavailable");
    const prior = this.lock;
    let release!: () => void;
    this.lock = new Promise((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      if (this.closed || this.poisoned) throw new NativeSpeechError("unavailable");
      return await work();
    } finally {
      release();
    }
  }
  list(clientId?: string): SpeechGrant[] {
    if (this.closed || this.poisoned) throw new NativeSpeechError("unavailable");
    return this.value.grants
      .filter((item) => !clientId || item.clientId === clientId)
      .map((item) => ({ ...item }));
  }
  async grant(value: unknown): Promise<boolean> {
    const checked = grant(value);
    const result = await this.auth.withActiveClient(checked.clientId, () =>
      this.serialized(async () => {
        if (!this.auth.listClients().some((client) => client.id === checked.clientId)) return false;
        const grants = [
          ...this.value.grants.filter((item) => item.clientId !== checked.clientId),
          checked,
        ];
        await this.commit({ version: 1, grants });
        return true;
      }),
    );
    return result === true;
  }
  async revoke(clientId: unknown): Promise<boolean> {
    const checked = identifier(clientId);
    return this.serialized(async () => {
      const grants = this.value.grants.filter((item) => item.clientId !== checked);
      if (grants.length === this.value.grants.length) return false;
      await this.commit({ version: 1, grants });
      this.cancelClient(checked);
      return true;
    });
  }
  async available(bearer: string): Promise<boolean> {
    const result = await this.auth.withAuthenticated(bearer, () =>
      this.serialized(() => {
        const client = this.auth.authenticateBearer(bearer);
        return !!client && this.allowed(client.id);
      }),
    );
    if (result !== true) return false;
    if (!(await this.probe())) throw new NativeSpeechError("unavailable");
    const fresh = await this.auth.withAuthenticated(bearer, () =>
      this.serialized(() => {
        const client = this.auth.authenticateBearer(bearer);
        return !!client && this.allowed(client.id);
      }),
    );
    return fresh === true;
  }
  async transcribe(
    bearer: string,
    turnId: string,
    audio: AsyncIterable<Uint8Array>,
    disconnected: AbortSignal,
  ): Promise<string> {
    if (!UUID.test(turnId)) throw new NativeSpeechError("invalid");
    const registered = await this.auth.withAuthenticated(bearer, () =>
      this.serialized(() => {
        const client = this.auth.authenticateBearer(bearer);
        if (!client) return undefined;
        if (!this.allowed(client.id)) throw new NativeSpeechError("forbidden");
        if (
          [...this.turns.values()].some((turn) => turn.clientId === client.id) ||
          this.turns.has(turnId) ||
          this.turns.size >= MAX_ACTIVE
        )
          throw new NativeSpeechError("busy");
        const abort = new AbortController();
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        this.turns.set(turnId, { clientId: client.id, abort, done, finish });
        return { client, abort };
      }),
    );
    if (!registered) throw new NativeSpeechError("forbidden");
    const signal = AbortSignal.any([
      registered.abort.signal,
      disconnected,
      AbortSignal.timeout(Math.max(1, Math.min(35_000, registered.client.expiresAt - Date.now()))),
    ]);
    try {
      let final: string | undefined;
      let count = 0;
      for await (const result of this.createInput().transcribe(audio, signal)) {
        count += 1;
        if (!result.final || count !== 1) throw new NativeSpeechError("invalid");
        final = result.text;
      }
      if (
        signal.aborted ||
        final === undefined ||
        final.length > MAX_SPEECH_TRANSCRIPT_UNITS ||
        Buffer.byteLength(final) > MAX_SPEECH_TRANSCRIPT_BYTES
      )
        throw new NativeSpeechError(signal.aborted ? "cancelled" : "invalid");
      const publish = await this.auth.withAuthenticated(bearer, () =>
        this.serialized(() => {
          const client = this.auth.authenticateBearer(bearer);
          return (
            !signal.aborted &&
            client?.id === registered.client.id &&
            this.allowed(client.id) &&
            this.turns.get(turnId)?.abort === registered.abort
          );
        }),
      );
      if (publish !== true || signal.aborted) throw new NativeSpeechError("cancelled");
      return final;
    } catch (error) {
      if (signal.aborted && !(error instanceof NativeSpeechError))
        throw new NativeSpeechError("cancelled");
      if (error instanceof SpeechInputError) {
        if (error.code === "INVALID_AUDIO" || error.code === "LIMIT_EXCEEDED")
          throw new NativeSpeechError("invalid");
        if (error.code === "ABORTED" || error.code === "TIMED_OUT")
          throw new NativeSpeechError("cancelled");
        if (error.code === "BUSY") throw new NativeSpeechError("busy");
        throw new NativeSpeechError("unavailable");
      }
      throw error;
    } finally {
      const turn = this.turns.get(turnId);
      if (turn?.abort === registered.abort) {
        this.turns.delete(turnId);
        turn.finish();
      }
    }
  }
  async cancel(bearer: string, turnId: string): Promise<boolean | undefined> {
    if (!UUID.test(turnId)) throw new NativeSpeechError("invalid");
    return this.auth.withAuthenticated(bearer, () =>
      this.serialized(() => {
        const client = this.auth.authenticateBearer(bearer);
        if (!client || !this.allowed(client.id)) return undefined;
        const turn = this.turns.get(turnId);
        if (!turn || turn.clientId !== client.id) return false;
        turn.abort.abort();
        return true;
      }),
    );
  }
  private allowed(clientId: string): boolean {
    return this.value.grants.some((item) => item.clientId === clientId);
  }
  private cancelClient(clientId: string): void {
    for (const turn of this.turns.values()) if (turn.clientId === clientId) turn.abort.abort();
  }
  private async commit(next: AuthorityState): Promise<void> {
    if (next.grants.length > MAX_GRANTS) throw new NativeSpeechError("invalid");
    try {
      await this.persist(next);
    } catch {
      this.poisoned = true;
      throw new NativeSpeechError("unavailable");
    }
    this.value = next;
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const turn of this.turns.values()) turn.abort.abort();
    await this.lock;
    await Promise.all([...this.turns.values()].map((turn) => turn.done));
    this.unsubscribe();
  }
}

export async function loadNativeSpeechConfiguration(
  directory: string,
): Promise<NativeSpeechConfiguration | undefined> {
  const path = join(directory, SPEECH_CONFIGURATION_FILE);
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new NativeSpeechError("unavailable");
  }
  try {
    const value = record(await readPrivateJson(directory, SPEECH_CONFIGURATION_FILE, 4096));
    if (
      !exact(value, ["version", "executable", "model"]) ||
      value.version !== 1 ||
      typeof value.executable !== "string" ||
      typeof value.model !== "string" ||
      !isAbsolute(value.executable) ||
      !isAbsolute(value.model) ||
      value.executable.includes("\0") ||
      value.model.includes("\0")
    )
      throw new Error();
    return { executable: value.executable, model: value.model };
  } catch {
    throw new NativeSpeechError("unavailable");
  }
}

async function openAuthority(
  directory: string,
): Promise<{ value: AuthorityState; persist: (value: AuthorityState) => Promise<void> }> {
  await ensureFile(directory, SPEECH_AUTHORITY_FILE, { version: 1, grants: [] });
  const value = state(await readPrivateJson(directory, SPEECH_AUTHORITY_FILE, MAX_AUTHORITY_BYTES));
  return {
    value,
    persist: (next) =>
      writePrivateJson(directory, SPEECH_AUTHORITY_FILE, state(next), MAX_AUTHORITY_BYTES),
  };
}
function privateStats(value: Stats, kind: "directory" | "file"): void {
  if (
    value.isSymbolicLink() ||
    (kind === "directory" ? !value.isDirectory() : !value.isFile()) ||
    (value.mode & 0o777) !== (kind === "directory" ? 0o700 : 0o600) ||
    (process.getuid && value.uid !== process.getuid()) ||
    (kind === "file" && value.nlink !== 1)
  )
    throw new Error();
}
async function ensureFile(directory: string, file: string, empty: unknown): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const dir = await lstat(directory);
  privateStats(dir, "directory");
  const path = join(directory, file);
  try {
    await lstat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
    await syncDir(directory, dir);
  } finally {
    await rm(temp, { force: true });
  }
}
async function readPrivateJson(directory: string, file: string, maximum: number): Promise<unknown> {
  const dir = await lstat(directory);
  privateStats(dir, "directory");
  const path = join(directory, file);
  const before = await lstat(path);
  privateStats(before, "file");
  if (before.size > maximum) throw new Error();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const actual = await handle.stat();
    privateStats(actual, "file");
    if (actual.dev !== before.dev || actual.ino !== before.ino) throw new Error();
    const data = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < data.length) {
      const part = await handle.read(data, length, data.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > maximum) throw new Error();
    return JSON.parse(decoder.decode(data.subarray(0, length)));
  } finally {
    await handle.close();
  }
}
async function writePrivateJson(
  directory: string,
  file: string,
  value: unknown,
  maximum: number,
): Promise<void> {
  const dir = await lstat(directory);
  privateStats(dir, "directory");
  const path = join(directory, file);
  const before = await lstat(path);
  privateStats(before, "file");
  const data = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (data.length > maximum) throw new Error();
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
    privateStats(current, "file");
    if (current.dev !== before.dev || current.ino !== before.ino) throw new Error();
    await rename(temp, path);
    privateStats(await lstat(path), "file");
    await syncDir(directory, dir);
  } finally {
    await rm(temp, { force: true });
  }
}
async function syncDir(directory: string, expected: Stats): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    privateStats(actual, "directory");
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error();
    await handle.sync();
  } finally {
    await handle.close();
  }
}
