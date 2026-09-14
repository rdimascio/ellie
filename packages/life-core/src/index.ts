import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const LIFE_SCHEMA_VERSION = 3;
export const LIFE_RECORD_KINDS = [
  "memory",
  "contact",
  "place",
  "reminder",
  "timer",
  "event",
  "birthday",
  "holiday",
  "need",
  "goal",
  "routine",
  "source",
  "feedback",
] as const;
export type LifeRecordKind = (typeof LIFE_RECORD_KINDS)[number];
export type LifeScope = { type: "user" | "group"; id: string };
export type LifeActor = { userId: string };
export type Provenance = {
  sourceId: string;
  reference?: string;
  derived?: boolean;
  invalidatedAt?: number;
};
export type Relationship = { type: string; targetId: string };
export interface LifeRecord {
  id: string;
  kind: LifeRecordKind;
  title: string;
  body?: string;
  scope: LifeScope;
  data: Record<string, unknown>;
  relationships: Relationship[];
  provenance: Provenance[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface ResolvedSettings {
  values: Record<string, unknown>;
  origins: Record<string, "default" | "group" | "user" | "task">;
}
export interface SearchResult {
  sourceId: string;
  sourceTitle: string;
  chunkIndex: number;
  text: string;
  reference?: string;
  score: number;
}
export interface LifeRecordSummary {
  id: string;
  kind: LifeRecordKind;
  title: string;
  hasMoreTitle: boolean;
  scope: LifeScope;
  data: Record<string, unknown>;
  bodyPreview?: string;
  hasMoreBody: boolean;
  relationshipCount: number;
  relatedCompleted: boolean;
  provenanceStatus: "valid" | "needs-review";
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface LifeRecordSummaryPage {
  items: LifeRecordSummary[];
  hasMore: boolean;
  nextCursor?: string;
}
export interface ImportItem {
  key: string;
  kind: Extract<LifeRecordKind, "event" | "holiday" | "contact" | "birthday">;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  relatedKeys: Array<{ type: string; targetKey: string }>;
  warnings: string[];
}
export interface ImportCommitResult {
  source: LifeRecord;
  records: LifeRecord[];
  created: number;
  updated: number;
  unchanged: number;
  conflicts: Array<{ key: string; recordId: string; warning: string }>;
}
export interface NotificationUpdateResult {
  notification: LifeRecord;
  linked?: LifeRecord;
}
export type PersonalLifeExportItem =
  | { type: "record"; record: LifeRecord }
  | { type: "setting"; key: string; value: unknown; updatedAt: number }
  | { type: "conversation"; conversation: ConversationSummary }
  | { type: "conversation-turn"; conversationId: string; turn: ConversationTurn };
export interface PersonalLifeSummary {
  generation: number;
  records: number;
  sources: number;
  feedback: number;
  guidance: number;
  settings: number;
  conversations: number;
  conversationTurns: number;
  bytes: number;
}
export interface PersonalLifeExportPage {
  format: "ellie-life-v1";
  generation: number;
  items: PersonalLifeExportItem[];
  nextCursor?: string;
}
export interface PersonalResetJournal {
  userId: string;
  operationId: string;
  reviewTokenHash: string;
  state: "draining" | "tasks-deleted" | "plugins-deleted" | "life-deleted" | "completed";
  lifeGeneration: number;
  taskGeneration: number;
  pluginGeneration: number;
  requestedAt: number;
  updatedAt: number;
}
export interface ConversationSummary {
  id: string;
  scope: LifeScope;
  title: string;
  revision: number;
  turnCount: number;
  pending: boolean;
  createdAt: number;
  updatedAt: number;
}
export interface ConversationEvidence {
  sourceId: string;
  sourceRevision: number;
  title: string;
  reference?: string;
}
export interface ConversationResult {
  reply: string;
  actions: Array<{ label: string; status: string }>;
  recordIds: string[];
  taskIds: string[];
  evidence: ConversationEvidence[];
}
export interface ConversationTurn {
  id: string;
  requestId: string;
  user: string;
  assistant?: string;
  status: "pending" | "completed" | "interrupted";
  outdated: boolean;
  evidence: ConversationEvidence[];
  actions: Array<{ label: string; status: string }>;
  createdAt: number;
  updatedAt: number;
}
export interface ConversationPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}
export interface ConversationIndex extends ConversationPage<ConversationSummary> {
  chatEpoch: number;
}
export type SourceFormat = "text" | "markdown" | "html" | "email" | "transcript" | "binary";
export type TextSourceFormat = Exclude<SourceFormat, "binary">;
export interface BinaryExtractor {
  extract(
    input: Uint8Array,
    metadata?: Record<string, unknown>,
  ): { text: string; chunks?: Array<{ text: string; reference?: string }> };
}

export class LifeConflictError extends Error {
  override name = "LifeConflictError";
}
export class LifeAccessError extends Error {
  override name = "LifeAccessError";
}

const MAX_TEXT = 100_000,
  MAX_BODY = 5_000_000,
  MAX_JSON = 256_000,
  MAX_ARRAY = 1000,
  MAX_DEPTH = 12,
  MAX_RECORDS_PER_SCOPE = 10_000,
  MAX_SOURCES_PER_SCOPE = 1_000,
  MAX_CHUNKS_PER_SCOPE = 100_000;
const SUMMARY_DATA_KEYS = [
  "date",
  "dueAt",
  "startAt",
  "startsAt",
  "startDate",
  "deadline",
  "nextDate",
  "month",
  "day",
  "timeZone",
  "completed",
  "cancelled",
  "type",
  "notification",
  "category",
  "dismissed",
  "reminderId",
  "relatedRecordId",
  "deliveredAt",
  "expiresAt",
  "trainingEligible",
  "taskId",
  "format",
  "enabled",
  "status",
  "version",
] as const;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const kinds = new Set<string>(LIFE_RECORD_KINDS);
const formats = new Set<string>(["text", "markdown", "html", "email", "transcript", "binary"]);
function isAuthoritySetting(key: string): boolean {
  return /(^|[.:/])(permission|permissions|authority|authorization|auth|capability|capabilities|membership|role)([.:/]|$)/i.test(
    key,
  );
}
function settingValue(key: string, value: unknown): unknown {
  const checked = jsonValue(value, "setting.value");
  if (key === "timeZone") {
    if (typeof checked !== "string") throw new TypeError("timeZone must be an IANA time zone");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: checked }).format(0);
    } catch {
      throw new TypeError("timeZone must be an IANA time zone");
    }
  } else if (
    (key === "proactiveSuggestions" || key === "proactive") &&
    typeof checked !== "boolean"
  ) {
    throw new TypeError(`${key} must be a boolean`);
  } else if (key === "quietHours") {
    if (checked === null) return checked;
    if (typeof checked !== "object" || Array.isArray(checked))
      throw new TypeError("quietHours must be an object");
    const quiet = checked as Record<string, unknown>;
    if (
      (quiet.enabled !== undefined && typeof quiet.enabled !== "boolean") ||
      !["start", "end"].every(
        (field) =>
          quiet[field] === null ||
          (typeof quiet[field] === "number" &&
            Number.isFinite(quiet[field]) &&
            quiet[field] >= 0 &&
            quiet[field] <= 24),
      )
    )
      throw new TypeError("quietHours start/end must be from 0 through 24");
  }
  return checked;
}
function text(value: unknown, label: string, max = MAX_TEXT): string {
  const hasDisallowedControl =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && code !== 9 && code !== 10 && code !== 13;
    });
  if (typeof value !== "string" || value.length < 1 || value.length > max || hasDisallowedControl)
    throw new TypeError(`${label} is invalid`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = text(value, label, 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) throw new TypeError(`${label} is invalid`);
  return result;
}
function jsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new TypeError(`${label} is too deeply nested`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) throw new TypeError(`${label} has too many items`);
    return value.map((item) => jsonValue(item, label, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_ARRAY) throw new TypeError(`${label} has too many fields`);
    const result: Record<string, unknown> = {};
    for (const [rawKey, item] of entries) {
      const key = text(rawKey, `${label} key`, 200);
      if (unsafeKeys.has(key)) throw new TypeError(`${label} contains an unsafe key`);
      Object.defineProperty(result, key, {
        value: jsonValue(item, label, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  throw new TypeError(`${label} must contain JSON values`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  const checked = jsonValue(value, label) as Record<string, unknown>;
  if (JSON.stringify(checked).length > MAX_JSON) throw new TypeError(`${label} is too large`);
  return checked;
}
function privatePath(path: string, kind: "directory" | "file"): void {
  const stat = lstatSync(path),
    expected = kind === "directory" ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== expected ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (kind === "file" && stat.nlink !== 1)
  )
    throw new Error(`life database ${kind} failed private ownership checks`);
}
function recoveryError(): Error {
  return new Error(
    "Life database could not be opened safely. Stop Ellie, preserve it for diagnosis, and restore a supported backup or move it aside before restarting.",
  );
}
function tokens(value: string): string[] {
  return [...new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 32);
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function cleanContent(format: SourceFormat, content: string): string {
  if (format === "html")
    return content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ");
  return content;
}
function chunks(content: string): Array<{ text: string; reference?: string }> {
  const paragraphs = content
      .split(/\n\s*\n/)
      .map((v) => v.trim())
      .filter(Boolean),
    result: Array<{ text: string; reference?: string }> = [];
  let buffer = "";
  for (let paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > 1600) {
      result.push({ text: buffer });
      buffer = "";
    }
    while (paragraph.length > 2000) {
      result.push({ text: paragraph.slice(0, 2000) });
      paragraph = paragraph.slice(2000);
    }
    buffer += `${buffer ? "\n\n" : ""}${paragraph}`;
  }
  if (buffer) result.push({ text: buffer });
  return result.slice(0, 10_000);
}

export class LifeStore {
  private readonly db!: DatabaseSync;
  private readonly clock: () => number;
  private readonly makeId: () => string;
  readonly path: string;
  constructor(path: string, options: { now?: number | (() => number); id?: () => string } = {}) {
    this.path = path;
    const fixedNow = options.now;
    this.clock = typeof fixedNow === "function" ? fixedNow : () => fixedNow ?? Date.now();
    this.makeId = options.id ?? randomUUID;
    try {
      const directory = dirname(path);
      try {
        privatePath(directory, "directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        privatePath(directory, "directory");
      }
      try {
        privatePath(path, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
        closeSync(fd);
        privatePath(path, "file");
      }
      this.db = new DatabaseSync(path);
      this.db.exec(
        "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA foreign_keys=ON;",
      );
      const check = this.db.prepare("PRAGMA quick_check").get() as
        | Record<string, unknown>
        | undefined;
      if (!check || Object.values(check)[0] !== "ok") throw new Error("integrity");
      const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version);
      if (version > LIFE_SCHEMA_VERSION) throw new Error("newer schema");
      if (version === 0) this.migrate();
      else if (version === 1) this.migrateV2();
      else if (version === 2) this.migrateV3();
      this.db
        .prepare(
          "UPDATE conversation_turns SET status='interrupted',updated_at=? WHERE status='pending'",
        )
        .run(this.clock());
    } catch (error) {
      try {
        this.db!.close();
      } catch {}
      if (error instanceof Error && /locked/i.test(error.message))
        throw new Error("Life database is already in use by another coordinator.");
      throw recoveryError();
    }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private migrate(): void {
    this.transaction(() =>
      this.db.exec(`
    CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
    CREATE TABLE group_members(group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,user_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('owner','member')),PRIMARY KEY(group_id,user_id)) STRICT;
    CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT,scope_type TEXT NOT NULL CHECK(scope_type IN('user','group')),scope_id TEXT NOT NULL,data_json TEXT NOT NULL,relationships_json TEXT NOT NULL,provenance_json TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE INDEX records_scope ON records(scope_type,scope_id,updated_at);
    CREATE TABLE settings(level TEXT NOT NULL CHECK(level IN('default','group','user')),scope_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(level,scope_id,key)) STRICT;
    CREATE TABLE source_chunks(source_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,chunk_index INTEGER NOT NULL,text TEXT NOT NULL,reference TEXT,search_text TEXT NOT NULL,PRIMARY KEY(source_id,chunk_index)) STRICT;
    CREATE INDEX chunks_search ON source_chunks(search_text);
    PRAGMA user_version=1;`),
    );
    this.migrateV2();
  }
  private migrateV2(): void {
    this.transaction(() =>
      this.db.exec(`
    CREATE TABLE IF NOT EXISTS personal_generations(user_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE IF NOT EXISTS personal_reset_journal(user_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,review_token_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('draining','tasks-deleted','plugins-deleted','life-deleted','completed')),life_generation INTEGER NOT NULL,task_generation INTEGER NOT NULL,plugin_generation INTEGER NOT NULL,requested_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE TRIGGER IF NOT EXISTS records_personal_insert AFTER INSERT ON records WHEN NEW.scope_type='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(NEW.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS records_personal_update AFTER UPDATE ON records WHEN OLD.scope_type='user' OR NEW.scope_type='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(OLD.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; INSERT INTO personal_generations(user_id,generation) SELECT NEW.scope_id,1 WHERE NEW.scope_id<>OLD.scope_id ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS records_personal_delete AFTER DELETE ON records WHEN OLD.scope_type='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(OLD.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS settings_personal_insert AFTER INSERT ON settings WHEN NEW.level='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(NEW.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS settings_personal_update AFTER UPDATE ON settings WHEN OLD.level='user' OR NEW.level='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(OLD.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER IF NOT EXISTS settings_personal_delete AFTER DELETE ON settings WHEN OLD.level='user' BEGIN INSERT INTO personal_generations(user_id,generation) VALUES(OLD.scope_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    PRAGMA user_version=2;`),
    );
    this.migrateV3();
  }
  private migrateV3(): void {
    this.transaction(() =>
      this.db.exec(`
    CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,scope_type TEXT NOT NULL CHECK(scope_type IN('user','group')),scope_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    CREATE INDEX conversations_user ON conversations(user_id,updated_at,id);
    CREATE TABLE conversation_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,user_id TEXT NOT NULL,request_id TEXT NOT NULL,user_content TEXT NOT NULL,assistant_content TEXT,status TEXT NOT NULL CHECK(status IN('pending','completed','interrupted')),result_json TEXT,evidence_json TEXT NOT NULL,context_fingerprint TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(user_id,request_id)) STRICT;
    CREATE TABLE chat_state(user_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>=1)) STRICT;
    CREATE TABLE conversation_request_tombstones(user_id TEXT NOT NULL,epoch INTEGER NOT NULL,request_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,epoch,request_hash)) STRICT;
    CREATE INDEX conversation_turns_page ON conversation_turns(conversation_id,created_at,id);
    CREATE TRIGGER conversations_generation_insert AFTER INSERT ON conversations BEGIN INSERT INTO personal_generations VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER conversations_generation_update AFTER UPDATE ON conversations BEGIN INSERT INTO personal_generations VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER conversations_generation_delete AFTER DELETE ON conversations BEGIN INSERT INTO personal_generations VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER conversation_turns_generation_insert AFTER INSERT ON conversation_turns BEGIN INSERT INTO personal_generations VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER conversation_turns_generation_update AFTER UPDATE ON conversation_turns BEGIN INSERT INTO personal_generations VALUES(NEW.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    CREATE TRIGGER conversation_turns_generation_delete AFTER DELETE ON conversation_turns BEGIN INSERT INTO personal_generations VALUES(OLD.user_id,1) ON CONFLICT(user_id) DO UPDATE SET generation=generation+1; END;
    UPDATE conversation_turns SET status='interrupted',updated_at=${this.clock()} WHERE status='pending';
    PRAGMA user_version=3;`),
    );
  }
  private actor(actor: LifeActor): string {
    return identifier(actor?.userId, "actor.userId");
  }
  private personalGeneration(userId: string): number {
    return Number(
      (
        this.db
          .prepare("SELECT generation FROM personal_generations WHERE user_id=?")
          .get(userId) as Record<string, unknown> | undefined
      )?.generation ?? 0,
    );
  }
  private canAccess(userId: string, scope: LifeScope): boolean {
    if (scope.type === "user") return scope.id === userId;
    return !!this.db
      .prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?")
      .get(scope.id, userId);
  }
  private scope(actor: LifeActor, scope: LifeScope): LifeScope {
    const userId = this.actor(actor);
    if (!scope || !["user", "group"].includes(scope.type))
      throw new TypeError("scope.type is invalid");
    const id = identifier(scope.id, "scope.id");
    if (scope.type === "user" && id !== userId)
      throw new LifeAccessError("Private scope belongs to another user");
    if (!this.canAccess(userId, { type: scope.type, id }))
      throw new LifeAccessError("Actor is not a member of this group");
    return { type: scope.type, id };
  }
  private owner(actor: LifeActor, groupId: string): string {
    const userId = this.actor(actor),
      id = identifier(groupId, "groupId");
    if (
      !this.db
        .prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=? AND role='owner'")
        .get(id, userId)
    )
      throw new LifeAccessError("Group owner access required");
    return id;
  }
  createGroup(
    actor: LifeActor,
    input: { id?: string; name: string },
  ): { id: string; name: string } {
    const userId = this.actor(actor),
      id = input.id ? identifier(input.id, "group.id") : this.makeId(),
      name = text(input.name, "group.name", 500),
      now = this.clock();
    this.transaction(() => {
      this.db.prepare("INSERT INTO groups VALUES(?,?,?)").run(id, name, now);
      this.db.prepare("INSERT INTO group_members VALUES(?,?,'owner')").run(id, userId);
    });
    return { id, name };
  }
  setGroupMember(
    actor: LifeActor,
    groupId: string,
    input: { userId: string; role: "owner" | "member" } | { userId: string; remove: true },
  ): void {
    const id = this.owner(actor, groupId),
      user = identifier(input.userId, "member.userId");
    this.transaction(() => {
      if ("remove" in input) {
        const row = this.db
          .prepare("SELECT role FROM group_members WHERE group_id=? AND user_id=?")
          .get(id, user) as { role?: string } | undefined;
        if (
          row?.role === "owner" &&
          Number(
            this.db
              .prepare("SELECT count(*) count FROM group_members WHERE group_id=? AND role='owner'")
              .get(id)?.count,
          ) <= 1
        )
          throw new Error("A group must retain an owner");
        this.db.prepare("DELETE FROM group_members WHERE group_id=? AND user_id=?").run(id, user);
      } else {
        if (!["owner", "member"].includes(input.role))
          throw new TypeError("member.role is invalid");
        this.db
          .prepare(
            "INSERT INTO group_members VALUES(?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET role=excluded.role",
          )
          .run(id, user, input.role);
      }
    });
  }
  listGroups(actor: LifeActor): Array<{ id: string; name: string; role: "owner" | "member" }> {
    const user = this.actor(actor);
    return this.db
      .prepare(
        "SELECT g.id,g.name,m.role FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.name",
      )
      .all(user) as Array<{ id: string; name: string; role: "owner" | "member" }>;
  }
  private record(row: Record<string, unknown>): LifeRecord {
    return {
      id: String(row.id),
      kind: row.kind as LifeRecordKind,
      title: String(row.title),
      ...(row.body === null ? {} : { body: String(row.body) }),
      scope: { type: row.scope_type as "user" | "group", id: String(row.scope_id) },
      data: JSON.parse(String(row.data_json)),
      relationships: JSON.parse(String(row.relationships_json)),
      provenance: JSON.parse(String(row.provenance_json)),
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  private relations(value: Relationship[] | undefined): Relationship[] {
    const v = value ?? [];
    if (!Array.isArray(v) || v.length > MAX_ARRAY) throw new TypeError("relationships are invalid");
    return v.map((x) => ({
      type: text(x?.type, "relationship.type", 100),
      targetId: identifier(x?.targetId, "relationship.targetId"),
    }));
  }
  private provenance(value: Provenance[] | undefined): Provenance[] {
    const v = value ?? [];
    if (!Array.isArray(v) || v.length > MAX_ARRAY) throw new TypeError("provenance is invalid");
    return v.map((x) => {
      if (x?.derived !== undefined && typeof x.derived !== "boolean")
        throw new TypeError("provenance.derived is invalid");
      if (
        x?.invalidatedAt !== undefined &&
        (!Number.isSafeInteger(x.invalidatedAt) || x.invalidatedAt < 0)
      )
        throw new TypeError("provenance.invalidatedAt is invalid");
      return {
        sourceId: identifier(x?.sourceId, "provenance.sourceId"),
        ...(x.reference === undefined
          ? {}
          : { reference: text(x.reference, "provenance.reference", 1000) }),
        ...(x.derived === undefined ? {} : { derived: x.derived }),
        ...(x.invalidatedAt === undefined ? {} : { invalidatedAt: x.invalidatedAt }),
      };
    });
  }
  private validateLinks(
    actor: LifeActor,
    scope: LifeScope,
    relationships: Relationship[],
    provenance: Provenance[],
  ): void {
    for (const relationship of relationships) {
      const target = this.getRecord(actor, relationship.targetId);
      if (!target || target.scope.type !== scope.type || target.scope.id !== scope.id)
        throw new LifeAccessError("Relationship target must be readable in the same scope");
    }
    for (const item of provenance) {
      const source = this.getRecord(actor, item.sourceId);
      if (
        !source ||
        source.kind !== "source" ||
        source.scope.type !== scope.type ||
        source.scope.id !== scope.id
      )
        throw new LifeAccessError("Provenance source must be readable in the same scope");
    }
  }
  createRecord(
    actor: LifeActor,
    input: {
      id?: string;
      kind: LifeRecordKind;
      title: string;
      body?: string;
      scope: LifeScope;
      data?: Record<string, unknown>;
      relationships?: Relationship[];
      provenance?: Provenance[];
    },
  ): LifeRecord {
    this.actor(actor);
    if (!kinds.has(input.kind)) throw new TypeError("record.kind is invalid");
    const scope = this.scope(actor, input.scope),
      id = input.id ? identifier(input.id, "record.id") : this.makeId(),
      title = text(input.title, "record.title", 2000),
      body = input.body === undefined ? null : text(input.body, "record.body", MAX_BODY),
      data = object(input.data ?? {}, "record.data"),
      relationships = this.relations(input.relationships),
      provenance = this.provenance(input.provenance),
      now = this.clock();
    this.validateLinks(actor, scope, relationships, provenance);
    const count = Number(
      (
        this.db
          .prepare("SELECT count(*) count FROM records WHERE scope_type=? AND scope_id=?")
          .get(scope.type, scope.id) as { count: number }
      ).count,
    );
    if (count >= MAX_RECORDS_PER_SCOPE)
      throw new LifeConflictError("Record quota reached for this scope");
    this.db
      .prepare("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        id,
        input.kind,
        title,
        body,
        scope.type,
        scope.id,
        JSON.stringify(data),
        JSON.stringify(relationships),
        JSON.stringify(provenance),
        1,
        now,
        now,
      );
    return this.getRecord(actor, id)!;
  }
  getRecord(actor: LifeActor, id: string): LifeRecord | undefined {
    const user = this.actor(actor),
      row = this.db.prepare("SELECT * FROM records WHERE id=?").get(identifier(id, "record.id")) as
        | Record<string, unknown>
        | undefined;
    if (!row) return undefined;
    const record = this.record(row);
    if (!this.canAccess(user, record.scope)) return undefined;
    return record;
  }
  listRecords(
    actor: LifeActor,
    query: { scope?: LifeScope; kinds?: LifeRecordKind[]; limit?: number } = {},
  ): LifeRecord[] {
    const user = this.actor(actor),
      limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const requestedKinds = query.kinds?.map((kind) => {
      if (!kinds.has(kind)) throw new TypeError("record kind is invalid");
      return kind;
    });
    if (requestedKinds?.length === 0) return [];
    const kindSql = requestedKinds
      ? ` AND kind IN (${requestedKinds.map(() => "?").join(",")})`
      : "";
    let rows: Record<string, unknown>[];
    if (query.scope) {
      const scope = this.scope(actor, query.scope);
      rows = this.db
        .prepare(
          `SELECT * FROM records WHERE scope_type=? AND scope_id=?${kindSql} ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(scope.type, scope.id, ...(requestedKinds ?? []), limit) as Record<string, unknown>[];
    } else
      rows = this.db
        .prepare(
          `SELECT r.* FROM records r WHERE ((r.scope_type='user' AND r.scope_id=?) OR (r.scope_type='group' AND EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=r.scope_id AND m.user_id=?)))${kindSql} ORDER BY r.updated_at DESC LIMIT ?`,
        )
        .all(user, user, ...(requestedKinds ?? []), limit) as Record<string, unknown>[];
    return rows.map((r) => this.record(r));
  }
  listRecordSummaries(
    actor: LifeActor,
    query: { scope: LifeScope; kinds?: LifeRecordKind[]; limit?: number; cursor?: string },
  ): LifeRecordSummaryPage {
    this.actor(actor);
    const requestedLimit = query.limit ?? 100;
    if (!Number.isFinite(requestedLimit) || requestedLimit < 1)
      throw new TypeError("record summary limit is invalid");
    const scope = this.scope(actor, query.scope),
      limit = Math.min(500, Math.trunc(requestedLimit)),
      requestedKinds = query.kinds?.map((kind) => {
        if (!kinds.has(kind)) throw new TypeError("record kind is invalid");
        return kind;
      });
    if (requestedKinds?.length === 0) return { items: [], hasMore: false };
    const filter = requestedKinds?.join(",") ?? "*";
    let cursor: { updatedAt: number; id: string } | undefined;
    if (query.cursor !== undefined) {
      try {
        if (query.cursor.length > 500) throw new Error();
        const parsed = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as {
          updatedAt?: unknown;
          id?: unknown;
          scope?: unknown;
          filter?: unknown;
        };
        if (
          !Number.isSafeInteger(parsed.updatedAt) ||
          Number(parsed.updatedAt) < 0 ||
          parsed.scope !== `${scope.type}:${scope.id}` ||
          parsed.filter !== filter
        )
          throw new Error();
        cursor = { updatedAt: Number(parsed.updatedAt), id: identifier(parsed.id, "cursor.id") };
      } catch {
        throw new TypeError("record cursor is invalid");
      }
    }
    const kindSql = requestedKinds
        ? ` AND r.kind IN (${requestedKinds.map(() => "?").join(",")})`
        : "",
      cursorSql = cursor ? " AND (r.updated_at < ? OR (r.updated_at=? AND r.id < ?))" : "",
      summaryDataSql = SUMMARY_DATA_KEYS.map(
        (key, index) =>
          `json_type(r.data_json,'$.${key}') data_type_${index},substr(CAST(json_extract(r.data_json,'$.${key}') AS TEXT),1,501) data_value_${index}`,
      ).join(","),
      rows = this.db
        .prepare(
          `SELECT r.id,r.kind,substr(r.title,1,240) title_preview,length(r.title)>240 has_more_title,r.scope_type,r.scope_id,r.revision,r.created_at,r.updated_at,substr(r.body,1,240) body_preview,length(r.body)>240 has_more_body,json_array_length(r.relationships_json) relationship_count,EXISTS(SELECT 1 FROM json_each(r.provenance_json) WHERE json_type(value,'$.invalidatedAt') IS NOT NULL) provenance_invalid,EXISTS(SELECT 1 FROM json_each(r.relationships_json) rel JOIN records target ON target.id=json_extract(rel.value,'$.targetId') WHERE json_extract(rel.value,'$.type')='need' AND target.kind='need' AND target.scope_type=r.scope_type AND target.scope_id=r.scope_id AND (json_extract(target.data_json,'$.completed')=1 OR json_extract(target.data_json,'$.cancelled')=1)) related_completed,${summaryDataSql},substr(CAST(json_extract(r.data_json,'$.metadata.filename') AS TEXT),1,501) metadata_filename,substr(CAST(json_extract(r.data_json,'$.metadata.mimeType') AS TEXT),1,201) metadata_mime_type FROM records r WHERE r.scope_type=? AND r.scope_id=?${kindSql}${cursorSql} ORDER BY r.updated_at DESC,r.id DESC LIMIT ?`,
        )
        .all(
          scope.type,
          scope.id,
          ...(requestedKinds ?? []),
          ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
          limit + 1,
        ) as Record<string, unknown>[],
      hasMore = rows.length > limit,
      selected = rows.slice(0, limit),
      items = selected.map((row): LifeRecordSummary => {
        const data: Record<string, unknown> = {};
        for (const [index, key] of SUMMARY_DATA_KEYS.entries()) {
          const type = row[`data_type_${index}`],
            raw = row[`data_value_${index}`];
          if (type === "true" || type === "false") data[key] = type === "true";
          else if ((type === "integer" || type === "real") && Number.isFinite(Number(raw)))
            data[key] = Number(raw);
          else if (type === "text" && typeof raw === "string" && raw.length <= 500) data[key] = raw;
        }
        const filename = row.metadata_filename,
          mimeType = row.metadata_mime_type;
        if (
          (typeof filename === "string" && filename.length <= 500) ||
          (typeof mimeType === "string" && mimeType.length <= 200)
        )
          data.metadata = {
            ...(typeof filename === "string" && filename.length <= 500 ? { filename } : {}),
            ...(typeof mimeType === "string" && mimeType.length <= 200 ? { mimeType } : {}),
          };
        return {
          id: String(row.id),
          kind: row.kind as LifeRecordKind,
          title: String(row.title_preview),
          hasMoreTitle: Boolean(row.has_more_title),
          scope: { type: row.scope_type as "user" | "group", id: String(row.scope_id) },
          data,
          ...(row.body_preview === null ? {} : { bodyPreview: String(row.body_preview) }),
          hasMoreBody: Boolean(row.has_more_body),
          relationshipCount: Number(row.relationship_count),
          relatedCompleted: Boolean(row.related_completed),
          provenanceStatus: row.provenance_invalid ? "needs-review" : "valid",
          revision: Number(row.revision),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
        };
      });
    const last = items.at(-1);
    return {
      items,
      hasMore,
      ...(hasMore && last
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                updatedAt: last.updatedAt,
                id: last.id,
                scope: `${scope.type}:${scope.id}`,
                filter,
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  updateRecord(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    patch: {
      title?: string;
      body?: string | null;
      data?: Record<string, unknown>;
      relationships?: Relationship[];
      provenance?: Provenance[];
    },
  ): LifeRecord {
    const current = this.getRecord(actor, id);
    if (!current) throw new LifeAccessError("Record unavailable");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new TypeError("expectedRevision is invalid");
    const title =
        patch.title === undefined ? current.title : text(patch.title, "record.title", 2000),
      body =
        patch.body === undefined
          ? (current.body ?? null)
          : patch.body === null
            ? null
            : text(patch.body, "record.body", MAX_BODY),
      data = patch.data === undefined ? current.data : object(patch.data, "record.data"),
      relationships =
        patch.relationships === undefined
          ? current.relationships
          : this.relations(patch.relationships),
      provenance =
        patch.provenance === undefined ? current.provenance : this.provenance(patch.provenance),
      now = this.clock();
    this.validateLinks(actor, current.scope, relationships, provenance);
    const changed = this.db
      .prepare(
        "UPDATE records SET title=?,body=?,data_json=?,relationships_json=?,provenance_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
      )
      .run(
        title,
        body,
        JSON.stringify(data),
        JSON.stringify(relationships),
        JSON.stringify(provenance),
        now,
        current.id,
        expectedRevision,
      );
    if (changed.changes !== 1) throw new LifeConflictError("Record changed since it was read");
    return this.getRecord(actor, current.id)!;
  }
  deleteRecord(actor: LifeActor, id: string, expectedRevision: number): void {
    this.transaction(() => {
      const current = this.getRecord(actor, id);
      if (!current) throw new LifeAccessError("Record unavailable");
      const changed = this.db
        .prepare("DELETE FROM records WHERE id=? AND revision=?")
        .run(current.id, expectedRevision);
      if (changed.changes !== 1) throw new LifeConflictError("Record changed since it was read");
      if (current.kind === "source") this.invalidateProvenance(current.id, this.clock());
    });
  }
  private setting(
    level: "default" | "group" | "user",
    scopeId: string,
    key: string,
    value: unknown,
  ): void {
    const k = text(key, "setting.key", 200);
    if (unsafeKeys.has(k)) throw new TypeError("setting.key is unsafe");
    if (isAuthoritySetting(k))
      throw new LifeAccessError("Permissions cannot be changed through settings");
    const checked = settingValue(k, value);
    if (JSON.stringify(checked).length > MAX_JSON)
      throw new TypeError("setting.value is too large");
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?,?,?,?) ON CONFLICT(level,scope_id,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
      )
      .run(level, scopeId, k, JSON.stringify(checked), this.clock());
  }
  setDefaultSetting(key: string, value: unknown): void {
    this.setting("default", "*", key, value);
  }
  setUserSetting(actor: LifeActor, key: string, value: unknown): void {
    this.setting("user", this.actor(actor), key, value);
  }
  setGroupSetting(actor: LifeActor, groupId: string, key: string, value: unknown): void {
    this.setting("group", this.owner(actor, groupId), key, value);
  }
  setSettings(
    actor: LifeActor,
    input: {
      level: "default" | "user" | "group";
      groupId?: string;
      values: Record<string, unknown>;
    },
  ): void {
    const user = this.actor(actor),
      values = object(input.values, "settings.values"),
      entries = Object.entries(values);
    for (const [key, value] of entries) {
      if (unsafeKeys.has(key)) throw new TypeError("setting.key is unsafe");
      if (isAuthoritySetting(key))
        throw new LifeAccessError("Permissions cannot be changed through settings");
      settingValue(key, value);
    }
    let scopeId = "*";
    if (input.level === "user") scopeId = user;
    else if (input.level === "group") {
      if (!input.groupId) throw new TypeError("groupId is required for group settings");
      scopeId = this.owner(actor, input.groupId);
    } else if (input.groupId !== undefined) {
      throw new TypeError("groupId is only valid for group settings");
    }
    this.transaction(() => {
      for (const [key, value] of entries) this.setting(input.level, scopeId, key, value);
    });
  }
  deleteUserSetting(actor: LifeActor, key: string): void {
    this.db
      .prepare("DELETE FROM settings WHERE level='user' AND scope_id=? AND key=?")
      .run(this.actor(actor), text(key, "setting.key", 200));
  }
  deleteGroupSetting(actor: LifeActor, groupId: string, key: string): void {
    this.db
      .prepare("DELETE FROM settings WHERE level='group' AND scope_id=? AND key=?")
      .run(this.owner(actor, groupId), text(key, "setting.key", 200));
  }
  resolveSettings(
    actor: LifeActor,
    input: { groupId?: string; task?: Record<string, unknown> } = {},
  ): ResolvedSettings {
    const user = this.actor(actor),
      values: Record<string, unknown> = {},
      origins: ResolvedSettings["origins"] = {};
    const apply = (
      rows: Record<string, unknown>[],
      origin: keyof never | "default" | "group" | "user" | "task",
    ) => {
      for (const row of rows) {
        const key = String(row.key);
        if (unsafeKeys.has(key)) throw new TypeError("Stored setting key is unsafe");
        Object.defineProperty(values, key, {
          value: JSON.parse(String(row.value_json)),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        Object.defineProperty(origins, key, {
          value: origin,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    };
    apply(
      this.db
        .prepare("SELECT key,value_json FROM settings WHERE level='default' AND scope_id='*'")
        .all() as Record<string, unknown>[],
      "default",
    );
    if (input.groupId) {
      const id = identifier(input.groupId, "groupId");
      if (!this.canAccess(user, { type: "group", id }))
        throw new LifeAccessError("Actor is not a member of this group");
      apply(
        this.db
          .prepare("SELECT key,value_json FROM settings WHERE level='group' AND scope_id=?")
          .all(id) as Record<string, unknown>[],
        "group",
      );
    }
    apply(
      this.db
        .prepare("SELECT key,value_json FROM settings WHERE level='user' AND scope_id=?")
        .all(user) as Record<string, unknown>[],
      "user",
    );
    if (input.task) {
      for (const [key, value] of Object.entries(object(input.task, "task settings"))) {
        if (isAuthoritySetting(key))
          throw new LifeAccessError("Permissions cannot be changed through settings");
        values[key] = value;
        origins[key] = "task";
      }
    }
    return { values, origins };
  }
  ingestSource(
    actor: LifeActor,
    input: {
      id?: string;
      title: string;
      scope: LifeScope;
      format: TextSourceFormat;
      content: string;
      metadata?: Record<string, unknown>;
      chunks?: Array<{ text: string; reference?: string }>;
    },
  ): LifeRecord {
    if (!formats.has(input.format)) throw new TypeError("source.format is invalid");
    return this.transaction(() => {
      const scope = this.scope(actor, input.scope);
      const sourceCount = Number(
        (
          this.db
            .prepare(
              "SELECT count(*) count FROM records WHERE kind='source' AND scope_type=? AND scope_id=?",
            )
            .get(scope.type, scope.id) as { count: number }
        ).count,
      );
      if (sourceCount >= MAX_SOURCES_PER_SCOPE)
        throw new LifeConflictError("Source quota reached for this scope");
      const content = text(input.content, "source.content", MAX_BODY),
        record = this.createRecord(actor, {
          id: input.id,
          kind: "source",
          title: input.title,
          scope: input.scope,
          body: content,
          data: {
            format: input.format,
            metadata: object(input.metadata ?? {}, "source.metadata"),
            untrustedContent: true,
          },
        });
      this.replaceChunks(record.id, input.chunks ?? chunks(cleanContent(input.format, content)));
      return record;
    });
  }
  ingestExtractedSource(
    actor: LifeActor,
    input: {
      id?: string;
      title: string;
      scope: LifeScope;
      bytes: Uint8Array;
      extractor: BinaryExtractor;
      metadata?: Record<string, unknown>;
    },
  ): LifeRecord {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength > 100_000_000)
      throw new TypeError("source bytes are invalid");
    const extraction = input.extractor.extract(input.bytes, input.metadata),
      content = text(extraction.text, "extracted text", 5_000_000);
    return this.ingestSource(actor, {
      id: input.id,
      title: input.title,
      scope: input.scope,
      format: "text",
      content,
      metadata: { ...input.metadata, originalFormat: "binary" },
      chunks: extraction.chunks,
    });
  }
  updateSource(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    input: {
      title?: string;
      format?: TextSourceFormat;
      content: string;
      metadata?: Record<string, unknown>;
      chunks?: Array<{ text: string; reference?: string }>;
    },
  ): LifeRecord {
    return this.transaction(() => {
      const current = this.getRecord(actor, id);
      if (current?.kind !== "source") throw new LifeAccessError("Source unavailable");
      const format = input.format ?? (current.data.format as TextSourceFormat);
      if (!formats.has(format)) throw new TypeError("source.format is invalid");
      const content = text(input.content, "source.content", MAX_BODY),
        updated = this.updateRecord(actor, id, expectedRevision, {
          title: input.title,
          body: content,
          data: {
            format,
            metadata: object(
              input.metadata ?? (current.data.metadata as Record<string, unknown>) ?? {},
              "source.metadata",
            ),
            untrustedContent: true,
          },
        });
      this.replaceChunks(id, input.chunks ?? chunks(cleanContent(format, content)));
      this.invalidateProvenance(id, this.clock());
      return updated;
    });
  }
  deleteSource(actor: LifeActor, id: string, expectedRevision: number): void {
    this.deleteRecord(actor, id, expectedRevision);
  }
  commitImport(
    actor: LifeActor,
    input: {
      scope: LifeScope;
      format: "ics" | "vcard";
      content: string;
      sourceTitle: string;
      contentHash: string;
      sourceId?: string;
      items: ImportItem[];
    },
  ): ImportCommitResult {
    const scope = this.scope(actor, input.scope),
      format = input.format,
      content = text(input.content, "import.content", MAX_BODY),
      sourceTitle = text(input.sourceTitle, "import.sourceTitle", 2000),
      contentHash = text(input.contentHash, "import.contentHash", 64).toLowerCase();
    if ((format !== "ics" && format !== "vcard") || !/^[a-f0-9]{64}$/.test(contentHash))
      throw new TypeError("Import format or content hash is invalid");
    if (hash(content) !== contentHash)
      throw new TypeError("Import content hash does not match content");
    if (!Array.isArray(input.items) || input.items.length > MAX_ARRAY)
      throw new TypeError("Import items are invalid");
    const sourceId = input.sourceId
        ? identifier(input.sourceId, "import.sourceId")
        : `import-source-${contentHash.slice(0, 32)}`,
      keys = new Set<string>(),
      ids = new Set<string>();
    const prepared = input.items.map((raw) => {
      const key = text(raw?.key, "import.item.key", 1000);
      if (keys.has(key)) throw new TypeError("Import item keys must be unique");
      keys.add(key);
      if (!(["event", "holiday", "contact", "birthday"] as string[]).includes(raw?.kind))
        throw new TypeError("Import item kind is invalid");
      const id = `import-item-${hash(`${sourceId}\0${key}`).slice(0, 32)}`;
      if (ids.has(id)) throw new TypeError("Import item identity collision");
      ids.add(id);
      const title = text(raw.title, "import.item.title", 2000),
        body = raw.body === undefined ? undefined : text(raw.body, "import.item.body", MAX_BODY),
        data = object(raw.data, "import.item.data"),
        related = Array.isArray(raw.relatedKeys)
          ? raw.relatedKeys.map((relation) => ({
              type: text(relation?.type, "import.relationship.type", 100),
              targetKey: text(relation?.targetKey, "import.relationship.targetKey", 1000),
            }))
          : (() => {
              throw new TypeError("Import relationships are invalid");
            })(),
        warnings = Array.isArray(raw.warnings)
          ? raw.warnings.map((warning) => text(warning, "import.warning", 2000))
          : (() => {
              throw new TypeError("Import warnings are invalid");
            })();
      if (related.length > MAX_ARRAY || warnings.length > MAX_ARRAY)
        throw new TypeError("Import item has too many relationships or warnings");
      const fingerprint = hash(
        JSON.stringify({ kind: raw.kind, title, body, data, related, warnings }),
      );
      return { key, id, kind: raw.kind, title, body, data, related, warnings, fingerprint };
    });
    for (const item of prepared)
      for (const relation of item.related)
        if (!keys.has(relation.targetKey))
          throw new TypeError("Import relationship target is not in the selected items");

    return this.transaction(() => {
      const now = this.clock(),
        priorSource = this.getRecord(actor, sourceId);
      if (
        priorSource &&
        (priorSource.kind !== "source" ||
          priorSource.scope.type !== scope.type ||
          priorSource.scope.id !== scope.id)
      )
        throw new LifeConflictError("Import source identity belongs to another record");
      if (
        priorSource &&
        (priorSource.data.importSource !== true ||
          priorSource.revision !== priorSource.data.importManagedRevision)
      )
        throw new LifeConflictError(
          "Imported source was edited; preserve it and choose a new import",
        );

      const existing = new Map<string, LifeRecord>();
      for (const item of prepared) {
        const record = this.getRecord(actor, item.id);
        if (record) existing.set(item.id, record);
      }
      const conflicts: ImportCommitResult["conflicts"] = [],
        managedIds = new Set<string>();
      for (const item of prepared) {
        const record = existing.get(item.id);
        if (!record) {
          managedIds.add(item.id);
          continue;
        }
        const managed =
          record.scope.type === scope.type &&
          record.scope.id === scope.id &&
          record.data.importSourceId === sourceId &&
          record.data.importKey === item.key &&
          record.revision === record.data.importManagedRevision;
        if (managed) managedIds.add(item.id);
        else
          conflicts.push({
            key: item.key,
            recordId: item.id,
            warning: "This imported record was edited and was preserved.",
          });
      }

      let source: LifeRecord;
      if (!priorSource) {
        const sourceCount = Number(
          this.db
            .prepare(
              "SELECT count(*) count FROM records WHERE kind='source' AND scope_type=? AND scope_id=?",
            )
            .get(scope.type, scope.id)?.count,
        );
        if (sourceCount >= MAX_SOURCES_PER_SCOPE)
          throw new LifeConflictError("Source quota reached for this scope");
        source = this.createRecord(actor, {
          id: sourceId,
          kind: "source",
          title: sourceTitle,
          body: content,
          scope,
          data: {
            format: "text",
            importFormat: format,
            importContentHash: contentHash,
            importSource: true,
            importManagedRevision: 1,
            untrustedContent: true,
          },
        });
        this.replaceChunks(source.id, chunks(content));
      } else if (priorSource.data.importContentHash === contentHash) source = priorSource;
      else {
        source = this.updateRecord(actor, priorSource.id, priorSource.revision, {
          title: sourceTitle,
          body: content,
          data: {
            ...priorSource.data,
            importFormat: format,
            importContentHash: contentHash,
            importManagedRevision: priorSource.revision + 1,
            untrustedContent: true,
          },
        });
        this.replaceChunks(source.id, chunks(content));
        this.invalidateProvenance(source.id, now, managedIds);
      }

      let created = 0,
        updated = 0,
        unchanged = 0;
      const committedIds: string[] = [];
      for (const item of prepared) {
        if (!managedIds.has(item.id)) continue;
        const prior = existing.get(item.id),
          importData = {
            ...item.data,
            importSourceId: source.id,
            importKey: item.key,
            importFingerprint: item.fingerprint,
            importWarnings: item.warnings,
            importManagedRevision: prior ? prior.revision + 1 : 1,
          };
        if (!prior) {
          this.createRecord(actor, {
            id: item.id,
            kind: item.kind,
            title: item.title,
            ...(item.body === undefined ? {} : { body: item.body }),
            scope,
            data: importData,
          });
          created++;
        } else if (prior.data.importFingerprint === item.fingerprint) {
          unchanged++;
        } else {
          this.updateRecord(actor, prior.id, prior.revision, {
            title: item.title,
            body: item.body ?? null,
            data: importData,
            relationships: [],
            provenance: [],
          });
          updated++;
        }
        committedIds.push(item.id);
      }
      const idByKey = new Map(prepared.map((item) => [item.key, item.id]));
      for (const item of prepared) {
        if (!committedIds.includes(item.id)) continue;
        const relationships = item.related.map((relation) => ({
            type: relation.type,
            targetId: idByKey.get(relation.targetKey)!,
          })),
          provenance: Provenance[] = [{ sourceId: source.id, reference: item.key, derived: true }];
        this.validateLinks(actor, scope, relationships, provenance);
        this.db
          .prepare("UPDATE records SET relationships_json=?,provenance_json=? WHERE id=?")
          .run(JSON.stringify(relationships), JSON.stringify(provenance), item.id);
      }
      return {
        source,
        records: committedIds.map((id) => this.getRecord(actor, id)!),
        created,
        updated,
        unchanged,
        conflicts,
      };
    });
  }
  private replaceChunks(
    sourceId: string,
    items: Array<{ text: string; reference?: string }>,
  ): void {
    if (!Array.isArray(items) || items.length > 10_000)
      throw new TypeError("source has too many chunks");
    const scope = this.db
      .prepare("SELECT scope_type,scope_id FROM records WHERE id=?")
      .get(sourceId) as { scope_type: string; scope_id: string } | undefined;
    if (!scope) throw new LifeAccessError("Source unavailable");
    const existing = Number(
      (
        this.db
          .prepare("SELECT count(*) count FROM source_chunks WHERE source_id=?")
          .get(sourceId) as { count: number }
      ).count,
    );
    const scoped = Number(
      (
        this.db
          .prepare(
            "SELECT count(*) count FROM source_chunks c JOIN records r ON r.id=c.source_id WHERE r.scope_type=? AND r.scope_id=?",
          )
          .get(scope.scope_type, scope.scope_id) as { count: number }
      ).count,
    );
    if (scoped - existing + items.length > MAX_CHUNKS_PER_SCOPE)
      throw new LifeConflictError("Source chunk quota reached for this scope");
    this.db.prepare("DELETE FROM source_chunks WHERE source_id=?").run(sourceId);
    const insert = this.db.prepare("INSERT INTO source_chunks VALUES(?,?,?,?,?)");
    items.forEach((item, index) => {
      const value = text(item.text, "chunk.text", 10_000),
        reference =
          item.reference === undefined ? null : text(item.reference, "chunk.reference", 1000);
      insert.run(sourceId, index, value, reference, value.toLocaleLowerCase());
    });
  }
  private invalidateProvenance(sourceId: string, at: number, exceptIds = new Set<string>()): void {
    const rows = this.db.prepare("SELECT * FROM records WHERE kind!='source'").all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const r = this.record(row),
        exempt = exceptIds.has(r.id),
        p = r.provenance.map((item) =>
          item.sourceId === sourceId && !exempt ? { ...item, invalidatedAt: at } : item,
        );
      if (JSON.stringify(p) !== JSON.stringify(r.provenance))
        this.db
          .prepare(
            "UPDATE records SET provenance_json=?,revision=revision+1,updated_at=? WHERE id=?",
          )
          .run(JSON.stringify(p), at, r.id);
    }
  }
  search(
    actor: LifeActor,
    input: { query: string; scope?: LifeScope; limit?: number },
  ): SearchResult[] {
    const user = this.actor(actor),
      terms = tokens(text(input.query, "search.query", 1000));
    if (!terms.length) return [];
    const requestedLimit = input.limit ?? 10;
    if (!Number.isFinite(requestedLimit) || requestedLimit < 1)
      throw new TypeError("search.limit is invalid");
    const limit = Math.min(50, Math.trunc(requestedLimit));
    const scoreSql = terms
      .map(() => "CASE WHEN c.search_text LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END")
      .join("+");
    const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    const candidateLimit = Math.min(1000, Math.max(200, limit * 20));
    let rows: Record<string, unknown>[];
    if (input.scope) {
      const scope = this.scope(actor, input.scope);
      rows = this.db
        .prepare(
          `SELECT c.*,r.title source_title,r.scope_type,r.scope_id,(${scoreSql}) score FROM source_chunks c JOIN records r ON r.id=c.source_id WHERE r.scope_type=? AND r.scope_id=? AND (${terms.map(() => "c.search_text LIKE ? ESCAPE '\\'").join(" OR ")}) ORDER BY score DESC,c.source_id,c.chunk_index LIMIT ?`,
        )
        .all(...patterns, scope.type, scope.id, ...patterns, candidateLimit) as Record<
        string,
        unknown
      >[];
    } else
      rows = this.db
        .prepare(
          `SELECT c.*,r.title source_title,r.scope_type,r.scope_id,(${scoreSql}) score FROM source_chunks c JOIN records r ON r.id=c.source_id WHERE ((r.scope_type='user' AND r.scope_id=?) OR (r.scope_type='group' AND EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=r.scope_id AND m.user_id=?))) AND (${terms.map(() => "c.search_text LIKE ? ESCAPE '\\'").join(" OR ")}) ORDER BY score DESC,c.source_id,c.chunk_index LIMIT ?`,
        )
        .all(...patterns, user, user, ...patterns, candidateLimit) as Record<string, unknown>[];
    return rows
      .map((row) => {
        return {
          sourceId: String(row.source_id),
          sourceTitle: String(row.source_title),
          chunkIndex: Number(row.chunk_index),
          text: String(row.text),
          ...(row.reference === null ? {} : { reference: String(row.reference) }),
          score: Number(row.score),
        };
      })
      .sort(
        (a, b) =>
          b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.chunkIndex - b.chunkIndex,
      )
      .slice(0, limit);
  }
  recordFeedback(
    actor: LifeActor,
    input: {
      scope: LifeScope;
      target?: string;
      message: string;
      explicitPreference?: { key: string; value: unknown };
    },
  ): LifeRecord {
    return this.transaction(() => {
      const record = this.createRecord(actor, {
        kind: "feedback",
        title: "Feedback",
        body: text(input.message, "feedback.message", MAX_TEXT),
        scope: input.scope,
        data: {
          ...(input.target ? { target: identifier(input.target, "feedback.target") } : {}),
          explicitPreference: input.explicitPreference ?? null,
        },
      });
      if (input.explicitPreference) {
        if (input.scope.type === "user")
          this.setUserSetting(actor, input.explicitPreference.key, input.explicitPreference.value);
        else
          this.setGroupSetting(
            actor,
            input.scope.id,
            input.explicitPreference.key,
            input.explicitPreference.value,
          );
      }
      return record;
    });
  }
  createProactiveNotification(
    actor: LifeActor,
    input: {
      scope: LifeScope;
      recordId: string;
      expectedRevision: number;
      reason: string;
      category: string;
      expiresAt: number;
      at: number;
      cooldownMs?: number;
      lastNotifiedPrice?: number;
    },
  ): LifeRecord | undefined {
    const scope = this.scope(actor, input.scope),
      recordId = identifier(input.recordId, "recordId"),
      reason = text(input.reason, "notification.reason", MAX_TEXT),
      category = text(input.category, "notification.category", 200),
      cooldownMs = input.cooldownMs ?? 12 * 60 * 60_000;
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Number.isFinite(input.at) ||
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt <= input.at ||
      !Number.isFinite(cooldownMs) ||
      cooldownMs < 0 ||
      cooldownMs > 30 * 24 * 60 * 60_000 ||
      (input.lastNotifiedPrice !== undefined &&
        (!Number.isFinite(input.lastNotifiedPrice) || input.lastNotifiedPrice < 0))
    )
      throw new TypeError("Proactive notification timing is invalid");
    return this.transaction(() => {
      const current = this.getRecord(actor, recordId);
      const duplicatePreparation =
        category === "preparation" &&
        Boolean(
          this.db
            .prepare(
              `SELECT 1 FROM records WHERE kind='feedback' AND scope_type=? AND scope_id=?
               AND json_extract(data_json,'$.notification')=1
               AND json_extract(data_json,'$.category')='preparation'
               AND json_extract(data_json,'$.relatedRecordId')=?
               AND coalesce(json_extract(data_json,'$.dismissed'),0)=0
               AND coalesce(json_extract(data_json,'$.completed'),0)=0
               AND json_extract(data_json,'$.expiresAt')>? LIMIT 1`,
            )
            .get(scope.type, scope.id, recordId, input.at),
        );
      if (
        !current ||
        duplicatePreparation ||
        current.revision !== input.expectedRevision ||
        current.scope.type !== scope.type ||
        current.scope.id !== scope.id ||
        current.data.completed === true ||
        current.data.cancelled === true ||
        (typeof current.data.lastSuggestionAt === "number" &&
          input.at - current.data.lastSuggestionAt < cooldownMs)
      )
        return undefined;
      const notification = this.createRecord(actor, {
        kind: "feedback",
        scope,
        title: current.title,
        body: reason,
        data: {
          notification: true,
          category,
          relatedRecordId: current.id,
          expiresAt: input.expiresAt,
          dismissed: false,
        },
        relationships: [{ type: "suggestion-for", targetId: current.id }],
      });
      this.updateRecord(actor, current.id, input.expectedRevision, {
        data: {
          ...current.data,
          lastSuggestionAt: input.at,
          ...(input.lastNotifiedPrice === undefined
            ? {}
            : { lastNotifiedPrice: input.lastNotifiedPrice }),
        },
      });
      return notification;
    });
  }
  updateNotification(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    action: "dismiss" | "complete",
    at = this.clock(),
  ): NotificationUpdateResult {
    if (!Number.isFinite(at)) throw new TypeError("Notification timestamp is invalid");
    return this.transaction(() => {
      const current = this.getRecord(actor, id),
        isNotification =
          current &&
          ((current.kind === "event" && current.data.type === "notification") ||
            (current.kind === "feedback" && current.data.notification === true));
      if (!current || !isNotification) throw new LifeAccessError("Notification unavailable");
      const notification = this.updateRecord(actor, current.id, expectedRevision, {
        data: {
          ...current.data,
          dismissed: true,
          dismissedAt: at,
          ...(action === "complete" ? { completed: true, completedAt: at } : {}),
        },
      });
      if (action === "dismiss") return { notification };
      const linkedId =
          typeof current.data.reminderId === "string"
            ? current.data.reminderId
            : typeof current.data.relatedRecordId === "string"
              ? current.data.relatedRecordId
              : current.relationships[0]?.targetId,
        linked = linkedId ? this.getRecord(actor, linkedId) : undefined;
      if (
        !linked ||
        linked.scope.type !== current.scope.type ||
        linked.scope.id !== current.scope.id ||
        !(["reminder", "need", "goal"] as LifeRecordKind[]).includes(linked.kind)
      )
        return { notification };
      return {
        notification,
        linked: this.updateRecord(actor, linked.id, linked.revision, {
          data: { ...linked.data, completed: true, completedAt: at },
        }),
      };
    });
  }
  private contextFingerprintFor(actor: LifeActor, requested: LifeScope): string {
    const scope = this.scope(actor, requested),
      digest = createHash("sha256"),
      user = this.actor(actor);
    digest.update(`${scope.type}\0${scope.id}\0`);
    const records = this.db
      .prepare(
        "SELECT id,revision,updated_at FROM records WHERE scope_type=? AND scope_id=? ORDER BY id",
      )
      .all(scope.type, scope.id) as Array<Record<string, unknown>>;
    for (const row of records) digest.update(`${row.id}\0${row.revision}\0${row.updated_at}\0`);
    const settings = this.db
      .prepare(
        "SELECT level,scope_id,key,value_json,updated_at FROM settings WHERE level='default' OR (level='user' AND scope_id=?) OR (level='group' AND scope_id=?) ORDER BY level,scope_id,key",
      )
      .all(user, scope.type === "group" ? scope.id : "") as Array<Record<string, unknown>>;
    for (const row of settings)
      digest.update(
        `${row.level}\0${row.scope_id}\0${row.key}\0${row.value_json}\0${row.updated_at}\0`,
      );
    return digest.digest("hex");
  }
  chatEpoch(actor: LifeActor): number {
    const user = this.actor(actor);
    return Number(
      (
        this.db.prepare("SELECT epoch FROM chat_state WHERE user_id=?").get(user) as
          | Record<string, unknown>
          | undefined
      )?.epoch ?? 1,
    );
  }
  private conversationRow(row: Record<string, unknown>): ConversationSummary {
    return {
      id: String(row.id),
      scope: { type: String(row.scope_type) as LifeScope["type"], id: String(row.scope_id) },
      title: String(row.title),
      revision: Number(row.revision),
      turnCount: Number(row.turn_count ?? 0),
      pending: Boolean(row.pending),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  private accessibleConversation(actor: LifeActor, idInput: string): ConversationSummary {
    const user = this.actor(actor),
      id = identifier(idInput, "conversationId"),
      row = this.db
        .prepare(
          "SELECT c.*,(SELECT count(*) FROM conversation_turns t WHERE t.conversation_id=c.id) turn_count,EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='pending') pending FROM conversations c WHERE c.id=? AND c.user_id=?",
        )
        .get(id, user) as Record<string, unknown> | undefined;
    if (!row) throw new LifeAccessError("Conversation unavailable.");
    const conversation = this.conversationRow(row);
    this.scope(actor, conversation.scope);
    return conversation;
  }
  beginConversationTurn(
    actor: LifeActor,
    input: {
      scope: LifeScope;
      conversationId?: string;
      requestId: string;
      message: string;
      chatEpoch: number;
    },
  ): {
    conversation: ConversationSummary;
    turn: ConversationTurn;
    status: "new" | "pending" | "completed" | "interrupted";
    contextFingerprint: string;
    result?: ConversationResult;
  } {
    const user = this.actor(actor),
      scope = this.scope(actor, input.scope),
      requestId = identifier(input.requestId, "requestId"),
      message = text(input.message, "message", 8000);
    if (!Number.isSafeInteger(input.chatEpoch) || input.chatEpoch !== this.chatEpoch(actor))
      throw new LifeConflictError("Chat state changed; refresh before sending again.");
    const prior = this.db
      .prepare(
        "SELECT t.*,c.scope_type,c.scope_id,c.title,c.revision,c.created_at conversation_created,c.updated_at conversation_updated FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.user_id=? AND t.request_id=?",
      )
      .get(user, requestId) as Record<string, unknown> | undefined;
    if (prior) {
      if (
        String(prior.user_content) !== message ||
        prior.scope_type !== scope.type ||
        prior.scope_id !== scope.id ||
        (input.conversationId !== undefined &&
          String(prior.conversation_id) !== input.conversationId)
      )
        throw new LifeConflictError("Request id belongs to a different chat turn.");
      const conversation = this.accessibleConversation(actor, String(prior.conversation_id)),
        turn = this.turn(actor, prior, conversation);
      return {
        conversation,
        turn,
        status: turn.status,
        contextFingerprint: String(prior.context_fingerprint ?? ""),
        ...(prior.result_json
          ? { result: JSON.parse(String(prior.result_json)) as ConversationResult }
          : {}),
      };
    }
    const requestHash = createHash("sha256").update(requestId).digest("hex");
    if (
      this.db
        .prepare(
          "SELECT 1 found FROM conversation_request_tombstones WHERE user_id=? AND epoch=? AND request_hash=?",
        )
        .get(user, input.chatEpoch, requestHash)
    )
      throw new LifeConflictError("This retired chat request cannot be replayed.");
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO chat_state VALUES(?,?)").run(user, input.chatEpoch);
      let conversation: ConversationSummary;
      if (input.conversationId)
        conversation = this.accessibleConversation(actor, input.conversationId);
      else {
        const count = Number(
          this.db.prepare("SELECT count(*) count FROM conversations WHERE user_id=?").get(user)
            ?.count,
        );
        if (count >= 100)
          throw new LifeConflictError("Delete an older conversation before starting another.");
        const id = this.makeId(),
          at = this.clock(),
          title = message.slice(0, 80);
        this.db
          .prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)")
          .run(id, user, scope.type, scope.id, title, 1, at, at);
        conversation = {
          id,
          scope,
          title,
          revision: 1,
          turnCount: 0,
          pending: false,
          createdAt: at,
          updatedAt: at,
        };
      }
      if (conversation.scope.type !== scope.type || conversation.scope.id !== scope.id)
        throw new LifeAccessError("Conversation belongs to another space.");
      if (conversation.pending)
        throw new LifeConflictError("This conversation already has a pending turn.");
      const usage = this.db
        .prepare(
          "SELECT coalesce(sum(length(CAST(user_content AS BLOB))+length(CAST(coalesce(assistant_content,'') AS BLOB))+length(CAST(coalesce(result_json,'') AS BLOB))+length(CAST(evidence_json AS BLOB))),0) bytes,sum(status='pending') pending FROM conversation_turns WHERE user_id=?",
        )
        .get(user) as Record<string, unknown>;
      if (
        Number(usage.bytes) +
          Number(usage.pending) * 600_000 +
          Buffer.byteLength(message) +
          600_000 >
        20 * 1024 * 1024
      )
        throw new LifeConflictError(
          "Conversation history limit reached; delete an older conversation.",
        );
      if (conversation.turnCount >= 200)
        throw new LifeConflictError("This conversation has reached its retained turn limit.");
      const id = this.makeId(),
        at = this.clock(),
        fingerprint = this.contextFingerprintFor(actor, scope);
      this.db
        .prepare("INSERT INTO conversation_turns VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          conversation.id,
          user,
          requestId,
          message,
          null,
          "pending",
          null,
          "[]",
          fingerprint,
          at,
          at,
        );
      this.db
        .prepare("UPDATE conversations SET revision=revision+1,updated_at=? WHERE id=?")
        .run(at, conversation.id);
      conversation = this.accessibleConversation(actor, conversation.id);
      return {
        conversation,
        turn: {
          id,
          requestId,
          user: message,
          status: "pending",
          outdated: false,
          evidence: [],
          actions: [],
          createdAt: at,
          updatedAt: at,
        },
        status: "new" as const,
        contextFingerprint: fingerprint,
      };
    });
  }
  private evidenceCurrent(
    actor: LifeActor,
    scope: LifeScope,
    evidence: ConversationEvidence[],
  ): boolean {
    return evidence.every((item) => {
      const source = this.db
        .prepare("SELECT kind,scope_type,scope_id,revision FROM records WHERE id=?")
        .get(item.sourceId) as Record<string, unknown> | undefined;
      return Boolean(
        source &&
        source.kind === "source" &&
        source.scope_type === scope.type &&
        source.scope_id === scope.id &&
        Number(source.revision) === item.sourceRevision,
      );
    });
  }
  currentSourceReference(
    actor: LifeActor,
    requestedScope: LifeScope,
    idInput: string,
  ): { sourceId: string; sourceRevision: number; title: string } | undefined {
    const scope = this.scope(actor, requestedScope),
      id = identifier(idInput, "sourceId"),
      row = this.db
        .prepare(
          "SELECT id,revision,title FROM records WHERE id=? AND kind='source' AND scope_type=? AND scope_id=?",
        )
        .get(id, scope.type, scope.id) as Record<string, unknown> | undefined;
    return row
      ? { sourceId: String(row.id), sourceRevision: Number(row.revision), title: String(row.title) }
      : undefined;
  }
  private turn(
    actor: LifeActor,
    row: Record<string, unknown>,
    conversation: ConversationSummary,
    currentFingerprint?: string,
  ): ConversationTurn {
    const evidence = JSON.parse(String(row.evidence_json)) as ConversationEvidence[],
      fingerprint = currentFingerprint ?? this.contextFingerprintFor(actor, conversation.scope),
      result = row.result_json
        ? (JSON.parse(String(row.result_json)) as ConversationResult)
        : undefined;
    return {
      id: String(row.id),
      requestId: String(row.request_id),
      user: String(row.user_content),
      ...(row.assistant_content === null ? {} : { assistant: String(row.assistant_content) }),
      status: String(row.status) as ConversationTurn["status"],
      outdated:
        String(row.context_fingerprint ?? "") !== fingerprint ||
        !this.evidenceCurrent(actor, conversation.scope, evidence),
      evidence,
      actions: result?.actions ?? [],
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
  completeConversationTurn(
    actor: LifeActor,
    input: {
      conversationId: string;
      turnId: string;
      requestId: string;
      result: ConversationResult;
    },
  ): { conversation: ConversationSummary; turn: ConversationTurn; result: ConversationResult } {
    const conversation = this.accessibleConversation(actor, input.conversationId),
      turnId = identifier(input.turnId, "turnId"),
      requestId = identifier(input.requestId, "requestId"),
      reply = text(input.result.reply, "reply", 8000);
    if (
      !Array.isArray(input.result.actions) ||
      input.result.actions.length > 20 ||
      !Array.isArray(input.result.recordIds) ||
      input.result.recordIds.length > 100 ||
      !Array.isArray(input.result.taskIds) ||
      input.result.taskIds.length > 100 ||
      !Array.isArray(input.result.evidence) ||
      input.result.evidence.length > 50
    )
      throw new TypeError("Conversation result is invalid");
    const result: ConversationResult = {
      reply,
      actions: input.result.actions.map((a) => ({
        label: text(a.label, "action.label", 500),
        status: text(a.status, "action.status", 50),
      })),
      recordIds: input.result.recordIds.map((v) => identifier(v, "recordId")),
      taskIds: input.result.taskIds.map((v) => identifier(v, "taskId")),
      evidence: input.result.evidence.map((e) => ({
        sourceId: identifier(e.sourceId, "sourceId"),
        sourceRevision: Number(e.sourceRevision),
        title: text(e.title, "evidence.title", 500),
        ...(e.reference ? { reference: text(e.reference, "evidence.reference", 1000) } : {}),
      })),
    };
    if (
      result.evidence.some((e) => !Number.isSafeInteger(e.sourceRevision) || e.sourceRevision < 1)
    )
      throw new TypeError("Evidence revision is invalid");
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded) > 256_000)
      throw new TypeError("Conversation result is too large");
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM conversation_turns WHERE id=? AND conversation_id=? AND user_id=? AND request_id=?",
        )
        .get(turnId, conversation.id, this.actor(actor), requestId) as
        | Record<string, unknown>
        | undefined;
      if (!row) throw new LifeAccessError("Conversation turn unavailable.");
      if (row.status === "completed")
        return {
          conversation: this.accessibleConversation(actor, conversation.id),
          turn: this.turn(actor, row, conversation),
          result: JSON.parse(String(row.result_json)) as ConversationResult,
        };
      if (row.status !== "pending")
        throw new LifeConflictError("Interrupted turns cannot be replayed automatically.");
      const at = this.clock(),
        fingerprint = this.contextFingerprintFor(actor, conversation.scope);
      this.db
        .prepare(
          "UPDATE conversation_turns SET assistant_content=?,status='completed',result_json=?,evidence_json=?,context_fingerprint=?,updated_at=? WHERE id=? AND status='pending'",
        )
        .run(reply, encoded, JSON.stringify(result.evidence), fingerprint, at, turnId);
      this.db
        .prepare("UPDATE conversations SET revision=revision+1,updated_at=? WHERE id=?")
        .run(at, conversation.id);
      const current = this.accessibleConversation(actor, conversation.id),
        updated = this.db
          .prepare("SELECT * FROM conversation_turns WHERE id=?")
          .get(turnId) as Record<string, unknown>;
      return { conversation: current, turn: this.turn(actor, updated, current), result };
    });
  }
  interruptConversationTurn(
    actor: LifeActor,
    input: { conversationId: string; turnId: string; requestId: string },
  ): ConversationTurn {
    const user = this.actor(actor),
      conversationId = identifier(input.conversationId, "conversationId"),
      owned = this.db
        .prepare(
          "SELECT c.*,(SELECT count(*) FROM conversation_turns t WHERE t.conversation_id=c.id) turn_count,EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='pending') pending FROM conversations c WHERE c.id=? AND c.user_id=?",
        )
        .get(conversationId, user) as Record<string, unknown> | undefined,
      turnId = identifier(input.turnId, "turnId"),
      requestId = identifier(input.requestId, "requestId"),
      at = this.clock();
    if (!owned) throw new LifeAccessError("Conversation unavailable.");
    this.db
      .prepare(
        "UPDATE conversation_turns SET status='interrupted',updated_at=? WHERE id=? AND conversation_id=? AND user_id=? AND request_id=? AND status='pending'",
      )
      .run(at, turnId, conversationId, user, requestId);
    const row = this.db
      .prepare("SELECT * FROM conversation_turns WHERE id=? AND conversation_id=? AND user_id=?")
      .get(turnId, conversationId, user) as Record<string, unknown> | undefined;
    if (!row) throw new LifeAccessError("Conversation turn unavailable.");
    return this.turn(actor, row, this.accessibleConversation(actor, conversationId));
  }
  listConversations(
    actor: LifeActor,
    input: { scope: LifeScope; cursor?: string; limit?: number },
  ): ConversationPage<ConversationSummary> {
    const user = this.actor(actor),
      scope = this.scope(actor, input.scope),
      limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TypeError("Conversation limit is invalid");
    let cursor: { user: string; scope: string; updatedAt: number; id: string } | undefined;
    if (input.cursor)
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (
          cursor?.user !== user ||
          cursor.scope !== `${scope.type}:${scope.id}` ||
          !Number.isSafeInteger(cursor.updatedAt)
        )
          throw new Error();
      } catch {
        throw new TypeError("Conversation cursor is invalid");
      }
    const rows = this.db
      .prepare(
        `SELECT c.*,(SELECT count(*) FROM conversation_turns t WHERE t.conversation_id=c.id) turn_count,EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='pending') pending FROM conversations c WHERE user_id=? AND scope_type=? AND scope_id=?${cursor ? " AND (updated_at<? OR (updated_at=? AND id<?))" : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      )
      .all(
        user,
        scope.type,
        scope.id,
        ...(cursor ? [cursor.updatedAt, cursor.updatedAt, cursor.id] : []),
        limit + 1,
      ) as Array<Record<string, unknown>>;
    const items = rows.slice(0, limit).map((row) => this.conversationRow(row)),
      result: ConversationPage<ConversationSummary> = { items, hasMore: rows.length > limit };
    if (result.hasMore && items.length) {
      const last = items.at(-1)!;
      result.nextCursor = Buffer.from(
        JSON.stringify({
          user,
          scope: `${scope.type}:${scope.id}`,
          updatedAt: last.updatedAt,
          id: last.id,
        }),
      ).toString("base64url");
    }
    return result;
  }
  getConversation(
    actor: LifeActor,
    id: string,
    input: { cursor?: string; limit?: number } = {},
  ): { conversation: ConversationSummary; turns: ConversationPage<ConversationTurn> } {
    const conversation = this.accessibleConversation(actor, id),
      limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Turn limit is invalid");
    let cursor: { conversationId: string; createdAt: number; id: string } | undefined;
    if (input.cursor)
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (cursor?.conversationId !== conversation.id || !Number.isSafeInteger(cursor.createdAt))
          throw new Error();
      } catch {
        throw new TypeError("Turn cursor is invalid");
      }
    const rows = this.db
        .prepare(
          `SELECT * FROM conversation_turns WHERE conversation_id=?${cursor ? " AND (created_at<? OR (created_at=? AND id<?))" : ""} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .all(
          conversation.id,
          ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
          limit + 1,
        ) as Array<Record<string, unknown>>,
      pageRows = rows.slice(0, limit),
      fingerprint = this.contextFingerprintFor(actor, conversation.scope),
      items = pageRows.map((row) => this.turn(actor, row, conversation, fingerprint)),
      turns: ConversationPage<ConversationTurn> = { items, hasMore: rows.length > limit };
    if (turns.hasMore && pageRows.length) {
      const last = pageRows.at(-1)!;
      turns.nextCursor = Buffer.from(
        JSON.stringify({
          conversationId: conversation.id,
          createdAt: Number(last.created_at),
          id: String(last.id),
        }),
      ).toString("base64url");
    }
    return { conversation, turns };
  }
  getConversationRequest(
    actor: LifeActor,
    requestIdInput: string,
  ):
    | { conversation: ConversationSummary; turn: ConversationTurn; result?: ConversationResult }
    | undefined {
    const user = this.actor(actor),
      requestId = identifier(requestIdInput, "requestId"),
      row = this.db
        .prepare("SELECT * FROM conversation_turns WHERE user_id=? AND request_id=?")
        .get(user, requestId) as Record<string, unknown> | undefined;
    if (!row) return;
    const conversation = this.accessibleConversation(actor, String(row.conversation_id));
    return {
      conversation,
      turn: this.turn(actor, row, conversation),
      ...(row.result_json
        ? { result: JSON.parse(String(row.result_json)) as ConversationResult }
        : {}),
    };
  }
  conversationHistory(
    actor: LifeActor,
    id: string,
    limit = 12,
    currentFingerprint?: string,
  ): Array<{ role: "user" | "assistant"; content: string }> {
    const conversation = this.accessibleConversation(actor, id);
    if (!Number.isInteger(limit) || limit < 1 || limit > 12)
      throw new TypeError("History limit is invalid");
    const rows = this.db
        .prepare(
          "SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY created_at DESC,id DESC LIMIT 200",
        )
        .all(conversation.id) as Array<Record<string, unknown>>,
      current = currentFingerprint ?? this.contextFingerprintFor(actor, conversation.scope),
      valid: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (row.status !== "completed") continue;
      if (
        String(row.context_fingerprint) !== current ||
        !this.evidenceCurrent(actor, conversation.scope, JSON.parse(String(row.evidence_json)))
      )
        break;
      valid.push(row);
      if (valid.length >= Math.ceil(limit / 2)) break;
    }
    return valid
      .reverse()
      .flatMap((row) => [
        { role: "user" as const, content: String(row.user_content) },
        { role: "assistant" as const, content: String(row.assistant_content) },
      ])
      .slice(-limit);
  }
  conversationContextFingerprint(actor: LifeActor, id: string): string {
    const conversation = this.accessibleConversation(actor, id);
    return this.contextFingerprintFor(actor, conversation.scope);
  }
  deleteConversation(actor: LifeActor, id: string, expectedRevision: number): void {
    const conversation = this.accessibleConversation(actor, id);
    if (!Number.isSafeInteger(expectedRevision) || conversation.revision !== expectedRevision)
      throw new LifeConflictError("Conversation changed.");
    if (conversation.pending)
      throw new LifeConflictError("A pending conversation cannot be deleted.");
    const user = this.actor(actor),
      epoch = this.chatEpoch(actor);
    this.transaction(() => {
      const requests = this.db
        .prepare("SELECT request_id FROM conversation_turns WHERE conversation_id=?")
        .all(conversation.id) as Array<{ request_id: string }>;
      const retained = Number(
        this.db
          .prepare(
            "SELECT count(*) count FROM conversation_request_tombstones WHERE user_id=? AND epoch=?",
          )
          .get(user, epoch)?.count,
      );
      if (retained + requests.length > 20_000)
        throw new LifeConflictError(
          "Personal chat reset is required before deleting more history.",
        );
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO conversation_request_tombstones VALUES(?,?,?,?)",
      );
      for (const request of requests)
        insert.run(
          user,
          epoch,
          createHash("sha256").update(request.request_id).digest("hex"),
          this.clock(),
        );
      this.db
        .prepare("DELETE FROM conversations WHERE id=? AND user_id=? AND revision=?")
        .run(conversation.id, user, expectedRevision);
    });
  }
  personalSummary(actor: LifeActor): PersonalLifeSummary {
    const user = this.actor(actor),
      row = this.db
        .prepare(`SELECT
          (SELECT generation FROM personal_generations WHERE user_id=?) generation,
          count(*) records,
          sum(kind='source') sources,
          sum(kind='feedback') feedback,
          sum(kind='routine' AND json_extract(data_json,'$.type')='teaching-guide-v1') guidance,
          (SELECT count(*) FROM settings WHERE level='user' AND scope_id=?) settings,
          (SELECT count(*) FROM conversations WHERE user_id=?) conversations,
          (SELECT count(*) FROM conversation_turns WHERE user_id=?) conversation_turns,
          coalesce(sum(length(CAST(title AS BLOB))+length(CAST(coalesce(body,'') AS BLOB))+length(CAST(data_json AS BLOB))+length(CAST(relationships_json AS BLOB))+length(CAST(provenance_json AS BLOB))),0)+(SELECT coalesce(sum(length(CAST(key AS BLOB))+length(CAST(value_json AS BLOB))),0) FROM settings WHERE level='user' AND scope_id=?)+(SELECT coalesce(sum(length(CAST(user_content AS BLOB))+length(CAST(coalesce(assistant_content,'') AS BLOB))+length(CAST(coalesce(result_json,'') AS BLOB))+length(CAST(evidence_json AS BLOB))),0) FROM conversation_turns WHERE user_id=?) bytes
          FROM records WHERE scope_type='user' AND scope_id=?`)
        .get(user, user, user, user, user, user, user) as Record<string, unknown>;
    return {
      generation: Number(row.generation ?? 0),
      records: Number(row.records),
      sources: Number(row.sources),
      feedback: Number(row.feedback),
      guidance: Number(row.guidance),
      settings: Number(row.settings),
      conversations: Number(row.conversations),
      conversationTurns: Number(row.conversation_turns),
      bytes: Number(row.bytes),
    };
  }
  exportPersonalPage(
    actor: LifeActor,
    options: { cursor?: string; limit?: number; expectedGeneration?: number } = {},
  ): PersonalLifeExportPage {
    const user = this.actor(actor),
      generation = this.personalGeneration(user),
      limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("Personal export limit must be from 1 through 100");
    if (options.expectedGeneration !== undefined && options.expectedGeneration !== generation)
      throw new LifeConflictError("Personal data changed; review a fresh export.");
    let cursor:
      | { user: string; updatedAt: number; type: string; key: string; generation: number }
      | undefined;
    if (options.cursor) {
      try {
        if (options.cursor.length > 500) throw new Error();
        cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
        if (
          cursor?.user !== user ||
          cursor.generation !== generation ||
          !Number.isSafeInteger(cursor.updatedAt) ||
          !["record", "setting", "conversation", "conversation-turn"].includes(cursor.type) ||
          typeof cursor.key !== "string"
        )
          throw new Error();
      } catch {
        throw new TypeError("Personal export cursor is invalid");
      }
    }
    const rows = this.db
      .prepare(`SELECT type,key,updated_at FROM (
        SELECT 'record' type,id key,updated_at FROM records WHERE scope_type='user' AND scope_id=?
        UNION ALL SELECT 'setting' type,key,updated_at FROM settings WHERE level='user' AND scope_id=?
        UNION ALL SELECT 'conversation' type,id key,updated_at FROM conversations WHERE user_id=? AND (scope_type='user' OR EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=scope_id AND m.user_id=?))
        UNION ALL SELECT 'conversation-turn' type,t.id key,t.updated_at FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.user_id=? AND (c.scope_type='user' OR EXISTS(SELECT 1 FROM group_members m WHERE m.group_id=c.scope_id AND m.user_id=?))
      ) WHERE (? IS NULL OR updated_at<? OR (updated_at=? AND (type<? OR (type=? AND key<?))))
      ORDER BY updated_at DESC,type DESC,key DESC LIMIT ?`)
      .all(
        user,
        user,
        user,
        user,
        user,
        user,
        cursor?.key ?? null,
        cursor?.updatedAt ?? 0,
        cursor?.updatedAt ?? 0,
        cursor?.type ?? "",
        cursor?.type ?? "",
        cursor?.key ?? "",
        limit + 1,
      ) as Array<{
      type: "record" | "setting" | "conversation" | "conversation-turn";
      key: string;
      updated_at: number;
    }>;
    const pageRows: typeof rows = [],
      recordStatement = this.db.prepare(
        "SELECT * FROM records WHERE id=? AND scope_type='user' AND scope_id=?",
      ),
      settingStatement = this.db.prepare(
        "SELECT value_json,updated_at FROM settings WHERE level='user' AND scope_id=? AND key=?",
      ),
      conversationStatement = this.db.prepare(
        "SELECT c.*,(SELECT count(*) FROM conversation_turns t WHERE t.conversation_id=c.id) turn_count,EXISTS(SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.id AND t.status='pending') pending FROM conversations c WHERE c.id=? AND c.user_id=?",
      ),
      turnStatement = this.db.prepare("SELECT * FROM conversation_turns WHERE id=? AND user_id=?"),
      fingerprintByScope = new Map<string, string>(),
      items: PersonalLifeExportItem[] = [];
    let pageBytes = 0;
    for (const row of rows.slice(0, limit)) {
      let item: PersonalLifeExportItem;
      if (row.type === "record") {
        const record = recordStatement.get(row.key, user) as Record<string, unknown> | undefined;
        if (!record) throw new LifeConflictError("Personal data changed; review a fresh export.");
        item = { type: "record", record: this.record(record) };
      } else if (row.type === "setting") {
        const setting = settingStatement.get(user, row.key) as Record<string, unknown> | undefined;
        if (!setting) throw new LifeConflictError("Personal data changed; review a fresh export.");
        item = {
          type: "setting",
          key: row.key,
          value: JSON.parse(String(setting.value_json)),
          updatedAt: Number(setting.updated_at),
        };
      } else if (row.type === "conversation") {
        const found = conversationStatement.get(row.key, user) as
          | Record<string, unknown>
          | undefined;
        if (!found) throw new LifeConflictError("Personal data changed; review a fresh export.");
        item = { type: "conversation", conversation: this.conversationRow(found) };
      } else {
        const found = turnStatement.get(row.key, user) as Record<string, unknown> | undefined;
        if (!found) throw new LifeConflictError("Personal data changed; review a fresh export.");
        const conversation = this.accessibleConversation(actor, String(found.conversation_id));
        const scopeKey = `${conversation.scope.type}:${conversation.scope.id}`,
          fingerprint =
            fingerprintByScope.get(scopeKey) ??
            this.contextFingerprintFor(actor, conversation.scope);
        fingerprintByScope.set(scopeKey, fingerprint);
        item = {
          type: "conversation-turn",
          conversationId: conversation.id,
          turn: this.turn(actor, found, conversation, fingerprint),
        };
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item));
      if (items.length && pageBytes + itemBytes > 6_000_000) break;
      items.push(item);
      pageRows.push(row);
      pageBytes += itemBytes;
    }
    if (this.personalGeneration(user) !== generation)
      throw new LifeConflictError("Personal data changed; review a fresh export.");
    const result: PersonalLifeExportPage = { format: "ellie-life-v1", generation, items };
    if (rows.length > pageRows.length && pageRows.length) {
      const last = pageRows.at(-1)!;
      result.nextCursor = Buffer.from(
        JSON.stringify({
          user,
          generation,
          updatedAt: last.updated_at,
          type: last.type,
          key: last.key,
        }),
      ).toString("base64url");
    }
    return result;
  }
  /** Legacy bounded callers should prefer exportPersonalPage. */
  exportPersonal(actor: LifeActor): {
    records: LifeRecord[];
    settings: Record<string, unknown>;
    groups: Array<{ id: string; name: string; role: "owner" | "member" }>;
  } {
    const user = this.actor(actor),
      records = (
        this.db
          .prepare(
            "SELECT * FROM records WHERE scope_type='user' AND scope_id=? ORDER BY updated_at DESC",
          )
          .all(user) as Record<string, unknown>[]
      ).map((row) => this.record(row)),
      settings = this.resolveSettings(actor).values;
    return { records, settings, groups: this.listGroups(actor) };
  }
  beginPersonalReset(
    actor: LifeActor,
    input: {
      operationId: string;
      reviewTokenHash: string;
      lifeGeneration: number;
      taskGeneration: number;
      pluginGeneration: number;
    },
  ): PersonalResetJournal {
    const user = this.actor(actor),
      operationId = identifier(input.operationId, "operationId"),
      token = text(input.reviewTokenHash, "reviewTokenHash", 128);
    if (
      ![input.lifeGeneration, input.taskGeneration, input.pluginGeneration].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      )
    )
      throw new TypeError("Reset generations are invalid");
    if (this.personalSummary(actor).generation !== input.lifeGeneration)
      throw new LifeConflictError("Personal data changed; review reset again.");
    const existing = this.getPersonalReset(actor);
    if (existing && existing.state !== "completed") {
      if (existing.operationId !== operationId)
        throw new LifeConflictError("A personal reset is already in progress.");
      return existing;
    }
    const now = this.clock();
    this.db
      .prepare(
        "INSERT INTO personal_reset_journal(user_id,operation_id,review_token_hash,state,life_generation,task_generation,plugin_generation,requested_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET operation_id=excluded.operation_id,review_token_hash=excluded.review_token_hash,state=excluded.state,life_generation=excluded.life_generation,task_generation=excluded.task_generation,plugin_generation=excluded.plugin_generation,requested_at=excluded.requested_at,updated_at=excluded.updated_at",
      )
      .run(
        user,
        operationId,
        token,
        "draining",
        input.lifeGeneration,
        input.taskGeneration,
        input.pluginGeneration,
        now,
        now,
      );
    return this.getPersonalReset(actor)!;
  }
  getPersonalReset(actor: LifeActor): PersonalResetJournal | undefined {
    const user = this.actor(actor),
      row = this.db.prepare("SELECT * FROM personal_reset_journal WHERE user_id=?").get(user) as
        | Record<string, unknown>
        | undefined;
    if (!row) return undefined;
    return {
      userId: user,
      operationId: String(row.operation_id),
      reviewTokenHash: String(row.review_token_hash),
      state: String(row.state) as PersonalResetJournal["state"],
      lifeGeneration: Number(row.life_generation),
      taskGeneration: Number(row.task_generation),
      pluginGeneration: Number(row.plugin_generation),
      requestedAt: Number(row.requested_at),
      updatedAt: Number(row.updated_at),
    };
  }
  advancePersonalReset(
    actor: LifeActor,
    operationId: string,
    state: PersonalResetJournal["state"],
  ): PersonalResetJournal {
    const user = this.actor(actor),
      id = identifier(operationId, "operationId");
    if (
      !["draining", "tasks-deleted", "plugins-deleted", "life-deleted", "completed"].includes(state)
    )
      throw new TypeError("Reset state is invalid");
    const order: PersonalResetJournal["state"][] = [
      "draining",
      "tasks-deleted",
      "plugins-deleted",
      "life-deleted",
      "completed",
    ];
    return this.transaction(() => {
      const current = this.getPersonalReset(actor);
      if (!current || current.operationId !== id)
        throw new LifeAccessError("Personal reset is unavailable.");
      if (order.indexOf(state) < order.indexOf(current.state))
        throw new LifeConflictError("Personal reset cannot move backward.");
      if (order.indexOf(state) > order.indexOf(current.state) + 1)
        throw new LifeConflictError("Personal reset phase was skipped.");
      this.db
        .prepare(
          "UPDATE personal_reset_journal SET state=?,updated_at=? WHERE user_id=? AND operation_id=?",
        )
        .run(state, this.clock(), user, id);
      return this.getPersonalReset(actor)!;
    });
  }
  deletePersonal(
    actor: LifeActor,
    options: { preserveMemberships?: boolean; expectedGeneration?: number } = {},
  ): PersonalLifeSummary {
    const user = this.actor(actor);
    if (
      options.expectedGeneration !== undefined &&
      this.personalSummary(actor).generation !== options.expectedGeneration
    )
      throw new LifeConflictError("Personal data changed; review reset again.");
    this.transaction(() => {
      const epoch = this.chatEpoch(actor);
      this.db
        .prepare(
          "INSERT INTO chat_state VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET epoch=epoch+1",
        )
        .run(user, epoch + 1);
      this.db.prepare("DELETE FROM conversation_request_tombstones WHERE user_id=?").run(user);
      this.db.prepare("DELETE FROM conversations WHERE user_id=?").run(user);
      const sources = this.db
        .prepare("SELECT id FROM records WHERE kind='source' AND scope_type='user' AND scope_id=?")
        .all(user) as Array<{ id: string }>;
      this.db.prepare("DELETE FROM records WHERE scope_type='user' AND scope_id=?").run(user);
      const now = this.clock();
      for (const source of sources) this.invalidateProvenance(source.id, now);
      this.db.prepare("DELETE FROM settings WHERE level='user' AND scope_id=?").run(user);
      if (!options.preserveMemberships)
        this.db.prepare("DELETE FROM group_members WHERE user_id=? AND role='member'").run(user);
    });
    return this.personalSummary(actor);
  }
  close(): void {
    this.db.close();
  }
}

export function inferTone(textInput: string): {
  tone: "neutral" | "frustrated" | "urgent" | "positive";
  confidence: number;
  temporary: true;
} {
  const value = text(textInput, "text", MAX_TEXT).toLocaleLowerCase();
  let tone: "neutral" | "frustrated" | "urgent" | "positive" = "neutral",
    confidence = 0.3;
  if (/\b(frustrated|annoyed|upset|hate|wrong)\b/.test(value)) {
    tone = "frustrated";
    confidence = 0.65;
  } else if (/\b(urgent|asap|immediately|now)\b/.test(value)) {
    tone = "urgent";
    confidence = 0.65;
  } else if (/\b(thanks|great|love|helpful)\b/.test(value)) {
    tone = "positive";
    confidence = 0.6;
  }
  return { tone, confidence, temporary: true };
}
