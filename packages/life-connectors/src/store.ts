import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ConnectorObservation,
  LifeAnticipationResult,
} from "../../life-anticipation/src/index.ts";
import type { EvidenceRef, ProviderId, ProviderPullResult } from "./provider-types.ts";

export type ConnectionMode = "observe" | "prepare";
export interface Connection {
  id: string;
  actorId: string;
  provider: ProviderId;
  label: string;
  state: "connecting" | "connected" | "paused" | "error" | "revoked";
  mode: ConnectionMode;
  generation: number;
  accountId?: string;
  selectedCalendarId?: string;
  grantedScopes: string[];
  lastSyncAt?: number;
  cursor?: string;
  continuation?: string;
  error?: string;
}
export interface DerivedRecord {
  key: string;
  recordId: string;
  revision: number;
  evidenceRefs: EvidenceRef[];
  expiresAt: number;
  taskId?: string;
}

function privateFile(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const dir = lstatSync(directory);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (dir.mode & 0o777) !== 0o700 ||
    (process.getuid && dir.uid !== process.getuid())
  )
    throw new Error("Connector directory must be private.");
  try {
    closeSync(
      openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    (file.mode & 0o777) !== 0o600 ||
    (process.getuid && file.uid !== process.getuid())
  )
    throw new Error("Connector database must be private.");
}

/** Host-only metadata and evidence. Credentials live in the separate vault. */
export class ConnectorStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    privateFile(path);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, actor TEXT NOT NULL, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS evidence(connection TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, source_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(connection,source_key)) STRICT;
      CREATE TABLE IF NOT EXISTS analysis(connection TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS derived(connection TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(connection,key)) STRICT;
      CREATE TABLE IF NOT EXISTS dismissed(connection TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, key TEXT NOT NULL, PRIMARY KEY(connection,key)) STRICT;
      CREATE TABLE IF NOT EXISTS generations(actor TEXT PRIMARY KEY, value INTEGER NOT NULL) STRICT;`);
  }
  close(): void {
    this.db.close();
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private touch(actorId: string): void {
    this.db
      .prepare("INSERT INTO generations VALUES(?,1) ON CONFLICT(actor) DO UPDATE SET value=value+1")
      .run(actorId);
  }
  generation(actorId: string): number {
    return Number(
      (
        this.db.prepare("SELECT value FROM generations WHERE actor=?").get(actorId) as
          | { value: number }
          | undefined
      )?.value ?? 0,
    );
  }
  create(actorId: string, provider: ProviderId, mode: ConnectionMode): Connection {
    if (
      !actorId ||
      actorId.length > 200 ||
      !["observe", "prepare"].includes(mode) ||
      !/^[a-z][a-z0-9.-]{0,79}$/.test(provider)
    )
      throw new TypeError("Connection input is invalid.");
    if (this.list(actorId).filter((c) => c.state !== "revoked").length >= 20)
      throw new Error("Connection limit reached.");
    const connection: Connection = {
      id: randomUUID(),
      actorId,
      provider,
      mode,
      label: provider,
      state: "connecting",
      generation: 1,
      grantedScopes: [],
    };
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO connections VALUES(?,?,?)")
        .run(connection.id, actorId, JSON.stringify(connection));
      this.touch(actorId);
    });
    return connection;
  }
  get(actorId: string, id: string): Connection | undefined {
    const row = this.db
      .prepare("SELECT value FROM connections WHERE id=? AND actor=?")
      .get(id, actorId) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as Connection) : undefined;
  }
  list(actorId: string): Connection[] {
    return (
      this.db.prepare("SELECT value FROM connections WHERE actor=? ORDER BY id").all(actorId) as {
        value: string;
      }[]
    ).map((r) => JSON.parse(r.value) as Connection);
  }
  require(actorId: string, id: string, generation?: number): Connection {
    const connection = this.get(actorId, id);
    if (
      !connection ||
      connection.state === "revoked" ||
      (generation !== undefined && connection.generation !== generation)
    )
      throw new Error("Connection changed or is unavailable.");
    return connection;
  }
  /** Generation is the authorization epoch; only operational cursor/error checkpoints may preserve it. */
  update(
    actorId: string,
    id: string,
    generation: number,
    patch: Partial<
      Pick<
        Connection,
        | "state"
        | "mode"
        | "label"
        | "accountId"
        | "selectedCalendarId"
        | "grantedScopes"
        | "error"
        | "cursor"
        | "continuation"
      >
    >,
    invalidate = true,
  ): Connection {
    return this.transaction(() => {
      const current = this.require(actorId, id, generation);
      const next = { ...current, ...patch, generation: current.generation + (invalidate ? 1 : 0) };
      this.db.prepare("UPDATE connections SET value=? WHERE id=?").run(JSON.stringify(next), id);
      this.touch(actorId);
      return next;
    });
  }
  /** A page and its continuation commit together; stable cursor advances only on completion. */
  ingest(
    actorId: string,
    id: string,
    generation: number,
    page: ProviderPullResult,
    now: number,
  ): void {
    this.transaction(() => {
      const connection = this.require(actorId, id, generation);
      if (connection.accountId !== page.accountId || connection.state !== "connected")
        throw new Error("Provider account changed.");
      if (
        page.items.length > 250 ||
        (page.complete
          ? !page.cursor || page.continuation !== undefined
          : !page.continuation || page.cursor !== undefined)
      )
        throw new Error("Provider page is invalid.");
      for (const item of page.items) {
        const value = { ...item, connectionId: id };
        if (JSON.stringify(value).length > 20_000)
          throw new Error("Provider evidence is too large.");
        this.db
          .prepare(
            "INSERT INTO evidence VALUES(?,?,?) ON CONFLICT(connection,source_key) DO UPDATE SET value=excluded.value",
          )
          .run(id, item.sourceKey, JSON.stringify(value));
      }
      const count = Number(
        (
          this.db.prepare("SELECT count(*) count FROM evidence WHERE connection=?").get(id) as {
            count: number;
          }
        ).count,
      );
      if (count > 5_000) throw new Error("Connection evidence limit reached.");
      const next: Connection = {
        ...connection,
        error: undefined,
        continuation: page.complete ? undefined : page.continuation,
        ...(page.complete ? { cursor: page.cursor, lastSyncAt: now } : {}),
      };
      this.db.prepare("UPDATE connections SET value=? WHERE id=?").run(JSON.stringify(next), id);
      this.touch(actorId);
    });
  }
  observations(actorId: string, id: string): ConnectorObservation[] {
    this.require(actorId, id);
    return (
      this.db
        .prepare("SELECT value FROM evidence WHERE connection=? ORDER BY source_key")
        .all(id) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as ConnectorObservation);
  }
  clearEvidence(actorId: string, id: string, generation: number): void {
    this.transaction(() => {
      this.require(actorId, id, generation);
      this.db.prepare("DELETE FROM evidence WHERE connection=?").run(id);
      this.db.prepare("DELETE FROM analysis WHERE connection=?").run(id);
      this.touch(actorId);
    });
  }
  /** Change one calendar and its cursor/evidence in the same durable transaction. */
  selectCalendar(actorId: string, id: string, generation: number, calendarId: string): Connection {
    return this.transaction(() => {
      const current = this.require(actorId, id, generation);
      if (current.provider !== "google-calendar" || current.state !== "connected")
        throw new Error("Calendar connection is unavailable.");
      const next: Connection = {
        ...current,
        selectedCalendarId: calendarId,
        generation: current.generation + 1,
        cursor: undefined,
        continuation: undefined,
        lastSyncAt: undefined,
        error: undefined,
      };
      this.db.prepare("UPDATE connections SET value=? WHERE id=?").run(JSON.stringify(next), id);
      this.db.prepare("DELETE FROM evidence WHERE connection=?").run(id);
      this.db.prepare("DELETE FROM analysis WHERE connection=?").run(id);
      this.touch(actorId);
      return next;
    });
  }
  evidenceCurrent(actorId: string, refs: EvidenceRef[]): boolean {
    return (
      refs.length > 0 &&
      refs.length <= 8 &&
      refs.every((ref) => {
        const c = this.get(actorId, ref.connectionId);
        if (!c || c.state !== "connected") return false;
        const row = this.db
          .prepare("SELECT value FROM evidence WHERE connection=? AND source_key=?")
          .get(ref.connectionId, ref.sourceKey) as { value: string } | undefined;
        const item = row ? (JSON.parse(row.value) as ConnectorObservation) : undefined;
        return (
          item &&
          item.kind !== "deleted" &&
          !item.deleted &&
          item.sourceRevision === ref.sourceRevision
        );
      })
    );
  }
  saveAnalysis(
    actorId: string,
    id: string,
    generation: number,
    result: LifeAnticipationResult,
  ): void {
    this.transaction(() => {
      this.require(actorId, id, generation);
      this.db
        .prepare(
          "INSERT INTO analysis VALUES(?,?) ON CONFLICT(connection) DO UPDATE SET value=excluded.value",
        )
        .run(id, JSON.stringify(result));
      this.touch(actorId);
    });
  }
  analysis(actorId: string, id: string): LifeAnticipationResult | undefined {
    this.require(actorId, id);
    const row = this.db.prepare("SELECT value FROM analysis WHERE connection=?").get(id) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as LifeAnticipationResult) : undefined;
  }
  derived(actorId: string, id: string): DerivedRecord[] {
    if (!this.get(actorId, id)) throw new Error("Connection unavailable.");
    return (
      this.db.prepare("SELECT value FROM derived WHERE connection=?").all(id) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as DerivedRecord);
  }
  saveDerived(actorId: string, id: string, value: DerivedRecord): void {
    this.transaction(() => {
      this.require(actorId, id);
      this.db
        .prepare(
          "INSERT INTO derived VALUES(?,?,?) ON CONFLICT(connection,key) DO UPDATE SET value=excluded.value",
        )
        .run(id, value.key, JSON.stringify(value));
      this.touch(actorId);
    });
  }
  removeDerived(actorId: string, id: string, key: string): void {
    this.transaction(() => {
      if (!this.get(actorId, id)) throw new Error("Connection unavailable.");
      this.db.prepare("DELETE FROM derived WHERE connection=? AND key=?").run(id, key);
      this.touch(actorId);
    });
  }
  dismiss(actorId: string, id: string, key: string): void {
    this.transaction(() => {
      this.require(actorId, id);
      this.db.prepare("INSERT OR IGNORE INTO dismissed VALUES(?,?)").run(id, key);
      this.touch(actorId);
    });
  }
  dismissed(actorId: string, id: string): string[] {
    this.require(actorId, id);
    return (
      this.db.prepare("SELECT key FROM dismissed WHERE connection=? LIMIT 100").all(id) as {
        key: string;
      }[]
    ).map((r) => r.key);
  }
  isDismissed(actorId: string, id: string, key: string): boolean {
    this.require(actorId, id);
    return Boolean(
      this.db.prepare("SELECT 1 FROM dismissed WHERE connection=? AND key=?").get(id, key),
    );
  }
  revoke(actorId: string, id: string): Connection {
    return this.transaction(() => {
      const current = this.get(actorId, id);
      if (!current) throw new Error("Connection unavailable.");
      const next: Connection = {
        ...current,
        state: "revoked",
        generation: current.generation + 1,
        cursor: undefined,
        continuation: undefined,
        grantedScopes: [],
      };
      this.db.prepare("UPDATE connections SET value=? WHERE id=?").run(JSON.stringify(next), id);
      this.db.prepare("DELETE FROM evidence WHERE connection=?").run(id);
      this.db.prepare("DELETE FROM analysis WHERE connection=?").run(id);
      this.touch(actorId);
      return next;
    });
  }
  export(actorId: string): { generation: number; items: unknown[] } {
    const items: unknown[] = [];
    for (const c of this.list(actorId)) {
      const { cursor: _cursor, continuation: _continuation, ...metadata } = c;
      items.push({ type: "connection", connection: metadata });
      if (c.state === "revoked") continue;
      items.push(
        ...this.observations(actorId, c.id).map((evidence) => ({ type: "evidence", evidence })),
      );
      const analysis = this.analysis(actorId, c.id);
      if (analysis) items.push({ type: "analysis", connectionId: c.id, analysis });
      items.push({ type: "dismissals", connectionId: c.id, keys: this.dismissed(actorId, c.id) });
    }
    return { generation: this.generation(actorId), items };
  }
  summary(actorId: string): {
    generation: number;
    connections: number;
    evidence: number;
    bytes: number;
  } {
    const row = this.db
      .prepare(`SELECT (SELECT count(*) FROM connections WHERE actor=?) connections,
      (SELECT count(*) FROM evidence e JOIN connections c ON c.id=e.connection WHERE c.actor=?) evidence,
      coalesce((SELECT sum(length(value)) FROM connections WHERE actor=?),0)+
      coalesce((SELECT sum(length(e.value)) FROM evidence e JOIN connections c ON c.id=e.connection WHERE c.actor=?),0)+
      coalesce((SELECT sum(length(a.value)) FROM analysis a JOIN connections c ON c.id=a.connection WHERE c.actor=?),0)+
      coalesce((SELECT sum(length(d.value)) FROM derived d JOIN connections c ON c.id=d.connection WHERE c.actor=?),0) bytes`)
      .get(actorId, actorId, actorId, actorId, actorId, actorId) as {
      connections: number;
      evidence: number;
      bytes: number;
    };
    return { ...row, generation: this.generation(actorId) };
  }
  exportPage(
    actorId: string,
    options: { expectedGeneration: number; cursor?: string; limit?: number },
  ) {
    const generation = this.generation(actorId),
      offset = options.cursor === undefined ? 0 : Number(options.cursor),
      limit = options.limit ?? 100;
    if (generation !== options.expectedGeneration)
      throw new Error("Connected data changed; review again before exporting.");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new TypeError("Connected export page is invalid.");
    const rows = this.db
      .prepare(`SELECT kind,connection,value FROM (
      SELECT 'connection' kind,id connection,json_remove(value,'$.cursor','$.continuation') value,'0:'||id ordering FROM connections WHERE actor=?
      UNION ALL SELECT 'evidence',e.connection,e.value,'1:'||e.connection||':'||e.source_key FROM evidence e JOIN connections c ON c.id=e.connection WHERE c.actor=?
      UNION ALL SELECT 'analysis',a.connection,a.value,'2:'||a.connection FROM analysis a JOIN connections c ON c.id=a.connection WHERE c.actor=?
      UNION ALL SELECT 'receipt',d.connection,d.value,'3:'||d.connection||':'||d.key FROM derived d JOIN connections c ON c.id=d.connection WHERE c.actor=?
      UNION ALL SELECT 'dismissal',d.connection,json_object('key',d.key),'4:'||d.connection||':'||d.key FROM dismissed d JOIN connections c ON c.id=d.connection WHERE c.actor=?
    ) ORDER BY ordering LIMIT ? OFFSET ?`)
      .all(actorId, actorId, actorId, actorId, actorId, limit + 1, offset) as {
      kind: string;
      connection: string;
      value: string;
    }[];
    return {
      format: "ellie-connectors-v1",
      generation,
      items: rows.slice(0, limit).map((row) => ({
        type: row.kind,
        connectionId: row.connection,
        value: JSON.parse(row.value) as unknown,
      })),
      hasMore: rows.length > limit,
      ...(rows.length > limit ? { nextCursor: String(offset + limit) } : {}),
    };
  }
  deletePersonal(actorId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM connections WHERE actor=?").run(actorId);
      this.touch(actorId);
    });
  }
}
