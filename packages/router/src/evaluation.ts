import { action } from "@ellie/protocol";
import type { Action, Context } from "@ellie/protocol";

export type ExpectedDecision = { kind: "plan"; actions: Action[] } | { kind: "abstain" };

export interface RoutingCase {
  id: string;
  category: string;
  input: string;
  context?: Context;
  split: "development" | "heldout";
  expected: ExpectedDecision;
  labelReason?: string;
}

export interface RoutingPrediction {
  kind: "plan" | "abstain";
  actions?: Action[];
  /** The grammar accepted this case without consulting the semantic provider. */
  grammarHit?: boolean;
  /** An attempted semantic decision failed and the caller safely abstained. */
  fallback?: boolean;
  /** The semantic decision path was entered after the grammar missed. */
  semanticAttempt?: boolean;
  latencyMs?: number;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** False when a provider request may have consumed tokens but returned no usage. */
  usageKnown?: boolean;
}

export type CaseOutcome =
  | "correct_plan"
  | "correct_abstain"
  | "wrong_plan"
  | "false_execution"
  | "missed_plan";

export interface CaseScore {
  id: string;
  category: string;
  split: RoutingCase["split"];
  outcome: CaseOutcome;
  correct: boolean;
  grammarHit: boolean;
  fallback: boolean;
  semanticAttempt: boolean;
  latencyMs: number;
  model?: string;
  usage?: RoutingPrediction["usage"];
  usageKnown: boolean;
}

export interface EvaluationSummary {
  schemaVersion: 1;
  dataset: string;
  split: "all" | RoutingCase["split"];
  model: string;
  observedModels: string[];
  thresholds?: { minProbability: number; minMargin: number };
  timeoutMs?: number;
  count: number;
  expectedPlans: number;
  expectedAbstentions: number;
  correctPlans: number;
  correctAbstentions: number;
  wrongPlans: number;
  falseExecutions: number;
  missedPlans: number;
  exactPlanAccuracy: number;
  abstainAccuracy: number;
  accuracy: number;
  coverage: number;
  grammarHitRate: number;
  semanticAttemptRate: number;
  fallbackRate: number;
  latencyMs: { p50: number; p95: number };
  usage: { inputTokens: number; outputTokens: number; reportedCases: number; complete: boolean };
  /** Cost is only reported when a caller explicitly supplies both rates. */
  estimatedCostUsd?: number;
  byCategory: Record<string, { count: number; correct: number; falseExecutions: number }>;
}

export interface EvaluationOptions {
  dataset: string;
  split?: "all" | RoutingCase["split"];
  model: string;
  thresholds?: { minProbability: number; minMargin: number };
  timeoutMs?: number;
  pricePerMillionInputTokensUsd?: number;
  pricePerMillionOutputTokensUsd?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid routing case object.");
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid routing case text.");
  return value;
}

/** Validate labels before running a benchmark; malformed labels must never inflate accuracy. */
export function parseRoutingCases(value: unknown): RoutingCase[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Empty routing dataset.");
  const seen = new Set<string>();
  return value.map((raw) => {
    const row = object(raw);
    const id = nonempty(row.id);
    if (seen.has(id)) throw new Error(`Duplicate routing case ID: ${id}`);
    seen.add(id);
    const category = nonempty(row.category);
    const input = nonempty(row.input);
    if (row.split !== "development" && row.split !== "heldout")
      throw new Error(`Invalid split for ${id}.`);
    let context: Context | undefined;
    if (row.context !== undefined) {
      const rawContext = object(row.context);
      if (
        Object.keys(rawContext).some((key) => key !== "lastApp") ||
        (rawContext.lastApp !== undefined && typeof rawContext.lastApp !== "string")
      )
        throw new Error(`Invalid context for ${id}.`);
      context = rawContext as Context;
    }
    const expected = object(row.expected);
    let label: ExpectedDecision;
    if (expected.kind === "abstain" && Object.keys(expected).length === 1) {
      label = { kind: "abstain" };
    } else if (
      expected.kind === "plan" &&
      Array.isArray(expected.actions) &&
      expected.actions.length > 0 &&
      expected.actions.length <= 4
    ) {
      const validated = expected.actions.map((candidate: unknown) => {
        const original = object(candidate);
        const normalized = action(candidate);
        if (Object.keys(original).length !== Object.keys(normalized).length)
          throw new Error(`Extra action field in ${id}.`);
        return normalized;
      });
      label = { kind: "plan", actions: validated };
    } else {
      throw new Error(`Invalid expected decision for ${id}.`);
    }
    if (row.labelReason !== undefined && typeof row.labelReason !== "string")
      throw new Error(`Invalid label reason for ${id}.`);
    return {
      id,
      category,
      input,
      split: row.split,
      expected: label,
      ...(context === undefined ? {} : { context }),
      ...(row.labelReason === undefined ? {} : { labelReason: row.labelReason }),
    };
  });
}

function equalActions(expected: Action[], actual: Action[] | undefined): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return expected.every((wanted, index) => {
    const got = actual[index];
    if (!got) return false;
    const keys = Object.keys(wanted).sort();
    return (
      keys.length === Object.keys(got).length &&
      keys.every(
        (key) => (wanted as Record<string, unknown>)[key] === (got as Record<string, unknown>)[key],
      )
    );
  });
}

export function scoreRoutingCase(row: RoutingCase, prediction: RoutingPrediction): CaseScore {
  if (prediction.kind === "plan" && (!prediction.actions || prediction.actions.length === 0))
    throw new Error(`Empty predicted plan for ${row.id}.`);
  if (prediction.kind === "abstain" && prediction.actions !== undefined)
    throw new Error(`Actions on abstention for ${row.id}.`);
  let outcome: CaseOutcome;
  if (row.expected.kind === "abstain")
    outcome = prediction.kind === "abstain" ? "correct_abstain" : "false_execution";
  else if (prediction.kind === "abstain") outcome = "missed_plan";
  else
    outcome = equalActions(row.expected.actions, prediction.actions)
      ? "correct_plan"
      : "wrong_plan";
  const latencyMs = prediction.latencyMs ?? 0;
  if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("Invalid latency.");
  return {
    id: row.id,
    category: row.category,
    split: row.split,
    outcome,
    correct: outcome === "correct_plan" || outcome === "correct_abstain",
    grammarHit: prediction.grammarHit ?? false,
    fallback: prediction.fallback ?? false,
    semanticAttempt: prediction.semanticAttempt ?? false,
    latencyMs,
    ...(prediction.model === undefined ? {} : { model: prediction.model }),
    ...(prediction.usage === undefined ? {} : { usage: prediction.usage }),
    usageKnown: prediction.usageKnown ?? true,
  };
}

function fraction(numerator: number, denominator: number): number {
  return denominator ? numerator / denominator : 0;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.ceil(sorted.length * p) - 1]!;
}

export function summarizeRoutingEvaluation(
  scores: CaseScore[],
  options: EvaluationOptions,
): EvaluationSummary {
  const count = scores.length;
  const tally = (outcome: CaseOutcome) =>
    scores.filter((score) => score.outcome === outcome).length;
  const correctPlans = tally("correct_plan");
  const correctAbstentions = tally("correct_abstain");
  const wrongPlans = tally("wrong_plan");
  const falseExecutions = tally("false_execution");
  const missedPlans = tally("missed_plan");
  const expectedPlans = correctPlans + wrongPlans + missedPlans;
  const expectedAbstentions = correctAbstentions + falseExecutions;
  const latency = scores.map((score) => score.latencyMs).sort((a, b) => a - b);
  const usage = scores.reduce(
    (sum, score) => ({
      inputTokens: sum.inputTokens + (score.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (score.usage?.outputTokens ?? 0),
      reportedCases: sum.reportedCases + Number(score.usage !== undefined),
      complete: sum.complete && score.usageKnown,
    }),
    { inputTokens: 0, outputTokens: 0, reportedCases: 0, complete: true },
  );
  const byCategory: EvaluationSummary["byCategory"] = {};
  for (const score of scores) {
    const category = (byCategory[score.category] ??= { count: 0, correct: 0, falseExecutions: 0 });
    category.count++;
    category.correct += Number(score.correct);
    category.falseExecutions += Number(score.outcome === "false_execution");
  }
  const inputRate = options.pricePerMillionInputTokensUsd;
  const outputRate = options.pricePerMillionOutputTokensUsd;
  if (
    (inputRate === undefined) !== (outputRate === undefined) ||
    (inputRate !== undefined && (!Number.isFinite(inputRate) || inputRate < 0)) ||
    (outputRate !== undefined && (!Number.isFinite(outputRate) || outputRate < 0))
  )
    throw new Error("Both nonnegative token prices are required for cost estimates.");
  return {
    schemaVersion: 1,
    dataset: options.dataset,
    split: options.split ?? "all",
    model: options.model,
    observedModels: [
      ...new Set(scores.flatMap((score) => (score.model ? [score.model] : []))),
    ].sort(),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    count,
    expectedPlans,
    expectedAbstentions,
    correctPlans,
    correctAbstentions,
    wrongPlans,
    falseExecutions,
    missedPlans,
    exactPlanAccuracy: fraction(correctPlans, expectedPlans),
    abstainAccuracy: fraction(correctAbstentions, expectedAbstentions),
    accuracy: fraction(correctPlans + correctAbstentions, count),
    coverage: fraction(correctPlans + wrongPlans + falseExecutions, count),
    grammarHitRate: fraction(scores.filter((score) => score.grammarHit).length, count),
    semanticAttemptRate: fraction(scores.filter((score) => score.semanticAttempt).length, count),
    fallbackRate: fraction(scores.filter((score) => score.fallback).length, count),
    latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) },
    usage,
    ...(inputRate === undefined || outputRate === undefined || !usage.complete
      ? {}
      : {
          estimatedCostUsd:
            (usage.inputTokens * inputRate + usage.outputTokens * outputRate) / 1_000_000,
        }),
    byCategory,
  };
}
