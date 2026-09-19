import { validateDecisionResponse } from "@ellie/decisions";
import type { DecisionProvider, DecisionQuestion, DecisionResponse } from "@ellie/decisions";
import {
  decisionChoice as choice,
  decisionGate as gate,
  decisionSelected as selected,
} from "./decision.ts";

export const MAX_STEP_ITEMS = 32;
const UNKNOWN = "unknown";
const NONE = "none";
const MAX_GOAL_LENGTH = 300;
const MAX_LABEL_LENGTH = 160;
const AMBIGUOUS = "The model's judgment on this page did not clear the required confidence bound.";
const BLOCKED = "The model judged the stated goal unreachable from the current page.";
const BLOCKED_EMPTY =
  "The current page offers no selectable item and no available scroll direction.";
const SATISFIED = "The model judged the stated goal already satisfied by the current page.";

export interface BrowserStepItem {
  id: string;
  label: string;
}
export interface BrowserStepObservation {
  url: string;
  title?: string;
  summary?: string;
  items: BrowserStepItem[];
  scrollDirections: ("up" | "down")[];
}
export interface BrowserStepQuestionSet {
  state: {
    goal: string;
    url: string;
    title: string | null;
    summary: string | null;
    stepIndex: number;
    maxSteps: number;
    alreadySelected: string[];
  };
  questions: Record<string, DecisionQuestion>;
}
export type BrowserStepDecision =
  | {
      kind: "select";
      itemId: string;
      label: string;
      probability: number;
      margin: number;
      response: DecisionResponse;
    }
  | {
      kind: "scroll";
      direction: "up" | "down";
      probability: number;
      margin: number;
      response: DecisionResponse;
    }
  | { kind: "satisfied" | "blocked" | "ambiguous"; message: string; response?: DecisionResponse };

/** Control-char labels are dropped; long labels are truncated. Never dropped: it is data, not an id. */
function stepItemCandidates(items: BrowserStepItem[]): Map<string, BrowserStepItem> {
  const cleaned: BrowserStepItem[] = [];
  for (const item of items) {
    if (/\p{Cc}/u.test(item.label)) continue;
    cleaned.push({ id: item.id, label: item.label.slice(0, MAX_LABEL_LENGTH) });
    if (cleaned.length === MAX_STEP_ITEMS) break;
  }
  return new Map(cleaned.map((item, index) => [`item_${index}`, item]));
}

/** All model choices are bounded IDs. Page content is state data, never a source of action fields. */
export function buildBrowserStepQuestions(
  goal: string,
  observation: BrowserStepObservation,
  position: { stepIndex: number; maxSteps: number; alreadySelected: string[] },
): BrowserStepQuestionSet {
  const items = stepItemCandidates(observation.items);
  const hasDown = observation.scrollDirections.includes("down");
  const hasUp = observation.scrollDirections.includes("up");
  const stepEntries: [string, string][] = [
    ...[...items].map(([id, item]): [string, string] => [id, `Page item: ${item.label}`]),
    ...(hasDown
      ? ([["scroll_down", "Scroll the page down to reveal further items."]] as [string, string][])
      : []),
    ...(hasUp
      ? ([["scroll_up", "Scroll the page up to reveal earlier items."]] as [string, string][])
      : []),
    ["done", "The goal is already satisfied by the current page; no click or scroll is needed."],
    ["cannot", "No listed item or scroll direction can advance the stated goal."],
  ];
  return {
    state: {
      goal,
      url: observation.url,
      title: observation.title ?? null,
      summary: observation.summary ?? null,
      stepIndex: position.stepIndex,
      maxSteps: position.maxSteps,
      alreadySelected: position.alreadySelected,
    },
    questions: {
      progress: choice(
        "Judge the stated goal against the current page only: already satisfied, not yet satisfied but a listed item or scroll can help, or unreachable from this page by any listed action.",
        [
          ["satisfied", "The current page already satisfies the stated goal."],
          ["unsatisfied", "The goal is not yet satisfied; a listed item or scroll can advance it."],
          ["blocked", "The goal cannot be reached from this page by any listed action."],
        ],
      ),
      step: choice(
        "Select exactly one bounded action that advances the stated goal: one listed page item, one available scroll direction, done, or cannot.",
        stepEntries,
      ),
    },
  };
}

/** Mirror decideDesktop: early rejections before any provider call, then the shared confidence gate. */
export async function decideBrowserStep(
  goal: string,
  observation: BrowserStepObservation,
  provider: DecisionProvider,
  options: {
    signal: AbortSignal;
    stepIndex: number;
    maxSteps: number;
    alreadySelected?: string[];
    minProbability?: number;
    minMargin?: number;
  },
): Promise<BrowserStepDecision> {
  if (!goal.trim() || goal.length > MAX_GOAL_LENGTH || /\p{Cc}/u.test(goal))
    return { kind: "ambiguous", message: AMBIGUOUS };
  const items = stepItemCandidates(observation.items);
  if (items.size === 0 && observation.scrollDirections.length === 0)
    return { kind: "blocked", message: BLOCKED_EMPTY };
  if (options.signal.aborted) throw new Error("Browser step decision cancelled.");
  const minProbability = options.minProbability ?? 0.98;
  const minMargin = options.minMargin ?? 0.2;
  if (
    !Number.isFinite(minProbability) ||
    minProbability < 0 ||
    minProbability > 1 ||
    !Number.isFinite(minMargin) ||
    minMargin < 0 ||
    minMargin > 1
  )
    throw new Error("Invalid browser step decision threshold.");
  const alreadySelected = options.alreadySelected ?? [];
  const request = buildBrowserStepQuestions(goal, observation, {
    stepIndex: options.stepIndex,
    maxSteps: options.maxSteps,
    alreadySelected,
  });
  const response = validateDecisionResponse(
    request.questions,
    await provider.evaluate({ ...request, signal: options.signal }),
  );
  if (options.signal.aborted) throw new Error("Browser step decision cancelled.");
  if (!gate(response, ["progress"], minProbability, minMargin))
    return { kind: "ambiguous", message: AMBIGUOUS, response };
  const progress = selected(response, "progress");
  if (progress === "satisfied") return { kind: "satisfied", message: SATISFIED, response };
  if (progress === "blocked") return { kind: "blocked", message: BLOCKED, response };
  if (progress !== "unsatisfied") return { kind: "ambiguous", message: AMBIGUOUS, response };
  const confidence = gate(response, ["progress", "step"], minProbability, minMargin);
  if (!confidence) return { kind: "ambiguous", message: AMBIGUOUS, response };
  const step = selected(response, "step");
  if (step === UNKNOWN || step === NONE || step === "done" || step === "cannot")
    return { kind: "ambiguous", message: AMBIGUOUS, response };
  // scroll_down/scroll_up only ever appear as criteria when the direction was observed;
  // validateDecisionResponse already rejects any other choice against this question's criteria.
  if (step === "scroll_down" || step === "scroll_up")
    return {
      kind: "scroll",
      direction: step === "scroll_down" ? "down" : "up",
      ...confidence,
      response,
    };
  const item = items.get(step);
  if (!item) return { kind: "ambiguous", message: AMBIGUOUS, response };
  return { kind: "select", itemId: item.id, label: item.label, ...confidence, response };
}
