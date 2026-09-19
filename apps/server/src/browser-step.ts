import type { IncomingMessage } from "node:http";
import { readJson } from "@ellie/transport";
import { record, string, identifier } from "@ellie/protocol";
import type { Capability } from "@ellie/protocol";
import { decideBrowserStep } from "@ellie/router/browser-decision";
import type { BrowserStepDecision, BrowserStepObservation } from "@ellie/router/browser-decision";
import type { DecisionRoutingOptions } from "./index.ts";

const PATH = "/v1/decisions/browser-step";
const MAX_BODY_BYTES = 16_384;
const MAX_ITEMS = 32;
const MAX_ALREADY_SELECTED = 32;

export interface BrowserStepResponse {
  status: number;
  body: unknown;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function subsetKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function stepObservation(value: unknown): BrowserStepObservation {
  const v = record(value);
  if (!subsetKeys(v, ["url", "items", "scrollDirections"], ["title", "summary"]))
    throw new Error("Invalid browser step observation.");
  const items = v.items;
  if (!Array.isArray(items) || items.length > MAX_ITEMS)
    throw new Error("Invalid browser step observation.");
  const scrollDirections = v.scrollDirections;
  if (
    !Array.isArray(scrollDirections) ||
    scrollDirections.length > 2 ||
    scrollDirections.some((direction) => direction !== "up" && direction !== "down") ||
    new Set(scrollDirections).size !== scrollDirections.length
  )
    throw new Error("Invalid browser step observation.");
  return {
    url: string(v.url, 2048),
    ...(v.title === undefined ? {} : { title: string(v.title, 500) }),
    ...(v.summary === undefined ? {} : { summary: string(v.summary, 2000) }),
    items: items.map((raw) => {
      const item = record(raw);
      if (!exactKeys(item, ["id", "label"])) throw new Error("Invalid browser step item.");
      return { id: identifier(item.id), label: string(item.label, 500) };
    }),
    scrollDirections: scrollDirections as ("up" | "down")[],
  };
}

function stepPosition(value: unknown): {
  stepIndex: number;
  maxSteps: number;
  alreadySelected: string[];
} {
  const v = record(value);
  if (!exactKeys(v, ["stepIndex", "maxSteps", "alreadySelected"]))
    throw new Error("Invalid browser step position.");
  const { stepIndex, maxSteps, alreadySelected } = v;
  if (!Number.isInteger(stepIndex) || (stepIndex as number) < 0 || (stepIndex as number) > 7)
    throw new Error("Invalid browser step position.");
  if (!Number.isInteger(maxSteps) || (maxSteps as number) < 1 || (maxSteps as number) > 8)
    throw new Error("Invalid browser step position.");
  if (!Array.isArray(alreadySelected) || alreadySelected.length > MAX_ALREADY_SELECTED)
    throw new Error("Invalid browser step position.");
  return {
    stepIndex: stepIndex as number,
    maxSteps: maxSteps as number,
    alreadySelected: alreadySelected.map((id) => identifier(id)),
  };
}

function strip(decision: BrowserStepDecision): Record<string, unknown> {
  const { response: _response, ...rest } = decision;
  return rest;
}

/**
 * Propose-only mirror of handleBrowserManagement: never creates a node job. The caller still
 * dispatches through the ordinary /v1/commands one-action contract, authorized independently.
 */
export async function handleBrowserStepDecision(
  request: IncomingMessage,
  path: string,
  identityRole: "controller" | "node",
  options: {
    routing?: DecisionRoutingOptions;
    node(id: string): { capabilities: readonly Capability[]; stale: boolean } | undefined;
    signal: AbortSignal;
  },
): Promise<BrowserStepResponse | undefined> {
  if (path !== PATH) return undefined;
  if (identityRole !== "controller")
    return { status: 403, body: { error: "Controller identity required." } };
  if (request.method !== "POST")
    return { status: 404, body: { error: "Browser step decision route not found." } };
  const routing = options.routing;
  if (!routing) return { status: 409, body: { error: "Decision routing is not configured." } };

  let nodeId: string;
  let goal: string;
  let observation: BrowserStepObservation;
  let position: { stepIndex: number; maxSteps: number; alreadySelected: string[] };
  try {
    const body = record(await readJson(request, MAX_BODY_BYTES));
    if (!exactKeys(body, ["nodeId", "goal", "observation", "position"]))
      throw new Error("Invalid browser step decision request.");
    nodeId = identifier(body.nodeId);
    goal = string(body.goal, 300);
    observation = stepObservation(body.observation);
    position = stepPosition(body.position);
  } catch {
    return { status: 400, body: { error: "Invalid browser step decision request." } };
  }

  const node = options.node(nodeId);
  if (!node) return { status: 404, body: { error: "Unknown node ID." } };
  if (node.stale)
    return { status: 409, body: { error: "Node is registered but offline or stale." } };
  if (!node.capabilities.includes("browser.control"))
    return { status: 409, body: { error: "Node has not granted browser.control." } };

  try {
    const decision = await decideBrowserStep(goal, observation, routing.provider, {
      signal: options.signal,
      stepIndex: position.stepIndex,
      maxSteps: position.maxSteps,
      alreadySelected: position.alreadySelected,
      minProbability: routing.minProbability,
      minMargin: routing.minMargin,
    });
    return { status: 200, body: { ok: true, mode: routing.mode, step: strip(decision) } };
  } catch (error) {
    return {
      status: 200,
      body: {
        ok: false,
        mode: routing.mode,
        step: {
          kind: "ambiguous",
          message: error instanceof Error ? error.message : "Browser step decision failed.",
        },
      },
    };
  }
}
