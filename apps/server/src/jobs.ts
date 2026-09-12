import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobMetadata, JobOutcomeCode, JobState } from "@ellie/protocol";

export type { JobMetadata, JobOutcomeCode, JobState } from "@ellie/protocol";

export const JOB_SCHEMA_VERSION = 1;

export type JobKind = "desktop" | "inference";
const terminalStates = ["completed", "failed", "cancelled", "expired", "unknown"] as const;

function recoveryError(): Error {
  return new Error(
    "Job database could not be opened safely. Stop Ellie, preserve the database for diagnosis, and restore a supported backup or move it aside before restarting.",
  );
}

function assertPrivate(path: string, kind: "directory" | "file"): void {
  const stat = lstatSync(path);
  const mode = stat.mode & 0o777;
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  const expectedType = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (
    stat.isSymbolicLink() ||
    !expectedType ||
    mode !== expectedMode ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (kind === "file" && stat.nlink !== 1)
  )
    throw new Error(`job database ${kind} failed private ownership checks`);
}

function metadata(row: Record<string, unknown>): JobMetadata {
  return {
    id: String(row.id),
    kind: row.kind as JobKind,
    target: String(row.target),
    state: row.state as JobState,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at),
    ...(row.outcome_ok === null ? {} : { outcomeOk: Number(row.outcome_ok) === 1 }),
    ...(row.outcome_code === null ? {} : { outcomeCode: row.outcome_code as JobOutcomeCode }),
  };
}

export class JobStore {
  private readonly database!: DatabaseSync;
  private readonly retentionMs: number;
  private readonly maxRows: number;
  readonly path: string;

  constructor(
    path: string,
    options: { now?: number; retentionMs?: number; maxRows?: number } = {},
  ) {
    this.path = path;
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxRows = options.maxRows ?? 10_000;
    try {
      const directory = dirname(path);
      try {
        assertPrivate(directory, "directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertPrivate(directory, "directory");
      }
      try {
        assertPrivate(path, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const descriptor = openSync(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        closeSync(descriptor);
        assertPrivate(path, "file");
      }
      this.database = new DatabaseSync(path);
      this.database.exec(
        "PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA foreign_keys = ON;",
      );
      const integrity = this.database.prepare("PRAGMA quick_check").get() as
        | Record<string, unknown>
        | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok")
        throw new Error("integrity check failed");
      const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
      if (version > JOB_SCHEMA_VERSION)
        throw new Error(`schema version ${version} is newer than supported version 1`);
      if (version === 0) this.migrateFromZero();
      this.recover(options.now ?? Date.now());
    } catch (error) {
      try {
        this.database!.close();
      } catch {}
      if (error instanceof Error && /database is locked/i.test(error.message))
        throw new Error(
          "Job database is already in use by another coordinator. Stop the other coordinator before starting Ellie again.",
        );
      throw recoveryError();
    }
  }

  private transaction(run: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      run();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateFromZero(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('desktop', 'inference')),
          target TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('queued', 'delivered', 'running', 'cancellation_requested', 'completed', 'failed', 'cancelled', 'expired', 'unknown')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          outcome_ok INTEGER CHECK (outcome_ok IN (0, 1)),
          outcome_code TEXT CHECK (outcome_code IS NULL OR outcome_code IN ('succeeded', 'operation_failed', 'timed_out', 'cancelled_by_caller', 'expired_before_delivery', 'abandoned_after_restart', 'unknown_after_restart', 'node_revoked', 'coordinator_stopped'))
        ) STRICT;
        CREATE INDEX jobs_updated_at ON jobs(updated_at);
        PRAGMA user_version = 1;
      `);
    });
  }

  private recover(now: number): void {
    this.transaction(() => {
      this.database
        .prepare(
          "UPDATE jobs SET state = 'expired', updated_at = ?, outcome_ok = 0, outcome_code = 'expired_before_delivery' WHERE state = 'queued' AND expires_at <= ?",
        )
        .run(now, now);
      this.database
        .prepare(
          "UPDATE jobs SET state = 'cancelled', updated_at = ?, outcome_ok = 0, outcome_code = 'abandoned_after_restart' WHERE state = 'queued'",
        )
        .run(now);
      this.database
        .prepare(
          "UPDATE jobs SET state = 'unknown', updated_at = ?, outcome_ok = 0, outcome_code = 'unknown_after_restart' WHERE state IN ('delivered', 'running', 'cancellation_requested')",
        )
        .run(now);
    });
    this.prune(now);
  }

  create(input: {
    id: string;
    kind: JobKind;
    target: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.prune(input.createdAt);
    this.database
      .prepare(
        "INSERT INTO jobs (id, kind, target, state, created_at, updated_at, expires_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
      )
      .run(input.id, input.kind, input.target, input.createdAt, input.createdAt, input.expiresAt);
  }

  markDelivered(id: string, now = Date.now()): void {
    const change = this.database
      .prepare(
        "UPDATE jobs SET state = 'delivered', updated_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(now, id);
    if (change.changes !== 1) throw new Error("Job delivery was not committed; job was not sent.");
  }

  markRunning(id: string, now = Date.now()): boolean {
    const change = this.database
      .prepare(
        "UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'delivered'",
      )
      .run(now, id);
    if (change.changes === 1) return true;
    if (this.get(id)?.state === "cancellation_requested") return false;
    throw new Error("Job start did not match delivered work.");
  }

  requestCancellation(id: string, now = Date.now()): JobMetadata | undefined {
    this.database
      .prepare(
        "UPDATE jobs SET state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE 'cancellation_requested' END, updated_at = ?, outcome_ok = CASE WHEN state = 'queued' THEN 0 ELSE outcome_ok END, outcome_code = CASE WHEN state = 'queued' THEN 'cancelled_by_caller' ELSE outcome_code END WHERE id = ? AND state IN ('queued', 'delivered', 'running')",
      )
      .run(now, id);
    const stored = this.get(id);
    if (stored?.state === "cancelled") this.prune(now);
    return stored;
  }

  finish(
    id: string,
    state: Extract<JobState, "completed" | "failed" | "cancelled" | "expired" | "unknown">,
    outcomeCode: JobOutcomeCode,
    outcomeOk: boolean,
    now = Date.now(),
  ): void {
    const change = this.database
      .prepare(
        `UPDATE jobs SET state = ?, updated_at = ?, outcome_ok = ?, outcome_code = ?
         WHERE id = ? AND state IN ('queued', 'delivered', 'running', 'cancellation_requested')`,
      )
      .run(state, now, outcomeOk ? 1 : 0, outcomeCode, id);
    if (change.changes !== 1) throw new Error("Job completion did not match active work.");
    this.prune(now);
  }

  get(id: string): JobMetadata | undefined {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? metadata(row) : undefined;
  }

  list(target?: string, limit = 100): JobMetadata[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const rows = (
      target
        ? this.database
            .prepare("SELECT * FROM jobs WHERE target = ? ORDER BY created_at DESC LIMIT ?")
            .all(target, bounded)
        : this.database.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(bounded)
    ) as Record<string, unknown>[];
    return rows.map(metadata);
  }

  prune(now = Date.now()): void {
    const terminal = terminalStates.map(() => "?").join(", ");
    this.database
      .prepare(`DELETE FROM jobs WHERE state IN (${terminal}) AND updated_at < ?`)
      .run(...terminalStates, now - this.retentionMs);
    this.database
      .prepare(
        `DELETE FROM jobs WHERE id IN (
          SELECT id FROM jobs WHERE state IN (${terminal}) ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )`,
      )
      .run(...terminalStates, this.maxRows);
  }

  close(): void {
    this.database.close();
  }
}
