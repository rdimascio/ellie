import { randomUUID } from "node:crypto";
import type {
  LifeActor,
  LifeRecord,
  LifeScope,
  LifeRecordKind,
} from "../../life-core/src/index.ts";
import { inferTone, LifeAccessError, LifeStore } from "../../life-core/src/index.ts";
import { ProactivityEngine } from "../../life-context/src/index.ts";
import type { LifePlugin, MLBAdapter, PluginStore } from "../../life-plugins/src/index.ts";
import { builtInManifest, PluginError } from "../../life-plugins/src/index.ts";
import { LifeTeaching } from "../../life-teaching/src/index.ts";
import {
  addCalendarDays,
  CalendarTimeError,
  calendarDateKey,
  localParts,
  nextAnnualDate,
  nextWeekdayDate,
  parseCalendarDate,
  parseClock,
  parseInstant,
  resolveZoned,
  startOfLocalDay,
  validateCalendarDate,
} from "../../life-time/src/index.ts";
import type { OwnerScope, TaskRecord } from "../../task-runtime/src/index.ts";
import { TaskRuntime } from "../../task-runtime/src/index.ts";
import type { LifeModel, LifeModelPlan } from "./model.ts";
import { LifeModelBuildError, validateModelPlan } from "./model.ts";
import { LifeOperationInputError, LifeOperations } from "./operations.ts";
import type { OperationOutcome, ReminderRescheduleJournal } from "./operations.ts";
import type { LifeIntent } from "./operations.ts";
import { parseMissingReminder, pendingDirective, PendingAnswerInputError } from "./continuation.ts";
import type { ContinuationDirective, PendingLifeIntent, TemporalAnswer } from "./continuation.ts";
import { BoundedPluginBuilder, PluginBuildError, pluginBuildTimeout } from "./build.ts";
export * from "./model.ts";
export * from "./operations.ts";
export * from "./continuation.ts";
export * from "./build.ts";

export interface LifeHarnessOptions {
  store: LifeStore;
  tasks: TaskRuntime;
  plugins: PluginStore;
  mlb: MLBAdapter;
  model?: LifeModel;
  now?: () => number;
  context?: ProactivityEngine;
  teaching?: LifeTeaching;
}
export interface ChatRequest {
  actor: LifeActor;
  scope: LifeScope;
  message: string;
  conversationId?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  isContextCurrent?: () => boolean;
  signal?: AbortSignal;
  /** Trusted service data. Never populate this from a client request body. */
  pendingIntent?: PendingLifeIntent;
  /** Trusted receipt from the immediately preceding completed operation. */
  recentOperation?: {
    kind: "reminder" | "event";
    recordId: string;
    expectedRevision: number;
    taskId?: string;
  };
}
export interface ChatAction {
  label: string;
  status: "completed" | "scheduled" | "queued" | "skipped";
}
export interface ChatResponse {
  reply: string;
  conversationId: string;
  actions: ChatAction[];
  records: LifeRecord[];
  taskIds: string[];
  evidence: Array<{ sourceId: string; title: string; reference?: string }>;
  continuation?: ContinuationDirective;
  operationOutcome?: OperationOutcome["status"];
}
export interface LifeHarness {
  chat(request: ChatRequest): Promise<ChatResponse>;
  continuePendingIntent(request: {
    actor: LifeActor;
    scope: LifeScope;
    pendingIntent: PendingLifeIntent;
    answer?: TemporalAnswer;
    replacementJournal?: ReminderRescheduleJournal;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<ChatResponse>;
  invalidateContext(actor: LifeActor, scope: LifeScope): void;
  invalidateActorContext(actor: LifeActor): void;
  rerunBackgroundSummary(request: {
    actor: LifeActor;
    scope: LifeScope;
    taskId: string;
  }): TaskRecord;
  buildPlugin(request: {
    actor: LifeActor;
    scope: LifeScope;
    request: string;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LifePlugin>;
  revisePlugin(request: {
    actor: LifeActor;
    scope: LifeScope;
    id: string;
    request: string;
    expectedVersion: number;
    isContextCurrent?: () => boolean;
  }): Promise<LifePlugin>;
}

const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const scopeOwner = (scope: LifeScope): OwnerScope => `${scope.type}:${scope.id}`;
const clean = (value: string): string =>
  value
    .trim()
    .replace(/[.!]+$/, "")
    .trim();
const retrievalQuery = (value: string): string => value.trim().slice(0, 1_000);
const explicitlyRequestsRemembering = (value: string): boolean =>
  /^(?:(?:please\s+)?remember(?:\s+that)?|(?:can|could|would|will)\s+you\s+(?:please\s+)?remember\s+that)\s+\S/i.test(
    value.trim(),
  );
const titleCase = (value: string): string =>
  value.replace(/\b\w/g, (letter) => letter.toUpperCase());
const active = (record: LifeRecord): boolean =>
  record.data.completed !== true &&
  record.data.cancelled !== true &&
  record.provenance.every((item) => item.invalidatedAt === undefined);

function modelContext(
  store: LifeStore,
  teaching: LifeTeaching,
  actor: LifeActor,
  scope: LifeScope,
  message: string,
) {
  const terms = new Set(message.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  const memories = store
    .listRecords(actor, { scope, kinds: ["memory"], limit: 100 })
    .filter((record) => record.provenance.every((item) => item.invalidatedAt === undefined))
    .map((record) => {
      const text = (record.body ?? record.title).slice(0, 2_000);
      const score = (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).reduce(
        (total, term) => total + Number(terms.has(term)),
        0,
      );
      return {
        id: record.id,
        text,
        explicit: record.data.explicit === true,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ score: _score, ...memory }) => memory);
  return {
    preferences: store.resolveSettings(actor, scope.type === "group" ? { groupId: scope.id } : {})
      .values,
    memories,
    adoptedGuidance: teaching.resolve(actor, scope),
    tone: inferTone(message),
  };
}

function parseDelay(message: string): { delay: number; text: string } | undefined {
  const match = /\bin\s+(\d{1,6})\s*(minute|hour|day)s?\s+(?:to\s+)?(.+)$/i.exec(message);
  if (!match) return undefined;
  const unit = match[2]!.toLowerCase();
  return {
    delay: Number(match[1]) * { minute: 60_000, hour: 3_600_000, day: 86_400_000 }[unit]!,
    text: clean(match[3]!),
  };
}

function localAnchored(
  message: string,
  now: number,
  timeZone: string,
): { at: number; text: string } | undefined {
  const match =
    /\b(today|tomorrow|next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?\s+(?:to\s+)?(.+)$/i.exec(
      message,
    );
  if (!match) return undefined;
  const current = localParts(now, timeZone);
  let date = validateCalendarDate(current);
  if (match[1]!.toLowerCase() === "tomorrow") date = addCalendarDays(date, 1);
  else if (match[2])
    date = nextWeekdayDate(
      date,
      ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
        match[2].toLowerCase(),
      ),
    );
  const clock = parseClock(match[3] ?? "9:00");
  return { at: resolveZoned({ ...date, ...clock }, timeZone), text: clean(match[4]!) };
}

type EventWhen = { sortAt: number; dateKey: string; label: string; allDay: boolean };
function eventWhen(record: LifeRecord, timeZone: string): EventWhen | undefined {
  const raw = record.data.startAt ?? record.data.startDate ?? record.data.date;
  const calendar = parseCalendarDate(raw);
  if (calendar) {
    const dateKey = calendarDateKey(calendar);
    const start = startOfLocalDay(calendar, timeZone);
    if (start === undefined) return;
    return {
      sortAt: start,
      dateKey,
      label: dateKey,
      allDay: true,
    };
  }
  const instant = parseInstant(raw);
  if (instant === undefined) return;
  try {
    return {
      sortAt: instant,
      dateKey: calendarDateKey(localParts(instant, timeZone)),
      label: new Date(instant).toLocaleString("en-US", { timeZone }),
      allDay: false,
    };
  } catch {
    return;
  }
}

function findNamed(
  records: LifeRecord[],
  kinds: LifeRecordKind[],
  name: string,
): LifeRecord | undefined {
  const needle = clean(name).toLowerCase();
  return records
    .filter(
      (record) =>
        kinds.includes(record.kind) &&
        (record.title.toLowerCase().includes(needle) ||
          record.body?.toLowerCase().includes(needle)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

export function createLifeHarness(options: LifeHarnessOptions): LifeHarness {
  const now = options.now ?? Date.now;
  const context = options.context ?? new ProactivityEngine(options.store, now);
  const teaching = options.teaching ?? new LifeTeaching(options.store, now);
  const sessions = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();
  const contextGenerations = new Map<string, number>();
  const actorGenerations = new Map<string, number>();
  const pluginBuilder = new BoundedPluginBuilder(2);
  registerHandlers(options.store, options.tasks, options.model, now);

  const sessionId = (actor: LifeActor, scope: LifeScope, id: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))
      throw new TypeError("Conversation id is invalid.");
    return `${actor.userId}\0${scope.type}:${scope.id}\0${id}`;
  };
  const rememberSession = (key: string, role: "user" | "assistant", content: string) => {
    const history = sessions.get(key) ?? [];
    history.push({ role, content: content.slice(0, 8000) });
    sessions.set(key, history.slice(-12));
    if (sessions.size > 100) sessions.delete(sessions.keys().next().value!);
  };
  const contextKey = (actor: LifeActor, scope: LifeScope) =>
    `${actor.userId}\0${scope.type}:${scope.id}`;
  const invalidateContext = (actor: LifeActor, scope: LifeScope) => {
    options.store.listRecords(actor, { scope, limit: 1 });
    const generationKey = contextKey(actor, scope);
    contextGenerations.set(generationKey, (contextGenerations.get(generationKey) ?? 0) + 1);
    const prefix = `${generationKey}\0`;
    for (const key of sessions.keys()) if (key.startsWith(prefix)) sessions.delete(key);
  };
  const invalidateActorContext = (actor: LifeActor) => {
    options.store.listRecords(actor, { limit: 1 });
    actorGenerations.set(actor.userId, (actorGenerations.get(actor.userId) ?? 0) + 1);
    const prefix = `${actor.userId}\0`;
    for (const key of sessions.keys()) if (key.startsWith(prefix)) sessions.delete(key);
  };
  const enqueueBackgroundSummary = (
    actor: LifeActor,
    scope: LifeScope,
    query: string,
  ): TaskRecord | undefined => {
    const candidates = options.store.search(actor, {
      query: retrievalQuery(query),
      scope,
      limit: 20,
    });
    const sources = [...new Set(candidates.map((item) => item.sourceId))]
      .slice(0, 4)
      .map((sourceId) => options.store.getRecord(actor, sourceId))
      .filter(
        (source): source is LifeRecord =>
          source?.kind === "source" &&
          source.scope.type === scope.type &&
          source.scope.id === scope.id,
      );
    if (!sources.length) return undefined;
    const deadlineAt = now() + 30_000;
    return options.tasks.enqueueWorkflow({
      root: {
        owner: scopeOwner(scope),
        handler: "knowledge.aggregate",
        input: { actor, scope, query },
        allowedCapabilities: ["life.records.read"],
        budget: { maxTasks: 5, maxConcurrency: 2, maxRuntimeMs: 10_000 },
        deadlineAt,
      },
      children: sources.map((source) => ({
        handler: "knowledge.summarize-source",
        input: {
          actor,
          scope,
          query,
          sourceId: source.id,
          sourceRevision: source.revision,
        },
        deadlineAt,
      })),
    }).root;
  };
  const operations = new LifeOperations({
    store: options.store,
    tasks: options.tasks,
    now,
    enqueueSummary: enqueueBackgroundSummary,
  });
  const continuePendingIntent: LifeHarness["continuePendingIntent"] = async (request) => {
    const pending = request.pendingIntent;
    options.store.listRecords(request.actor, { scope: request.scope, limit: 1 });
    if (request.isContextCurrent?.() === false)
      throw new Error("Conversation context changed before the pending request was executed.");
    if (
      pending.scope.type !== request.scope.type ||
      pending.scope.id !== request.scope.id ||
      pending.state !== "executing" ||
      pending.expiresAt <= now()
    )
      throw new Error("Pending request is unavailable or expired.");
    const settings = options.store.resolveSettings(
      request.actor,
      request.scope.type === "group" ? { groupId: request.scope.id } : {},
    );
    const timeZone =
      typeof settings.values.timeZone === "string"
        ? settings.values.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const temporal =
      request.answer && "when" in request.answer
        ? request.answer.when
        : request.answer && "start" in request.answer
          ? request.answer.start
          : pending.intent.kind === "schedule-reminder" ||
              pending.intent.kind === "reschedule-reminder"
            ? pending.intent.when
            : pending.intent.start;
    if (!temporal || pending.missing.length)
      throw new Error("Pending request still needs a date or time.");
    options.store.listRecords(request.actor, { scope: request.scope, limit: 1 });
    if (request.isContextCurrent?.() === false)
      throw new Error("Conversation context changed before the pending request was executed.");
    const outcome =
      pending.intent.kind === "schedule-reminder"
        ? operations.execute(
            request.actor,
            request.scope,
            { kind: "schedule_reminder", title: pending.intent.title, when: temporal },
            timeZone,
          )
        : pending.intent.kind === "create-event"
          ? operations.execute(
              request.actor,
              request.scope,
              {
                kind: "create_event",
                title: pending.intent.title,
                start: temporal,
                ...(pending.intent.durationMinutes === undefined
                  ? {}
                  : { durationMinutes: pending.intent.durationMinutes }),
              },
              timeZone,
            )
          : pending.intent.kind === "reschedule-reminder"
            ? (() => {
                if (!pending.target?.taskId || !request.replacementJournal)
                  throw new Error("This reminder change requires its durable replacement journal.");
                return operations.rescheduleReminder(
                  request.actor,
                  request.scope,
                  {
                    operationId: pending.id,
                    recordId: pending.target.recordId,
                    expectedRevision: pending.target.expectedRevision,
                    replacesTaskId: pending.target.taskId,
                    when: temporal,
                  },
                  timeZone,
                  request.replacementJournal,
                );
              })()
            : (() => {
                if (!pending.target)
                  throw new Error("This event change is missing its revision-bound target.");
                return operations.rescheduleEvent(
                  request.actor,
                  request.scope,
                  {
                    recordId: pending.target.recordId,
                    expectedRevision: pending.target.expectedRevision,
                    start: temporal,
                    ...(pending.intent.durationMinutes === undefined
                      ? {}
                      : { durationMinutes: pending.intent.durationMinutes }),
                  },
                  timeZone,
                );
              })();
    return {
      reply: outcome.reply,
      conversationId: pending.conversationId,
      actions: [
        {
          label:
            pending.intent.kind === "schedule-reminder"
              ? `Schedule reminder: ${pending.intent.title}`
              : pending.intent.kind === "create-event"
                ? `Create event: ${pending.intent.title}`
                : pending.intent.kind === "reschedule-reminder"
                  ? `Reschedule reminder: ${outcome.records[0]?.title ?? "reminder"}`.slice(
                      0,
                      2_100,
                    )
                  : `Reschedule event: ${outcome.records[0]?.title ?? "event"}`.slice(0, 2_100),
          status:
            outcome.status === "rejected" || outcome.status === "clarify"
              ? "skipped"
              : outcome.status,
        },
      ],
      records: outcome.records,
      taskIds: outcome.tasks.map((task) => task.id),
      evidence: [],
      operationOutcome: outcome.status,
    };
  };
  const rerunBackgroundSummary = (input: {
    actor: LifeActor;
    scope: LifeScope;
    taskId: string;
  }): TaskRecord => {
    options.store.listRecords(input.actor, { scope: input.scope, limit: 1 });
    const previous = options.tasks.get(input.taskId, scopeOwner(input.scope));
    if (
      !previous ||
      previous.handler !== "knowledge.aggregate" ||
      !["succeeded", "failed", "cancelled", "expired", "unknown"].includes(previous.state)
    )
      throw new Error("A terminal background summary is required for an explicit rerun.");
    const previousInput = previous.input as Record<string, unknown>;
    if (typeof previousInput?.query !== "string")
      throw new Error("The prior background summary query is unavailable.");
    const task = enqueueBackgroundSummary(input.actor, input.scope, clean(previousInput.query));
    if (!task) throw new Error("No current scoped sources match the prior summary query.");
    return task;
  };

  const checkBuildAuthority = (actor: LifeActor, scope: LifeScope) => {
    try {
      options.store.listRecords(actor, { scope, limit: 1 });
    } catch (error) {
      if (error instanceof LifeAccessError)
        throw new PluginBuildError(
          "access_revoked",
          "Access to this space changed while building the app.",
          { cause: error },
        );
      throw error;
    }
  };
  const checkBuildContext = (
    input: {
      actor: LifeActor;
      scope: LifeScope;
      signal?: AbortSignal;
      isContextCurrent?: () => boolean;
    },
    scopeGeneration: number,
    actorGeneration: number,
  ) => {
    if (input.signal?.aborted)
      throw new PluginBuildError("cancelled", "Plugin build was cancelled.");
    if (
      input.isContextCurrent?.() === false ||
      (contextGenerations.get(contextKey(input.actor, input.scope)) ?? 0) !== scopeGeneration ||
      (actorGenerations.get(input.actor.userId) ?? 0) !== actorGeneration
    )
      throw new PluginBuildError(
        "context_changed",
        "Conversation context changed while building the app. Please try again.",
      );
  };
  const installCandidate = (owner: string, manifest: Parameters<PluginStore["install"]>[1]) => {
    try {
      return options.plugins.install(owner, manifest);
    } catch (error) {
      if (error instanceof PluginError && error.code === "invalid")
        throw new PluginBuildError(
          "invalid_candidate",
          "The generated app was invalid and was not installed. Try a simpler request.",
          { cause: error },
        );
      throw error;
    }
  };
  const updateCandidate = (
    owner: string,
    id: string,
    expectedVersion: number,
    manifest: Parameters<PluginStore["update"]>[3],
  ) => {
    try {
      return options.plugins.update(owner, id, expectedVersion, manifest);
    } catch (error) {
      if (error instanceof PluginError && error.code === "invalid")
        throw new PluginBuildError(
          "invalid_candidate",
          "The generated revision was invalid, so the current app was kept.",
          { cause: error },
        );
      if (error instanceof PluginError && ["conflict", "not_found"].includes(error.code))
        throw new PluginBuildError("conflict", "The app changed while its revision was building.", {
          cause: error,
        });
      throw error;
    }
  };
  const runModelBuild = async <T>(
    execute: (signal: AbortSignal) => Promise<T>,
    input: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> => {
    try {
      return await pluginBuilder.run(execute, input);
    } catch (error) {
      if (!(error instanceof LifeModelBuildError)) throw error;
      const code = {
        invalid_response: "invalid_candidate",
        transport: "model_unavailable",
        timeout: "timeout",
        cancelled: "cancelled",
      }[error.code] as PluginBuildError["code"];
      const message = {
        invalid_response:
          "The local model returned an invalid app candidate. Try a simpler request.",
        transport:
          "The local model could not complete the app build. Try again when it is available.",
        timeout: "The local model did not finish the app build before its deadline.",
        cancelled: "Plugin build was cancelled.",
      }[error.code];
      throw new PluginBuildError(code, message, { cause: error });
    }
  };

  async function buildPlugin(input: {
    actor: LifeActor;
    scope: LifeScope;
    request: string;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LifePlugin> {
    if (!input.request.trim() || input.request.length > 8_000)
      throw new TypeError("Plugin build request is invalid.");
    pluginBuildTimeout(input.timeoutMs);
    const scopeGeneration = contextGenerations.get(contextKey(input.actor, input.scope)) ?? 0,
      actorGeneration = actorGenerations.get(input.actor.userId) ?? 0;
    checkBuildAuthority(input.actor, input.scope);
    checkBuildContext(input, scopeGeneration, actorGeneration);
    const manifest = builtInManifest(input.request);
    if (manifest) {
      checkBuildContext(input, scopeGeneration, actorGeneration);
      return installCandidate(scopeOwner(input.scope), manifest);
    }
    if (!options.model?.build)
      throw new PluginBuildError(
        "model_unavailable",
        "A local model is required to build this custom app. I can build an arcade or MLB view without one.",
      );
    const generated = await runModelBuild(
      (signal) => options.model!.build!(input.request, signal),
      { signal: input.signal, timeoutMs: input.timeoutMs },
    );
    checkBuildAuthority(input.actor, input.scope);
    checkBuildContext(input, scopeGeneration, actorGeneration);
    return installCandidate(scopeOwner(input.scope), {
      ...generated,
      kind: "custom",
      capabilities: ["storage"],
    });
  }

  async function revisePlugin(input: {
    actor: LifeActor;
    scope: LifeScope;
    id: string;
    request: string;
    expectedVersion: number;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LifePlugin> {
    if (!input.request.trim() || input.request.length > 8_000)
      throw new TypeError("Plugin revision request is invalid.");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
      throw new TypeError("Plugin expected version is invalid.");
    pluginBuildTimeout(input.timeoutMs);
    const scopeGeneration = contextGenerations.get(contextKey(input.actor, input.scope)) ?? 0,
      actorGeneration = actorGenerations.get(input.actor.userId) ?? 0;
    checkBuildAuthority(input.actor, input.scope);
    checkBuildContext(input, scopeGeneration, actorGeneration);
    const owner = scopeOwner(input.scope),
      previous = options.plugins.get(owner, input.id);
    if (previous.version !== input.expectedVersion)
      throw new PluginBuildError(
        "conflict",
        "The app changed before its revision started building.",
      );
    if (previous.kind !== "custom") {
      const rename = /(?:rename|change (?:the )?name)(?: it)? to\s+(.+)$/i.exec(input.request);
      if (!rename)
        throw new Error(
          "Built-in apps can be renamed here; code revisions are available for custom apps.",
        );
      return updateCandidate(owner, input.id, input.expectedVersion, {
        name: clean(rename[1]!),
        description: previous.description,
        kind: previous.kind,
        capabilities: previous.capabilities,
      });
    }
    if (!options.model?.build)
      throw new PluginBuildError(
        "model_unavailable",
        "A local model is required to revise a custom app.",
      );
    const generated = await runModelBuild(
      (signal) =>
        options.model!.build!(
          {
            request: input.request,
            previous: {
              name: previous.name,
              description: previous.description,
              html: previous.html!,
            },
          },
          signal,
        ),
      { signal: input.signal, timeoutMs: input.timeoutMs },
    );
    checkBuildAuthority(input.actor, input.scope);
    checkBuildContext(input, scopeGeneration, actorGeneration);
    let current: LifePlugin;
    try {
      current = options.plugins.get(owner, input.id);
    } catch (error) {
      if (error instanceof PluginError && error.code === "not_found")
        throw new PluginBuildError("conflict", "The app changed while its revision was building.", {
          cause: error,
        });
      throw error;
    }
    if (
      current.version !== input.expectedVersion ||
      current.kind !== previous.kind ||
      JSON.stringify(current.capabilities) !== JSON.stringify(previous.capabilities)
    )
      throw new PluginBuildError("conflict", "The app changed while its revision was building.");
    return updateCandidate(owner, input.id, input.expectedVersion, {
      ...generated,
      kind: "custom",
      capabilities: [...previous.capabilities],
    });
  }

  async function chat(request: ChatRequest): Promise<ChatResponse> {
    const message = request.message.trim();
    if (!message || message.length > 20_000) throw new TypeError("Chat message is invalid.");
    options.store.listRecords(request.actor, {
      scope: request.scope,
      limit: 1,
    });
    const conversationId = request.conversationId ?? randomUUID();
    const conversationKey = sessionId(request.actor, request.scope, conversationId);
    const suppliedHistory = request.history?.map((turn) => {
      if (
        (turn.role !== "user" && turn.role !== "assistant") ||
        typeof turn.content !== "string" ||
        !turn.content.trim() ||
        turn.content.length > 8_000
      )
        throw new TypeError("Conversation history is invalid.");
      return { role: turn.role, content: turn.content };
    });
    if (suppliedHistory && suppliedHistory.length > 24)
      throw new TypeError("Conversation history is invalid.");
    rememberSession(conversationKey, "user", message);
    const records: LifeRecord[] = [],
      tasks: TaskRecord[] = [],
      actions: ChatAction[] = [],
      evidence: ChatResponse["evidence"] = [];
    const all = (kinds?: LifeRecordKind[]) =>
      options.store.listRecords(request.actor, {
        scope: request.scope,
        ...(kinds ? { kinds } : {}),
        limit: 500,
      });
    const create = (input: Parameters<LifeStore["createRecord"]>[1]) => {
      const record = options.store.createRecord(request.actor, input);
      records.push(record);
      return record;
    };
    let continuation: ContinuationDirective | undefined;
    const finish = (reply: string): ChatResponse => {
      rememberSession(conversationKey, "assistant", reply);
      return {
        reply,
        conversationId,
        actions,
        records,
        taskIds: tasks.map((task) => task.id),
        evidence,
        ...(continuation ? { continuation } : {}),
      };
    };
    const lower = message.toLowerCase();
    const settings = options.store.resolveSettings(
      request.actor,
      request.scope.type === "group" ? { groupId: request.scope.id } : {},
    );
    const timeZone =
      typeof settings.values.timeZone === "string"
        ? settings.values.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (request.pendingIntent) {
      try {
        const directive = pendingDirective(
          request.actor,
          request.scope,
          request.pendingIntent,
          message,
          now(),
          timeZone,
        );
        if (directive) {
          continuation = directive;
          return finish(
            directive.action === "cancel"
              ? "Okay, I’ll drop that reminder request."
              : "Got it. I can schedule that reminder now.",
          );
        }
      } catch (error) {
        if (error instanceof PendingAnswerInputError) return finish(error.message);
        if (error instanceof CalendarTimeError)
          return finish(`${error.message} Please choose another time.`);
        throw error;
      }
      if (
        request.pendingIntent.state === "awaiting-fields" &&
        /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:please\s+)?remind me\b/i.test(
          message,
        ) &&
        /\b(?:in\s+\d|today|tomorrow|next\s+(?:sun|mon|tues|wednes|thurs|fri|satur)day|at\s+\d)\b/i.test(
          message,
        )
      )
        continuation = {
          action: "cancel",
          pendingIntentId: request.pendingIntent.id,
          expectedRevision: request.pendingIntent.revision,
        };
    }
    const timeCorrection =
      /^actually,?\s+(?:make|move|change)\s+it\s+(?:to\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)[.!?]?$/i.exec(
        message,
      );
    if (timeCorrection && request.recentOperation) {
      const receipt = request.recentOperation;
      const target = options.store.getRecord(request.actor, receipt.recordId);
      if (
        !target ||
        target.kind !== receipt.kind ||
        target.scope.type !== request.scope.type ||
        target.scope.id !== request.scope.id ||
        target.revision !== receipt.expectedRevision
      )
        return finish("That item changed. Please tell me which current reminder or event to move.");
      const previousAt = parseInstant(
        target.data[receipt.kind === "reminder" ? "dueAt" : "startAt"],
      );
      if (previousAt === undefined)
        return finish("That item does not have a current time I can safely change.");
      try {
        const previous = localParts(previousAt, timeZone),
          clock = parseClock(timeCorrection[1]!),
          at = resolveZoned(
            {
              year: previous.year,
              month: previous.month,
              day: previous.day,
              ...clock,
            },
            timeZone,
          );
        if (at <= now()) return finish("That time is in the past. Please choose a future time.");
        continuation = {
          action: "replace",
          intent:
            receipt.kind === "reminder"
              ? { kind: "reschedule-reminder" }
              : { kind: "reschedule-event" },
          missing: [receipt.kind === "reminder" ? "when" : "start"],
          question: `Move “${target.title}” to ${timeCorrection[1]!.trim()}?`,
          answer:
            receipt.kind === "reminder"
              ? { when: { type: "instant", at } }
              : { start: { type: "instant", at } },
          target: {
            recordId: target.id,
            expectedRevision: target.revision,
            ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
          },
        };
        return finish(`I can move “${target.title}” to ${timeCorrection[1]!.trim()}.`);
      } catch (error) {
        if (error instanceof CalendarTimeError)
          return finish(`${error.message} Please choose another time.`);
        throw error;
      }
    }
    const missingReminder = options.model ? undefined : parseMissingReminder(message);
    if (missingReminder) {
      continuation = {
        action: request.pendingIntent?.state === "awaiting-fields" ? "replace" : "create",
        intent: missingReminder,
        missing: ["when"],
        question: "When should I remind you?",
      };
      return finish("When should I remind you?");
    }
    const runOperation = (intent: LifeIntent, label: string) => {
      const outcome = operations.execute(request.actor, request.scope, intent, timeZone);
      records.push(...outcome.records);
      tasks.push(...outcome.tasks);
      actions.push({
        label,
        status:
          outcome.status === "clarify" || outcome.status === "rejected"
            ? "skipped"
            : outcome.status,
      });
      return finish(outcome.reply);
    };
    const teachDirect = /^teach ellie:\s*(.+)$/is.exec(message);
    if (teachDirect) {
      const instructions = teachDirect[1]!.trim();
      if (instructions.length > 4_000)
        return finish("Please shorten that guidance to 4,000 characters or fewer.");
      const guide = teaching.create(request.actor, {
        scope: request.scope,
        title: instructions.slice(0, 80),
        instructions,
        enabled: true,
      });
      records.push(guide.record);
      invalidateContext(request.actor, request.scope);
      actions.push({ label: `Enable guidance: ${guide.record.title}`, status: "completed" });
      return finish(`I’ll use “${guide.record.title}” as guidance in this space.`);
    }
    const sourceGuidance = /^use\s+(.+?)\s+as guidance[.!?]?$/i.exec(message);
    if (sourceGuidance) {
      const needle = clean(sourceGuidance[1]!).toLowerCase();
      const matches = all(["source"]).filter(
        (record) => clean(record.title).toLowerCase() === needle,
      );
      if (matches.length !== 1)
        return finish(
          matches.length
            ? "That title matches more than one source. Please rename one first."
            : `I couldn’t find a source named “${clean(sourceGuidance[1]!)}” in this space.`,
        );
      const source = matches[0]!;
      if (!source.body || source.body.length > 4_000)
        return finish(
          "That source is too long to adopt safely. Use “Teach Ellie: …” with the specific instruction text you want.",
        );
      const guide = teaching.create(request.actor, {
        scope: request.scope,
        title: `${source.title} guidance`.slice(0, 200),
        instructions: source.body,
        sources: [{ id: source.id, revision: source.revision }],
        enabled: true,
      });
      records.push(guide.record);
      invalidateContext(request.actor, request.scope);
      actions.push({ label: `Enable guidance: ${guide.record.title}`, status: "completed" });
      return finish(`I adopted “${source.title}” as versioned guidance for this space.`);
    }
    if (/^(?:list|show)(?: my)? guidance[.!?]?$/i.test(message)) {
      const guides = teaching.list(request.actor, request.scope);
      return finish(
        guides.length
          ? guides.map((guide) => `${guide.record.title} — ${guide.status}`).join("\n")
          : "There is no adopted guidance in this space.",
      );
    }
    const toggleGuidance = /^(pause|resume) guidance\s+(.+?)[.!?]?$/i.exec(message);
    if (toggleGuidance) {
      const needle = clean(toggleGuidance[2]!).toLowerCase();
      const matches = teaching
        .list(request.actor, request.scope)
        .filter((guide) => clean(guide.record.title).toLowerCase() === needle);
      if (matches.length !== 1)
        return finish(
          matches.length
            ? "That name matches more than one guide. Please rename one first."
            : `I couldn’t find guidance named “${clean(toggleGuidance[2]!)}”.`,
        );
      const enabled = toggleGuidance[1]!.toLowerCase() === "resume";
      const guide = teaching.setEnabled(
        request.actor,
        matches[0]!.record.id,
        matches[0]!.record.revision,
        enabled,
      );
      records.push(guide.record);
      invalidateContext(request.actor, request.scope);
      actions.push({
        label: `${enabled ? "Resume" : "Pause"} guidance: ${guide.record.title}`,
        status: "completed",
      });
      return finish(`${enabled ? "Resumed" : "Paused"} “${guide.record.title}”.`);
    }
    const placeReminder = /^remind me to\s+(.+?)\s+when i(?:'m| am) at\s+(.+)$/i.exec(message);
    if (placeReminder) {
      const storeName = clean(placeReminder[2]!);
      const need = create({
        kind: "need",
        title: clean(placeReminder[1]!),
        scope: request.scope,
        data: { completed: false, store: storeName },
      });
      actions.push({
        label: `Link ${need.title} to ${storeName}`,
        status: "completed",
      });
      return finish(
        `I linked “${need.title}” to ${storeName}. Ellie will surface it when an authorized fresh shopping or location signal arrives; this did not create a fake geofence.`,
      );
    }
    const shopping = /^i(?:'m| am) (?:shopping )?at\s+(.+)$/i.exec(message);
    if (shopping) {
      const storeName = clean(shopping[1]!);
      const suggestions = context.evaluate(request.actor, request.scope, {
        type: "shopping",
        store: storeName,
        at: now(),
      });
      return finish(
        suggestions.length
          ? suggestions.map((item) => `${item.title}: ${item.reason}`).join("\n")
          : `I checked your open needs for ${storeName} and found nothing timely.`,
      );
    }
    if (/^(?:what should i prepare for|check upcoming preparation)$/i.test(message)) {
      const suggestions = context.evaluate(request.actor, request.scope, {
        type: "check",
        at: now(),
      });
      return finish(
        suggestions.length
          ? suggestions.map((item) => `${item.title}: ${item.reason}`).join("\n")
          : "I found no events in this space that need preparation in the next 48 hours.",
      );
    }
    const createBirthdayPlan = (
      name: string,
      birthdayAt: number,
      month: number,
      day: number,
      interests: string[] = [],
      budget?: number,
      birthYear?: number,
    ) => {
      const contact = create({
        kind: "contact",
        title: name,
        scope: request.scope,
        data: { interests },
      });
      const date = calendarDateKey(localParts(birthdayAt, timeZone));
      const event = create({
        kind: "birthday",
        title: `${name}'s birthday`,
        scope: request.scope,
        data: {
          month: month + 1,
          day,
          nextDate: date,
          timeZone,
          ...(birthYear === undefined ? {} : { birthYear }),
        },
        relationships: [{ type: "person", targetId: contact.id }],
      });
      const need = create({
        kind: "need",
        title: `Gift for ${name}`,
        scope: request.scope,
        data: {
          completed: false,
          deadlineAt:
            startOfLocalDay(addCalendarDays(localParts(birthdayAt, timeZone), 1), timeZone) ??
            birthdayAt,
          interests,
          ...(budget === undefined ? {} : { budget }),
        },
        relationships: [
          { type: "occasion", targetId: event.id },
          { type: "person", targetId: contact.id },
        ],
      });
      const dueAt = Math.max(now() + 1_000, birthdayAt - 7 * 86_400_000);
      const reminder = create({
        kind: "reminder",
        title: `Plan ${name}'s birthday gift`,
        scope: request.scope,
        data: { dueAt, completed: false, timeZone },
        relationships: [{ type: "need", targetId: need.id }],
      });
      const task = scheduleReminder(options.tasks, request.actor, request.scope, reminder, dueAt);
      tasks.push(task);
      options.store.updateRecord(request.actor, reminder.id, reminder.revision, {
        data: { ...reminder.data, taskId: task.id },
      });
      actions.push(
        { label: `Remember ${name}'s birthday`, status: "completed" },
        { label: "Create gift need", status: "completed" },
        { label: "Schedule preparation reminder", status: "scheduled" },
      );
      return finish(
        `I remembered ${name}'s birthday, opened a gift need${budget === undefined ? "" : ` under $${budget}`}, and scheduled preparation.`,
      );
    };

    const relativeBirthday =
      /^my friend(?:'s|’s) birthday is next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(
        message,
      );
    if (relativeBirthday && !message.includes("?")) {
      const weekday = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ].indexOf(relativeBirthday[1]!.toLowerCase());
      const date = nextWeekdayDate(validateCalendarDate(localParts(now(), timeZone)), weekday);
      const birthdayAt = resolveZoned({ ...date, hour: 9, minute: 0 }, timeZone);
      const month = date.month - 1,
        day = date.day;
      const interest = /they love\s+([^.!?]+)/i.exec(message)?.[1];
      const budget = /under\s+\$(\d{1,6})/i.exec(message)?.[1];
      return createBirthdayPlan(
        "My friend",
        birthdayAt,
        month,
        day,
        interest ? [clean(interest)] : [],
        budget ? Number(budget) : undefined,
      );
    }

    const birthday =
      /^(?:please\s+)?(?:remember\s+)?(?:that\s+)?(.+?)(?:'s|’s) birthday is\s+([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:\s+and\s+(?:she|he|they)\s+(?:loves?|likes?)\s+([^.!?]+?))?(?:[.!]\s*help me get something under\s+\$(\d{1,6}))?[.!]?$/i.exec(
        message,
      );
    const birthdayStatement =
      !message.includes("?") &&
      !/^(?:don't|do not|never|do|does|did|can|could|would|will|is|are|for example|example)\b/i.test(
        message,
      );
    if (birthdayStatement && birthday && months.includes(birthday[2]!.toLowerCase())) {
      const name = clean(birthday[1]!),
        month = months.indexOf(birthday[2]!.toLowerCase()),
        day = Number(birthday[3]);
      const check = new Date(Date.UTC(2024, month, day));
      if (check.getUTCMonth() !== month || check.getUTCDate() !== day)
        return finish("That birthday date isn’t valid.");
      const nextDate = nextAnnualDate({ month: month + 1, day }, now(), timeZone);
      const birthdayAt = resolveZoned({ ...nextDate, hour: 9, minute: 0 }, timeZone);
      return createBirthdayPlan(
        name,
        birthdayAt,
        month,
        day,
        birthday[5] ? [clean(birthday[5])] : [],
        birthday[6] ? Number(birthday[6]) : undefined,
        birthday[4] ? Number(birthday[4]) : undefined,
      );
    }

    const saveEvent = (title: string, startAt: number) => {
      const display = titleCase(title);
      return runOperation(
        { kind: "create_event", title: display, start: { type: "instant", at: startAt } },
        `Create ${display}`,
      );
    };
    const anchoredEvent =
      /^(?:schedule|add|create)\s+(?:an?\s+)?(.+?)(?:\s+(?:appointment|event))?\s+(?:on\s+)?(today|tomorrow|next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday))\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(
        message,
      );
    if (anchoredEvent) {
      try {
        const current = localParts(now(), timeZone);
        let date = validateCalendarDate(current);
        if (anchoredEvent[2]!.toLowerCase() === "tomorrow") date = addCalendarDays(date, 1);
        else if (anchoredEvent[3])
          date = nextWeekdayDate(
            date,
            ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(
              anchoredEvent[3].toLowerCase(),
            ),
          );
        return saveEvent(
          clean(anchoredEvent[1]!),
          resolveZoned({ ...date, ...parseClock(anchoredEvent[4]!) }, timeZone),
        );
      } catch (error) {
        if (error instanceof CalendarTimeError) return finish(error.message);
        throw error;
      }
    }
    const eventRequest =
      /^(?:schedule|add|create)\s+(?:an?\s+)?(.+?)(?:\s+(?:appointment|event))?\s+on\s+([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/i.exec(
        message,
      );
    if (eventRequest && months.includes(eventRequest[2]!.toLowerCase())) {
      const title = clean(eventRequest[1]!),
        month = months.indexOf(eventRequest[2]!.toLowerCase()),
        day = Number(eventRequest[3]);
      const localYear = Number(
          new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
          }).format(new Date(now())),
        ),
        year = eventRequest[4] ? Number(eventRequest[4]) : localYear;
      try {
        const date = validateCalendarDate({ year, month: month + 1, day });
        return saveEvent(
          title,
          resolveZoned({ ...date, ...parseClock(eventRequest[5]!) }, timeZone),
        );
      } catch (error) {
        if (error instanceof CalendarTimeError) return finish(error.message);
        throw error;
      }
    }

    if (/\b(upcoming birthdays|birthdays coming up)\b/i.test(message)) {
      const birthdays = all(["birthday"])
        .filter(active)
        .sort(
          (a, b) =>
            Number(a.data.month) - Number(b.data.month) || Number(a.data.day) - Number(b.data.day),
        )
        .slice(0, 20);
      return finish(
        birthdays.length
          ? `Upcoming birthdays: ${birthdays.map((record) => `${record.title} (${record.data.month}/${record.data.day})`).join("; ")}.`
          : "I don’t have any birthdays in this space yet.",
      );
    }

    if (/\b(upcoming events|appointments coming up|what(?:'s| is) upcoming)\b/i.test(message)) {
      const today = calendarDateKey(localParts(now(), timeZone));
      const events = all(["event"])
        .filter(active)
        .map((record) => ({ record, when: eventWhen(record, timeZone) }))
        .filter((item): item is { record: LifeRecord; when: EventWhen } =>
          Boolean(
            item.when &&
            (item.when.allDay ? item.when.dateKey >= today : item.when.sortAt >= now()),
          ),
        )
        .sort((a, b) => a.when.sortAt - b.when.sortAt)
        .slice(0, 20);
      return finish(
        events.length
          ? `Upcoming: ${events.map(({ record, when }) => `${record.title} (${when.label})`).join("; ")}.`
          : "I don’t see any upcoming events in this space.",
      );
    }

    const reminderStart = /^(?:please\s+)?(remind me|set (?:a )?timer)\s+/i.exec(message);
    if (reminderStart) {
      let parsed: ReturnType<typeof parseDelay> | ReturnType<typeof localAnchored>;
      try {
        parsed = parseDelay(message) ?? localAnchored(message, now(), timeZone);
      } catch (error) {
        if (error instanceof CalendarTimeError) return finish(error.message);
        throw error;
      }
      if (parsed) {
        const dueAt = "delay" in parsed ? now() + parsed.delay : parsed.at;
        if (dueAt <= now())
          return finish("That reminder time is in the past. Please choose a future time.");
        const kind = /timer/i.test(reminderStart[1]!) ? "timer" : "reminder";
        if (kind === "reminder")
          return runOperation(
            {
              kind: "schedule_reminder",
              title: parsed.text,
              when: { type: "instant", at: dueAt },
            },
            `Schedule reminder: ${parsed.text}`,
          );
        const record = create({
          kind,
          title: parsed.text,
          scope: request.scope,
          data: { dueAt, completed: false },
        });
        const task = scheduleReminder(options.tasks, request.actor, request.scope, record, dueAt);
        tasks.push(task);
        records.push(
          options.store.updateRecord(request.actor, record.id, record.revision, {
            data: { ...record.data, taskId: task.id },
          }),
        );
        actions.push({
          label: `${kind === "timer" ? "Set timer" : "Schedule reminder"}: ${parsed.text}`,
          status: "scheduled",
        });
        return finish(
          `${kind === "timer" ? "Timer set" : "I'll remind you"} at ${new Date(dueAt).toLocaleString()}: ${parsed.text}.`,
        );
      }
    }

    const routine =
      /^every\s+(day|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:remind me to\s+)?(.+)$/i.exec(
        message,
      );
    if (routine) {
      let clock: { hour: number; minute: number };
      try {
        clock = parseClock(routine[2]!);
      } catch (error) {
        if (error instanceof CalendarTimeError) return finish(error.message);
        throw error;
      }
      const { hour, minute } = clock;
      const text = clean(routine[3]!);
      const record = create({
        kind: "routine",
        title: text,
        scope: request.scope,
        data: { completed: false, timeZone },
      });
      const day = routine[1]!.toLowerCase();
      const schedule =
        day === "day"
          ? {
              kind: "daily" as const,
              time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
              timeZone,
            }
          : {
              kind: "weekly" as const,
              weekday: [
                "sunday",
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
              ].indexOf(day),
              time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
              timeZone,
            };
      const task = options.tasks.schedule({
        owner: scopeOwner(request.scope),
        handler: "reminder.notify",
        input: {
          recordId: record.id,
          scope: request.scope,
          userId: request.actor.userId,
        },
        schedule,
      });
      tasks.push(task);
      records.push(
        options.store.updateRecord(request.actor, record.id, record.revision, {
          data: { ...record.data, taskId: task.id },
        }),
      );
      actions.push({ label: `Schedule routine: ${text}`, status: "scheduled" });
      return finish(
        `Scheduled “${text}” ${day === "day" ? "every day" : `every ${titleCase(day)}`} at ${schedule.time}.`,
      );
    }

    const contactRequest = /^(?:add|remember)\s+(.+?)\s+as (?:a )?contact$/i.exec(message);
    if (contactRequest) {
      const name = clean(contactRequest[1]!);
      return runOperation({ kind: "create_contact", name }, `Add ${name}`);
    }

    const needRequest = /^(?:i need|add (?:a )?need(?: to)?|track)\s+(.+)$/i.exec(message);
    if (needRequest) {
      const title = clean(needRequest[1]!);
      return runOperation({ kind: "create_need", title }, `Track ${title}`);
    }

    const remember = /^(?:please\s+)?remember(?: that)?\s+(.+)$/i.exec(message);
    if (remember) {
      const body = clean(remember[1]!);
      const record = create({
        kind: "memory",
        title: body.slice(0, 120),
        body,
        scope: request.scope,
        data: { explicit: true },
      });
      actions.push({ label: "Save memory", status: "completed" });
      return finish(`I’ll remember: ${record.body}.`);
    }

    const correction = /^correct\s+(.+?)\s+(?:to|:)\s+(.+)$/i.exec(message);
    if (correction) {
      const record = findNamed(
        all(["memory", "contact", "need", "reminder"]),
        ["memory", "contact", "need", "reminder"],
        correction[1]!,
      );
      if (!record) return finish(`I couldn’t find “${clean(correction[1]!)}” in this space.`);
      const value = clean(correction[2]!);
      const updated = options.store.updateRecord(request.actor, record.id, record.revision, {
        title: value.slice(0, 120),
        body: record.kind === "memory" ? value : record.body,
      });
      records.push(updated);
      invalidateContext(request.actor, request.scope);
      actions.push({ label: `Correct ${record.title}`, status: "completed" });
      return finish(
        record.kind === "memory" ? "Updated that memory." : `Updated “${record.title}”.`,
      );
    }

    const forget = /^(?:please\s+)?forget\s+(.+)$/i.exec(message);
    if (forget) {
      const record = findNamed(
        all(["memory", "contact", "birthday", "need", "source"]),
        ["memory", "contact", "birthday", "need", "source"],
        forget[1]!,
      );
      if (!record) return finish(`I couldn’t find “${clean(forget[1]!)}” in this space.`);
      options.store.deleteRecord(request.actor, record.id, record.revision);
      invalidateContext(request.actor, request.scope);
      actions.push({ label: "Forget saved item", status: "completed" });
      return finish("Forgot that saved item.");
    }

    const completion = /^(complete|cancel)\s+(.+)$/i.exec(message);
    if (completion) {
      const record = findNamed(
        all(["need", "reminder", "timer"]),
        ["need", "reminder", "timer"],
        completion[2]!,
      );
      if (!record) return finish(`I couldn’t find an open item named “${clean(completion[2]!)}”.`);
      const cancelled = completion[1]!.toLowerCase() === "cancel";
      if (record.kind === "need")
        return runOperation(
          {
            kind: "resolve_need",
            operation: cancelled ? "cancel" : "complete",
            title: record.title,
          },
          `${cancelled ? "Cancel" : "Complete"} ${record.title}`,
        );
      const updated = options.store.updateRecord(request.actor, record.id, record.revision, {
        data: {
          ...record.data,
          [cancelled ? "cancelled" : "completed"]: true,
          resolvedAt: now(),
        },
      });
      records.push(updated);
      if (typeof record.data.taskId === "string")
        options.tasks.cancel(record.data.taskId, scopeOwner(request.scope));
      for (const reminder of all(["reminder"]).filter(
        (item) =>
          item.kind === "reminder" &&
          item.relationships.some((relation) => relation.targetId === record.id),
      )) {
        if (typeof reminder.data.taskId === "string")
          options.tasks.cancel(reminder.data.taskId, scopeOwner(request.scope));
      }
      actions.push({
        label: `${cancelled ? "Cancel" : "Complete"} ${record.title}`,
        status: "completed",
      });
      return finish(`${cancelled ? "Cancelled" : "Completed"} “${record.title}”.`);
    }

    if (/\b(today|what(?:'s| is) next|agenda)\b/i.test(message)) {
      const localToday = validateCalendarDate(localParts(now(), timeZone)),
        todayKey = calendarDateKey(localToday),
        start = startOfLocalDay(localToday, timeZone) ?? now(),
        end = startOfLocalDay(addCalendarDays(localToday, 1), timeZone) ?? start + 86_400_000;
      const due = all(["reminder", "timer", "event", "birthday", "need"])
        .filter(
          (record) =>
            active(record) &&
            (record.kind === "event"
              ? eventWhen(record, timeZone)?.dateKey === todayKey
              : record.kind === "birthday"
                ? Number(record.data.month) === localToday.month &&
                  Number(record.data.day) === localToday.day
                : typeof (record.data.dueAt ?? record.data.deadlineAt) === "number"
                  ? Number(record.data.dueAt ?? record.data.deadlineAt) >= start &&
                    Number(record.data.dueAt ?? record.data.deadlineAt) < end
                  : record.kind === "need"),
        )
        .slice(0, 10);
      return finish(
        due.length
          ? `Here’s what’s active: ${due.map((item) => item.title).join("; ")}.`
          : "You don’t have anything due in this space today.",
      );
    }

    const pref = /^(?:please\s+)?(?:always\s+)?be\s+(concise|brief|warm)(?:\s+from now on)?$/i.exec(
      message,
    );
    if (pref) {
      const value = pref[1]!.toLowerCase();
      const key = value === "warm" ? "tone" : "verbosity";
      const record = options.store.recordFeedback(request.actor, {
        scope: request.scope,
        message,
        explicitPreference: {
          key,
          value: value === "warm" ? "warm" : "brief",
        },
      });
      records.push(record);
      invalidateContext(request.actor, request.scope);
      actions.push({ label: `Set ${key}`, status: "completed" });
      return finish(`Got it. I’ll keep my replies ${value}.`);
    }

    const feedback = /^feedback:\s*(.+)$/i.exec(message);
    if (feedback) {
      records.push(
        options.store.recordFeedback(request.actor, {
          scope: request.scope,
          message: clean(feedback[1]!),
        }),
      );
      actions.push({ label: "Record feedback", status: "completed" });
      return finish(
        "Thanks. I recorded that feedback without turning it into a lasting preference.",
      );
    }

    if (
      /^(?:build|create|make)\s+(?:me\s+)?(?:an?\s+)?(?:app|plugin|widget|game)\b/i.test(message)
    ) {
      const plugin = await buildPlugin({
        actor: request.actor,
        scope: request.scope,
        request: message,
        isContextCurrent: request.isContextCurrent,
        signal: request.signal,
      });
      actions.push({ label: `Build ${plugin.name}`, status: "completed" });
      return finish(`Built “${plugin.name}”. It’s ready in your space.`);
    }

    const rollback = /^roll back\s+(.+?)(?:\s+to version\s+(\d+))?$/i.exec(message);
    if (rollback) {
      const matches = options.plugins
        .list(scopeOwner(request.scope))
        .filter((plugin) => plugin.name.toLowerCase().includes(clean(rollback[1]!).toLowerCase()));
      if (matches.length !== 1)
        return finish(
          matches.length
            ? "That matches more than one app. Please use its exact name."
            : "I couldn’t find that app in this space.",
        );
      const plugin = matches[0]!,
        target = rollback[2] ? Number(rollback[2]) : plugin.version - 1;
      if (target < 1) return finish("That app has no earlier saved version.");
      const updated = options.plugins.rollback(
        scopeOwner(request.scope),
        plugin.id,
        plugin.version,
        target,
      );
      actions.push({ label: `Roll back ${plugin.name}`, status: "completed" });
      return finish(
        `Rolled “${plugin.name}” back to version ${target}; the active revision is now ${updated.version}.`,
      );
    }

    const revision = /^(?:change|update|revise)\s+(.+?)\s+(?:so that|to)\s+(.+)$/i.exec(message);
    if (revision) {
      const matches = options.plugins
        .list(scopeOwner(request.scope))
        .filter((plugin) => plugin.name.toLowerCase().includes(clean(revision[1]!).toLowerCase()));
      if (matches.length !== 1)
        return finish(
          matches.length
            ? "That matches more than one app. Please use its exact name."
            : "I couldn’t find that app in this space.",
        );
      const plugin = await revisePlugin({
        actor: request.actor,
        scope: request.scope,
        id: matches[0]!.id,
        request: clean(revision[2]!),
        expectedVersion: matches[0]!.version,
        isContextCurrent: request.isContextCurrent,
        signal: request.signal,
      });
      actions.push({ label: `Revise ${plugin.name}`, status: "completed" });
      return finish(`Updated “${plugin.name}” to version ${plugin.version}.`);
    }

    const background = /^(?:work on|research|summarize)\s+(.+?)\s+in (?:the )?background$/i.exec(
      message,
    );
    if (background) {
      const query = clean(background[1]!);
      return runOperation({ kind: "summarize_sources", query }, `Summarize ${query}`);
    }

    if (/\b(remember|know|search|find)\b/i.test(lower)) {
      const query = clean(
        message.replace(
          /^(what do you (?:remember|know) about|search(?: sources)? for|find)\s+/i,
          "",
        ),
      ).replace(/[?]+$/, "");
      const memories = all(["memory"])
        .filter((record) =>
          `${record.title} ${record.body ?? ""}`.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, 5);
      const found = options.store.search(request.actor, {
        query: retrievalQuery(query),
        scope: request.scope,
        limit: 5,
      });
      evidence.push(
        ...found.map((item) => ({
          sourceId: item.sourceId,
          title: item.sourceTitle,
          ...(item.reference ? { reference: item.reference } : {}),
        })),
      );
      if (memories.length || found.length)
        return finish(
          [
            memories.map((item) => item.body ?? item.title).join("; "),
            found.map((item) => `${item.sourceTitle}: ${item.text}`).join("\n"),
          ]
            .filter(Boolean)
            .join("\n"),
        );
    }

    if (options.model) {
      const found = options.store.search(request.actor, {
        query: retrievalQuery(message),
        scope: request.scope,
        limit: 5,
      });
      evidence.push(
        ...found.map((item) => ({
          sourceId: item.sourceId,
          title: item.sourceTitle,
          ...(item.reference ? { reference: item.reference } : {}),
        })),
      );
      const generationKey = contextKey(request.actor, request.scope);
      const generation = contextGenerations.get(generationKey) ?? 0;
      const actorGeneration = actorGenerations.get(request.actor.userId) ?? 0;
      const plan = validateModelPlan(
        await options.model.plan({
          message,
          evidence: found.map((item) => ({
            sourceId: item.sourceId,
            title: item.sourceTitle,
            text: item.text,
            ...(item.reference ? { reference: item.reference } : {}),
          })),
          history: suppliedHistory ?? sessions.get(conversationKey)?.slice(0, -1) ?? [],
          now: now(),
          timeZone,
          ...modelContext(options.store, teaching, request.actor, request.scope, message),
        }),
      );
      options.store.listRecords(request.actor, { scope: request.scope, limit: 1 });
      if (
        (contextGenerations.get(generationKey) ?? 0) !== generation ||
        (actorGenerations.get(request.actor.userId) ?? 0) !== actorGeneration ||
        request.isContextCurrent?.() === false
      )
        return {
          reply:
            "The saved context changed while I was answering. Please ask again so I can use the current version.",
          conversationId,
          actions: [],
          records: [],
          taskIds: [],
          evidence: [],
        };
      return applyModelPlan(
        plan,
        request,
        create,
        options.store,
        actions,
        records,
        tasks,
        evidence,
        finish,
        operations,
        timeZone,
      );
    }

    const tone = inferTone(message);
    return finish(
      `${tone.tone === "frustrated" ? "I hear the frustration. " : ""}I can remember or correct facts, set reminders and timers, track birthdays and needs, search your sources, show today’s agenda, record feedback, queue source summaries, and build an arcade or MLB view. Try “remember that I prefer mornings” or “remind me in 20 minutes to check the oven.”`,
    );
  }
  return {
    chat,
    continuePendingIntent,
    invalidateContext,
    invalidateActorContext,
    rerunBackgroundSummary,
    buildPlugin,
    revisePlugin,
  };
}

function scheduleReminder(
  tasks: TaskRuntime,
  actor: LifeActor,
  scope: LifeScope,
  record: LifeRecord,
  dueAt: number,
): TaskRecord {
  return tasks.schedule({
    owner: scopeOwner(scope),
    handler: "reminder.notify",
    input: { recordId: record.id, scope, userId: actor.userId },
    schedule: { kind: "once", at: dueAt },
  });
}

type SourceSummaryInput = {
  actor: LifeActor;
  scope: LifeScope;
  query: string;
  sourceId: string;
  sourceRevision: number;
};
type SourceSummaryResult = {
  status: "complete" | "skipped";
  sourceId: string;
  sourceRevision: number;
  title?: string;
  summary?: string;
  references?: string[];
  reason?: string;
};
function currentSource(store: LifeStore, input: SourceSummaryInput): LifeRecord | undefined {
  const source = store.getRecord(input.actor, input.sourceId);
  return source?.kind === "source" &&
    source.revision === input.sourceRevision &&
    source.scope.type === input.scope.type &&
    source.scope.id === input.scope.id
    ? source
    : undefined;
}

function registerHandlers(
  store: LifeStore,
  tasks: TaskRuntime,
  model: LifeModel | undefined,
  now: () => number,
): void {
  const register = (handler: Parameters<TaskRuntime["registerHandler"]>[0]) => {
    try {
      tasks.registerHandler(handler);
    } catch (error) {
      if (!(error instanceof Error) || !/already registered/.test(error.message)) throw error;
    }
  };
  register({
    name: "reminder.notify",
    requiredCapabilities: ["life.records.write"],
    async run(context, raw) {
      const input = raw as {
        recordId: string;
        scope: LifeScope;
        userId: string;
      };
      const actor = { userId: input.userId };
      const reminder = store.getRecord(actor, input.recordId);
      if (!reminder || !active(reminder))
        return { status: "skipped", reason: "record_unavailable_or_closed" };
      if (
        reminder.data.taskId !== context.task.id &&
        reminder.data.taskId !== context.task.parentId
      )
        return { status: "skipped", reason: "task_superseded" };
      for (const relation of reminder.relationships) {
        const linked = store.getRecord(actor, relation.targetId);
        if (linked?.kind === "need" && !active(linked))
          return { status: "skipped", reason: "need_closed" };
      }
      const existing = store
        .listRecords(actor, {
          scope: input.scope,
          kinds: ["event"],
          limit: 500,
        })
        .find((record) => record.data.deliveryKey === context.idempotencyKey);
      if (existing) return { status: "delivered", notificationId: existing.id };
      const notification = store.createRecord(actor, {
        kind: "event",
        title: `Notification: ${reminder.title}`,
        scope: input.scope,
        data: {
          type: "notification",
          reminderId: reminder.id,
          deliveryKey: context.idempotencyKey,
          deliveredAt: now(),
        },
        relationships: [{ type: "reminder", targetId: reminder.id }],
      });
      return { status: "delivered", notificationId: notification.id };
    },
    checkOutcome: (_context, result) =>
      ["delivered", "skipped"].includes(String((result as { status?: unknown }).status)),
  });
  register({
    name: "knowledge.summarize-source",
    requiredCapabilities: ["life.records.read"],
    resumable: true,
    async run(context, raw) {
      const input = raw as SourceSummaryInput;
      if (!currentSource(store, input))
        return {
          status: "skipped",
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          reason: "source_unavailable",
        } satisfies SourceSummaryResult;
      const found = store
        .search(input.actor, {
          query: retrievalQuery(input.query),
          scope: input.scope,
          limit: 20,
        })
        .filter((item) => item.sourceId === input.sourceId)
        .slice(0, 5);
      context.progress({
        message: `Found ${found.length} passages in one source`,
        current: found.length,
        total: found.length,
      });
      const beforeResult = currentSource(store, input);
      if (!beforeResult)
        return {
          status: "skipped",
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          reason: "source_unavailable",
        } satisfies SourceSummaryResult;
      const references = [
        ...new Set(found.flatMap((item) => (item.reference ? [item.reference] : []))),
      ];
      if (!model) {
        const summary = found
          .map((item) => item.text)
          .join("\n")
          .slice(0, 24_000);
        if (!currentSource(store, input))
          return {
            status: "skipped",
            sourceId: input.sourceId,
            sourceRevision: input.sourceRevision,
            reason: "source_unavailable",
          } satisfies SourceSummaryResult;
        return {
          status: "complete",
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          title: beforeResult.title,
          summary,
          references,
        } satisfies SourceSummaryResult;
      }
      const plan = validateModelPlan(
        await model.plan(
          {
            message: `Summarize: ${input.query}`,
            evidence: found.map((item) => ({
              sourceId: item.sourceId,
              title: item.sourceTitle,
              text: item.text,
              ...(item.reference ? { reference: item.reference } : {}),
            })),
            history: [],
            tone: inferTone(input.query),
          },
          context.signal,
        ),
      );
      const afterModel = currentSource(store, input);
      if (!afterModel)
        return {
          status: "skipped",
          sourceId: input.sourceId,
          sourceRevision: input.sourceRevision,
          reason: "source_unavailable",
        } satisfies SourceSummaryResult;
      return {
        status: "complete",
        sourceId: input.sourceId,
        sourceRevision: input.sourceRevision,
        title: afterModel.title,
        summary: plan.reply.slice(0, 24_000),
        references,
      } satisfies SourceSummaryResult;
    },
    checkOutcome: (_context, result) =>
      ["complete", "skipped"].includes(String((result as { status?: unknown }).status)),
  });
  register({
    name: "knowledge.aggregate",
    requiredCapabilities: ["life.records.read"],
    resumable: true,
    async run(context, raw) {
      const input = raw as { actor: LifeActor; scope: LifeScope; query: string };
      const children = tasks.list({
        owner: context.task.owner,
        parentId: context.task.id,
        limit: 64,
      });
      const available = children
        .filter((child) => child.state === "succeeded" && child.outcomeVerified)
        .map((child) => child.result as SourceSummaryResult)
        .filter((result) => {
          if (result.status !== "complete" || !result.summary) return false;
          return Boolean(
            currentSource(store, {
              actor: input.actor,
              scope: input.scope,
              query: input.query,
              sourceId: result.sourceId,
              sourceRevision: result.sourceRevision,
            }),
          );
        });
      const citations = available.map((result) => ({
        sourceId: result.sourceId,
        sourceRevision: result.sourceRevision,
        title: result.title!,
        references: result.references ?? [],
      }));
      let summary = available.map((result) => `${result.title}: ${result.summary}`).join("\n\n");
      if (model && available.length) {
        const plan = validateModelPlan(
          await model.plan(
            {
              message: `Combine these source summaries for: ${input.query}`,
              evidence: available.map((result) => ({
                sourceId: result.sourceId,
                title: result.title!,
                text: result.summary!,
              })),
              history: [],
              tone: inferTone(input.query),
            },
            context.signal,
          ),
        );
        const allStillCurrent = available.every((result) =>
          currentSource(store, {
            actor: input.actor,
            scope: input.scope,
            query: input.query,
            sourceId: result.sourceId,
            sourceRevision: result.sourceRevision,
          }),
        );
        if (allStillCurrent) summary = plan.reply;
        else {
          const currentIds = new Set(
            available
              .filter((result) =>
                currentSource(store, {
                  actor: input.actor,
                  scope: input.scope,
                  query: input.query,
                  sourceId: result.sourceId,
                  sourceRevision: result.sourceRevision,
                }),
              )
              .map((result) => result.sourceId),
          );
          summary = available
            .filter((result) => currentIds.has(result.sourceId))
            .map((result) => `${result.title}: ${result.summary}`)
            .join("\n\n");
          citations.splice(
            0,
            citations.length,
            ...citations.filter((item) => currentIds.has(item.sourceId)),
          );
        }
      }
      context.progress({
        message: `Aggregated ${citations.length} current sources`,
        current: citations.length,
        total: children.length,
      });
      return {
        status: "complete",
        summary: citations.length
          ? summary.slice(0, 64_000)
          : "No current source passages remain for this summary.",
        citations,
        omitted: children.length - citations.length,
        ...(citations.length ? {} : { reason: "no_current_sources" }),
      };
    },
    checkOutcome: (_context, result) => (result as { status?: unknown }).status === "complete",
  });
}

function applyModelPlan(
  plan: LifeModelPlan,
  request: ChatRequest,
  create: (input: Parameters<LifeStore["createRecord"]>[1]) => LifeRecord,
  store: LifeStore,
  actions: ChatAction[],
  records: LifeRecord[],
  tasks: TaskRecord[],
  evidence: ChatResponse["evidence"],
  finish: (reply: string) => ChatResponse,
  operations: LifeOperations,
  timeZone: string,
): ChatResponse {
  let reply = plan.reply;
  const outcomeReplies: string[] = [];
  let continuation: ContinuationDirective | undefined;
  for (const action of plan.actions) {
    if (action.type === "reply") {
      if (!outcomeReplies.length) reply = action.text;
    } else if (action.type === "create_memory") {
      if (!explicitlyRequestsRemembering(request.message)) {
        outcomeReplies.push(
          "I need a direct request in your current message before I save a memory.",
        );
      } else {
        const saved = create({
          kind: "memory",
          title: action.title,
          body: action.body,
          scope: request.scope,
          data: { explicit: true, proposedByLocalModel: true },
        });
        actions.push({ label: "Save memory", status: "completed" });
        outcomeReplies.push(`Saved “${saved.title}” to memory.`);
      }
    } else if (action.type === "search_sources") {
      const found = store.search(request.actor, {
        query: retrievalQuery(action.query),
        scope: request.scope,
        limit: 5,
      });
      evidence.push(
        ...found.map((item) => ({
          sourceId: item.sourceId,
          title: item.sourceTitle,
          ...(item.reference ? { reference: item.reference } : {}),
        })),
      );
    } else if (action.type === "draft_life_operation") {
      const authorized =
        action.intent.kind === "schedule_reminder"
          ? authorizesIntent(request.message, {
              kind: "schedule_reminder",
              title: action.intent.title,
              when: { type: "instant", at: 0 },
            })
          : authorizesIntent(request.message, {
              kind: "create_event",
              title: action.intent.title,
              start: { type: "instant", at: 0 },
              ...(action.intent.durationMinutes === undefined
                ? {}
                : { durationMinutes: action.intent.durationMinutes }),
            });
      if (!authorized) {
        outcomeReplies.push(
          "I need a direct request in your current message before I prepare that change.",
        );
      } else if (action.intent.kind === "schedule_reminder") {
        continuation = {
          action: "create",
          intent: { kind: "schedule-reminder", title: action.intent.title },
          missing: ["when"],
          question: "When should I remind you?",
        };
        outcomeReplies.push("When should I remind you?");
      } else {
        continuation = {
          action: "create",
          intent: {
            kind: "create-event",
            title: action.intent.title,
            ...(action.intent.durationMinutes === undefined
              ? {}
              : { durationMinutes: action.intent.durationMinutes }),
          },
          missing: ["start"],
          question: "When should I add that event?",
        };
        outcomeReplies.push("When should I add that event?");
      }
    } else if (action.type === "life_operation") {
      if (!authorizesIntent(request.message, action.intent)) {
        outcomeReplies.push(
          "I need a direct request in your current message before I change saved life data.",
        );
        continue;
      }
      let outcome;
      try {
        outcome = operations.execute(request.actor, request.scope, action.intent, timeZone);
      } catch (error) {
        if (error instanceof LifeOperationInputError) {
          outcomeReplies.push(`${error.message} No changes were saved.`);
          continue;
        }
        throw error;
      }
      records.push(...outcome.records);
      tasks.push(...outcome.tasks);
      actions.push({
        label: operationLabel(action.intent),
        status:
          outcome.status === "clarify" || outcome.status === "rejected"
            ? "skipped"
            : outcome.status,
      });
      outcomeReplies.push(outcome.reply);
    }
  }
  const response = finish(
    (outcomeReplies.length ? outcomeReplies.join("\n") : reply).slice(0, 8_000),
  );
  return continuation ? { ...response, continuation } : response;
}

function authorizesIntent(message: string, intent: LifeIntent): boolean {
  const value = message.trim(),
    requestText = value.replace(/\?$/, "").trim();
  if (intent.kind === "query" || intent.kind === "clarify") return true;
  if (
    /^(?:what|why|how|where|when|who|is|are|do|does|did|never|for example|example|quote)\b/i.test(
      requestText,
    )
  )
    return false;
  const polite = String.raw`(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?`;
  const overlaps = (wanted: string) =>
    wanted
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .some((word) => word.length >= 3 && requestText.toLocaleLowerCase().includes(word));
  switch (intent.kind) {
    case "schedule_reminder":
      return (
        (new RegExp(
          `^(?:please\\s+)?${polite}(?:remind|make sure|don't let me forget)\\b`,
          "i",
        ).test(requestText) ||
          (new RegExp(`^(?:please\\s+)?${polite}(?:set|schedule|create|add|put)\\b`, "i").test(
            requestText,
          ) &&
            /\b(?:reminder|timer)\b/i.test(requestText))) &&
        overlaps(intent.title)
      );
    case "create_event":
      return (
        new RegExp(`^(?:please\\s+)?${polite}(?:schedule|add|create|put)\\b`, "i").test(
          requestText,
        ) &&
        /\b(?:calendar|event|appointment|meeting|session)\b/i.test(requestText) &&
        overlaps(intent.title)
      );
    case "create_need":
      return (
        new RegExp(`^(?:please\\s+)?${polite}(?:i need|add|create|track|put)\\b`, "i").test(
          requestText,
        ) && overlaps(intent.title)
      );
    case "resolve_need":
      return (
        new RegExp(`^(?:please\\s+)?${polite}(?:complete|finish|cancel|mark)\\b`, "i").test(
          requestText,
        ) && overlaps(intent.title)
      );
    case "create_contact":
      return (
        new RegExp(`^(?:please\\s+)?${polite}(?:add|save|remember|create)\\b`, "i").test(
          requestText,
        ) && overlaps(intent.name)
      );
    case "summarize_sources":
      return (
        new RegExp(
          `^(?:please\\s+)?${polite}(?:summarize|research|work on|review|analyze)\\b`,
          "i",
        ).test(requestText) && overlaps(intent.query)
      );
  }
}
function operationLabel(intent: LifeIntent): string {
  switch (intent.kind) {
    case "schedule_reminder":
      return `Schedule reminder: ${intent.title}`;
    case "create_event":
      return `Create event: ${intent.title}`;
    case "create_need":
      return `Track need: ${intent.title}`;
    case "resolve_need":
      return `${intent.operation === "cancel" ? "Cancel" : "Complete"} need: ${intent.title}`;
    case "create_contact":
      return `Add contact: ${intent.name}`;
    case "query":
      return `Show ${intent.view}`;
    case "summarize_sources":
      return `Summarize ${intent.query}`;
    case "clarify":
      return "Clarify request";
  }
}
