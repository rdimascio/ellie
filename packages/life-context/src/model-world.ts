import type {
  LifeActor,
  LifeRecord,
  LifeRecordKind,
  LifeScope,
} from "../../life-core/src/index.ts";
import { LifeStore } from "../../life-core/src/index.ts";
import { LifePlanError, planDetails } from "../../life-plans/src/index.ts";
import { parseCalendarDate, parseInstant } from "../../life-time/src/index.ts";

export interface ModelWorldRecord {
  id: string;
  revision: number;
  kind: LifeRecordKind;
  title: string;
  facts: string[];
  note?: string;
  noteOmitted?: true;
  relatedIds: string[];
}
export interface ModelWorldContext {
  records: ModelWorldRecord[];
  partial: true;
  candidateWindowsTruncated: boolean;
  omittedMatches: number;
}
export type ModelDeliveryStatus =
  | "scheduled"
  | "paused"
  | "running"
  | "delivered"
  | "complete"
  | "cancelled"
  | "failed"
  | "skipped"
  | "unknown";
export interface ModelDeliveryContext {
  status: ModelDeliveryStatus;
  scheduleStatus: ModelDeliveryStatus;
  occurrenceStatus?: ModelDeliveryStatus;
}

const families: LifeRecordKind[][] = [
  ["contact", "birthday"],
  ["need", "goal"],
  ["event", "reminder", "timer", "holiday"],
  ["place", "routine"],
];
const kinds = new Set(families.flat());
const instructionTypes = new Set(["teaching-guide-v1", "learning-improvement-v1"]);
const ignored = new Set(
  "about after again also and are can could for from have help how like me more my now please should some that the their them then there these they this today tomorrow want what when where which with would you your".split(
    " ",
  ),
);
const terms = (value: string) =>
  new Set(
    (
      value
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? []
    )
      .filter((term) => !ignored.has(term))
      .slice(0, 64),
  );
const matchCount = (value: string, query: Set<string>) =>
  [...terms(value)].reduce((sum, term) => sum + Number(query.has(term)), 0);
const dataFields = [
  "completed",
  "cancelled",
  "enabled",
  "status",
  "interests",
  "relationship",
  "budget",
  "currency",
  "quantity",
  "unit",
  "store",
  "preferredStore",
  "location",
  "address",
  "city",
  "month",
  "day",
  "year",
  "timeZone",
  "durationMinutes",
  "allDay",
  "priority",
] as const;
const timeFields = ["dueAt", "deadlineAt", "startAt", "endAt", "startDate", "date"] as const;

function project(
  record: LifeRecord,
  resolveDelivery?: (record: LifeRecord) => ModelDeliveryContext | undefined,
): ModelWorldRecord | undefined {
  if (
    !kinds.has(record.kind) ||
    instructionTypes.has(String(record.data.type)) ||
    record.title.length > 500 ||
    record.provenance.some((source) => source.invalidatedAt !== undefined)
  )
    return;
  const facts: string[] = [];
  if (record.data.type === "life-plan-v1") {
    let plan;
    try {
      plan = planDetails(record);
    } catch (error) {
      if (error instanceof LifePlanError && error.code === "invalid_plan") return undefined;
      throw error;
    }
    facts.push(`checklistProgress: ${plan.completedSteps}/${plan.totalSteps} steps completed`);
    const selectedSteps = plan.steps
      .map((step, index) => ({ step, number: index + 1 }))
      .sort((a, b) => Number(a.step.completed) - Number(b.step.completed) || a.number - b.number)
      .filter(({ step }) => step.title.length <= 300)
      .slice(0, 8);
    for (const { step, number } of selectedSteps)
      facts.push(
        `checklistStep ${number} (${step.completed ? "completed" : "unfinished"}): ${step.title}`,
      );
    if (selectedSteps.length < plan.totalSteps)
      facts.push(`checklistStepsOmitted: ${plan.totalSteps - selectedSteps.length}`);
  }
  for (const key of dataFields) {
    const value = record.data[key];
    if (typeof value === "string" && value.length <= 240) facts.push(`${key}: ${value}`);
    else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
      facts.push(`${key}: ${value}`);
    else if (
      Array.isArray(value) &&
      value.length <= 8 &&
      value.every((item) => typeof item === "string" && item.length <= 100)
    )
      facts.push(`${key}: ${JSON.stringify(value)}`);
  }
  for (const key of timeFields) {
    const value = record.data[key],
      at = parseInstant(value);
    if (at !== undefined) facts.push(`${key}: ${new Date(at).toISOString()}`);
    else if (typeof value === "string" && parseCalendarDate(value))
      facts.push(`${key} (calendar date): ${value}`);
  }
  const delivery = resolveDelivery?.(record);
  if (delivery !== undefined) {
    facts.push(`notificationDeliveryStatus: ${delivery.status}`);
    facts.push(`notificationScheduleStatus: ${delivery.scheduleStatus}`);
    if (delivery.occurrenceStatus !== undefined)
      facts.push(`notificationOccurrenceStatus: ${delivery.occurrenceStatus}`);
  }
  const result: ModelWorldRecord = {
    id: record.id,
    revision: record.revision,
    kind: record.kind,
    title: record.title,
    facts,
    ...(record.body && record.body.length <= 1200 ? { note: record.body } : {}),
    ...(record.body && record.body.length > 1200 ? { noteOmitted: true as const } : {}),
    relatedIds: [...new Set(record.relationships.map((relation) => relation.targetId))].slice(0, 8),
  };
  // Omit whole records instead of cutting a qualification from a note or field.
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= 4000 ? result : undefined;
}

/** A bounded read of the selected space. These observations never authorize an action. */
export function selectModelWorld(
  store: LifeStore,
  actor: LifeActor,
  scope: LifeScope,
  message: string,
  resolveDelivery?: (record: LifeRecord) => ModelDeliveryContext | undefined,
): ModelWorldContext {
  const query = terms(message),
    preferred = new Set<LifeRecordKind>(),
    mentions = (pattern: RegExp) => pattern.test(message);
  if (mentions(/\b(gift|birthday|friend|family|contact|person|people)\b/i)) {
    preferred.add("contact");
    preferred.add("birthday");
    preferred.add("need");
  }
  if (mentions(/\b(shopping|buy|need|needs|groceries|dinner|cook|recipe|store)\b/i)) {
    preferred.add("need");
    preferred.add("place");
  }
  if (mentions(/\b(today|tomorrow|week|agenda|schedule|prepare|appointment|event|plan)\b/i)) {
    preferred.add("event");
    preferred.add("reminder");
    preferred.add("holiday");
    preferred.add("goal");
    preferred.add("routine");
  }
  if (mentions(/\b(near|where|restaurant|place|places)\b/i)) preferred.add("place");
  if (mentions(/\b(plan|plans|checklist|checklists|steps)\b/i)) preferred.add("goal");
  if (mentions(/\b(timer|timers|reminder|reminders|routine|routines)\b/i)) {
    preferred.add("timer");
    preferred.add("reminder");
    preferred.add("routine");
  }
  const pages = families.map((family) =>
      store.listRecordSummaries(actor, { scope, kinds: family, limit: 50 }),
    ),
    scored = pages
      .flatMap((page) => page.items)
      .filter(
        (record) =>
          record.provenanceStatus === "valid" && !instructionTypes.has(String(record.data.type)),
      )
      .map((record) => ({
        record,
        lexical:
          8 * matchCount(record.title, query) + 2 * matchCount(record.bodyPreview ?? "", query),
        fallback:
          preferred.has(record.kind) &&
          record.data.completed !== true &&
          record.data.cancelled !== true
            ? 1
            : 0,
      })),
    hasLexicalMatch = scored.some((item) => item.lexical > 0),
    candidates = scored
      .map((item) => ({ ...item, score: item.lexical + item.fallback }))
      .filter((item) => (hasLexicalMatch ? item.lexical > 0 : item.fallback > 0))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.record.updatedAt - a.record.updatedAt ||
          a.record.id.localeCompare(b.record.id),
      ),
    records: ModelWorldRecord[] = [],
    selected = new Set<string>();
  const add = (id: string) => {
    if (selected.has(id)) return;
    selected.add(id);
    const record = store.getRecord(actor, id);
    if (!record || record.scope.type !== scope.type || record.scope.id !== scope.id) return;
    const projected = project(record, resolveDelivery);
    if (projected) records.push(projected);
  };
  for (const { record } of candidates.slice(0, 8)) add(record.id);
  const related = [...new Set(records.flatMap((record) => record.relatedIds))];
  // A small number of direct relationships lets a gift need bring its person's interests.
  for (const id of related.slice(0, 4)) add(id);
  const included = new Set(records.map((record) => record.id));
  for (const record of records)
    record.relatedIds = record.relatedIds.filter((id) => included.has(id));
  return {
    records,
    partial: true,
    candidateWindowsTruncated: pages.some((page) => page.hasMore),
    omittedMatches: candidates.filter(({ record }) => !included.has(record.id)).length,
  };
}
