import { randomUUID } from "node:crypto";
import { LifeAccessError, LifeStore } from "../../life-core/src/index.ts";
import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";

export interface LifePlanStep {
  id: string;
  title: string;
  completed: boolean;
}
export interface LifePlan {
  record: LifeRecord;
  steps: LifePlanStep[];
  completedSteps: number;
  totalSteps: number;
  completed: boolean;
}
export interface LifePlanPage {
  plans: LifePlan[];
  hasMore: boolean;
  unavailableCount: number;
}
export class LifePlanError extends Error {
  readonly code: "not_found" | "ambiguous" | "capacity" | "invalid_plan";
  constructor(code: "not_found" | "ambiguous" | "capacity" | "invalid_plan", message: string) {
    super(message);
    this.code = code;
  }
}

const TYPE = "life-plan-v1";
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new TypeError(`${label} is invalid.`);
  return value.trim();
}
function storedText(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > limit)
    throw new LifePlanError("invalid_plan", "Plan data is invalid.");
  return value;
}
function steps(record: LifeRecord): LifePlanStep[] {
  const value = record.data.steps;
  if (record.kind !== "goal" || record.data.type !== TYPE || !Array.isArray(value))
    throw new LifePlanError("invalid_plan", "Plan data is invalid.");
  if (value.length < 1 || value.length > 24)
    throw new LifePlanError("invalid_plan", "Plan data is invalid.");
  const ids = new Set<string>();
  let characters = 0;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new LifePlanError("invalid_plan", "Plan data is invalid.");
    const item = entry as Record<string, unknown>,
      id = storedText(item.id, 200),
      title = storedText(item.title, 500);
    if (
      Object.keys(item).some((key) => !["id", "title", "completed"].includes(key)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id) ||
      typeof item.completed !== "boolean" ||
      ids.has(id)
    )
      throw new LifePlanError("invalid_plan", "Plan data is invalid.");
    ids.add(id);
    characters += title.length;
    if (characters > 8_000) throw new LifePlanError("invalid_plan", "Plan data is invalid.");
    return { id, title, completed: item.completed };
  });
}
export function planDetails(record: LifeRecord): LifePlan {
  storedText(record.title, 200);
  const items = steps(record),
    completedSteps = items.filter((item) => item.completed).length,
    completed = completedSteps === items.length;
  if (record.data.completed !== completed)
    throw new LifePlanError("invalid_plan", "Plan data is invalid.");
  return { record, steps: items, completedSteps, totalSteps: items.length, completed };
}

export class LifePlans {
  private readonly store: LifeStore;
  constructor(store: LifeStore) {
    this.store = store;
  }

  create(actor: LifeActor, input: { scope: LifeScope; title: string; steps: string[] }): LifePlan {
    const title = text(input.title, "plan title", 200);
    if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 24)
      throw new TypeError("A plan requires one through twenty-four steps.");
    let characters = 0;
    const items = input.steps.map((value) => {
      const stepTitle = text(value, "plan step", 500);
      characters += stepTitle.length;
      if (characters > 8_000) throw new TypeError("Plan step text exceeds 8000 characters.");
      return { id: randomUUID(), title: stepTitle, completed: false };
    });
    if (this.store.listPlanRecords(actor, { scope: input.scope, limit: 65 }).length >= 64)
      throw new LifePlanError("capacity", "This space may contain at most 64 plans.");
    return planDetails(
      this.store.createRecord(actor, {
        kind: "goal",
        title,
        scope: input.scope,
        data: { type: TYPE, steps: items, completed: false },
      }),
    );
  }

  get(actor: LifeActor, id: string): LifePlan {
    const record = this.store.getRecord(actor, id);
    if (!record) throw new LifeAccessError("Plan is unavailable.");
    return planDetails(record);
  }

  list(actor: LifeActor, input: { scope: LifeScope; limit?: number }): LifePlanPage {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw new TypeError("Plan limit is invalid.");
    const records = this.store.listPlanRecords(actor, { scope: input.scope, limit: 65 }),
      valid: LifePlan[] = [];
    let unavailableCount = 0;
    for (const record of records)
      try {
        valid.push(planDetails(record));
      } catch (error) {
        if (!(error instanceof LifePlanError) || error.code !== "invalid_plan") throw error;
        unavailableCount++;
      }
    return {
      plans: valid.slice(0, limit),
      hasMore: valid.length > limit,
      unavailableCount,
    };
  }

  find(actor: LifeActor, scope: LifeScope, titleInput: string): LifePlan {
    const title = text(titleInput, "plan title", 200),
      matches = this.store.findPlanRecordsByTitle(actor, scope, title);
    if (matches.length > 1)
      throw new LifePlanError("ambiguous", "More than one plan has that title.");
    if (!matches[0]) throw new LifePlanError("not_found", "Plan is unavailable.");
    return planDetails(matches[0]);
  }

  setStep(
    actor: LifeActor,
    input: { id: string; stepId: string; completed: boolean; expectedRevision: number },
  ): LifePlan {
    if (typeof input.completed !== "boolean") throw new TypeError("completed is invalid.");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new TypeError("expectedRevision is invalid.");
    const current = this.get(actor, input.id),
      stepId = text(input.stepId, "plan step id", 200),
      index = current.steps.findIndex((item) => item.id === stepId);
    if (index < 0) throw new LifeAccessError("Plan step is unavailable.");
    const updated = current.steps.map((item, itemIndex) =>
        itemIndex === index ? { ...item, completed: input.completed } : item,
      ),
      completed = updated.every((item) => item.completed);
    return planDetails(
      this.store.updateRecord(actor, current.record.id, input.expectedRevision, {
        data: { ...current.record.data, steps: updated, completed },
      }),
    );
  }
}
