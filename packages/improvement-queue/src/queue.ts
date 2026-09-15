import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  IMPROVEMENT_LANE,
  IMPROVEMENT_SCOPE,
  type EnqueueImprovement,
  type ImprovementClaim,
  type ImprovementItem,
  type ImprovementOutcome,
  type ImprovementResult,
  type ReconciliationAttribution,
  type ReconciliationRecord,
} from "./types.ts";
import { improvementDeduplicationKey } from "./policy.ts";
import { readPrivateEvidenceFile } from "./evidence-file.ts";
import { validatedImprovementStateDirectory } from "./state-path.ts";

const SCHEMA_VERSION = 1;
const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const commitPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function bounded(value: string, name: string, maximum: number, pattern?: RegExp): string {
  if (value.length === 0 || value.length > maximum || (pattern && !pattern.test(value)))
    throw new Error(`${name} is invalid.`);
  return value;
}

function privateEntry(path: string, kind: "directory" | "file"): Stats {
  const stat = lstatSync(path);
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (
    stat.isSymbolicLink() ||
    (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) ||
    (stat.mode & 0o777) !== expectedMode ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (kind === "file" && stat.nlink !== 1)
  )
    throw new Error(`Improvement queue ${kind} failed private ownership checks.`);
  return stat;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function rowItem(row: Record<string, unknown>): ImprovementItem {
  return {
    id: String(row.id),
    lane: row.lane as ImprovementItem["lane"],
    scope: row.scope as ImprovementItem["scope"],
    deduplicationKey: String(row.dedup_key),
    state: row.state as ImprovementItem["state"],
    priority: Number(row.priority),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    evidence: {
      format: "life-quality-report-v1",
      reference: String(row.evidence_reference),
      sha256: String(row.evidence_sha256),
      sourceRevision: String(row.source_revision),
      runnerSha256: String(row.runner_sha256),
      evaluatorSha256: String(row.evaluator_sha256),
      artifactSha256: String(row.artifact_sha256),
      scenario: "memory",
      observedStatus: row.observed_status as "fail" | "error",
    },
    attemptsUsed: Number(row.attempts_used),
    attemptBudget: Number(row.attempt_budget),
    maxRuntimeMs: Number(row.max_runtime_ms),
    ...(row.owner_id === null ? {} : { ownerId: String(row.owner_id) }),
    ...(row.lease_id === null ? {} : { leaseId: String(row.lease_id) }),
    ...(row.lease_started_at === null ? {} : { leaseStartedAt: Number(row.lease_started_at) }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: Number(row.lease_expires_at) }),
    ...(row.outcome === null ? {} : { outcome: row.outcome as ImprovementOutcome }),
    ...(row.outcome_evidence_reference === null
      ? {}
      : { outcomeEvidenceReference: String(row.outcome_evidence_reference) }),
    ...(row.outcome_evidence_sha256 === null
      ? {}
      : { outcomeEvidenceSha256: String(row.outcome_evidence_sha256) }),
    ...(row.candidate_commit === null ? {} : { candidateCommit: String(row.candidate_commit) }),
    ...(row.candidate_reference === null
      ? {}
      : { candidateReference: String(row.candidate_reference) }),
    promotionState: row.promotion_state as ImprovementItem["promotionState"],
    ...(row.result_key === null ? {} : { resultKey: String(row.result_key) }),
  };
}

export class ImprovementQueue {
  readonly directory: string;
  readonly path: string;
  private readonly database!: DatabaseSync;
  private readonly directoryDescriptor!: number;
  private readonly directoryIdentity!: FileIdentity;
  private readonly databaseIdentity!: FileIdentity;
  private readonly now: () => number;
  private readonly makeId: () => string;

  constructor(directory: string, options: { now?: () => number; makeId?: () => string } = {}) {
    try {
      this.directory = validatedImprovementStateDirectory(directory);
    } catch (error) {
      throw new Error(
        "Improvement queue could not be opened safely. Preserve it for diagnosis and use a supported private state directory.",
        { cause: error },
      );
    }
    this.path = join(this.directory, "queue.sqlite");
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? randomUUID;
    try {
      try {
        privateEntry(this.directory, "directory");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        if (validatedImprovementStateDirectory(this.directory) !== this.directory)
          throw new Error("Improvement queue directory changed during creation.");
        privateEntry(this.directory, "directory");
      }
      this.directoryIdentity = identity(privateEntry(this.directory, "directory"));
      this.directoryDescriptor = openSync(
        this.directory,
        constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
      );
      if (!sameIdentity(identity(fstatSync(this.directoryDescriptor)), this.directoryIdentity))
        throw new Error("Improvement queue directory changed while opening.");
      this.assertSafeSidecars();
      try {
        privateEntry(this.path, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const descriptor = openSync(
          this.path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
          0o600,
        );
        closeSync(descriptor);
        privateEntry(this.path, "file");
      }
      this.databaseIdentity = identity(privateEntry(this.path, "file"));
      this.database = new DatabaseSync(this.path);
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      this.assertStorageIdentity();
      const integrity = this.database.prepare("PRAGMA quick_check").get() as
        | Record<string, unknown>
        | undefined;
      if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error("integrity failed");
      const version = Number(this.database.prepare("PRAGMA user_version").get()?.user_version);
      if (version > SCHEMA_VERSION) throw new Error(`unsupported schema ${version}`);
      if (version === 0) this.migrate();
      this.refreshExpiredLeases();
    } catch (error) {
      try {
        this.database!.close();
      } catch {}
      try {
        closeSync(this.directoryDescriptor!);
      } catch {}
      throw new Error(
        "Improvement queue could not be opened safely. Preserve it for diagnosis and use a supported private state directory.",
        { cause: error },
      );
    }
  }

  private transaction<T>(run: () => T): T {
    this.assertStorageIdentity();
    this.database.exec("BEGIN IMMEDIATE");
    let active = true;
    try {
      const result = run();
      this.database.exec("COMMIT");
      active = false;
      this.assertStorageIdentity();
      return result;
    } catch (error) {
      if (active) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertSafeSidecars(): void {
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try {
        privateEntry(`${this.path}${suffix}`, "file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private assertStorageIdentity(): void {
    if (validatedImprovementStateDirectory(this.directory) !== this.directory)
      throw new Error("Improvement queue directory path changed.");
    const directoryPathIdentity = identity(privateEntry(this.directory, "directory"));
    const directoryDescriptorIdentity = identity(fstatSync(this.directoryDescriptor));
    const databasePathIdentity = identity(privateEntry(this.path, "file"));
    if (
      !sameIdentity(directoryPathIdentity, this.directoryIdentity) ||
      !sameIdentity(directoryDescriptorIdentity, this.directoryIdentity) ||
      !sameIdentity(databasePathIdentity, this.databaseIdentity)
    )
      throw new Error("Improvement queue storage identity changed while open.");
    this.assertSafeSidecars();
  }

  private read<T>(run: () => T): T {
    this.assertStorageIdentity();
    const result = run();
    this.assertStorageIdentity();
    return result;
  }

  private migrate(): void {
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE improvement_items (
          id TEXT PRIMARY KEY,
          dedup_key TEXT NOT NULL UNIQUE,
          lane TEXT NOT NULL CHECK (lane = 'life-quality'),
          scope TEXT NOT NULL CHECK (scope = 'repository:ellie'),
          state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'reconciliation_required', 'candidate_recorded', 'succeeded', 'failed', 'blocked')),
          priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 100),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          evidence_format TEXT NOT NULL CHECK (evidence_format = 'life-quality-report-v1'),
          evidence_reference TEXT NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          source_revision TEXT NOT NULL,
          runner_sha256 TEXT NOT NULL,
          evaluator_sha256 TEXT NOT NULL,
          artifact_sha256 TEXT NOT NULL,
          scenario TEXT NOT NULL CHECK (scenario = 'memory'),
          observed_status TEXT NOT NULL CHECK (observed_status IN ('fail', 'error')),
          attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
          attempt_budget INTEGER NOT NULL CHECK (attempt_budget BETWEEN 1 AND 10),
          max_runtime_ms INTEGER NOT NULL CHECK (max_runtime_ms BETWEEN 1000 AND 1800000),
          owner_id TEXT,
          lease_id TEXT,
          lease_started_at INTEGER,
          lease_expires_at INTEGER,
          outcome TEXT CHECK (outcome IS NULL OR outcome IN ('candidate', 'no_change', 'failed', 'blocked')),
          outcome_evidence_reference TEXT,
          outcome_evidence_sha256 TEXT,
          candidate_commit TEXT,
          candidate_reference TEXT UNIQUE,
          promotion_state TEXT NOT NULL DEFAULT 'not_applicable' CHECK (promotion_state IN ('not_applicable', 'awaiting_release_owner')),
          result_key TEXT UNIQUE
        ) STRICT;
        CREATE INDEX improvement_claim_order ON improvement_items(state, priority DESC, created_at, id);
        CREATE TABLE improvement_reconciliations (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES improvement_items(id),
          stale_lease_id TEXT NOT NULL,
          operator_role TEXT NOT NULL CHECK (operator_role = 'local-operator'),
          operator_id TEXT NOT NULL,
          decision TEXT NOT NULL CHECK (decision = 'blocked'),
          evidence_reference TEXT NOT NULL,
          evidence_sha256 TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(item_id, stale_lease_id)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
    });
  }

  refreshExpiredLeases(): number {
    const now = this.now();
    return this.transaction(() =>
      Number(
        this.database
          .prepare(
            "UPDATE improvement_items SET state = 'reconciliation_required', updated_at = ? WHERE state = 'leased' AND lease_expires_at <= ?",
          )
          .run(now, now).changes,
      ),
    );
  }

  enqueue(input: EnqueueImprovement): { item: ImprovementItem; created: boolean } {
    if (input.lane !== IMPROVEMENT_LANE || input.scope !== IMPROVEMENT_SCOPE)
      throw new Error("Unsupported improvement lane or scope.");
    bounded(input.deduplicationKey, "deduplication key", 64, sha256Pattern);
    if (input.evidence.format !== "life-quality-report-v1" || input.evidence.scenario !== "memory")
      throw new Error("Unsupported improvement evidence format or scenario.");
    if (input.evidence.observedStatus !== "fail" && input.evidence.observedStatus !== "error")
      throw new Error("Only failing or errored evidence can enter the improvement queue.");
    bounded(input.evidence.reference, "evidence reference", 4096);
    bounded(input.evidence.sha256, "evidence SHA-256", 64, sha256Pattern);
    bounded(input.evidence.sourceRevision, "source revision", 40, /^[a-f0-9]{40}$/);
    bounded(input.evidence.runnerSha256, "runner SHA-256", 64, sha256Pattern);
    bounded(input.evidence.evaluatorSha256, "evaluator SHA-256", 64, sha256Pattern);
    bounded(input.evidence.artifactSha256, "artifact SHA-256", 64, sha256Pattern);
    if (input.deduplicationKey !== improvementDeduplicationKey(input.evidence))
      throw new Error("Improvement deduplication key does not match its evidence inputs.");
    if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100)
      throw new Error("Improvement priority is invalid.");
    if (
      !Number.isSafeInteger(input.attemptBudget) ||
      input.attemptBudget < 1 ||
      input.attemptBudget > 10
    )
      throw new Error("Improvement attempt budget is invalid.");
    if (
      !Number.isSafeInteger(input.maxRuntimeMs) ||
      input.maxRuntimeMs < 1000 ||
      input.maxRuntimeMs > 30 * 60 * 1000
    )
      throw new Error("Improvement runtime budget is invalid.");
    const now = this.now();
    return this.transaction(() => {
      const id = this.makeId();
      const change = this.database
        .prepare(
          `INSERT INTO improvement_items (
            id, dedup_key, lane, scope, state, priority, created_at, updated_at,
            evidence_format, evidence_reference, evidence_sha256, source_revision,
            runner_sha256, evaluator_sha256, artifact_sha256, scenario, observed_status,
            attempt_budget, max_runtime_ms
          ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dedup_key) DO NOTHING`,
        )
        .run(
          id,
          input.deduplicationKey,
          input.lane,
          input.scope,
          input.priority,
          now,
          now,
          input.evidence.format,
          input.evidence.reference,
          input.evidence.sha256,
          input.evidence.sourceRevision,
          input.evidence.runnerSha256,
          input.evidence.evaluatorSha256,
          input.evidence.artifactSha256,
          input.evidence.scenario,
          input.evidence.observedStatus,
          input.attemptBudget,
          input.maxRuntimeMs,
        );
      const row = this.database
        .prepare("SELECT * FROM improvement_items WHERE dedup_key = ?")
        .get(input.deduplicationKey) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Improvement enqueue did not persist an item.");
      return { item: rowItem(row), created: change.changes === 1 };
    });
  }

  claim(ownerId: string, leaseMs: number): ImprovementClaim | undefined {
    bounded(ownerId, "owner id", 128, identifierPattern);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 30 * 60 * 1000)
      throw new Error("Lease duration must be from 1,000 through 1,800,000 ms.");
    this.refreshExpiredLeases();
    const now = this.now();
    return this.transaction(() => {
      const candidate = this.database
        .prepare(
          `SELECT id, max_runtime_ms FROM improvement_items
           WHERE state = 'queued' AND attempts_used < attempt_budget
           ORDER BY priority DESC, created_at, id LIMIT 1`,
        )
        .get() as Record<string, unknown> | undefined;
      if (!candidate) return undefined;
      const leaseId = this.makeId();
      const leaseExpiresAt = now + Math.min(leaseMs, Number(candidate.max_runtime_ms));
      const changed = this.database
        .prepare(
          `UPDATE improvement_items SET state = 'leased', owner_id = ?, lease_id = ?,
             lease_started_at = ?, lease_expires_at = ?, attempts_used = attempts_used + 1,
             updated_at = ? WHERE id = ? AND state = 'queued'`,
        )
        .run(ownerId, leaseId, now, leaseExpiresAt, now, String(candidate.id));
      if (changed.changes !== 1) throw new Error("Improvement claim lost serialization.");
      const item = this.get(String(candidate.id));
      if (!item) throw new Error("Claimed improvement item is unavailable.");
      return { item, ownerId, leaseId, leaseExpiresAt };
    });
  }

  quarantineLease(itemId: string, ownerId: string, leaseId: string): ImprovementItem {
    bounded(itemId, "item id", 128, identifierPattern);
    bounded(ownerId, "owner id", 128, identifierPattern);
    bounded(leaseId, "lease id", 128, identifierPattern);
    const now = this.now();
    return this.transaction(() => {
      const current = this.get(itemId);
      if (!current || current.ownerId !== ownerId || current.leaseId !== leaseId)
        throw new Error("Uncertain work does not match the item's owner lease.");
      if (current.state === "reconciliation_required") return current;
      if (current.state !== "leased")
        throw new Error("Only actively leased work can become uncertain.");
      const changed = this.database
        .prepare(
          `UPDATE improvement_items SET state = 'reconciliation_required', updated_at = ?
           WHERE id = ? AND state = 'leased' AND owner_id = ? AND lease_id = ?`,
        )
        .run(now, itemId, ownerId, leaseId);
      if (changed.changes !== 1) throw new Error("Uncertain owner lease was not preserved.");
      return this.get(itemId)!;
    });
  }

  recordResult(
    itemId: string,
    ownerId: string,
    leaseId: string,
    result: ImprovementResult,
  ): ImprovementItem {
    bounded(itemId, "item id", 128, identifierPattern);
    bounded(ownerId, "owner id", 128, identifierPattern);
    bounded(leaseId, "lease id", 128, identifierPattern);
    bounded(result.resultKey, "result key", 128, identifierPattern);
    bounded(result.originEvidenceSha256, "origin evidence SHA-256", 64, sha256Pattern);
    bounded(result.evidenceReference, "result evidence reference", 4096);
    bounded(result.evidenceSha256, "result evidence SHA-256", 64, sha256Pattern);
    if (
      !(["candidate", "no_change", "failed", "blocked"] satisfies ImprovementOutcome[]).includes(
        result.outcome,
      )
    )
      throw new Error("Improvement result outcome is unsupported.");
    if (result.candidateCommit)
      bounded(result.candidateCommit, "candidate commit", 64, commitPattern);
    if (result.candidateReference) {
      bounded(result.candidateReference, "candidate reference", 2048);
      if (!result.candidateReference.startsWith("https://"))
        throw new Error("Candidate reference must be HTTPS.");
    }
    if (result.outcome === "candidate" && (!result.candidateCommit || !result.candidateReference))
      throw new Error("Candidate outcomes require both commit and reference.");
    if (result.outcome !== "candidate" && (result.candidateCommit || result.candidateReference))
      throw new Error("Only candidate outcomes may record candidate metadata.");
    const now = this.now();
    return this.transaction(() => {
      const existing = this.get(itemId);
      if (!existing) throw new Error("Improvement item was not found.");
      if (existing.ownerId !== ownerId || existing.leaseId !== leaseId)
        throw new Error("Result does not match the item's owner lease.");
      if (existing.evidence.sha256 !== result.originEvidenceSha256)
        throw new Error("Result is not bound to the item's originating evidence.");
      if (existing.resultKey) {
        const matches =
          existing.resultKey === result.resultKey &&
          existing.outcome === result.outcome &&
          existing.outcomeEvidenceReference === result.evidenceReference &&
          existing.outcomeEvidenceSha256 === result.evidenceSha256 &&
          existing.candidateCommit === result.candidateCommit &&
          existing.candidateReference === result.candidateReference;
        if (matches) return existing;
        throw new Error("Improvement item already has a different recorded result.");
      }
      if (existing.state !== "leased" && existing.state !== "reconciliation_required")
        throw new Error("Result does not match active or uncertain leased work.");
      const outcomeEvidence = readPrivateEvidenceFile(result.evidenceReference);
      if (outcomeEvidence.sha256 !== result.evidenceSha256)
        throw new Error("Result evidence SHA-256 does not match its private file.");
      const state =
        result.outcome === "candidate"
          ? "candidate_recorded"
          : result.outcome === "no_change"
            ? "succeeded"
            : result.outcome;
      const promotion =
        result.outcome === "candidate" ? "awaiting_release_owner" : "not_applicable";
      const changed = this.database
        .prepare(
          `UPDATE improvement_items SET state = ?, updated_at = ?, outcome = ?,
             outcome_evidence_reference = ?, outcome_evidence_sha256 = ?,
             candidate_commit = ?, candidate_reference = ?, promotion_state = ?, result_key = ?
           WHERE id = ? AND owner_id = ? AND lease_id = ?
             AND state IN ('leased', 'reconciliation_required') AND result_key IS NULL`,
        )
        .run(
          state,
          now,
          result.outcome,
          outcomeEvidence.reference,
          outcomeEvidence.sha256,
          result.candidateCommit ?? null,
          result.candidateReference ?? null,
          promotion,
          result.resultKey,
          itemId,
          ownerId,
          leaseId,
        );
      if (changed.changes !== 1) throw new Error("Improvement result was not recorded.");
      return this.get(itemId)!;
    });
  }

  markBlocked(
    itemId: string,
    staleLeaseId: string,
    operator: ReconciliationAttribution,
    input: {
      evidenceReference: string;
      evidenceSha256: string;
    },
  ): ReconciliationRecord {
    bounded(itemId, "item id", 128, identifierPattern);
    bounded(staleLeaseId, "stale lease id", 128, identifierPattern);
    if (operator.role !== "local-operator")
      throw new Error("Blocked reconciliation requires local-operator attribution.");
    bounded(operator.id, "operator id", 128, identifierPattern);
    bounded(input.evidenceReference, "reconciliation evidence reference", 4096);
    bounded(input.evidenceSha256, "reconciliation evidence SHA-256", 64, sha256Pattern);
    const now = this.now();
    return this.transaction(() => {
      const duplicate = this.database
        .prepare(
          "SELECT * FROM improvement_reconciliations WHERE item_id = ? AND stale_lease_id = ?",
        )
        .get(itemId, staleLeaseId) as Record<string, unknown> | undefined;
      if (duplicate) {
        const existing = this.reconciliationRow(duplicate);
        if (
          existing.operator.role === operator.role &&
          existing.operator.id === operator.id &&
          existing.evidenceReference === input.evidenceReference &&
          existing.evidenceSha256 === input.evidenceSha256
        )
          return existing;
        throw new Error("Uncertain lease already has a different reconciliation record.");
      }
      const item = this.get(itemId);
      if (!item || item.state !== "reconciliation_required" || item.leaseId !== staleLeaseId)
        throw new Error("Reconciliation does not match uncertain leased work.");
      const evidence = readPrivateEvidenceFile(input.evidenceReference);
      if (evidence.sha256 !== input.evidenceSha256)
        throw new Error("Reconciliation evidence SHA-256 does not match its private file.");
      const id = this.makeId();
      this.database
        .prepare(
          `INSERT INTO improvement_reconciliations (
            id, item_id, stale_lease_id, operator_role, operator_id, decision,
            evidence_reference, evidence_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          itemId,
          staleLeaseId,
          operator.role,
          operator.id,
          "blocked",
          evidence.reference,
          evidence.sha256,
          now,
        );
      this.database
        .prepare(
          `UPDATE improvement_items SET state = 'blocked', updated_at = ?, outcome = 'blocked',
               outcome_evidence_reference = ?, outcome_evidence_sha256 = ?
             WHERE id = ? AND state = 'reconciliation_required' AND lease_id = ?`,
        )
        .run(now, evidence.reference, evidence.sha256, itemId, staleLeaseId);
      return {
        id,
        itemId,
        staleLeaseId,
        operator,
        decision: "blocked",
        evidenceReference: evidence.reference,
        evidenceSha256: evidence.sha256,
        createdAt: now,
      };
    });
  }

  private reconciliationRow(row: Record<string, unknown>): ReconciliationRecord {
    return {
      id: String(row.id),
      itemId: String(row.item_id),
      staleLeaseId: String(row.stale_lease_id),
      operator: { role: "local-operator", id: String(row.operator_id) },
      decision: "blocked",
      evidenceReference: String(row.evidence_reference),
      evidenceSha256: String(row.evidence_sha256),
      createdAt: Number(row.created_at),
    };
  }

  get(id: string): ImprovementItem | undefined {
    return this.read(() => {
      const row = this.database.prepare("SELECT * FROM improvement_items WHERE id = ?").get(id) as
        | Record<string, unknown>
        | undefined;
      return row ? rowItem(row) : undefined;
    });
  }

  list(limit = 100): ImprovementItem[] {
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.read(() =>
      (
        this.database
          .prepare("SELECT * FROM improvement_items ORDER BY created_at DESC, id LIMIT ?")
          .all(boundedLimit) as Record<string, unknown>[]
      ).map(rowItem),
    );
  }

  close(): void {
    let validationError: unknown;
    try {
      this.assertStorageIdentity();
    } catch (error) {
      validationError = error;
    }
    this.database.close();
    closeSync(this.directoryDescriptor);
    if (validationError) throw validationError;
  }
}
