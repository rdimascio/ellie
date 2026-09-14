import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync, lstatSync, constants } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nextOccurrence, occurrenceKey } from "./schedule.ts";
import type {
  EnqueueTask,
  EnqueueWorkflow,
  HandlerContext,
  MissedRunPolicy,
  OwnerScope,
  ProgressRecord,
  RuntimeOptions,
  ScheduleTask,
  TaskHandler,
  TaskRecord,
  TaskSchedule,
  TaskState,
  WatchEvent,
  WatchRecord,
  WatchTask,
  WorkflowRecord,
} from "./types.ts";

type Row = Record<string, unknown>;
const terminal = new Set<TaskState>(["succeeded", "failed", "cancelled", "expired", "unknown"]);
const json = <T>(value: unknown, fallback: T): T =>
  value == null ? fallback : (JSON.parse(String(value)) as T);

export class TaskRuntime {
  readonly databasePath: string;
  private readonly db!: DatabaseSync;
  private readonly options: Required<Pick<RuntimeOptions, "concurrency" | "leaseMs" | "tickMs">> &
    RuntimeOptions;
  private readonly handlers = new Map<string, TaskHandler<unknown, unknown>>();
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer?: NodeJS.Timeout;
  private schedulerError?: Error;
  private closed = false;
  private recovered = false;

  private assertOwner(owner: OwnerScope): void {
    if (!/^(user|group):[^:\s][^\s]{0,199}$/.test(owner))
      throw new Error("A canonical owner is required.");
  }

  constructor(options: RuntimeOptions) {
    this.options = {
      concurrency: 4,
      leaseMs: 30_000,
      tickMs: 1_000,
      ...options,
    };
    if (
      !Number.isSafeInteger(this.options.concurrency) ||
      this.options.concurrency < 1 ||
      this.options.concurrency > 64 ||
      !Number.isSafeInteger(this.options.leaseMs) ||
      this.options.leaseMs < 10 ||
      this.options.leaseMs > 86_400_000 ||
      !Number.isSafeInteger(this.options.tickMs) ||
      this.options.tickMs < 10 ||
      this.options.tickMs > 3_600_000
    )
      throw new Error("Task runtime limits are invalid.");
    if (!options.directory) throw new Error("Task runtime directory is required.");
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(options.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (directory.mode & 0o777) !== 0o700 ||
      (process.getuid && directory.uid !== process.getuid())
    )
      throw new Error("Task runtime directory must be a private, real directory.");
    this.databasePath = join(options.directory, "task-runtime.sqlite");
    try {
      try {
        const existing = lstatSync(this.databasePath);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1 ||
          (existing.mode & 0o777) !== 0o600 ||
          (process.getuid && existing.uid !== process.getuid())
        )
          throw new Error("Task runtime database must be a private, regular file.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const fd = openSync(
          this.databasePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        closeSync(fd);
      }
      const file = lstatSync(this.databasePath);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        (file.mode & 0o777) !== 0o600 ||
        (process.getuid && file.uid !== process.getuid())
      )
        throw new Error("Task runtime database must be a private, regular file.");
      this.db = new DatabaseSync(this.databasePath);
      chmodSync(this.databasePath, 0o600);
      this.db.exec(
        "PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT; PRAGMA foreign_keys=ON;",
      );
      const check = this.db.prepare("PRAGMA quick_check").get() as Row | undefined;
      if (!check || Object.values(check)[0] !== "ok")
        throw new Error("Database integrity check failed.");
      this.migrate();
    } catch (error) {
      try {
        this.db?.close();
      } catch {}
      throw new Error(
        `Task runtime database could not be opened safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private migrate(): void {
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version > 1)
      throw new Error("Unsupported task runtime schema; preserve the database and upgrade Ellie.");
    if (version === 0)
      this.db.exec(`
      BEGIN;
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, handler TEXT NOT NULL,
        input TEXT NOT NULL, state TEXT NOT NULL, capabilities TEXT NOT NULL, allowed_capabilities TEXT NOT NULL, parent_id TEXT,
        root_id TEXT NOT NULL, dependencies TEXT NOT NULL, budget TEXT NOT NULL, deadline_at INTEGER,
        expires_at INTEGER, scheduled_for INTEGER, schedule TEXT, missed_policy TEXT, attempt INTEGER NOT NULL,
        retry TEXT, idempotency_key TEXT NOT NULL UNIQUE, result TEXT, outcome_code TEXT,
        outcome_verified INTEGER, lease_until INTEGER, occurrence_key TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX tasks_dispatch ON tasks(state, scheduled_for, created_at);
      CREATE INDEX tasks_root ON tasks(root_id, state);
      CREATE UNIQUE INDEX tasks_occurrence ON tasks(parent_id, occurrence_key) WHERE occurrence_key IS NOT NULL;
      CREATE TABLE progress (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        at INTEGER NOT NULL, message TEXT NOT NULL, current REAL, total REAL);
      CREATE TABLE watches (id TEXT PRIMARY KEY, owner_scope TEXT NOT NULL, topic TEXT NOT NULL,
        handler TEXT NOT NULL, input TEXT NOT NULL, capabilities TEXT NOT NULL, budget TEXT NOT NULL,
        deadline_at INTEGER, expires_at INTEGER, retry TEXT, paused INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE watch_events (owner_scope TEXT NOT NULL, topic TEXT NOT NULL, dedupe_key TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_scope,topic,dedupe_key));
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  registerHandler<Input, Result>(handler: TaskHandler<Input, Result>): void {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(handler.name)) throw new Error("Invalid handler name.");
    if (this.handlers.has(handler.name))
      throw new Error(`Handler already registered: ${handler.name}`);
    this.handlers.set(handler.name, handler as TaskHandler<unknown, unknown>);
  }

  enqueue(request: EnqueueTask): TaskRecord {
    return this.insert(request, "queued");
  }

  /** Atomically creates a cancellable root whose execution waits for every child. */
  enqueueWorkflow(request: EnqueueWorkflow): WorkflowRecord {
    if (
      !Array.isArray(request.children) ||
      request.children.length < 1 ||
      request.children.length > 64
    )
      throw new Error("A workflow requires 1 through 64 children.");
    if (request.children.some((child) => "dependsOn" in child))
      throw new Error("Workflow children cannot have caller-supplied dependencies.");
    if (request.root.parentId || request.root.dependsOn?.length)
      throw new Error("A workflow root cannot have a parent or caller-supplied dependencies.");
    const rootRequest = { ...request.root, id: request.root.id ?? randomUUID() };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const root = this.insert(rootRequest, "queued");
      const children = request.children.map((child) =>
        this.insert(
          {
            ...child,
            id: child.id ?? randomUUID(),
            owner: root.owner,
            parentId: root.id,
          },
          "queued",
        ),
      );
      this.db
        .prepare("UPDATE tasks SET dependencies=?,updated_at=? WHERE id=?")
        .run(JSON.stringify(children.map((child) => child.id)), this.now(), root.id);
      this.db.exec("COMMIT");
      return { root: this.getInternal(root.id)!, children };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  schedule(request: ScheduleTask): TaskRecord {
    if (
      request.missedRunPolicy?.kind === "catch-up" &&
      (!Number.isSafeInteger(request.missedRunPolicy.limit) ||
        request.missedRunPolicy.limit < 1 ||
        request.missedRunPolicy.limit > 100)
    )
      throw new Error("Missed-run catch-up limit is invalid.");
    const scheduledFor = nextOccurrence(request.schedule, this.now() - 1);
    if (scheduledFor === undefined) throw new Error("One-shot schedule is already past.");
    return this.insert(
      request,
      "scheduled",
      scheduledFor,
      request.schedule,
      request.missedRunPolicy ?? { kind: "latest" },
    );
  }

  watch(request: WatchTask): string {
    if (!this.handlers.has(request.handler))
      throw new Error(`Unknown task handler: ${request.handler}`);
    if (
      !/^(user|group):[^:\s][^\s]{0,199}$/.test(request.owner) ||
      !request.topic.trim() ||
      request.topic.length > 200
    )
      throw new Error("A canonical owner and event topic are required.");
    this.assertJson(request.input ?? null, "Watch input");
    if (request.parentId || request.dependsOn?.length || request.allowedCapabilities)
      throw new Error("Watches cannot have parents, dependencies, or a capability ceiling.");
    if (request.id && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(request.id))
      throw new Error("Watch id is invalid.");
    const capabilities = [...new Set(request.capabilities ?? [])];
    if (
      capabilities.length > 64 ||
      capabilities.some(
        (capability) =>
          typeof capability !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability),
      )
    )
      throw new Error("Watch capability is invalid.");
    const finiteTime = (value: number | undefined) =>
      value === undefined || (Number.isSafeInteger(value) && value >= 0);
    if (!finiteTime(request.deadlineAt) || !finiteTime(request.expiresAt))
      throw new Error("Watch deadline is invalid.");
    if (
      request.retry &&
      (!Number.isSafeInteger(request.retry.maxAttempts) ||
        request.retry.maxAttempts < 1 ||
        request.retry.maxAttempts > 10 ||
        !finiteTime(request.retry.delayMs))
    )
      throw new Error("Watch retry policy is invalid.");
    const budget = request.budget ?? {};
    if (
      (budget.maxTasks !== undefined &&
        (!Number.isSafeInteger(budget.maxTasks) ||
          budget.maxTasks < 1 ||
          budget.maxTasks > 10_000)) ||
      (budget.maxConcurrency !== undefined &&
        (!Number.isSafeInteger(budget.maxConcurrency) ||
          budget.maxConcurrency < 1 ||
          budget.maxConcurrency > 64)) ||
      (budget.maxRuntimeMs !== undefined &&
        (!Number.isSafeInteger(budget.maxRuntimeMs) ||
          budget.maxRuntimeMs < 1 ||
          budget.maxRuntimeMs > 86_400_000))
    )
      throw new Error("Watch budget is invalid.");
    const count = Number(
      (
        this.db
          .prepare("SELECT count(*) count FROM watches WHERE owner_scope=?")
          .get(request.owner) as Row
      ).count,
    );
    if (count >= 1_000) throw new Error("Watch limit reached for owner.");
    const id = request.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO watches(id,owner_scope,topic,handler,input,capabilities,budget,deadline_at,expires_at,retry,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        request.owner,
        request.topic,
        request.handler,
        JSON.stringify(request.input ?? null),
        JSON.stringify(capabilities),
        JSON.stringify(budget),
        request.deadlineAt ?? null,
        request.expiresAt ?? null,
        request.retry ? JSON.stringify(request.retry) : null,
        this.now(),
      );
    return id;
  }

  listWatches(owner: OwnerScope): WatchRecord[] {
    this.assertOwner(owner);
    return (
      this.db
        .prepare(
          "SELECT id,owner_scope,topic,handler,paused,created_at FROM watches WHERE owner_scope=? ORDER BY created_at,id",
        )
        .all(owner) as Row[]
    ).map((row) => ({
      id: String(row.id),
      owner: String(row.owner_scope) as OwnerScope,
      topic: String(row.topic),
      handler: String(row.handler),
      paused: Boolean(row.paused),
      createdAt: Number(row.created_at),
    }));
  }

  pauseWatch(id: string, owner: OwnerScope): boolean {
    this.assertOwner(owner);
    return (
      Number(
        this.db.prepare("UPDATE watches SET paused=1 WHERE id=? AND owner_scope=?").run(id, owner)
          .changes,
      ) > 0
    );
  }

  resumeWatch(id: string, owner: OwnerScope): boolean {
    this.assertOwner(owner);
    return (
      Number(
        this.db.prepare("UPDATE watches SET paused=0 WHERE id=? AND owner_scope=?").run(id, owner)
          .changes,
      ) > 0
    );
  }

  removeWatch(id: string, owner: OwnerScope): boolean {
    this.assertOwner(owner);
    return (
      Number(
        this.db.prepare("DELETE FROM watches WHERE id=? AND owner_scope=?").run(id, owner).changes,
      ) > 0
    );
  }

  publish(event: WatchEvent): TaskRecord[] {
    const at = this.now();
    if (
      !/^(user|group):[^:\s][^\s]{0,199}$/.test(event.owner) ||
      !event.topic.trim() ||
      event.topic.length > 200 ||
      !event.dedupeKey ||
      event.dedupeKey.length > 200
    )
      throw new Error("Watch event identity is invalid.");
    this.assertJson(event.payload ?? null, "Watch payload");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const inserted = this.db
        .prepare(
          "INSERT OR IGNORE INTO watch_events(owner_scope,topic,dedupe_key,payload,created_at) VALUES(?,?,?,?,?)",
        )
        .run(event.owner, event.topic, event.dedupeKey, JSON.stringify(event.payload ?? null), at);
      if (Number(inserted.changes) === 0) {
        this.db.exec("COMMIT");
        return [];
      }
      const rows = this.db
        .prepare(
          "SELECT * FROM watches WHERE owner_scope=? AND topic=? AND paused=0 AND (expires_at IS NULL OR expires_at>?)",
        )
        .all(event.owner, event.topic, at) as Row[];
      const created = rows.map((row) =>
        this.enqueue({
          owner: event.owner,
          handler: String(row.handler),
          input: {
            watchInput: json(row.input, null),
            event: event.payload ?? null,
          },
          capabilities: json(row.capabilities, []),
          budget: json(row.budget, {}),
          ...(row.deadline_at != null ? { deadlineAt: Number(row.deadline_at) } : {}),
          ...(row.expires_at != null ? { expiresAt: Number(row.expires_at) } : {}),
          ...(row.retry ? { retry: json(row.retry, { maxAttempts: 0 }) } : {}),
          id: `${String(row.id)}:${event.dedupeKey}`,
        }),
      );
      this.db.exec("COMMIT");
      return created;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insert(
    request: EnqueueTask,
    state: TaskState,
    scheduledFor?: number,
    schedule?: TaskSchedule,
    missed?: MissedRunPolicy,
    occurrence?: string,
    independentRoot = false,
  ): TaskRecord {
    this.prune(this.now());
    if (!this.handlers.has(request.handler))
      throw new Error(`Unknown task handler: ${request.handler}`);
    if (!/^(user|group):[^:\s][^\s]{0,199}$/.test(request.owner))
      throw new Error("Task owner must be a canonical user: or group: scope.");
    const id = request.id ?? randomUUID();
    const now = this.now();
    const parent = request.parentId ? this.getInternal(request.parentId) : undefined;
    if (request.parentId && (!parent || parent.owner !== request.owner))
      throw new Error("Parent task is outside this owner scope.");
    if (parent && terminal.has(parent.state))
      throw new Error("Cannot add work beneath a terminal parent.");
    if (
      parent?.deadlineAt !== undefined &&
      request.deadlineAt !== undefined &&
      request.deadlineAt > parent.deadlineAt
    )
      throw new Error("Child deadline exceeds its parent deadline.");
    if (
      parent?.expiresAt !== undefined &&
      request.expiresAt !== undefined &&
      request.expiresAt > parent.expiresAt
    )
      throw new Error("Child expiry exceeds its parent expiry.");
    const deadlineAt = request.deadlineAt ?? parent?.deadlineAt;
    const expiresAt = request.expiresAt ?? parent?.expiresAt;
    const rootId = independentRoot ? id : (parent?.rootId ?? id);
    const root = parent ? this.getInternal(rootId) : undefined;
    const budget = root?.budget ?? request.budget ?? {};
    if (budget.maxTasks !== undefined) {
      const count = Number(
        (this.db.prepare("SELECT count(*) count FROM tasks WHERE root_id = ?").get(rootId) as Row)
          .count,
      );
      if (count >= budget.maxTasks) throw new Error("Task tree budget exhausted.");
    }
    const dependencies = [...new Set(request.dependsOn ?? [])];
    for (const dependency of dependencies) {
      const task = this.getInternal(dependency);
      if (!task || task.owner !== request.owner)
        throw new Error("Dependency is outside this owner scope.");
    }
    const capabilities = [...new Set(request.capabilities ?? [])];
    const handlerCapabilities = this.handlers.get(request.handler)?.requiredCapabilities ?? [];
    const allowedCapabilities = [
      ...new Set(
        request.allowedCapabilities ??
          (parent ? parent.allowedCapabilities : [...handlerCapabilities, ...capabilities]),
      ),
    ];
    if (
      parent &&
      allowedCapabilities.some((capability) => !parent.allowedCapabilities.includes(capability))
    )
      throw new Error("Child capability ceiling exceeds its parent capability ceiling.");
    if (capabilities.length > 64 || dependencies.length > 128)
      throw new Error("Task grants or dependencies exceed limit.");
    if (
      capabilities.some(
        (capability) =>
          typeof capability !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability),
      )
    )
      throw new Error("Task capability is invalid.");
    if (
      allowedCapabilities.length > 64 ||
      allowedCapabilities.some(
        (capability) =>
          typeof capability !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(capability),
      )
    )
      throw new Error("Task capability ceiling is invalid.");
    if (
      [...new Set([...handlerCapabilities, ...capabilities])].some(
        (capability) => !allowedCapabilities.includes(capability),
      )
    )
      throw new Error("Task requirements exceed the parent capability ceiling.");
    const finiteTime = (value: number | undefined) =>
      value === undefined || (Number.isSafeInteger(value) && value >= 0);
    if (!finiteTime(deadlineAt) || !finiteTime(expiresAt))
      throw new Error("Task deadline is invalid.");
    if (
      request.retry &&
      (!Number.isSafeInteger(request.retry.maxAttempts) ||
        request.retry.maxAttempts < 1 ||
        request.retry.maxAttempts > 10 ||
        !finiteTime(request.retry.delayMs))
    )
      throw new Error("Task retry policy is invalid.");
    if (
      (budget.maxTasks !== undefined &&
        (!Number.isSafeInteger(budget.maxTasks) ||
          budget.maxTasks < 1 ||
          budget.maxTasks > 10_000)) ||
      (budget.maxConcurrency !== undefined &&
        (!Number.isSafeInteger(budget.maxConcurrency) ||
          budget.maxConcurrency < 1 ||
          budget.maxConcurrency > 64)) ||
      (budget.maxRuntimeMs !== undefined &&
        (!Number.isSafeInteger(budget.maxRuntimeMs) ||
          budget.maxRuntimeMs < 1 ||
          budget.maxRuntimeMs > 86_400_000))
    )
      throw new Error("Task budget is invalid.");
    this.assertJson(request.input ?? null, "Task input");
    this.db
      .prepare(
        `INSERT INTO tasks (id,owner_scope,handler,input,state,capabilities,allowed_capabilities,parent_id,root_id,
      dependencies,budget,deadline_at,expires_at,scheduled_for,schedule,missed_policy,attempt,retry,idempotency_key,
      occurrence_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        request.owner,
        request.handler,
        JSON.stringify(request.input ?? null),
        state,
        JSON.stringify(capabilities),
        JSON.stringify(allowedCapabilities),
        request.parentId ?? null,
        rootId,
        JSON.stringify(dependencies),
        JSON.stringify(budget),
        deadlineAt ?? null,
        expiresAt ?? null,
        scheduledFor ?? null,
        schedule ? JSON.stringify(schedule) : null,
        missed ? JSON.stringify(missed) : null,
        0,
        request.retry ? JSON.stringify(request.retry) : null,
        id,
        occurrence ?? null,
        now,
        now,
      );
    return this.getInternal(id)!;
  }

  private assertJson(value: unknown, label: string, max = 256_000): void {
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(value);
    } catch {}
    if (encoded === undefined || Buffer.byteLength(encoded) > max)
      throw new Error(`${label} is invalid or too large.`);
  }

  private prune(at: number): void {
    const cutoff = at - 90 * 86_400_000;
    this.db
      .prepare(
        "DELETE FROM progress WHERE task_id IN (SELECT id FROM tasks WHERE state IN ('succeeded','failed','cancelled','expired','unknown') AND updated_at < ?)",
      )
      .run(cutoff);
    this.db
      .prepare(
        "DELETE FROM tasks WHERE state IN ('succeeded','failed','cancelled','expired','unknown') AND updated_at < ?",
      )
      .run(cutoff);
    const excess = this.db
      .prepare(
        "SELECT id FROM tasks WHERE state IN ('succeeded','failed','cancelled','expired','unknown') ORDER BY updated_at DESC,id DESC LIMIT -1 OFFSET 10000",
      )
      .all() as Row[];
    const removeProgress = this.db.prepare("DELETE FROM progress WHERE task_id=?"),
      removeTask = this.db.prepare("DELETE FROM tasks WHERE id=?");
    for (const row of excess) {
      removeProgress.run(String(row.id));
      removeTask.run(String(row.id));
    }
    this.db.prepare("DELETE FROM watch_events WHERE created_at < ?").run(cutoff);
    const oldEvents = this.db
      .prepare(
        "SELECT owner_scope,topic,dedupe_key FROM watch_events ORDER BY created_at DESC LIMIT -1 OFFSET 10000",
      )
      .all() as Row[];
    const removeEvent = this.db.prepare(
      "DELETE FROM watch_events WHERE owner_scope=? AND topic=? AND dedupe_key=?",
    );
    for (const row of oldEvents)
      removeEvent.run(String(row.owner_scope), String(row.topic), String(row.dedupe_key));
  }

  private fromRow(row?: Row): TaskRecord | undefined {
    if (!row) return undefined;
    return {
      id: String(row.id),
      owner: String(row.owner_scope) as OwnerScope,
      handler: String(row.handler),
      input: json(row.input, null),
      state: String(row.state) as TaskState,
      requiredCapabilities: json(row.capabilities, []),
      allowedCapabilities: json(row.allowed_capabilities, []),
      ...(row.parent_id ? { parentId: String(row.parent_id) } : {}),
      rootId: String(row.root_id),
      dependsOn: json(row.dependencies, []),
      budget: json(row.budget, {}),
      ...(row.deadline_at != null ? { deadlineAt: Number(row.deadline_at) } : {}),
      ...(row.expires_at != null ? { expiresAt: Number(row.expires_at) } : {}),
      ...(row.scheduled_for != null ? { scheduledFor: Number(row.scheduled_for) } : {}),
      ...(row.schedule
        ? {
            schedule: json<TaskSchedule>(row.schedule, { kind: "once", at: 0 }),
          }
        : {}),
      ...(row.missed_policy
        ? {
            missedRunPolicy: json<MissedRunPolicy>(row.missed_policy, {
              kind: "latest",
            }),
          }
        : {}),
      attempt: Number(row.attempt),
      ...(row.retry ? { retry: json(row.retry, { maxAttempts: 0 }) } : {}),
      idempotencyKey: String(row.idempotency_key),
      ...(row.result ? { result: json(row.result, null) } : {}),
      ...(row.outcome_code ? { outcomeCode: String(row.outcome_code) } : {}),
      ...(row.outcome_verified != null ? { outcomeVerified: Boolean(row.outcome_verified) } : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private getInternal(id: string): TaskRecord | undefined {
    return this.fromRow(
      this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined,
    );
  }

  get(id: string, owner?: OwnerScope): TaskRecord | undefined {
    const task = this.getInternal(id);
    return task && (!owner || task.owner === owner) ? task : undefined;
  }

  list(query: {
    owner: OwnerScope;
    state?: TaskState;
    parentId?: string;
    limit?: number;
  }): TaskRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(query.limit ?? 100)));
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE owner_scope = ?
      ${query.state ? "AND state = ?" : ""} ${query.parentId ? "AND parent_id = ?" : ""} ORDER BY created_at,id LIMIT ?`,
      )
      .all(
        query.owner,
        ...(query.state ? [query.state] : []),
        ...(query.parentId ? [query.parentId] : []),
        limit,
      ) as Row[];
    return rows.map((row) => this.fromRow(row)!);
  }

  progress(id: string, owner: OwnerScope): ProgressRecord[] {
    if (!this.get(id, owner)) return [];
    return (
      this.db.prepare("SELECT * FROM progress WHERE task_id = ? ORDER BY id").all(id) as Row[]
    ).map((row) => ({
      id: Number(row.id),
      taskId: String(row.task_id),
      at: Number(row.at),
      message: String(row.message),
      ...(row.current != null ? { current: Number(row.current) } : {}),
      ...(row.total != null ? { total: Number(row.total) } : {}),
    }));
  }

  pause(id: string, owner: OwnerScope): boolean {
    return this.transition(id, owner, ["queued", "scheduled", "waiting"], "paused");
  }
  resume(id: string, owner: OwnerScope): boolean {
    return this.transition(id, owner, ["paused", "waiting"], "queued");
  }

  cancel(id: string, owner: OwnerScope): boolean {
    const task = this.get(id, owner);
    if (!task || terminal.has(task.state)) return false;
    const ids = [
      id,
      ...(
        this.db
          .prepare(
            "WITH RECURSIVE tree(id) AS (SELECT id FROM tasks WHERE parent_id = ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id) SELECT id FROM tree",
          )
          .all(id) as Row[]
      ).map((r) => String(r.id)),
    ];
    const now = this.now();
    const update = this.db.prepare(
      "UPDATE tasks SET state='cancelled', outcome_code='cancelled', updated_at=? WHERE id=? AND state NOT IN ('succeeded','failed','cancelled','expired','unknown')",
    );
    for (const taskId of ids) {
      this.active.get(taskId)?.controller.abort(new Error("Task cancelled."));
      update.run(now, taskId);
    }
    return true;
  }

  private transition(id: string, owner: OwnerScope, from: TaskState[], to: TaskState): boolean {
    const task = this.get(id, owner);
    if (!task || !from.includes(task.state)) return false;
    this.db.prepare(`UPDATE tasks SET state=?,updated_at=? WHERE id=?`).run(to, this.now(), id);
    return true;
  }

  async runNow(id: string, owner: OwnerScope): Promise<void> {
    const task = this.get(id, owner);
    if (!task) throw new Error("Task not found in owner scope.");
    if (terminal.has(task.state))
      throw new Error(`Task in terminal state ${task.state} cannot be run again.`);
    if (task.schedule && task.state === "scheduled") this.materialize(task, this.now());
    else if (task.state === "scheduled" || task.state === "paused" || task.state === "waiting")
      this.db
        .prepare("UPDATE tasks SET state='queued',scheduled_for=NULL,updated_at=? WHERE id=?")
        .run(this.now(), id);
    await this.tick();
  }

  private recover(): void {
    if (this.recovered) return;
    this.recovered = true;
    const now = this.now();
    for (const row of this.db.prepare("SELECT * FROM tasks WHERE state='running'").all() as Row[]) {
      const task = this.fromRow(row)!;
      const handler = this.handlers.get(task.handler);
      const canRetry =
        handler?.resumable === true && task.retry && task.attempt < task.retry.maxAttempts;
      this.db
        .prepare(
          "UPDATE tasks SET state=?,outcome_code=?,scheduled_for=?,lease_until=NULL,updated_at=? WHERE id=?",
        )
        .run(
          canRetry ? "queued" : "unknown",
          canRetry ? "resuming_after_restart" : "side_effect_outcome_unknown",
          canRetry ? now + (task.retry?.delayMs ?? 0) : null,
          now,
          task.id,
        );
    }
  }

  async tick(at = this.now()): Promise<void> {
    if (this.closed) throw new Error("Task runtime is closed.");
    this.recover();
    this.prune(at);
    this.expire(at);
    this.materializeDue(at);
    const rows = this.db
      .prepare(
        "SELECT * FROM tasks WHERE state='queued' AND (scheduled_for IS NULL OR scheduled_for <= ?) ORDER BY created_at,id LIMIT ?",
      )
      .all(at, this.options.concurrency) as Row[];
    const promises: Promise<void>[] = [];
    for (const row of rows) {
      const task = this.fromRow(row)!;
      if (!this.dependenciesReady(task)) continue;
      const reserved = this.reserve(task, at);
      if (reserved) promises.push(this.dispatch(reserved, at));
    }
    await Promise.allSettled(promises);
  }

  private expire(at: number): void {
    this.db
      .prepare(
        `UPDATE tasks SET state='expired',outcome_code='deadline_or_expiry_reached',updated_at=?
      WHERE state IN ('queued','scheduled','waiting','paused') AND ((expires_at IS NOT NULL AND expires_at <= ?) OR (deadline_at IS NOT NULL AND deadline_at <= ?))`,
      )
      .run(at, at, at);
  }

  private dependenciesReady(task: TaskRecord): boolean {
    for (const id of task.dependsOn) {
      const dependency = this.getInternal(id);
      if (
        !dependency ||
        dependency.state === "failed" ||
        dependency.state === "cancelled" ||
        dependency.state === "expired" ||
        dependency.state === "unknown"
      ) {
        this.db
          .prepare(
            "UPDATE tasks SET state='failed',outcome_code='dependency_failed',updated_at=? WHERE id=?",
          )
          .run(this.now(), task.id);
        return false;
      }
      if (dependency.state !== "succeeded") return false;
    }
    return true;
  }

  private treeHasCapacity(task: TaskRecord): boolean {
    const limit = task.budget.maxConcurrency;
    if (limit === undefined) return true;
    const count = Number(
      (
        this.db
          .prepare("SELECT count(*) count FROM tasks WHERE root_id=? AND state='running'")
          .get(task.rootId) as Row
      ).count,
    );
    return count < limit;
  }

  private reserve(task: TaskRecord, at: number): TaskRecord | undefined {
    if (!this.handlers.has(task.handler)) {
      this.db
        .prepare(
          "UPDATE tasks SET state='waiting',outcome_code='handler_unavailable',updated_at=? WHERE id=? AND state='queued'",
        )
        .run(at, task.id);
      return undefined;
    }
    const running = Number(
      (this.db.prepare("SELECT count(*) count FROM tasks WHERE state='running'").get() as Row)
        .count,
    );
    if (running >= this.options.concurrency || !this.treeHasCapacity(task)) return undefined;
    const attempt = task.attempt + 1;
    const changed = this.db
      .prepare(
        "UPDATE tasks SET state='running',attempt=?,lease_until=?,updated_at=? WHERE id=? AND state='queued'",
      )
      .run(attempt, at + this.options.leaseMs, at, task.id);
    return Number(changed.changes) === 1 ? this.getInternal(task.id) : undefined;
  }

  private materializeDue(at: number): void {
    for (const row of this.db
      .prepare(
        "SELECT * FROM tasks WHERE state='scheduled' AND scheduled_for <= ? ORDER BY scheduled_for",
      )
      .all(at) as Row[]) {
      const scheduleTask = this.fromRow(row)!;
      const policy = scheduleTask.missedRunPolicy ?? { kind: "latest" };
      const occurrences: number[] = [];
      let occurrence = scheduleTask.scheduledFor!;
      while (occurrence <= at) {
        occurrences.push(occurrence);
        const next = nextOccurrence(scheduleTask.schedule!, occurrence);
        if (next === undefined) break;
        occurrence = next;
        if (occurrences.length > 10_000) throw new Error("Missed schedule window is too large.");
      }
      const selected =
        policy.kind === "skip"
          ? occurrences.length > 1
            ? []
            : occurrences
          : policy.kind === "latest"
            ? occurrences.slice(-1)
            : occurrences.slice(0, policy.limit);
      for (const due of selected) this.materialize(scheduleTask, due);
      const next = nextOccurrence(scheduleTask.schedule!, occurrences.at(-1) ?? at);
      if (next === undefined)
        this.db
          .prepare(
            "UPDATE tasks SET state='succeeded',outcome_code='schedule_complete',outcome_verified=1,updated_at=? WHERE id=?",
          )
          .run(at, scheduleTask.id);
      else
        this.db
          .prepare("UPDATE tasks SET scheduled_for=?,updated_at=? WHERE id=?")
          .run(next, at, scheduleTask.id);
    }
  }

  private materialize(template: TaskRecord, due: number): void {
    const key = occurrenceKey(template.schedule!, due);
    try {
      this.insert(
        {
          owner: template.owner,
          handler: template.handler,
          input: template.input,
          capabilities: template.requiredCapabilities,
          parentId: template.id,
          budget: template.budget,
          deadlineAt: template.deadlineAt,
          expiresAt: template.expiresAt,
          retry: template.retry,
        },
        "queued",
        undefined,
        undefined,
        undefined,
        key,
        true,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE constraint failed"))
        throw error;
    }
  }

  private dispatch(task: TaskRecord, at: number): Promise<void> {
    const handler = this.handlers.get(task.handler)!;
    const controller = new AbortController();
    const required = new Set([
      ...(handler.requiredCapabilities ?? []),
      ...task.requiredCapabilities,
    ]);
    const current = task;
    let deadline: NodeJS.Timeout | undefined;
    const deadlines = [
      current.deadlineAt,
      current.budget.maxRuntimeMs ? at + current.budget.maxRuntimeMs : undefined,
    ].filter((value): value is number => value !== undefined);
    const effectiveDeadline = deadlines.length > 0 ? Math.min(...deadlines) : undefined;
    if (effectiveDeadline !== undefined)
      deadline = setTimeout(
        () => controller.abort(new Error("Task deadline reached.")),
        Math.max(0, effectiveDeadline - this.now()),
      );
    const context: HandlerContext = {
      task: current,
      signal: controller.signal,
      idempotencyKey: current.idempotencyKey,
      progress: (update) => {
        if (
          typeof update.message !== "string" ||
          !update.message.trim() ||
          update.message.length > 4_000
        )
          throw new Error("Progress message is invalid or too large.");
        if (
          (update.current !== undefined && !Number.isFinite(update.current)) ||
          (update.total !== undefined && !Number.isFinite(update.total))
        )
          throw new Error("Progress values are invalid.");
        this.db
          .prepare("INSERT INTO progress(task_id,at,message,current,total) VALUES(?,?,?,?,?)")
          .run(
            current.id,
            this.now(),
            update.message,
            update.current ?? null,
            update.total ?? null,
          );
        this.db
          .prepare(
            "DELETE FROM progress WHERE task_id=? AND id NOT IN (SELECT id FROM progress WHERE task_id=? ORDER BY id DESC LIMIT 1000)",
          )
          .run(current.id, current.id);
      },
      enqueueChild: (child) => {
        if (controller.signal.aborted || this.getInternal(current.id)?.state !== "running")
          throw new Error("Parent task is no longer active.");
        return this.enqueue({
          ...child,
          owner: current.owner,
          parentId: current.id,
        });
      },
    };
    const operation = Promise.resolve().then(async () => {
      try {
        const granted = new Set(await (this.options.capabilityResolver?.(task.owner) ?? []));
        if (this.getInternal(current.id)?.state !== "running") return;
        if (controller.signal.aborted) {
          this.db
            .prepare(
              "UPDATE tasks SET state='expired',outcome_code='cancelled_before_dispatch',lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
            )
            .run(this.now(), current.id);
          return;
        }
        if ([...required].some((capability) => !granted.has(capability))) {
          this.db
            .prepare(
              "UPDATE tasks SET state='failed',outcome_code='capability_revoked',outcome_verified=1,lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
            )
            .run(this.now(), task.id);
          return;
        }
        try {
          const result = await handler.run(context, current.input);
          if (this.getInternal(current.id)?.state === "cancelled") return;
          if (controller.signal.aborted) {
            this.db
              .prepare(
                "UPDATE tasks SET state='unknown',outcome_code='deadline_outcome_unknown',lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
              )
              .run(this.now(), current.id);
            return;
          }
          this.assertJson(result ?? null, "Task result");
          const verified = handler.checkOutcome
            ? await handler.checkOutcome(context, result)
            : false;
          if (this.getInternal(current.id)?.state !== "running") return;
          if (controller.signal.aborted) {
            this.db
              .prepare(
                "UPDATE tasks SET state='unknown',outcome_code='outcome_check_deadline_unknown',lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
              )
              .run(this.now(), current.id);
            return;
          }
          this.db
            .prepare(
              "UPDATE tasks SET state=?,result=?,outcome_code=?,outcome_verified=?,lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
            )
            .run(
              verified ? "succeeded" : "failed",
              JSON.stringify(result ?? null),
              verified ? "outcome_verified" : "outcome_unverified",
              verified ? 1 : 0,
              this.now(),
              current.id,
            );
        } catch (error) {
          if (this.getInternal(current.id)?.state === "cancelled") return;
          const latest = this.getInternal(current.id)!;
          const retry =
            handler.resumable === true &&
            latest.retry &&
            latest.attempt < latest.retry.maxAttempts &&
            !controller.signal.aborted;
          this.db
            .prepare(
              "UPDATE tasks SET state=?,scheduled_for=?,outcome_code=?,lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
            )
            .run(
              retry ? "queued" : controller.signal.aborted ? "unknown" : "failed",
              retry ? this.now() + (latest.retry?.delayMs ?? 0) : null,
              controller.signal.aborted
                ? "deadline_outcome_unknown"
                : error instanceof Error
                  ? error.message.slice(0, 200)
                  : "handler_failed",
              this.now(),
              current.id,
            );
        }
      } catch (error) {
        if (this.getInternal(current.id)?.state === "running")
          this.db
            .prepare(
              "UPDATE tasks SET state=?,outcome_code=?,lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
            )
            .run(
              controller.signal.aborted ? "expired" : "failed",
              controller.signal.aborted
                ? "cancelled_before_dispatch"
                : "capability_resolution_failed",
              this.now(),
              current.id,
            );
      } finally {
        if (deadline) clearTimeout(deadline);
        this.active.delete(current.id);
      }
    });
    this.active.set(task.id, { controller, promise: operation });
    return operation;
  }

  start(): void {
    if (!this.timer) {
      const run = () =>
        void this.tick().catch((error) => {
          this.schedulerError = error instanceof Error ? error : new Error(String(error));
        });
      this.timer = setInterval(run, this.options.tickMs);
      this.timer.unref();
      run();
    }
  }
  get lastSchedulerError(): Error | undefined {
    return this.schedulerError;
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const active = [...this.active.entries()];
    if (!active.length) return;
    const stoppedAt = this.now();
    for (const [id, value] of active) {
      this.db
        .prepare(
          "UPDATE tasks SET state='unknown',outcome_code='coordinator_shutdown_outcome_unknown',lease_until=NULL,updated_at=? WHERE id=? AND state='running'",
        )
        .run(stoppedAt, id);
      value.controller.abort(new Error("Task runtime is stopping."));
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.min(this.options.leaseMs, 5_000));
    });
    const outcome = await Promise.race([
      Promise.allSettled(active.map(([, value]) => value.promise)).then(() => "settled" as const),
      timeout,
    ]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout")
      throw new Error("Task handlers did not stop cooperatively; runtime remains open.");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.stop();
    this.closed = true;
    this.db.close();
  }
}
