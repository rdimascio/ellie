import { randomUUID } from "node:crypto";
import type {
  LifeActor,
  LifeRecord,
  LifeScope,
  LifeRecordKind,
} from "../../life-core/src/index.ts";
import { inferTone, LifeStore } from "../../life-core/src/index.ts";
import { ProactivityEngine } from "../../life-context/src/index.ts";
import type { LifePlugin, MLBAdapter, PluginStore } from "../../life-plugins/src/index.ts";
import { builtInManifest } from "../../life-plugins/src/index.ts";
import { LifeTeaching } from "../../life-teaching/src/index.ts";
import type { OwnerScope, TaskRecord } from "../../task-runtime/src/index.ts";
import { nextOccurrence, TaskRuntime } from "../../task-runtime/src/index.ts";
import type { LifeModel, LifeModelPlan } from "./model.ts";
export * from "./model.ts";

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
}
export interface LifeHarness {
  chat(request: ChatRequest): Promise<ChatResponse>;
  invalidateContext(actor: LifeActor, scope: LifeScope): void;
  rerunBackgroundSummary(request: {
    actor: LifeActor;
    scope: LifeScope;
    taskId: string;
  }): TaskRecord;
  buildPlugin(request: {
    actor: LifeActor;
    scope: LifeScope;
    request: string;
  }): Promise<LifePlugin>;
  revisePlugin(request: {
    actor: LifeActor;
    scope: LifeScope;
    id: string;
    request: string;
    expectedVersion: number;
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

function zonedDateTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  });
  const center = Date.UTC(year, month, day, hour);
  for (let at = center - 15 * 3_600_000; at <= center + 15 * 3_600_000; at += 60_000) {
    const values = Object.fromEntries(
      formatter
        .formatToParts(new Date(at))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    if (
      values.year === year &&
      values.month === month + 1 &&
      values.day === day &&
      values.hour === hour
    )
      return at;
  }
  throw new Error("Local date does not exist in the configured time zone.");
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

function localTomorrow(
  message: string,
  now: number,
  timeZone: string,
): { at: number; text: string } | undefined {
  const match =
    /\btomorrow(?:\s+at\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?)?\s+(?:to\s+)?(.+)$/i.exec(message);
  if (!match) return undefined;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const local = Object.fromEntries(
    formatter
      .formatToParts(new Date(now))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = Number(local.year),
    month = Number(local.month),
    day = Number(local.day);
  if (![year, month, day].every(Number.isFinite))
    throw new Error("Could not resolve the configured local date.");
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
  let hour = Number(match[1] ?? 9);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const at =
    zonedDateTime(
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth(),
      tomorrow.getUTCDate(),
      hour,
      timeZone,
    ) +
    Number(match[2] ?? 0) * 60_000;
  return { at, text: clean(match[4]!) };
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

  async function buildPlugin(input: {
    actor: LifeActor;
    scope: LifeScope;
    request: string;
  }): Promise<LifePlugin> {
    // Reading the scope through LifeStore is the authority check, even when there are no records yet.
    options.store.listRecords(input.actor, { scope: input.scope, limit: 1 });
    const manifest = builtInManifest(input.request);
    if (manifest) return options.plugins.install(scopeOwner(input.scope), manifest);
    if (!options.model?.build)
      throw new Error(
        "A local model is required to build this custom app. I can build an arcade or MLB view without one.",
      );
    const generated = await options.model.build(input.request);
    options.store.listRecords(input.actor, { scope: input.scope, limit: 1 });
    return options.plugins.install(scopeOwner(input.scope), {
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
  }): Promise<LifePlugin> {
    if (!input.request.trim() || input.request.length > 8_000)
      throw new TypeError("Plugin revision request is invalid.");
    options.store.listRecords(input.actor, { scope: input.scope, limit: 1 });
    const owner = scopeOwner(input.scope),
      previous = options.plugins.get(owner, input.id);
    if (previous.kind !== "custom") {
      const rename = /(?:rename|change (?:the )?name)(?: it)? to\s+(.+)$/i.exec(input.request);
      if (!rename)
        throw new Error(
          "Built-in apps can be renamed here; code revisions are available for custom apps.",
        );
      return options.plugins.update(owner, input.id, input.expectedVersion, {
        name: clean(rename[1]!),
        description: previous.description,
        kind: previous.kind,
        capabilities: previous.capabilities,
      });
    }
    if (!options.model?.build) throw new Error("A local model is required to revise a custom app.");
    const generated = await options.model.build({
      request: input.request,
      previous: {
        name: previous.name,
        description: previous.description,
        html: previous.html!,
      },
    });
    options.store.listRecords(input.actor, { scope: input.scope, limit: 1 });
    return options.plugins.update(owner, input.id, input.expectedVersion, {
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
    rememberSession(conversationKey, "user", message);
    const records: LifeRecord[] = [],
      tasks: TaskRecord[] = [],
      actions: ChatAction[] = [],
      evidence: ChatResponse["evidence"] = [];
    const all = () =>
      options.store.listRecords(request.actor, {
        scope: request.scope,
        limit: 500,
      });
    const create = (input: Parameters<LifeStore["createRecord"]>[1]) => {
      const record = options.store.createRecord(request.actor, input);
      records.push(record);
      return record;
    };
    const finish = (reply: string): ChatResponse => {
      rememberSession(conversationKey, "assistant", reply);
      return {
        reply,
        conversationId,
        actions,
        records,
        taskIds: tasks.map((task) => task.id),
        evidence,
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
      const matches = all().filter(
        (record) => record.kind === "source" && clean(record.title).toLowerCase() === needle,
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
      const date = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        ...(birthYear === undefined ? {} : { birthYear }),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(birthdayAt));
      const event = create({
        kind: "birthday",
        title: `${name}'s birthday`,
        scope: request.scope,
        data: { month: month + 1, day, nextDate: date, timeZone },
        relationships: [{ type: "person", targetId: contact.id }],
      });
      const need = create({
        kind: "need",
        title: `Gift for ${name}`,
        scope: request.scope,
        data: {
          completed: false,
          deadlineAt: birthdayAt,
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
      /my friend(?:'s|’s) birthday is next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/i.exec(
        message,
      );
    if (relativeBirthday) {
      const weekday = [
        "sunday",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
      ].indexOf(relativeBirthday[1]!.toLowerCase());
      const birthdayAt = nextOccurrence(
        { kind: "weekly", weekday, time: "09:00", timeZone },
        now(),
      )!;
      const local = new Intl.DateTimeFormat("en-US", {
        timeZone,
        month: "numeric",
        day: "numeric",
      }).formatToParts(new Date(birthdayAt));
      const month = Number(local.find((part) => part.type === "month")!.value) - 1,
        day = Number(local.find((part) => part.type === "day")!.value);
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
      /(?:remember\s+)?(?:that\s+)?(.+?)(?:'s|’s) birthday is\s+([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i.exec(
        message,
      );
    if (birthday && months.includes(birthday[2]!.toLowerCase())) {
      const name = clean(birthday[1]!),
        month = months.indexOf(birthday[2]!.toLowerCase()),
        day = Number(birthday[3]);
      const check = new Date(Date.UTC(2024, month, day));
      if (check.getUTCMonth() !== month || check.getUTCDate() !== day)
        return finish("That birthday date isn’t valid.");
      const localYear = Number(
        new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(new Date(now())),
      );
      let year = localYear;
      let birthdayAt = zonedDateTime(year, month, day, 9, timeZone);
      if (birthdayAt <= now()) {
        year++;
        birthdayAt = zonedDateTime(year, month, day, 9, timeZone);
      }
      return createBirthdayPlan(
        name,
        birthdayAt,
        month,
        day,
        [],
        undefined,
        birthday[4] ? Number(birthday[4]) : undefined,
      );
    }

    const eventRequest =
      /^(?:schedule|add|create)\s+(?:an?\s+)?(.+?)(?:\s+(?:appointment|event))?\s+on\s+([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i.exec(
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
      let hour = Number(eventRequest[5]),
        minute = Number(eventRequest[6] ?? 0);
      if (eventRequest[7]?.toLowerCase() === "pm" && hour < 12) hour += 12;
      if (eventRequest[7]?.toLowerCase() === "am" && hour === 12) hour = 0;
      const check = new Date(Date.UTC(year, month, day));
      if (check.getUTCMonth() !== month || check.getUTCDate() !== day || hour > 23)
        return finish("That event date or time isn’t valid.");
      const startAt = zonedDateTime(year, month, day, hour, timeZone) + minute * 60_000;
      if (startAt <= now())
        return finish("That event time is in the past. Please give me a future date.");
      const event = create({
        kind: "event",
        title: titleCase(title),
        scope: request.scope,
        data: { startAt, endAt: startAt + 3_600_000, timeZone },
      });
      actions.push({ label: `Create ${event.title}`, status: "completed" });
      return finish(
        `Added “${event.title}” for ${new Date(startAt).toLocaleString("en-US", { timeZone })}.`,
      );
    }

    if (/\b(upcoming birthdays|birthdays coming up)\b/i.test(message)) {
      const birthdays = all()
        .filter((record) => record.kind === "birthday")
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
      const events = all()
        .filter(
          (record) =>
            record.kind === "event" &&
            typeof record.data.startAt === "number" &&
            record.data.startAt >= now(),
        )
        .sort((a, b) => Number(a.data.startAt) - Number(b.data.startAt))
        .slice(0, 20);
      return finish(
        events.length
          ? `Upcoming: ${events.map((record) => `${record.title} (${new Date(Number(record.data.startAt)).toLocaleString("en-US", { timeZone })})`).join("; ")}.`
          : "I don’t see any upcoming events in this space.",
      );
    }

    const reminderStart = /^(?:please\s+)?(remind me|set (?:a )?timer)\s+/i.exec(message);
    if (reminderStart) {
      const parsed = parseDelay(message) ?? localTomorrow(message, now(), timeZone);
      if (parsed) {
        const dueAt = "delay" in parsed ? now() + parsed.delay : parsed.at;
        const kind = /timer/i.test(reminderStart[1]!) ? "timer" : "reminder";
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
      /^every\s+(day|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+at\s+(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s+(?:remind me to\s+)?(.+)$/i.exec(
        message,
      );
    if (routine) {
      let hour = Number(routine[2]),
        minute = Number(routine[3] ?? 0);
      if (routine[4]?.toLowerCase() === "pm" && hour < 12) hour += 12;
      if (routine[4]?.toLowerCase() === "am" && hour === 12) hour = 0;
      if (hour > 23) return finish("That routine time isn’t valid.");
      const text = clean(routine[5]!);
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
      const record = create({
        kind: "contact",
        title: clean(contactRequest[1]!),
        scope: request.scope,
        data: {},
      });
      actions.push({ label: `Add ${record.title}`, status: "completed" });
      return finish(`Added ${record.title} as a contact.`);
    }

    const needRequest = /^(?:i need|add (?:a )?need(?: to)?|track)\s+(.+)$/i.exec(message);
    if (needRequest) {
      const record = create({
        kind: "need",
        title: clean(needRequest[1]!),
        scope: request.scope,
        data: { completed: false },
      });
      actions.push({ label: `Track ${record.title}`, status: "completed" });
      return finish(`I’m tracking “${record.title}”.`);
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
      const record = findNamed(all(), ["memory", "contact", "need", "reminder"], correction[1]!);
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
        all(),
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
      const record = findNamed(all(), ["need", "reminder", "timer"], completion[2]!);
      if (!record) return finish(`I couldn’t find an open item named “${clean(completion[2]!)}”.`);
      const cancelled = completion[1]!.toLowerCase() === "cancel";
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
      for (const reminder of all().filter(
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
      const end = now() + 24 * 60 * 60_000;
      const due = all()
        .filter(
          (record) =>
            ["reminder", "timer", "event", "birthday", "need"].includes(record.kind) &&
            active(record) &&
            (typeof record.data.dueAt !== "number" ||
              (record.data.dueAt >= now() && record.data.dueAt <= end)),
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
      const key = value === "warm" ? "response.tone" : "response.length";
      const record = options.store.recordFeedback(request.actor, {
        scope: request.scope,
        message,
        explicitPreference: {
          key,
          value: value === "brief" ? "concise" : value,
        },
      });
      records.push(record);
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
      });
      actions.push({ label: `Revise ${plugin.name}`, status: "completed" });
      return finish(`Updated “${plugin.name}” to version ${plugin.version}.`);
    }

    const background = /^(?:work on|research|summarize)\s+(.+?)\s+in (?:the )?background$/i.exec(
      message,
    );
    if (background) {
      const query = clean(background[1]!);
      const task = enqueueBackgroundSummary(request.actor, request.scope, query);
      if (!task) return finish(`I couldn't find a scoped source to summarize for “${query}”.`);
      tasks.push(task);
      actions.push({ label: `Summarize ${query}`, status: "queued" });
      return finish(
        `I queued a background summary using sources already available in this space. I won’t claim internet research without a connector.`,
      );
    }

    if (/\b(remember|know|search|find)\b/i.test(lower)) {
      const query = clean(
        message.replace(
          /^(what do you (?:remember|know) about|search(?: sources)? for|find)\s+/i,
          "",
        ),
      ).replace(/[?]+$/, "");
      const memories = all()
        .filter(
          (record) =>
            record.kind === "memory" &&
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
      const plan = await options.model.plan({
        message,
        evidence: found.map((item) => ({
          sourceId: item.sourceId,
          title: item.sourceTitle,
          text: item.text,
          ...(item.reference ? { reference: item.reference } : {}),
        })),
        history: sessions.get(conversationKey)?.slice(0, -1) ?? [],
        ...modelContext(options.store, teaching, request.actor, request.scope, message),
      });
      if ((contextGenerations.get(generationKey) ?? 0) !== generation)
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
        evidence,
        finish,
      );
    }

    const tone = inferTone(message);
    return finish(
      `${tone.tone === "frustrated" ? "I hear the frustration. " : ""}I can remember or correct facts, set reminders and timers, track birthdays and needs, search your sources, show today’s agenda, record feedback, queue source summaries, and build an arcade or MLB view. Try “remember that I prefer mornings” or “remind me in 20 minutes to check the oven.”`,
    );
  }
  return {
    chat,
    invalidateContext,
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
      const plan = await model.plan(
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
        const plan = await model.plan(
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
  evidence: ChatResponse["evidence"],
  finish: (reply: string) => ChatResponse,
): ChatResponse {
  let reply = plan.reply;
  for (const action of plan.actions) {
    if (action.type === "reply") reply = action.text;
    else if (action.type === "create_memory" && explicitlyRequestsRemembering(request.message)) {
      create({
        kind: "memory",
        title: action.title,
        body: action.body,
        scope: request.scope,
        data: { explicit: true, proposedByLocalModel: true },
      });
      actions.push({ label: "Save memory", status: "completed" });
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
    }
  }
  return finish(reply);
}
