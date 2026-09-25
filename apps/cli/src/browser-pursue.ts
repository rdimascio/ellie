import { identifier, record, result, string } from "@ellie/protocol";
import type { Result } from "@ellie/protocol";

const PER_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const READ_VIEW = "summary";
const USAGE =
  'Use: bun run ellie browser pursue --node ID --max-steps N --allow-page-content "goal" (N is 1-8, no default)';

class PursuitDeadlineExpired extends Error {}

export type PursueOutcome =
  | "satisfied_unverified"
  | "blocked"
  | "ambiguous"
  | "exhausted"
  | "no_change"
  | "cancelled"
  | "unavailable"
  | "shadow";
export interface PursueStep {
  index: number;
  revision: string;
  url: string;
  title?: string;
  action: "select" | "scroll";
  itemId?: string;
  label?: string;
  direction?: "up" | "down";
  outcome: "unknown" | "proposed";
}
export interface PursueReport {
  outcome: PursueOutcome;
  dispatched: number;
  steps: PursueStep[];
  lines: string[];
}
export interface PursueClient {
  call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<unknown>;
}
export interface PursueOptions {
  nodeId: string;
  goal: string;
  maxSteps: number;
  signal: AbortSignal;
  totalTimeoutMs?: number;
  now?: () => number;
  onDispatch?(): void;
  onSettle?(): void;
}

type StepDecision =
  | { kind: "select"; itemId: string; label: string; probability: number; margin: number }
  | { kind: "scroll"; direction: "up" | "down"; probability: number; margin: number }
  | { kind: "satisfied" | "blocked" | "ambiguous"; message: string };

function unitInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("Invalid browser step decision.");
  return value;
}

function stepDecision(value: unknown): StepDecision {
  const v = record(value);
  if (v.kind === "select")
    return {
      kind: "select",
      itemId: identifier(v.itemId),
      label: string(v.label, 500),
      probability: unitInterval(v.probability),
      margin: unitInterval(v.margin),
    };
  if (v.kind === "scroll") {
    if (v.direction !== "up" && v.direction !== "down")
      throw new Error("Invalid browser step decision.");
    return {
      kind: "scroll",
      direction: v.direction,
      probability: unitInterval(v.probability),
      margin: unitInterval(v.margin),
    };
  }
  if (v.kind === "satisfied" || v.kind === "blocked" || v.kind === "ambiguous")
    return { kind: v.kind, message: string(v.message, 4000) };
  throw new Error("Invalid browser step decision.");
}

function stepResponse(value: unknown): {
  ok: boolean;
  mode: "shadow" | "execute";
  step: StepDecision;
} {
  const v = record(value);
  if (typeof v.ok !== "boolean" || (v.mode !== "shadow" && v.mode !== "execute"))
    throw new Error("Invalid browser step response.");
  return { ok: v.ok, mode: v.mode, step: stepDecision(v.step) };
}

/** Explicit bounds only; every invocation must state its own step count and content disclosure. */
export function parsePursueCommand(args: string[]): {
  nodeId?: string;
  goal: string;
  maxSteps: number;
} {
  let nodeId: string | undefined;
  let maxSteps: number | undefined;
  let allowPageContent = false;
  const words: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--node") {
      if (nodeId !== undefined) throw new Error("Use --node only once.");
      nodeId = identifier(args[++index]);
    } else if (arg === "--max-steps") {
      if (maxSteps !== undefined) throw new Error("Use --max-steps only once.");
      const raw = Number(args[++index]);
      if (!Number.isInteger(raw) || raw < 1 || raw > 8)
        throw new Error("--max-steps requires an explicit bounded integer from 1 to 8.");
      maxSteps = raw;
    } else if (arg === "--allow-page-content") {
      allowPageContent = true;
    } else if (arg?.startsWith("--")) {
      throw new Error(USAGE);
    } else {
      words.push(arg ?? "");
    }
  }
  if (maxSteps === undefined) throw new Error(USAGE);
  if (!allowPageContent)
    throw new Error(
      "--allow-page-content is required every invocation: the loop sends page titles, summaries, and item labels to the decision provider.",
    );
  const goal = string(words.join(" "), 300);
  return { nodeId, goal, maxSteps };
}

function signature(title: string | undefined, items: { label: string }[]): string {
  return JSON.stringify([title ?? null, items.map((item) => item.label).sort()]);
}

function actionDescription(step: PursueStep): string {
  return step.action === "select"
    ? `select "${step.label}" (item ${step.itemId})`
    : `scroll ${step.direction}`;
}

function ledgerLine(step: PursueStep): string {
  return `Step ${step.index + 1}: ${actionDescription(step)} at revision ${step.revision} -> outcome ${step.outcome}.`;
}

function finalLine(
  outcome: PursueOutcome,
  dispatched: number,
  attempted: number,
  url?: string,
): string {
  const at = url ? ` at ${url}` : "";
  if (outcome === "shadow")
    return `Shadow mode: ${dispatched} proposal(s) printed; nothing was dispatched.`;
  if (outcome === "satisfied_unverified" && dispatched === 0)
    return `The model judged the goal already satisfied${at}; this was not independently verified. Nothing was dispatched.`;
  const base = `${outcome} after ${attempted} step${attempted === 1 ? "" : "s"}${at}`;
  if (dispatched === 0) return `${base}; nothing was dispatched.`;
  return `${base}; ${dispatched} mutation${dispatched === 1 ? "" : "s"} dispatched with unknown outcome; read the page before doing anything else.`;
}

/** Never throws for a protocol-level refusal; every such case resolves to a report. Throws only on transport failure. */
export async function runBrowserPursuit(
  client: PursueClient,
  options: PursueOptions,
): Promise<PursueReport> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const lines: string[] = [];
  const steps: PursueStep[] = [];
  const dispatchedItems = new Set<string>();
  let dispatched = 0;
  let priorAtRevision: { revision: string; signature: string } | undefined;

  const requestTimeout = (): number => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) throw new PursuitDeadlineExpired();
    return Math.min(PER_REQUEST_TIMEOUT_MS, remaining);
  };
  const call = (action: unknown, timeoutMs = requestTimeout()): Promise<unknown> =>
    client.call(
      "POST",
      "/v1/commands",
      { nodeId: options.nodeId, action },
      { signal: options.signal, timeoutMs },
    );

  const finish = (
    outcome: PursueOutcome,
    attempted: number,
    observedUrl?: string,
  ): PursueReport => {
    lines.push(finalLine(outcome, dispatched, attempted, observedUrl));
    return { outcome, dispatched, steps, lines };
  };

  for (let stepIndex = 0; stepIndex < options.maxSteps; stepIndex++) {
    if (options.signal.aborted) return finish("cancelled", stepIndex);
    if (now() >= deadline) return finish("exhausted", stepIndex);

    let status: Result;
    try {
      status = result(await call({ tool: "browser.status" }));
    } catch (error) {
      return finish(
        error instanceof PursuitDeadlineExpired || now() >= deadline ? "exhausted" : "unavailable",
        stepIndex,
      );
    }
    if (!("browser" in status)) return finish("unavailable", stepIndex);
    if (status.browser.operation !== "status") return finish("unavailable", stepIndex);
    if (status.browser.status !== "connected") return finish("unavailable", stepIndex);
    const revision = status.browser.revision;
    const url = status.browser.origin;
    if (revision === undefined || url === undefined) return finish("unavailable", stepIndex);

    if (options.signal.aborted) return finish("cancelled", stepIndex, url);
    if (now() >= deadline) return finish("exhausted", stepIndex, url);
    let read: Result;
    try {
      read = result(await call({ tool: "browser.read", view: READ_VIEW, revision }));
    } catch (error) {
      return finish(
        error instanceof PursuitDeadlineExpired || now() >= deadline ? "exhausted" : "unavailable",
        stepIndex,
        url,
      );
    }
    if (!("browser" in read)) return finish("unavailable", stepIndex, url);
    if (read.browser.operation !== "read") return finish("unavailable", stepIndex, url);
    if (read.browser.status !== "completed") return finish("unavailable", stepIndex, url);
    const view = read.browser.view;
    const items = view.items.map((item) => ({ id: item.id, label: item.label }));
    const observation = {
      url,
      ...(view.title === undefined ? {} : { title: view.title }),
      ...(view.summary === undefined ? {} : { summary: view.summary }),
      items,
      scrollDirections: view.axScrollDirections ?? [],
    };
    const sig = signature(view.title, items);
    if (
      priorAtRevision &&
      priorAtRevision.revision === revision &&
      priorAtRevision.signature === sig
    )
      return finish("no_change", stepIndex, url);
    priorAtRevision = { revision, signature: sig };

    if (options.signal.aborted) return finish("cancelled", stepIndex, url);
    if (now() >= deadline) return finish("exhausted", stepIndex, url);
    const alreadySelected = [...dispatchedItems]
      .filter((key) => key.startsWith(`${revision}:`))
      .map((key) => key.slice(revision.length + 1));
    let decision: { ok: boolean; mode: "shadow" | "execute"; step: StepDecision };
    try {
      decision = stepResponse(
        await client.call(
          "POST",
          "/v1/decisions/browser-step",
          {
            nodeId: options.nodeId,
            goal: options.goal,
            observation,
            position: { stepIndex, maxSteps: options.maxSteps, alreadySelected },
          },
          { signal: options.signal, timeoutMs: requestTimeout() },
        ),
      );
    } catch (error) {
      return finish(
        error instanceof PursuitDeadlineExpired || now() >= deadline ? "exhausted" : "unavailable",
        stepIndex,
        url,
      );
    }

    const step = decision.step;
    if (decision.mode === "shadow") {
      if (step.kind === "select" || step.kind === "scroll") {
        const proposed: PursueStep = {
          index: stepIndex,
          revision,
          url,
          ...(view.title === undefined ? {} : { title: view.title }),
          action: step.kind,
          ...(step.kind === "select"
            ? { itemId: step.itemId, label: step.label }
            : { direction: step.direction }),
          outcome: "proposed",
        };
        steps.push(proposed);
        lines.push(
          `Step ${stepIndex + 1}: would ${actionDescription(proposed)} (shadow mode; not dispatched).`,
        );
      }
      return finish("shadow", stepIndex + 1, url);
    }

    if (step.kind !== "select" && step.kind !== "scroll") {
      const outcome =
        step.kind === "satisfied"
          ? "satisfied_unverified"
          : step.kind === "blocked"
            ? "blocked"
            : "ambiguous";
      return finish(outcome, stepIndex + 1, url);
    }

    const repeatKey = step.kind === "select" ? `${revision}:${step.itemId}` : undefined;
    if (repeatKey && dispatchedItems.has(repeatKey)) return finish("ambiguous", stepIndex + 1, url);

    if (options.signal.aborted) return finish("cancelled", stepIndex, url);
    let dispatchTimeoutMs: number;
    try {
      dispatchTimeoutMs = requestTimeout();
    } catch {
      return finish("exhausted", stepIndex, url);
    }
    const action =
      step.kind === "select"
        ? { tool: "browser.select", itemId: step.itemId, revision }
        : { tool: "browser.scroll", direction: step.direction, revision };
    options.onDispatch?.();
    let dispatchRaw: unknown;
    let transportFailed = false;
    try {
      dispatchRaw = await call(action, dispatchTimeoutMs);
    } catch {
      transportFailed = true;
    }
    options.onSettle?.();
    dispatched++;
    const dispatchedStep: PursueStep = {
      index: stepIndex,
      revision,
      url,
      ...(view.title === undefined ? {} : { title: view.title }),
      action: step.kind,
      ...(step.kind === "select"
        ? { itemId: step.itemId, label: step.label }
        : { direction: step.direction }),
      outcome: "unknown",
    };
    steps.push(dispatchedStep);
    lines.push(ledgerLine(dispatchedStep));
    if (repeatKey) dispatchedItems.add(repeatKey);
    if (transportFailed) return finish("unavailable", stepIndex + 1, url);

    let dispatchResult: Result;
    try {
      dispatchResult = result(dispatchRaw);
    } catch {
      return finish("unavailable", stepIndex + 1, url);
    }
    // Fails closed: any shape other than a real dispatched-command outcome stops the loop
    // without a retry, since the actual physical effect of the click may still be unknown.
    if (!("browser" in dispatchResult) || dispatchResult.browser.operation !== "command")
      return finish("unavailable", stepIndex + 1, url);
  }
  return finish("exhausted", options.maxSteps);
}
