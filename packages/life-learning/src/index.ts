import { LifeAccessError, LifeStore } from "../../life-core/src/index.ts";
import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";
export * from "./improvement.ts";

export interface FeedbackExample {
  prompt: string;
  response: string;
  preferredResponse?: string;
}
export interface LearningFeedback {
  scope: LifeScope;
  message: string;
  rating?: -1 | 0 | 1;
  example?: FeedbackExample;
  trainingEligible?: boolean;
  relatedRecordId?: string;
}
const MARKER = "learning-feedback-v1";
function bounded(value: unknown, name: string, max = 8_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new TypeError(`${name} must contain 1 through ${max} characters.`);
  return value.trim();
}
function sample(value: FeedbackExample): FeedbackExample {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("A feedback example must be an object.");
  return {
    prompt: bounded(value.prompt, "Example prompt"),
    response: bounded(value.response, "Example response", 16_000),
    ...(value.preferredResponse === undefined
      ? {}
      : { preferredResponse: bounded(value.preferredResponse, "Preferred response", 16_000) }),
  };
}

/** Explicit feedback is evidence for evaluation. It never grants permission or changes model weights. */
export class LifeLearning {
  private readonly store: LifeStore;
  constructor(store: LifeStore) {
    this.store = store;
  }

  record(actor: LifeActor, input: LearningFeedback): LifeRecord {
    const message = bounded(input.message, "Feedback"),
      example = input.example === undefined ? undefined : sample(input.example);
    if (input.rating !== undefined && ![-1, 0, 1].includes(input.rating))
      throw new TypeError("Rating must be -1, 0, or 1.");
    if (input.trainingEligible !== undefined && typeof input.trainingEligible !== "boolean")
      throw new TypeError("Training selection must be a boolean.");
    if (input.trainingEligible && (!example || input.scope.type !== "user"))
      throw new TypeError("Only a personal feedback example can be selected for export.");
    let related: LifeRecord | undefined;
    if (input.relatedRecordId !== undefined) {
      related = this.store.getRecord(actor, input.relatedRecordId);
      if (
        !related ||
        related.scope.type !== input.scope.type ||
        related.scope.id !== input.scope.id
      )
        throw new LifeAccessError("Feedback target is unavailable in this space.");
    }
    return this.store.createRecord(actor, {
      kind: "feedback",
      scope: input.scope,
      title:
        input.rating === 1
          ? "Helpful response"
          : input.rating === -1
            ? "Response to improve"
            : "Feedback",
      body: message,
      data: {
        type: MARKER,
        authorId: actor.userId,
        rating: input.rating ?? null,
        trainingEligible: input.trainingEligible === true,
        ...(example ? { example } : {}),
      },
      ...(related ? { relationships: [{ type: "feedback-for", targetId: related.id }] } : {}),
    });
  }

  list(
    actor: LifeActor,
    scope: LifeScope,
  ): { records: LifeRecord[]; windowLimit: number; hasMore: boolean } {
    const records = this.store.listRecords(actor, { scope, kinds: ["feedback"], limit: 500 });
    return {
      records: records.filter((record) => record.data.type === MARKER),
      windowLimit: 500,
      hasMore: records.length === 500,
    };
  }

  selectForExport(
    actor: LifeActor,
    id: string,
    expectedRevision: number,
    selected: boolean,
  ): LifeRecord {
    const record = this.personalExample(actor, id);
    if (typeof selected !== "boolean") throw new TypeError("Export selection must be a boolean.");
    return this.store.updateRecord(actor, id, expectedRevision, {
      data: { ...record.data, trainingEligible: selected },
    });
  }

  exportExamples(
    actor: LifeActor,
    ids: string[],
  ): { format: "ellie-feedback-v1"; count: number; jsonl: string } {
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length
    )
      throw new TypeError("Select 1 through 100 distinct personal feedback examples.");
    // Validate every selected example before returning any data. No group corpus or automatic collection.
    const rows = ids.map((id) => {
      const record = this.personalExample(actor, id);
      if (record.data.trainingEligible !== true)
        throw new LifeAccessError("This example is not selected for export.");
      const example = sample(record.data.example as unknown as FeedbackExample);
      return {
        schema: "ellie-feedback-v1",
        feedbackId: record.id,
        createdAt: record.createdAt,
        input: example.prompt,
        output: example.response,
        ...(example.preferredResponse ? { preferredOutput: example.preferredResponse } : {}),
        rating: record.data.rating,
        correction: record.body,
      };
    });
    return {
      format: "ellie-feedback-v1",
      count: rows.length,
      jsonl: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    };
  }

  private personalExample(actor: LifeActor, id: string): LifeRecord {
    const record = this.store.getRecord(actor, id);
    if (
      !record ||
      record.kind !== "feedback" ||
      record.data.type !== MARKER ||
      record.scope.type !== "user" ||
      record.scope.id !== actor.userId ||
      record.data.authorId !== actor.userId ||
      !record.data.example
    )
      throw new LifeAccessError("Personal feedback example unavailable.");
    return record;
  }
}
