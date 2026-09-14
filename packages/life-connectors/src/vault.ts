import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type JsonCredential = Record<string, unknown>;
type EncryptedRecord = { iv: string; ciphertext: string; tag: string };

function privatePath(path: string, directory: boolean): void {
  const info = lstatSync(path),
    expected = directory ? 0o700 : 0o600;
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.nlink !== 1) ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    (info.mode & 0o777) !== expected
  )
    throw new Error("Credential vault failed private ownership checks.");
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value))
    throw new TypeError("Credential id is invalid.");
  return value;
}

export class HostCredentialVault {
  private readonly directory: string;
  private readonly keyPath: string;
  private readonly dataPath: string;
  private key: Buffer;
  private records: Record<string, EncryptedRecord>;
  private closed = false;

  constructor(directory: string) {
    if (typeof directory !== "string" || !directory) throw new TypeError("Vault path is invalid.");
    this.directory = resolve(directory);
    this.keyPath = join(this.directory, "credential-vault.key");
    this.dataPath = join(this.directory, "credential-vault.json");
    try {
      privatePath(this.directory, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      privatePath(this.directory, true);
    }
    this.key = this.loadKey();
    this.records = this.loadRecords();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("Credential vault is closed.");
    privatePath(this.directory, true);
  }

  private loadKey(): Buffer {
    try {
      privatePath(this.keyPath, false);
      const key = readFileSync(this.keyPath);
      if (key.length !== 32) throw new Error("Credential vault key is invalid.");
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const descriptor = openSync(
        this.keyPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      const key = randomBytes(32);
      try {
        writeFileSync(descriptor, key);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      privatePath(this.keyPath, false);
      return key;
    }
  }

  private loadRecords(): Record<string, EncryptedRecord> {
    try {
      privatePath(this.dataPath, false);
      const bytes = readFileSync(this.dataPath);
      if (bytes.length > 4 * 1024 * 1024) throw new Error("Credential vault is too large.");
      const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Credential vault is invalid.");
      const records = parsed as Record<string, EncryptedRecord>;
      if (Object.keys(records).length > 256) throw new Error("Credential vault is too large.");
      for (const [id, record] of Object.entries(records)) {
        identifier(id);
        if (
          !record ||
          typeof record !== "object" ||
          typeof record.iv !== "string" ||
          typeof record.ciphertext !== "string" ||
          typeof record.tag !== "string"
        )
          throw new Error("Credential vault is invalid.");
      }
      return records;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {};
    }
  }

  private persist(records: Record<string, EncryptedRecord>): void {
    this.ensureOpen();
    const encoded = JSON.stringify(records);
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
      throw new Error("Credential vault is too large.");
    const temporary = join(
      this.directory,
      `.credential-vault.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    const descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      writeFileSync(descriptor, encoded, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      renameSync(temporary, this.dataPath);
      chmodSync(this.dataPath, 0o600);
      const directoryDescriptor = openSync(this.directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    privatePath(this.dataPath, false);
  }

  put(idInput: string, credential: object): void {
    this.ensureOpen();
    const id = identifier(idInput);
    if (!credential || typeof credential !== "object" || Array.isArray(credential))
      throw new TypeError("Credential is invalid.");
    const plaintext = JSON.stringify(credential);
    if (!plaintext || Buffer.byteLength(plaintext) > 64 * 1024)
      throw new TypeError("Credential is invalid.");
    if (!this.records[id] && Object.keys(this.records).length >= 256)
      throw new Error("Credential vault is full.");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const next = { ...this.records };
    next[id] = {
      iv: iv.toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
    };
    this.persist(next);
    this.records = next;
  }

  get<T extends object = JsonCredential>(idInput: string): T | undefined {
    this.ensureOpen();
    const id = identifier(idInput),
      record = this.records[id];
    if (!record) return;
    try {
      const iv = Buffer.from(record.iv, "base64url"),
        tag = Buffer.from(record.tag, "base64url"),
        ciphertext = Buffer.from(record.ciphertext, "base64url");
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 64 * 1024) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(id, "utf8"));
      decipher.setAuthTag(tag);
      const value = JSON.parse(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"),
      ) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as T;
    } catch {
      throw new Error("Credential vault record failed authentication.");
    }
  }

  delete(idInput: string): boolean {
    this.ensureOpen();
    const id = identifier(idInput);
    if (!this.records[id]) return false;
    const next = { ...this.records };
    delete next[id];
    this.persist(next);
    this.records = next;
    return true;
  }

  deleteMatching(predicate: (id: string, value: object) => boolean): number {
    this.ensureOpen();
    if (typeof predicate !== "function") throw new TypeError("Credential predicate is invalid.");
    const selected: string[] = [];
    for (const id of Object.keys(this.records).sort()) {
      const value = this.get(id);
      if (value && predicate(id, value)) selected.push(id);
    }
    if (!selected.length) return 0;
    const next = { ...this.records };
    for (const id of selected) delete next[id];
    this.persist(next);
    this.records = next;
    return selected.length;
  }

  clear(): void {
    this.ensureOpen();
    this.persist({});
    this.records = {};
  }

  close(): void {
    if (this.closed) return;
    this.key.fill(0);
    this.records = {};
    this.closed = true;
  }
}
