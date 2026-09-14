import { LifeAccessError, LifeConflictError, LifeStore } from "../../life-core/src/index.ts";
import type { LifeActor, LifeRecord } from "../../life-core/src/index.ts";
import { LifeTeaching } from "../../life-teaching/src/index.ts";

const TYPE = "learning-improvement-v1";
const FEEDBACK_TYPE = "learning-feedback-v1";
const DEFAULT_TIMEOUT_MS = 90_000;

export interface ImprovementFeedbackRef {
  id: string;
  revision: number;
}
export interface ImprovementPreview {
  feedbackId: string;
  prompt: string;
  recordedResponse: string;
  preferredResponse?: string;
  candidateResponse: string;
}
export interface ImprovementProposal {
  record: LifeRecord;
  status: "ready" | "adopted" | "dismissed" | "stale";
  instructions: string;
  rationale: string;
  feedback: ImprovementFeedbackRef[];
  previews: ImprovementPreview[];
  guideId?: string;
}
export type LifeImprovementErrorCode =
  | "invalid_input"
  | "unavailable"
  | "model_unavailable"
  | "busy"
  | "capacity"
  | "timeout"
  | "cancelled"
  | "invalid_candidate"
  | "model_transport"
  | "stale"
  | "context_changed";

export class LifeImprovementError extends Error {
  readonly code: LifeImprovementErrorCode;
  constructor(code: LifeImprovementErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LifeImprovementError";
    this.code = code;
  }
}

type FeedbackExample = {
  feedbackId: string;
  prompt: string;
  response: string;
  correction: string;
  preferredResponse?: string;
};
type ImprovementCandidate = { title: string; instructions: string; rationale: string };
export interface ImprovementModel {
  suggestImprovement?: (
    request: { examples: FeedbackExample[]; goal?: string },
    signal?: AbortSignal,
  ) => Promise<ImprovementCandidate>;
  previewImprovement?: (
    request: { example: FeedbackExample; instructions: string },
    signal?: AbortSignal,
  ) => Promise<{ reply: string }>;
}

function bounded(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new LifeImprovementError(
      "invalid_input",
      `${name} must contain 1 through ${limit} characters.`,
    );
  return value.trim();
}
function refs(value: unknown): ImprovementFeedbackRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3)
    throw new LifeAccessError("Improvement proposal unavailable.");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new LifeAccessError("Improvement proposal unavailable.");
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !Number.isSafeInteger(row.revision) ||
      Number(row.revision) < 1
    )
      throw new LifeAccessError("Improvement proposal unavailable.");
    return { id: row.id, revision: Number(row.revision) };
  });
}
function modelFailure(error: unknown): LifeImprovementError | undefined {
  if (
    !error ||
    typeof error !== "object" ||
    (error as { name?: unknown }).name !== "LifeModelImprovementError"
  )
    return;
  const code = (error as { code?: unknown }).code;
  if (code === "timeout")
    return new LifeImprovementError("timeout", "Improvement review timed out.", { cause: error });
  if (code === "cancelled")
    return new LifeImprovementError("cancelled", "Improvement review was cancelled.", {
      cause: error,
    });
  if (code === "transport")
    return new LifeImprovementError(
      "model_transport",
      "The local model is unavailable for improvement review.",
      { cause: error },
    );
  if (code === "invalid_input")
    return new LifeImprovementError(
      "invalid_input",
      "The selected feedback could not be reviewed safely.",
      { cause: error },
    );
  if (code === "invalid_response")
    return new LifeImprovementError(
      "invalid_candidate",
      "The local model did not return a valid improvement candidate.",
      { cause: error },
    );
}

/** Private reviewed-example loop. It changes no guidance until explicit adoption. */
export class LifeImprovementEngine {
  private readonly store: LifeStore;
  private readonly teaching: LifeTeaching;
  private readonly model?: ImprovementModel;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly activeOperations = new Set<Promise<unknown>>();

  constructor(options: {
    store: LifeStore;
    teaching: LifeTeaching;
    model?: ImprovementModel;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.store = options.store;
    this.teaching = options.teaching;
    this.model = options.model;
    this.now = options.now ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new TypeError("Improvement timeout must be 1 through 120000 milliseconds.");
    this.timeoutMs = timeoutMs;
  }

  get modelAvailable(): boolean {
    return Boolean(this.model?.suggestImprovement && this.model.previewImprovement);
  }

  /** Waits for actual model callbacks, including noncooperative calls retained after timeout. */
  async settleActive(timeoutMs = 5_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000)
      throw new TypeError("Settle timeout must be 0 through 120000 milliseconds.");
    const active = [...this.activeOperations];
    if (!active.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = Promise.allSettled(active).then(() => true);
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const result = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    return result;
  }

  list(actor: LifeActor): ImprovementProposal[] {
    return this.proposalRecords(actor)
      .slice(0, 20)
      .flatMap((record) => {
        try {
          return [this.describe(actor, record)];
        } catch {
          return [];
        }
      });
  }

  private proposalRecords(actor: LifeActor): LifeRecord[] {
    return this.store.listImprovementRecords(actor, 21);
  }

  get(actor: LifeActor, id: string): ImprovementProposal {
    const record = this.store.getRecord(actor, id);
    if (!record) throw new LifeAccessError("Improvement proposal unavailable.");
    return this.describe(actor, record);
  }

  async propose(
    actor: LifeActor,
    input: {
      feedback: ImprovementFeedbackRef[];
      goal?: string;
      signal?: AbortSignal;
      isContextCurrent?: () => boolean;
    },
  ): Promise<ImprovementProposal> {
    if (!this.model?.suggestImprovement || !this.model.previewImprovement)
      throw new LifeImprovementError(
        "model_unavailable",
        "Improvement review needs the configured local model.",
      );
    if (
      !Array.isArray(input.feedback) ||
      input.feedback.length < 1 ||
      input.feedback.length > 3 ||
      new Set(input.feedback.map((item) => item.id)).size !== input.feedback.length
    )
      throw new LifeImprovementError(
        "invalid_input",
        "Choose 1 through 3 distinct feedback examples.",
      );
    const feedback = input.feedback.map((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      )
        throw new LifeImprovementError("invalid_input", "Feedback selection is invalid.");
      return { id: item.id, revision: item.revision };
    });
    const goal = input.goal === undefined ? undefined : bounded(input.goal, "Goal", 1_000);
    if (this.proposalRecords(actor).length >= 20)
      throw new LifeImprovementError(
        "capacity",
        "Keep at most 20 retained improvement proposals; delete one before proposing another.",
      );
    if (this.active >= 2)
      throw new LifeImprovementError("busy", "Two improvement reviews are already running.");
    const examples = this.loadExamples(actor, feedback);
    this.active += 1;
    const epoch = this.store.chatEpoch(actor);
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error("deadline")), this.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      const rejectAbort = () =>
        reject(
          new LifeImprovementError(
            input.signal?.aborted ? "cancelled" : "timeout",
            input.signal?.aborted
              ? "Improvement review was cancelled."
              : "Improvement review timed out.",
          ),
        );
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    const operation = (async () => {
      this.checkCurrent(actor, feedback, epoch, input, controller.signal);
      const candidate = await this.model!.suggestImprovement!(
        { examples, ...(goal ? { goal } : {}) },
        controller.signal,
      );
      this.checkCurrent(actor, feedback, epoch, input, controller.signal);
      const title = bounded(candidate.title, "Candidate title", 200),
        instructions = bounded(candidate.instructions, "Candidate instructions", 4_000),
        rationale = bounded(candidate.rationale, "Candidate rationale", 2_000),
        previews: Array<{ feedbackId: string; candidateResponse: string }> = [];
      for (const example of examples) {
        const preview = await this.model!.previewImprovement!(
          { example, instructions },
          controller.signal,
        );
        this.checkCurrent(actor, feedback, epoch, input, controller.signal);
        previews.push({
          feedbackId: example.feedbackId,
          candidateResponse: bounded(preview.reply, "Candidate response", 8_000),
        });
      }
      this.checkCurrent(actor, feedback, epoch, input, controller.signal);
      if (this.proposalRecords(actor).length >= 20)
        throw new LifeImprovementError(
          "capacity",
          "Keep at most 20 retained improvement proposals; delete one before proposing another.",
        );
      const record = this.store.createRecord(actor, {
        kind: "routine",
        scope: { type: "user", id: actor.userId },
        title,
        body: instructions,
        data: {
          type: TYPE,
          status: "ready",
          candidateInstructions: instructions,
          rationale,
          feedback,
          previews,
          createdEpoch: epoch,
        },
      });
      return this.describe(actor, record);
    })();
    this.activeOperations.add(operation);
    const cleanup = () => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      this.active -= 1;
      this.activeOperations.delete(operation);
    };
    void operation.then(cleanup, cleanup);
    try {
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (error instanceof LifeImprovementError) throw error;
      if (controller.signal.aborted)
        throw new LifeImprovementError(
          input.signal?.aborted ? "cancelled" : "timeout",
          input.signal?.aborted
            ? "Improvement review was cancelled."
            : "Improvement review timed out.",
          { cause: error },
        );
      const mapped = modelFailure(error);
      if (mapped) throw mapped;
      throw error;
    }
  }

  adopt(actor: LifeActor, id: string, expectedRevision: number): ImprovementProposal {
    const current = this.get(actor, id);
    if (current.status === "stale")
      throw new LifeImprovementError(
        "stale",
        "Selected feedback changed; create a new improvement proposal.",
      );
    if (current.status !== "ready")
      throw new LifeAccessError("Only a ready improvement can be adopted.");
    this.teaching.adoptImprovement(actor, id, expectedRevision);
    return this.get(actor, id);
  }

  dismiss(actor: LifeActor, id: string, expectedRevision: number): ImprovementProposal {
    const current = this.get(actor, id);
    if (current.record.revision !== expectedRevision)
      throw new LifeConflictError("Improvement proposal changed.");
    if (current.status === "adopted")
      throw new LifeAccessError("Adopted guidance can be paused or revised instead.");
    if (current.status === "dismissed") return current;
    const record = this.store.updateRecord(actor, id, expectedRevision, {
      data: { ...current.record.data, status: "dismissed", dismissedAt: this.now() },
    });
    return this.describe(actor, record);
  }

  private checkCurrent(
    actor: LifeActor,
    feedback: ImprovementFeedbackRef[],
    epoch: number,
    input: { isContextCurrent?: () => boolean },
    signal: AbortSignal,
  ): void {
    if (signal.aborted)
      throw new LifeImprovementError("cancelled", "Improvement review was cancelled.");
    if (this.store.chatEpoch(actor) !== epoch || input.isContextCurrent?.() === false)
      throw new LifeImprovementError(
        "context_changed",
        "Private context changed during improvement review; try again.",
      );
    this.loadExamples(actor, feedback);
  }

  private loadExamples(actor: LifeActor, selected: ImprovementFeedbackRef[]): FeedbackExample[] {
    return selected.map((reference) => {
      const record = this.store.getRecord(actor, reference.id);
      if (
        !record ||
        record.revision !== reference.revision ||
        record.kind !== "feedback" ||
        record.scope.type !== "user" ||
        record.scope.id !== actor.userId ||
        record.data.type !== FEEDBACK_TYPE ||
        record.data.authorId !== actor.userId ||
        !record.data.example ||
        typeof record.data.example !== "object" ||
        Array.isArray(record.data.example)
      )
        throw new LifeImprovementError("stale", "Selected feedback changed or is unavailable.");
      const example = record.data.example as Record<string, unknown>;
      return {
        feedbackId: record.id,
        prompt: bounded(example.prompt, "Example prompt", 8_000),
        response: bounded(example.response, "Recorded response", 16_000),
        correction: bounded(record.body, "Correction", 8_000),
        ...(example.preferredResponse === undefined
          ? {}
          : {
              preferredResponse: bounded(example.preferredResponse, "Preferred response", 16_000),
            }),
      };
    });
  }

  private describe(actor: LifeActor, record: LifeRecord): ImprovementProposal {
    if (
      record.kind !== "routine" ||
      record.scope.type !== "user" ||
      record.scope.id !== actor.userId
    )
      throw new LifeAccessError("Improvement proposal unavailable.");
    const adopted = record.data.type === "teaching-guide-v1";
    const data = (adopted ? record.data.improvementAudit : record.data) as
      | Record<string, unknown>
      | undefined;
    if (!data || data.type !== TYPE) throw new LifeAccessError("Improvement proposal unavailable.");
    const feedback = refs(data.feedback),
      rationale = bounded(data.rationale, "Candidate rationale", 2_000),
      candidateInstructions = bounded(data.candidateInstructions, "Candidate instructions", 4_000),
      instructions = adopted
        ? candidateInstructions
        : bounded(record.body, "Candidate instructions", 4_000);
    let stale = false;
    let examples: FeedbackExample[] = [];
    try {
      examples = this.loadExamples(actor, feedback);
    } catch {
      stale = true;
    }
    if (!adopted && record.body !== candidateInstructions) stale = true;
    const savedPreviews = Array.isArray(data.previews) ? data.previews : [];
    const previews = stale
      ? []
      : examples.map((example) => {
          const saved = savedPreviews.find(
            (item) =>
              item &&
              typeof item === "object" &&
              !Array.isArray(item) &&
              (item as Record<string, unknown>).feedbackId === example.feedbackId,
          ) as Record<string, unknown> | undefined;
          if (!saved) throw new LifeAccessError("Improvement proposal unavailable.");
          return {
            feedbackId: example.feedbackId,
            prompt: example.prompt,
            recordedResponse: example.response,
            ...(example.preferredResponse ? { preferredResponse: example.preferredResponse } : {}),
            candidateResponse: bounded(saved.candidateResponse, "Candidate response", 8_000),
          };
        });
    const savedStatus = data.status;
    return {
      record,
      status: adopted
        ? "adopted"
        : savedStatus === "dismissed"
          ? "dismissed"
          : stale
            ? "stale"
            : "ready",
      instructions,
      rationale,
      feedback,
      previews,
      ...(adopted ? { guideId: record.id } : {}),
    };
  }
}
