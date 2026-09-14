import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";
import type { OwnerScope, TaskRecord, TaskState } from "../../task-runtime/src/index.ts";
import { LifeStore } from "../../life-core/src/index.ts";
import { TaskRuntime } from "../../task-runtime/src/index.ts";

export type ScheduledDeliveryStatus =
  | "scheduled"
  | "paused"
  | "running"
  | "delivered"
  | "skipped"
  | "complete"
  | "cancelled"
  | "failed"
  | "unknown";
export type ScheduledDeliveryAction = "pause" | "resume" | "cancel" | "run";
export interface ScheduledDelivery {
  record: LifeRecord;
  taskId: string;
  activeTaskId?: string;
  status: ScheduledDeliveryStatus;
  scheduleStatus: ScheduledDeliveryStatus;
  occurrence?: {
    taskId: string;
    state: TaskState;
    status: ScheduledDeliveryStatus;
    outcomeCode?: string;
    outcomeVerified?: boolean;
  };
  actions: ScheduledDeliveryAction[];
}
export interface ScheduledDeliveryPage {
  items: ScheduledDelivery[];
  hasMore: boolean;
  scanned: number;
}
export class ScheduledDeliveryError extends Error {
  readonly code: "not_found" | "ambiguous" | "invalid_binding" | "partial_window" | "conflict";
  constructor(
    code: "not_found" | "ambiguous" | "invalid_binding" | "partial_window" | "conflict",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

const owner = (scope: LifeScope): OwnerScope => `${scope.type}:${scope.id}`;
const terminal = new Set<TaskState>(["succeeded", "failed", "cancelled", "expired", "unknown"]);
type DeliveryRecord = Pick<LifeRecord, "id" | "kind" | "scope" | "data">;
export type DeliveryKind = "reminder" | "timer" | "routine";
const recordEligible = (record: DeliveryRecord): boolean =>
  record.kind === "reminder" ||
  record.kind === "timer" ||
  (record.kind === "routine" &&
    record.data.type !== "teaching-guide-v1" &&
    record.data.type !== "learning-improvement-v1");
const matchesRecord = (
  task: TaskRecord,
  record: DeliveryRecord,
  expectedOwner: OwnerScope,
): boolean => {
  if (
    task.owner !== expectedOwner ||
    !["reminder.notify", "life.connected.notify"].includes(task.handler)
  )
    return false;
  if (!task.input || typeof task.input !== "object" || Array.isArray(task.input)) return false;
  const input = task.input as Record<string, unknown>;
  if (input.recordId !== record.id) return false;
  if (input.scope !== undefined) {
    const scope = input.scope;
    if (
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      (scope as Record<string, unknown>).type !== record.scope.type ||
      (scope as Record<string, unknown>).id !== record.scope.id
    )
      return false;
  }
  return true;
};
const baseStatus = (record: DeliveryRecord, task: TaskRecord): ScheduledDeliveryStatus => {
  if (record.data.completed === true) return "complete";
  if (record.data.cancelled === true || task.state === "cancelled") return "cancelled";
  if (task.state === "succeeded") return "complete";
  if (task.state === "failed" || task.state === "expired") return "failed";
  if (task.state === "unknown") return "unknown";
  return task.state === "queued" || task.state === "waiting" ? "scheduled" : task.state;
};
const occurrenceStatus = (record: DeliveryRecord, task: TaskRecord): ScheduledDeliveryStatus => {
  const base = baseStatus(record, task);
  if (task.state !== "succeeded" || task.outcomeVerified !== true) return base;
  const resultStatus =
    task.result && typeof task.result === "object" && !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>).status
      : undefined;
  if (resultStatus === "delivered") return "delivered";
  if (resultStatus === "skipped") return "skipped";
  return "complete";
};
const actions = (task: TaskRecord): ScheduledDeliveryAction[] => {
  if (task.state === "paused") return ["resume", "cancel", "run"];
  if (["queued", "waiting", "scheduled"].includes(task.state)) return ["pause", "cancel", "run"];
  if (task.state === "running") return ["cancel"];
  return [];
};

export class ScheduledDeliveries {
  private readonly store: LifeStore;
  private readonly tasks: TaskRuntime;
  constructor(store: LifeStore, tasks: TaskRuntime) {
    this.store = store;
    this.tasks = tasks;
  }

  statusFor(
    record: Pick<LifeRecord, "id" | "kind" | "scope" | "data">,
  ): Omit<ScheduledDelivery, "record"> {
    if (!recordEligible(record) || typeof record.data.taskId !== "string")
      throw new ScheduledDeliveryError("invalid_binding", "Record has no scheduled delivery.");
    const expectedOwner = owner(record.scope),
      template = this.tasks.get(record.data.taskId, expectedOwner);
    if (!template || !matchesRecord(template, record, expectedOwner))
      throw new ScheduledDeliveryError("invalid_binding", "Scheduled delivery binding is invalid.");
    const occurrences = this.tasks.deliveryOccurrences(template.id, expectedOwner),
      activeChild =
        occurrences.active && matchesRecord(occurrences.active, record, expectedOwner)
          ? occurrences.active
          : undefined,
      latestChild =
        occurrences.latest && matchesRecord(occurrences.latest, record, expectedOwner)
          ? occurrences.latest
          : undefined,
      scheduleStatus = baseStatus(record, template),
      currentOccurrence = activeChild ?? latestChild;
    let visibleStatus = scheduleStatus;
    if (terminal.has(template.state)) {
      if (currentOccurrence) visibleStatus = occurrenceStatus(record, currentOccurrence);
      else if (template.state === "succeeded")
        visibleStatus = record.data.completed === true ? "complete" : "unknown";
    }
    return {
      taskId: template.id,
      ...(activeChild ? { activeTaskId: activeChild.id } : {}),
      status: visibleStatus,
      scheduleStatus,
      ...(currentOccurrence
        ? {
            occurrence: {
              taskId: currentOccurrence.id,
              state: currentOccurrence.state,
              status: occurrenceStatus(record, currentOccurrence),
              ...(currentOccurrence.outcomeCode
                ? { outcomeCode: currentOccurrence.outcomeCode }
                : {}),
              ...(currentOccurrence.outcomeVerified !== undefined
                ? { outcomeVerified: currentOccurrence.outcomeVerified }
                : {}),
            },
          }
        : {}),
      actions: terminal.has(template.state) && activeChild ? ["cancel"] : actions(template),
    };
  }

  private bound(record: LifeRecord): ScheduledDelivery {
    return { record, ...this.statusFor(record) };
  }

  list(
    actor: LifeActor,
    query: {
      scope: LifeScope;
      kinds?: DeliveryKind[];
      limit?: number;
      scanLimit?: number;
    },
  ): ScheduledDeliveryPage {
    const limit = query.limit ?? 100,
      scanLimit = query.scanLimit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("scheduled delivery limit is invalid");
    if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > 500)
      throw new TypeError("scheduled delivery scan limit is invalid");
    const kinds = query.kinds ?? ["reminder", "timer", "routine"];
    if (!kinds.length || new Set(kinds).size !== kinds.length)
      throw new TypeError("scheduled delivery kinds are invalid");
    const records = this.store.listRecords(actor, {
        scope: query.scope,
        kinds,
        limit: scanLimit,
      }),
      items: ScheduledDelivery[] = [];
    for (const record of records) {
      if (!recordEligible(record) || typeof record.data.taskId !== "string") continue;
      try {
        items.push(this.bound(record));
      } catch (error) {
        if (!(error instanceof ScheduledDeliveryError) || error.code !== "invalid_binding")
          throw error;
      }
      if (items.length === limit) break;
    }
    return {
      items,
      hasMore: items.length === limit || records.length === scanLimit,
      scanned: records.length,
    };
  }

  find(
    actor: LifeActor,
    scope: LifeScope,
    idOrTitle: string,
    kinds: DeliveryKind[] = ["reminder", "timer", "routine"],
  ): ScheduledDelivery {
    if (typeof idOrTitle !== "string" || idOrTitle.length < 1 || idOrTitle.length > 2000)
      throw new TypeError("scheduled delivery query is invalid");
    if (!kinds.length || new Set(kinds).size !== kinds.length)
      throw new TypeError("scheduled delivery kinds are invalid");
    const direct = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(idOrTitle)
      ? this.store.getRecord(actor, idOrTitle)
      : undefined;
    if (
      direct &&
      kinds.includes(direct.kind as DeliveryKind) &&
      direct.scope.type === scope.type &&
      direct.scope.id === scope.id
    )
      return this.bound(direct);
    const records = this.store.listRecords(actor, {
        scope,
        kinds,
        limit: 500,
      }),
      matches = records.filter(
        (record) =>
          recordEligible(record) && record.title.toLowerCase() === idOrTitle.toLowerCase(),
      );
    if (records.length === 500 && matches.length <= 1)
      throw new ScheduledDeliveryError(
        "partial_window",
        "Scheduled delivery title is not unique within the bounded lookup window.",
      );
    if (matches.length > 1)
      throw new ScheduledDeliveryError(
        "ambiguous",
        "More than one scheduled delivery has that title.",
      );
    if (!matches[0]) {
      throw new ScheduledDeliveryError("not_found", "Scheduled delivery was not found.");
    }
    return this.bound(matches[0]);
  }

  async control(
    actor: LifeActor,
    request: {
      scope: LifeScope;
      idOrTitle: string;
      kinds?: DeliveryKind[];
      action: ScheduledDeliveryAction;
    },
  ): Promise<ScheduledDelivery> {
    const found = this.find(actor, request.scope, request.idOrTitle, request.kinds),
      target = found.taskId,
      taskOwner = owner(request.scope);
    let changed = false;
    if (request.action === "run") {
      await this.tasks.runNow(target, taskOwner);
      changed = true;
    } else
      changed =
        request.action === "pause"
          ? this.tasks.pause(target, taskOwner)
          : request.action === "resume"
            ? this.tasks.resume(target, taskOwner)
            : this.tasks.cancel(target, taskOwner);
    if (!changed)
      throw new ScheduledDeliveryError("conflict", "Delivery state did not allow this action.");
    return this.find(actor, request.scope, found.record.id);
  }
}
