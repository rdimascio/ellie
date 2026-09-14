import type {
  LifeActor,
  LifeRecord,
  LifeRecordKind,
  LifeScope,
} from "../../life-core/src/index.ts";
import { LifeStore } from "../../life-core/src/index.ts";
import {
  CalendarTimeError,
  calendarDateKey,
  localParts,
  nextAnnualDate,
  parseCalendarDate,
  parseInstant,
  resolveZoned,
  startOfLocalDay,
  validateCalendarDate,
} from "../../life-time/src/index.ts";
import type { PreparedTaskReplacement, TaskRecord } from "../../task-runtime/src/index.ts";
import { TaskRuntime } from "../../task-runtime/src/index.ts";
import { LifePlans } from "../../life-plans/src/index.ts";

export type TemporalSpec =
  | { type: "instant"; at: number }
  | {
      type: "local";
      date: { year: number; month: number; day: number };
      clock: { hour: number; minute: number };
      timeZone?: string;
    };
export type LifeIntent =
  | { kind: "schedule_reminder"; title: string; when: TemporalSpec }
  | { kind: "create_event"; title: string; start: TemporalSpec; durationMinutes?: number }
  | {
      kind: "create_need";
      title: string;
      due?: TemporalSpec;
      budget?: number;
      currency?: string;
    }
  | { kind: "resolve_need"; operation: "complete" | "cancel"; title: string }
  | {
      kind: "create_contact";
      name: string;
      interests?: string[];
      birthday?: { month: number; day: number; year?: number };
    }
  | { kind: "query"; view: "today" | "upcoming" | "birthdays" }
  | { kind: "summarize_sources"; query: string }
  | { kind: "create_plan"; title: string; steps: string[] }
  | { kind: "clarify"; question: string; missing: string[] };

export interface OperationOutcome {
  status: "completed" | "scheduled" | "queued" | "clarify" | "rejected";
  reply: string;
  records: LifeRecord[];
  tasks: TaskRecord[];
}
export interface LifeOperationsOptions {
  store: LifeStore;
  tasks: TaskRuntime;
  now: () => number;
  enqueueSummary?: (actor: LifeActor, scope: LifeScope, query: string) => TaskRecord | undefined;
  deliveryStatus?: (
    record: Pick<LifeRecord, "id" | "kind" | "scope" | "data">,
  ) => { status: string; scheduleStatus: string } | undefined;
  plans?: LifePlans;
}
export interface ReminderRescheduleJournal {
  prepared(value: { operationId: string; replacementTaskId: string; dueAt: number }): void;
  recordUpdated(value: { recordId: string; revision: number; replacementTaskId: string }): void;
}
export class LifeOperationInputError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "LifeOperationInputError";
  }
}
const owner = (scope: LifeScope) => `${scope.type}:${scope.id}` as const;
const current = (record: LifeRecord) =>
  record.data.completed !== true &&
  record.data.cancelled !== true &&
  record.provenance.every((item) => item.invalidatedAt === undefined);
const text = (value: string, max: number, label: string) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new LifeOperationInputError(`${label} is invalid.`);
  return value.trim();
};

export class LifeOperations {
  private readonly options: LifeOperationsOptions;
  constructor(options: LifeOperationsOptions) {
    this.options = options;
  }

  rescheduleReminder(
    actor: LifeActor,
    scope: LifeScope,
    input: {
      operationId: string;
      recordId: string;
      expectedRevision: number;
      replacesTaskId: string;
      when: TemporalSpec;
    },
    effectiveZone: string,
    journal: ReminderRescheduleJournal,
  ): OperationOutcome {
    const reminder = this.options.store.getRecord(actor, input.recordId);
    if (
      !reminder ||
      reminder.kind !== "reminder" ||
      reminder.scope.type !== scope.type ||
      reminder.scope.id !== scope.id ||
      reminder.revision !== input.expectedRevision ||
      reminder.data.taskId !== input.replacesTaskId ||
      !current(reminder)
    )
      return this.rejected("That reminder changed. Please review it before rescheduling.");
    const dueAt = this.when(input.when, effectiveZone);
    if (dueAt <= this.options.now())
      return this.rejected("That reminder time is in the past. Please choose a future time.");
    const replacement = this.options.tasks.prepareReplacement({
      operationId: input.operationId,
      owner: owner(scope),
      replacesTaskId: input.replacesTaskId,
      task: {
        owner: owner(scope),
        handler: "reminder.notify",
        input: { recordId: reminder.id, scope, userId: actor.userId },
        schedule: { kind: "once", at: dueAt },
      },
    });
    journal.prepared({
      operationId: input.operationId,
      replacementTaskId: replacement.replacementTaskId,
      dueAt,
    });
    let updated: LifeRecord;
    try {
      updated = this.options.store.updateRecord(actor, reminder.id, reminder.revision, {
        data: {
          ...reminder.data,
          dueAt,
          taskId: replacement.replacementTaskId,
          rescheduleOperationId: input.operationId,
          timeZone: effectiveZone,
        },
      });
    } catch (error) {
      this.options.tasks.discardReplacement(input.operationId, owner(scope));
      throw error;
    }
    journal.recordUpdated({
      recordId: updated.id,
      revision: updated.revision,
      replacementTaskId: replacement.replacementTaskId,
    });
    const activated = this.options.tasks.activateReplacement(input.operationId, owner(scope));
    return {
      status: "scheduled",
      reply: `Moved “${updated.title}” to ${new Date(dueAt).toLocaleString("en-US", { timeZone: effectiveZone })}.`,
      records: [updated],
      tasks: activated.task ? [activated.task] : [],
    };
  }

  recoverReminderReschedule(
    actor: LifeActor,
    scope: LifeScope,
    operationId: string,
    recordId: string,
  ): PreparedTaskReplacement {
    const replacement = this.options.tasks.getReplacement(operationId, owner(scope));
    if (!replacement) throw new Error("Prepared reminder replacement is unavailable.");
    const reminder = this.options.store.getRecord(actor, recordId);
    if (
      !reminder ||
      reminder.scope.type !== scope.type ||
      reminder.scope.id !== scope.id ||
      reminder.data.taskId !== replacement.replacementTaskId ||
      reminder.data.rescheduleOperationId !== operationId
    ) {
      if (replacement.state === "prepared")
        return this.options.tasks.discardReplacement(operationId, owner(scope));
      throw new Error("Activated replacement no longer matches its reminder record.");
    }
    return replacement.state === "prepared"
      ? this.options.tasks.activateReplacement(operationId, owner(scope))
      : replacement;
  }

  rescheduleEvent(
    actor: LifeActor,
    scope: LifeScope,
    input: {
      recordId: string;
      expectedRevision: number;
      start: TemporalSpec;
      durationMinutes?: number;
    },
    effectiveZone: string,
  ): OperationOutcome {
    const event = this.options.store.getRecord(actor, input.recordId);
    if (
      !event ||
      event.kind !== "event" ||
      event.scope.type !== scope.type ||
      event.scope.id !== scope.id ||
      event.revision !== input.expectedRevision ||
      !current(event)
    )
      return this.rejected("That event changed. Please review it before rescheduling.");
    const startAt = this.when(input.start, effectiveZone);
    if (startAt <= this.options.now())
      return this.rejected("That event time is in the past. Please choose a future time.");
    const existingStart = parseInstant(event.data.startAt);
    const existingEnd = parseInstant(event.data.endAt);
    const duration =
      input.durationMinutes ??
      (existingStart !== undefined && existingEnd !== undefined && existingEnd > existingStart
        ? (existingEnd - existingStart) / 60_000
        : 60);
    if (!Number.isInteger(duration) || duration < 1 || duration > 7 * 24 * 60)
      throw new LifeOperationInputError("Event duration is invalid.");
    const updated = this.options.store.updateRecord(actor, event.id, event.revision, {
      data: {
        ...event.data,
        startAt,
        endAt: startAt + duration * 60_000,
        timeZone: effectiveZone,
      },
    });
    return {
      status: "completed",
      reply: `Moved “${updated.title}” to ${new Date(startAt).toLocaleString("en-US", { timeZone: effectiveZone })}.`,
      records: [updated],
      tasks: [],
    };
  }

  execute(
    actor: LifeActor,
    scope: LifeScope,
    intent: LifeIntent,
    effectiveZone: string,
  ): OperationOutcome {
    // This read is the authority check for both user and group scope on every direct SDK call.
    this.options.store.listRecords(actor, { scope, limit: 1 });
    const now = this.options.now();
    if (intent.kind === "clarify")
      return {
        status: "clarify",
        reply: text(intent.question, 1000, "Clarification"),
        records: [],
        tasks: [],
      };
    if (intent.kind === "schedule_reminder") {
      const title = text(intent.title, 2000, "Reminder title"),
        dueAt = this.when(intent.when, effectiveZone);
      if (dueAt <= now)
        return this.rejected("That reminder time is in the past. Please choose a future time.");
      const record = this.options.store.createRecord(actor, {
        kind: "reminder",
        title,
        scope,
        data: { dueAt, completed: false, timeZone: effectiveZone },
      });
      let task: TaskRecord | undefined;
      let updated: LifeRecord;
      try {
        task = this.options.tasks.schedule({
          owner: owner(scope),
          handler: "reminder.notify",
          input: { recordId: record.id, scope, userId: actor.userId },
          schedule: { kind: "once", at: dueAt },
        });
        updated = this.options.store.updateRecord(actor, record.id, record.revision, {
          data: { ...record.data, taskId: task.id },
        });
      } catch (error) {
        try {
          if (task) this.options.tasks.cancel(task.id, owner(scope));
          this.options.store.deleteRecord(actor, record.id, record.revision);
        } catch (cleanup) {
          throw new Error("Reminder creation failed and cleanup outcome is unknown.", {
            cause: { operation: error, cleanup },
          });
        }
        throw error;
      }
      return {
        status: "scheduled",
        reply: `I'll remind you at ${new Date(dueAt).toLocaleString("en-US", { timeZone: effectiveZone })}: ${title}.`,
        records: [record, updated],
        tasks: [task],
      };
    }
    if (intent.kind === "create_event") {
      const title = text(intent.title, 2000, "Event title"),
        startAt = this.when(intent.start, effectiveZone),
        duration = intent.durationMinutes ?? 60;
      if (!Number.isInteger(duration) || duration < 1 || duration > 7 * 24 * 60)
        throw new LifeOperationInputError("Event duration is invalid.");
      if (startAt <= now)
        return this.rejected("That event time is in the past. Please give me a future date.");
      const record = this.options.store.createRecord(actor, {
        kind: "event",
        title,
        scope,
        data: { startAt, endAt: startAt + duration * 60_000, timeZone: effectiveZone },
      });
      return {
        status: "completed",
        reply: `Added “${record.title}” for ${new Date(startAt).toLocaleString("en-US", { timeZone: effectiveZone })}.`,
        records: [record],
        tasks: [],
      };
    }
    if (intent.kind === "create_need") {
      const data: Record<string, unknown> = { completed: false };
      if (intent.due) {
        const deadlineAt = this.when(intent.due, effectiveZone);
        if (deadlineAt <= now)
          return this.rejected("That need deadline is in the past. Please choose a future time.");
        data.deadlineAt = deadlineAt;
      }
      if (intent.budget !== undefined) {
        if (!Number.isFinite(intent.budget) || intent.budget < 0 || intent.budget > 1_000_000)
          throw new LifeOperationInputError("Need budget is invalid.");
        data.budget = intent.budget;
      }
      if (intent.currency !== undefined)
        data.currency = text(intent.currency, 8, "Currency").toUpperCase();
      const record = this.options.store.createRecord(actor, {
        kind: "need",
        title: text(intent.title, 2000, "Need title"),
        scope,
        data,
      });
      return {
        status: "completed",
        reply: `I’m tracking “${record.title}”.`,
        records: [record],
        tasks: [],
      };
    }
    if (intent.kind === "resolve_need") {
      const matches = this.named(actor, scope, ["need"], intent.title).filter(current);
      if (matches.length !== 1)
        return {
          status: "clarify",
          reply: matches.length
            ? `More than one open need matches “${intent.title}”. Please use its exact title.`
            : `I couldn’t find an open need named “${intent.title}”.`,
          records: [],
          tasks: [],
        };
      const record = matches[0]!,
        cancelled = intent.operation === "cancel";
      const updated = this.options.store.updateRecord(actor, record.id, record.revision, {
        data: { ...record.data, [cancelled ? "cancelled" : "completed"]: true, resolvedAt: now },
      });
      if (typeof record.data.taskId === "string")
        this.options.tasks.cancel(record.data.taskId, owner(scope));
      for (const reminder of this.options.store.listRecords(actor, {
        scope,
        kinds: ["reminder"],
        limit: 500,
      }))
        if (
          reminder.relationships.some((relation) => relation.targetId === record.id) &&
          typeof reminder.data.taskId === "string"
        )
          this.options.tasks.cancel(reminder.data.taskId, owner(scope));
      return {
        status: "completed",
        reply: `${cancelled ? "Cancelled" : "Completed"} “${record.title}”.`,
        records: [updated],
        tasks: [],
      };
    }
    if (intent.kind === "create_contact") {
      const interests = (intent.interests ?? []).map((item) => text(item, 200, "Interest"));
      if (interests.length > 20) throw new LifeOperationInputError("Too many contact interests.");
      let birthdayData:
        | { month: number; day: number; nextDate: string; birthYear?: number }
        | undefined;
      if (intent.birthday) {
        let base, next;
        try {
          base = validateCalendarDate({
            year: 2000,
            month: intent.birthday.month,
            day: intent.birthday.day,
          });
          next = nextAnnualDate(base, now, effectiveZone);
        } catch (error) {
          if (error instanceof CalendarTimeError) throw new LifeOperationInputError(error.message);
          throw error;
        }
        if (
          intent.birthday.year !== undefined &&
          (!Number.isInteger(intent.birthday.year) ||
            intent.birthday.year < 1 ||
            intent.birthday.year > next.year)
        )
          throw new LifeOperationInputError("Birthday year is invalid.");
        if (intent.birthday.year !== undefined)
          try {
            validateCalendarDate({
              year: intent.birthday.year,
              month: base.month,
              day: base.day,
            });
          } catch (error) {
            if (error instanceof CalendarTimeError)
              throw new LifeOperationInputError(error.message);
            throw error;
          }
        birthdayData = {
          month: base.month,
          day: base.day,
          nextDate: calendarDateKey(next),
          ...(intent.birthday.year === undefined ? {} : { birthYear: intent.birthday.year }),
        };
      }
      const contact = this.options.store.createRecord(actor, {
        kind: "contact",
        title: text(intent.name, 500, "Contact name"),
        scope,
        data: { interests },
      });
      const records = [contact];
      if (birthdayData) {
        try {
          records.push(
            this.options.store.createRecord(actor, {
              kind: "birthday",
              title: `${contact.title}'s birthday`,
              scope,
              data: { ...birthdayData, timeZone: effectiveZone },
              relationships: [{ type: "person", targetId: contact.id }],
            }),
          );
        } catch (error) {
          try {
            this.options.store.deleteRecord(actor, contact.id, contact.revision);
          } catch (cleanup) {
            throw new Error("Contact creation failed and cleanup outcome is unknown.", {
              cause: { operation: error, cleanup },
            });
          }
          throw error;
        }
      }
      return {
        status: "completed",
        reply: `Added ${contact.title} as a contact.`,
        records,
        tasks: [],
      };
    }
    if (intent.kind === "query") return this.query(actor, scope, intent.view, effectiveZone);
    if (intent.kind === "create_plan") {
      if (!this.options.plans) return this.rejected("Plan storage is unavailable.");
      const plan = this.options.plans.create(actor, {
        scope,
        title: intent.title,
        steps: intent.steps,
      });
      return {
        status: "completed",
        reply: `Created plan “${plan.record.title}” with ${plan.totalSteps} ${plan.totalSteps === 1 ? "step" : "steps"}.`,
        records: [plan.record],
        tasks: [],
      };
    }
    const query = text(intent.query, 1000, "Summary query");
    const task = this.options.enqueueSummary?.(actor, scope, query);
    if (!task) return this.rejected(`I couldn't find a scoped source to summarize for “${query}”.`);
    return {
      status: "queued",
      reply: "I queued a background summary using sources already available in this space.",
      records: [],
      tasks: [task],
    };
  }

  private when(spec: TemporalSpec, zone: string): number {
    try {
      if (spec.type === "instant") {
        const instant = parseInstant(spec.at);
        if (instant === undefined) throw new LifeOperationInputError("Time is invalid.");
        const local = localParts(instant, zone);
        validateCalendarDate(local);
        return instant;
      }
      if (spec.timeZone !== undefined && spec.timeZone !== zone)
        throw new LifeOperationInputError("Use the active scope’s time zone.");
      return resolveZoned({ ...validateCalendarDate(spec.date), ...spec.clock }, zone);
    } catch (error) {
      if (error instanceof LifeOperationInputError) throw error;
      if (error instanceof CalendarTimeError) throw new LifeOperationInputError(error.message);
      throw error;
    }
  }

  private named(actor: LifeActor, scope: LifeScope, kinds: LifeRecordKind[], title: string) {
    const wanted = text(title, 500, "Record title").toLocaleLowerCase();
    const records = this.options.store.listRecords(actor, { scope, kinds, limit: 500 }),
      exact = records.filter((record) => record.title.trim().toLocaleLowerCase() === wanted);
    return exact.length
      ? exact
      : records.filter((record) => record.title.trim().toLocaleLowerCase().includes(wanted));
  }

  private query(
    actor: LifeActor,
    scope: LifeScope,
    view: "today" | "upcoming" | "birthdays",
    zone: string,
  ): OperationOutcome {
    const today = localParts(this.options.now(), zone),
      todayKey = calendarDateKey(today);
    if (view === "birthdays") {
      const rows = this.options.store
        .listRecords(actor, { scope, kinds: ["birthday"], limit: 500 })
        .filter(current)
        .slice(0, 20);
      return {
        status: "completed",
        reply: rows.length
          ? `Upcoming birthdays: ${rows.map((row) => `${row.title} (${row.data.month}/${row.data.day})`).join("; ")}.`
          : "I don’t have any birthdays in this space yet.",
        records: [],
        tasks: [],
      };
    }
    const rows = this.options.store
      .listRecords(actor, {
        scope,
        kinds: ["event", "reminder", "timer", "birthday", "need"],
        limit: 500,
      })
      .filter(current);
    const candidates = rows
      .map((record) => ({
        record,
        when: this.recordWhen(record, zone),
        delivery:
          record.kind === "reminder" || record.kind === "timer"
            ? this.options.deliveryStatus?.(record)
            : undefined,
      }))
      .filter(({ record, when }) =>
        when
          ? view === "today"
            ? when.dateKey === todayKey
            : when.allDay
              ? when.dateKey >= todayKey
              : when.at >= this.options.now()
          : view === "today" && record.kind === "need",
      );
    const visible = candidates
      .filter(
        ({ record, delivery }) =>
          (record.kind !== "reminder" && record.kind !== "timer") ||
          delivery === undefined ||
          delivery.status === "scheduled" ||
          delivery.status === "running",
      )
      .sort((a, b) => (a.when?.at ?? 0) - (b.when?.at ?? 0))
      .slice(0, 20);
    const deliveryNotes = candidates
      .filter(
        ({ record, delivery }) =>
          (record.kind === "reminder" || record.kind === "timer") &&
          delivery &&
          delivery.status !== "scheduled" &&
          delivery.status !== "running",
      )
      .slice(0, 20);
    const activeReply = visible.length
      ? `${view === "today" ? "Here’s what’s active" : "Upcoming"}: ${visible.map(({ record }) => record.title).join("; ")}.`
      : view === "today"
        ? "You don’t have anything active in this space today."
        : "I don’t see any upcoming events in this space.";
    return {
      status: "completed",
      reply: `${activeReply}${
        deliveryNotes.length
          ? ` Delivery status: ${deliveryNotes.map(({ record, delivery }) => `${record.title} (${delivery!.status})`).join("; ")}.`
          : ""
      }`,
      records: [],
      tasks: [],
    };
  }

  private recordWhen(
    record: LifeRecord,
    zone: string,
  ): { at: number; dateKey: string; allDay: boolean } | undefined {
    const raw = record.data.startAt ?? record.data.dueAt ?? record.data.deadlineAt;
    const at = parseInstant(raw);
    if (at !== undefined) {
      try {
        return { at, dateKey: calendarDateKey(localParts(at, zone)), allDay: false };
      } catch {
        return;
      }
    }
    const date = parseCalendarDate(
      record.data.startDate ?? record.data.date ?? record.data.nextDate,
    );
    if (!date) return;
    const start = startOfLocalDay(date, zone);
    if (start === undefined) return;
    return {
      at: start,
      dateKey: calendarDateKey(date),
      allDay: true,
    };
  }

  private rejected(reply: string): OperationOutcome {
    return { status: "rejected", reply, records: [], tasks: [] };
  }
}
