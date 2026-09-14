import { createHash } from "node:crypto";
import type { AnticipatoryProposal } from "../../life-anticipation/src/index.ts";
import { LifeAccessError, LifeConflictError, LifeStore } from "../../life-core/src/index.ts";
import type { LifeRecord } from "../../life-core/src/index.ts";
import { TaskRuntime } from "../../task-runtime/src/index.ts";
import type { EvidenceRef } from "./provider-types.ts";

const READ = "life.records.read";
const WRITE = "life.records.write";

export interface ConnectedPreparationMapping {
  key: string;
  recordId: string;
  revision: number;
  taskId: string;
  evidenceRefs: EvidenceRef[];
  expiresAt: number;
}

export interface ConnectedPreparationsOptions {
  life: LifeStore;
  tasks: TaskRuntime;
  /** Rechecks connected state, Prepare mode, and every evidence revision. */
  isCurrent(actorId: string, connectionId: string, refs: EvidenceRef[]): boolean;
  now?: () => number;
}

type NotifyInput = {
  actorId: string;
  connectionId: string;
  recordId: string;
  recordRevision: number;
  templateTaskId: string;
  evidenceRefs: EvidenceRef[];
  expiresAt: number;
};

function bounded(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`${label} is invalid.`);
  return value.trim();
}

function refs(input: unknown, connectionId: string): EvidenceRef[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8)
    throw new TypeError("Preparation evidence is invalid.");
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new TypeError("Preparation evidence is invalid.");
    const candidate = item as Record<string, unknown>;
    if (candidate.connectionId !== connectionId)
      throw new TypeError("Preparation evidence belongs to another connection.");
    return {
      connectionId,
      sourceKey: bounded(candidate.sourceKey, "Evidence source key", 500),
      sourceRevision: bounded(candidate.sourceRevision, "Evidence source revision", 500),
    };
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function isQuiet(life: LifeStore, actorId: string, at: number): boolean {
  const settings = life.resolveSettings({ userId: actorId }).values;
  if ((settings.proactiveSuggestions ?? settings.proactive) === false) return true;
  const quiet = settings.quietHours;
  if (!quiet || typeof quiet !== "object" || Array.isArray(quiet)) return false;
  const { enabled, start, end } = quiet as Record<string, unknown>;
  if (
    enabled === false ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    start >= 24 ||
    end < 0 ||
    end > 24 ||
    start === end
  )
    return false;
  let timeZone =
    typeof settings.timeZone === "string"
      ? settings.timeZone
      : Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(at);
  } catch {
    timeZone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(at),
    value = (type: string) => Number(parts.find((part) => part.type === type)?.value),
    localTime = value("hour") + value("minute") / 60;
  return start < end
    ? localTime >= start && localTime < end
    : localTime >= start || localTime < end;
}

function matches(
  record: LifeRecord,
  input: NotifyInput,
  taskId: string,
  parentId?: string,
): boolean {
  return (
    (record.kind === "reminder" || record.kind === "routine") &&
    record.scope.type === "user" &&
    record.scope.id === input.actorId &&
    record.revision === input.recordRevision &&
    record.data.type === "connected-preparation-v1" &&
    record.data.connectionId === input.connectionId &&
    record.data.taskId === input.templateTaskId &&
    (taskId === input.templateTaskId || parentId === input.templateTaskId) &&
    record.provenance.length > 0 &&
    record.provenance.every((item) => item.invalidatedAt === undefined)
  );
}

/** Materializes private, guarded reminders from connector preparation proposals. */
export class ConnectedPreparations {
  private readonly life: LifeStore;
  private readonly tasks: TaskRuntime;
  private readonly isCurrent: ConnectedPreparationsOptions["isCurrent"];
  private readonly now: () => number;

  constructor(options: ConnectedPreparationsOptions) {
    this.life = options.life;
    this.tasks = options.tasks;
    this.isCurrent = options.isCurrent;
    this.now = options.now ?? Date.now;
    try {
      this.tasks.registerHandler<NotifyInput, Record<string, unknown>>({
        name: "life.connected.notify",
        requiredCapabilities: [READ, WRITE],
        resumable: true,
        run: async (context, input) => {
          const at = this.now();
          if (context.task.owner !== `user:${input.actorId}`)
            return { status: "skipped", reason: "owner_mismatch" };
          if (at > input.expiresAt) return { status: "skipped", reason: "proposal_expired" };
          const record = this.life.getRecord({ userId: input.actorId }, input.recordId);
          if (!record || !matches(record, input, context.task.id, context.task.parentId))
            return { status: "skipped", reason: "reminder_changed_or_unavailable" };
          if (!this.isCurrent(input.actorId, input.connectionId, input.evidenceRefs))
            return { status: "skipped", reason: "connection_or_evidence_changed" };
          if (isQuiet(this.life, input.actorId, at))
            return { status: "skipped", reason: "proactivity_or_quiet_hours" };
          // Recheck authority immediately before the only durable effect.
          if (!this.isCurrent(input.actorId, input.connectionId, input.evidenceRefs))
            return { status: "skipped", reason: "connection_or_evidence_changed" };
          const notificationId = `connected-notification-${digest(context.idempotencyKey)}`;
          const existing = this.life.getRecord({ userId: input.actorId }, notificationId);
          if (existing) {
            if (
              existing.kind !== "event" ||
              existing.data.type !== "notification" ||
              existing.data.reminderId !== record.id ||
              existing.data.deliveryKey !== context.idempotencyKey
            )
              throw new LifeConflictError("Connected notification id is already in use.");
            return { status: "delivered", notificationId: existing.id };
          }
          const notification = this.life.createRecord(
            { userId: input.actorId },
            {
              id: notificationId,
              kind: "event",
              title: `Notification: ${record.title}`,
              scope: record.scope,
              data: {
                type: "notification",
                reminderId: record.id,
                deliveryKey: context.idempotencyKey,
                deliveredAt: at,
                connected: true,
              },
              relationships: [{ type: "reminder", targetId: record.id }],
            },
          );
          return { status: "delivered", notificationId: notification.id };
        },
        checkOutcome: (_context, result) =>
          result.status === "delivered" || result.status === "skipped",
      });
    } catch (error) {
      if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error;
    }
  }

  apply(
    actorIdInput: string,
    connectionIdInput: string,
    proposal: AnticipatoryProposal,
    sourceIdInput: string,
    authorityGenerationInput = 0,
  ): ConnectedPreparationMapping | undefined {
    const actorId = bounded(actorIdInput, "Actor id", 200),
      connectionId = bounded(connectionIdInput, "Connection id", 200),
      sourceId = bounded(sourceIdInput, "Source id", 200),
      key = `reminder:${bounded(proposal.key, "Proposal key", 1000)}`,
      at = this.now(),
      dueAt = proposal.suggestedReminderAt,
      suggestedSchedule = proposal.suggestedSchedule,
      expiresAt = proposal.expiresAt,
      evidenceRefs = refs(proposal.evidenceRefs, connectionId),
      authorityGeneration = authorityGenerationInput;
    if (!Number.isSafeInteger(authorityGeneration) || authorityGeneration < 0)
      throw new TypeError("Connection authority generation is invalid.");
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= at) return undefined;
    const schedule = suggestedSchedule
      ? suggestedSchedule.kind === "weekly" &&
        Number.isSafeInteger(suggestedSchedule.weekday) &&
        suggestedSchedule.weekday >= 0 &&
        suggestedSchedule.weekday <= 6 &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(suggestedSchedule.time) &&
        typeof suggestedSchedule.timeZone === "string" &&
        suggestedSchedule.timeZone.length <= 100
        ? suggestedSchedule
        : undefined
      : typeof dueAt === "number" && Number.isSafeInteger(dueAt) && dueAt > at && dueAt <= expiresAt
        ? ({ kind: "once", at: dueAt } as const)
        : undefined;
    if (!schedule) return undefined;
    if (schedule.kind === "weekly") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: schedule.timeZone }).format(at);
      } catch {
        return undefined;
      }
    }
    if (!this.isCurrent(actorId, connectionId, evidenceRefs)) return undefined;
    const fingerprint = digest({
        actorId,
        connectionId,
        authorityGeneration,
        key,
        schedule,
        expiresAt,
        evidenceRefs,
      }),
      recordId = `connected-reminder-${fingerprint}`,
      taskId = `connected-reminder-task-${fingerprint}`,
      actor = { userId: actorId },
      priorTask = this.tasks.get(taskId, `user:${actorId}`),
      existing = this.life.getRecord(actor, recordId);
    if (priorTask?.state === "cancelled") return undefined;
    if (existing) {
      const exact =
        existing.revision === 1 &&
        existing.kind === (schedule.kind === "weekly" ? "routine" : "reminder") &&
        existing.scope.type === "user" &&
        existing.scope.id === actorId &&
        existing.data.type === "connected-preparation-v1" &&
        existing.data.taskId === taskId &&
        (schedule.kind === "weekly" || existing.data.dueAt === dueAt) &&
        (schedule.kind === "once" ||
          JSON.stringify(existing.data.schedule) === JSON.stringify(schedule)) &&
        existing.data.connectionId === connectionId &&
        existing.data.key === key &&
        JSON.stringify(existing.data.evidenceRefs) === JSON.stringify(evidenceRefs);
      // A user's edit owns the record. It must not be rebound to connector state.
      if (!exact) return undefined;
      if (schedule.kind === "weekly" && priorTask) {
        const retainedExpiry = existing.data.expiresAt;
        if (!Number.isSafeInteger(retainedExpiry) || (retainedExpiry as number) <= at)
          return undefined;
        return {
          key,
          recordId,
          revision: existing.revision,
          taskId,
          evidenceRefs,
          expiresAt: retainedExpiry as number,
        };
      }
    } else {
      if (!this.life.getRecord(actor, sourceId)) return undefined;
      this.life.createRecord(actor, {
        id: recordId,
        kind: schedule.kind === "weekly" ? "routine" : "reminder",
        title: bounded(proposal.title, "Proposal title", 2000),
        body: bounded(proposal.reason, "Proposal reason", 5_000),
        scope: { type: "user", id: actorId },
        data: {
          type: "connected-preparation-v1",
          taskId,
          ...(schedule.kind === "once" ? { dueAt } : { schedule }),
          expiresAt,
          connectionId,
          key,
          evidenceRefs,
        },
        provenance: [{ sourceId, reference: key, derived: true }],
      });
    }
    const record = this.life.getRecord(actor, recordId)!;
    if (!priorTask) {
      try {
        this.tasks.schedule({
          id: taskId,
          owner: `user:${actorId}`,
          handler: "life.connected.notify",
          input: {
            actorId,
            connectionId,
            recordId,
            recordRevision: record.revision,
            templateTaskId: taskId,
            evidenceRefs,
            expiresAt,
          } satisfies NotifyInput,
          capabilities: [READ, WRITE],
          allowedCapabilities: [READ, WRITE],
          schedule,
          expiresAt,
          retry: { maxAttempts: 2 },
        });
      } catch (error) {
        // A synchronous failure cannot leave a newly-created false reminder behind.
        if (!existing) {
          try {
            this.life.deleteRecord(actor, record.id, record.revision);
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Preparation scheduling and cleanup failed.",
            );
          }
        }
        throw error;
      }
    } else if (
      priorTask.owner !== `user:${actorId}` ||
      priorTask.handler !== "life.connected.notify" ||
      JSON.stringify(priorTask.input) !==
        JSON.stringify({
          actorId,
          connectionId,
          recordId,
          recordRevision: record.revision,
          templateTaskId: taskId,
          evidenceRefs,
          expiresAt,
        })
    ) {
      throw new LifeConflictError("Connected preparation task binding changed.");
    }
    return { key, recordId, revision: record.revision, taskId, evidenceRefs, expiresAt };
  }

  invalidate(actorIdInput: string, mapping: ConnectedPreparationMapping): void {
    const actorId = bounded(actorIdInput, "Actor id", 200),
      actor = { userId: actorId },
      record = this.life.getRecord(actor, mapping.recordId),
      task = this.tasks.get(mapping.taskId, `user:${actorId}`),
      taskInput =
        task?.input && typeof task.input === "object" && !Array.isArray(task.input)
          ? (task.input as Record<string, unknown>)
          : undefined,
      taskOwned =
        task?.handler === "life.connected.notify" &&
        taskInput?.recordId === mapping.recordId &&
        taskInput?.templateTaskId === mapping.taskId &&
        typeof taskInput.connectionId === "string" &&
        mapping.evidenceRefs.every((ref) => ref.connectionId === taskInput.connectionId);
    if (!taskOwned && !record) return;
    try {
      if (taskOwned) this.tasks.cancel(mapping.taskId, `user:${actorId}`);
    } catch (error) {
      if (!(error instanceof Error) || !/not found|terminal/i.test(error.message)) throw error;
    }
    if (!record) return;
    const owned =
      record.kind === "reminder" &&
      record.scope.type === "user" &&
      record.scope.id === actorId &&
      record.data.type === "connected-preparation-v1" &&
      record.data.taskId === mapping.taskId &&
      record.data.key === mapping.key;
    if (!owned) return;
    if (record.revision === mapping.revision) {
      this.life.deleteRecord(actor, record.id, record.revision);
      return;
    }
    // Preserve user edits while removing connector assertions from current context.
    try {
      this.life.updateRecord(actor, record.id, record.revision, {
        provenance: record.provenance.map((item) =>
          item.invalidatedAt === undefined ? { ...item, invalidatedAt: this.now() } : item,
        ),
        data: { ...record.data, cancelled: true, connectedInvalidatedAt: this.now() },
      });
    } catch (error) {
      if (!(error instanceof LifeAccessError || error instanceof LifeConflictError)) throw error;
    }
  }

  cancelConnection(
    actorId: string,
    connectionIdInput: string,
    mappings: readonly ConnectedPreparationMapping[],
  ): void {
    const connectionId = bounded(connectionIdInput, "Connection id", 200);
    if (!Array.isArray(mappings) || mappings.length > 100)
      throw new TypeError("Connected preparation mapping list is invalid.");
    for (const mapping of mappings) {
      if (
        !Array.isArray(mapping.evidenceRefs) ||
        mapping.evidenceRefs.length < 1 ||
        mapping.evidenceRefs.some((ref: EvidenceRef) => ref.connectionId !== connectionId)
      )
        throw new TypeError("Connected preparation belongs to another connection.");
      this.invalidate(actorId, mapping);
    }
  }
}
