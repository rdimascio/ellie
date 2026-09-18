export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string }
  | { type: "score"; instructions: string; criteria: string[] };

export interface DecisionRequest {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal: AbortSignal;
}

export type DecisionAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number }
  | {
      type: "score";
      score: number;
      probabilities: Record<string, number>;
      confidence: number;
      legend: Record<string, string>;
    };

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: { inputTokens: number; outputTokens: number };
  rounding?: { probabilityDecimals?: number; scoreDecimals?: number };
  latencyMs: number;
}

export interface DecisionProvider {
  id: string;
  locality: "local" | "cloud";
  evaluate(request: DecisionRequest): Promise<DecisionResponse>;
}

export { TypeSafeDecisionProvider, LocalDecisionProvider } from "./providers.ts";
export { GatewayDecisionProvider } from "./gateway.ts";

function invalid(): never {
  throw new Error("Invalid decision response");
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) invalid();
  return value;
}

function keysMatch(actual: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(actual);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) invalid();
}

function distribution(
  value: unknown,
  expected: string[],
  probabilityDecimals?: number,
): Record<string, number> {
  const probabilities = record(value);
  keysMatch(probabilities, expected);
  const sum = Object.values(probabilities).reduce<number>(
    (total, probability) => total + finite(probability, 0, 1),
    0,
  );
  const roundingTolerance =
    probabilityDecimals === undefined
      ? 0.001
      : Math.min(0.02, expected.length * 0.5 * 10 ** -probabilityDecimals + 0.000001);
  if (Math.abs(sum - 1) > roundingTolerance) invalid();
  return probabilities as Record<string, number>;
}

function setAnswer(
  target: Record<string, DecisionAnswer>,
  id: string,
  answer: DecisionAnswer,
): void {
  Object.defineProperty(target, id, {
    value: answer,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Check the boundary shared by remote, local, and test decision providers. */
export function validateDecisionResponse(
  questions: Record<string, DecisionQuestion>,
  value: unknown,
): DecisionResponse {
  const response = record(value);
  if (typeof response.model !== "string" || !response.model.trim() || response.model.length > 200)
    invalid();
  let rounding: DecisionResponse["rounding"];
  if (response.rounding !== undefined) {
    const value = record(response.rounding);
    if (Object.keys(value).some((key) => key !== "probabilityDecimals" && key !== "scoreDecimals"))
      invalid();
    const probabilityDecimals = value.probabilityDecimals;
    const scoreDecimals = value.scoreDecimals;
    for (const decimals of [probabilityDecimals, scoreDecimals])
      if (
        decimals !== undefined &&
        (!Number.isInteger(decimals) || (decimals as number) < 2 || (decimals as number) > 15)
      )
        invalid();
    rounding = {
      ...(probabilityDecimals !== undefined
        ? { probabilityDecimals: probabilityDecimals as number }
        : {}),
      ...(scoreDecimals !== undefined ? { scoreDecimals: scoreDecimals as number } : {}),
    };
  }
  const answers = record(response.answers);
  keysMatch(answers, Object.keys(questions));
  const normalized: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    if (!question || typeof question !== "object") invalid();
    const answer = record(answers[id]);
    if (answer.type !== question.type) invalid();
    if (question.type === "noul") {
      setAnswer(normalized, id, { type: "noul", noul: finite(answer.noul, 0, 1) });
    } else if (question.type === "choice") {
      record(question.criteria);
      const probabilities = distribution(
        answer.probabilities,
        Object.keys(question.criteria),
        rounding?.probabilityDecimals,
      );
      const choice = answer.choice;
      if (typeof choice !== "string" || !Object.hasOwn(probabilities, choice)) invalid();
      const max = Math.max(...Object.values(probabilities));
      if (probabilities[choice] !== max) invalid();
      setAnswer(normalized, id, {
        type: "choice",
        choice,
        probabilities,
        confidence: finite(answer.confidence, 0, 1),
      });
    } else {
      if (
        question.type !== "score" ||
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2
      )
        invalid();
      const levels = question.criteria.map((_, index) => String(index));
      const probabilities = distribution(
        answer.probabilities,
        levels,
        rounding?.probabilityDecimals,
      );
      const legend = record(answer.legend);
      keysMatch(legend, levels);
      for (const [index, description] of question.criteria.entries())
        if (legend[String(index)] !== description) invalid();
      const score = finite(answer.score, 0, question.criteria.length - 1);
      const weighted = levels.reduce(
        (total, level) => total + Number(level) * probabilities[level]!,
        0,
      );
      const weightedTolerance = rounding
        ? Math.min(
            0.05,
            0.001 +
              levels.reduce(
                (total, level) =>
                  total +
                  Number(level) *
                    (rounding.probabilityDecimals === undefined
                      ? 0
                      : 0.5 * 10 ** -rounding.probabilityDecimals),
                0,
              ) +
              (rounding.scoreDecimals === undefined ? 0 : 0.5 * 10 ** -rounding.scoreDecimals),
          )
        : 0.05;
      if (Math.abs(score - weighted) > weightedTolerance) invalid();
      setAnswer(normalized, id, {
        type: "score",
        score,
        probabilities,
        confidence: finite(answer.confidence, 0, 1),
        legend: legend as Record<string, string>,
      });
    }
  }
  let usage: DecisionResponse["usage"];
  if (response.usage !== undefined) {
    const wireUsage = record(response.usage);
    const inputTokens = finite(wireUsage.inputTokens, 0, Number.MAX_SAFE_INTEGER);
    const outputTokens = finite(wireUsage.outputTokens, 0, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) invalid();
    usage = { inputTokens, outputTokens };
  }
  const latencyMs = finite(response.latencyMs, 0, Number.MAX_SAFE_INTEGER);
  return {
    model: response.model,
    answers: normalized,
    ...(usage ? { usage } : {}),
    ...(rounding ? { rounding } : {}),
    latencyMs,
  };
}
