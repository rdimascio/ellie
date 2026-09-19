import { action, LAYOUTS, MONITORS } from "@ellie/protocol";
import type { Context, Layout, Monitor, Plan } from "@ellie/protocol";
import { browserForSite, siteAliasForUrl } from "@ellie/config/defaults";
import type { Preferences } from "@ellie/config/defaults";
import { validateDecisionResponse } from "@ellie/decisions";
import type { DecisionProvider, DecisionQuestion, DecisionResponse } from "@ellie/decisions";

export type DesktopDecision =
  | { kind: "plan"; plan: Plan; probability: number; margin: number; response: DecisionResponse }
  | { kind: "clarify" | "unsupported"; message: string; response?: DecisionResponse };

export interface DesktopQuestionSet {
  state: { input: string; lastApp: string | null };
  questions: Record<string, DecisionQuestion>;
}

const UNKNOWN = "unknown";
const NONE = "none";
const MAX_CHOICES = 255;
const OPERATION = ["app.open", "url.open", "window.place", "window.adjacent"] as const;
const CLARIFY = "Please specify one supported desktop action and its target.";
const UNSUPPORTED = "That request needs an unsupported or multi-step action.";

function choice(instructions: string, entries: [string, string][]): DecisionQuestion {
  return {
    type: "choice",
    instructions,
    criteria: Object.fromEntries([
      [UNKNOWN, "The request is unclear or cannot be resolved."],
      [NONE, "No value from this category is requested."],
      ...entries,
    ]),
  };
}

function allowedApps(prefs: Preferences): string[] {
  return [...new Set([...Object.values(prefs.apps), prefs.browser])].filter((app) =>
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(app),
  );
}

function candidates(values: string[], prefix: string): Map<string, string> {
  return new Map(values.map((value, index) => [`${prefix}_${index}`, value]));
}

function appCandidates(context: Context, prefs: Preferences): Map<string, string> {
  const apps = allowedApps(prefs);
  if (context.lastApp && apps.includes(context.lastApp)) {
    apps.splice(apps.indexOf(context.lastApp), 1);
    apps.unshift(context.lastApp);
  }
  return candidates(apps.slice(0, MAX_CHOICES - 2), "app");
}

function siteCandidates(prefs: Preferences): Map<string, string> {
  const valid = Object.values(prefs.sites).filter((url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  });
  return candidates([...new Set(valid)].slice(0, MAX_CHOICES - 2), "site");
}

function namesFor(value: string, aliases: Record<string, string>): string {
  return Object.entries(aliases)
    .filter(([, item]) => item === value)
    .map(([alias]) => alias)
    .join(", ");
}

/** All model choices are bounded IDs. The original input is data, never a source of action fields. */
export function buildDesktopQuestions(
  input: string,
  context: Context,
  prefs: Preferences,
): DesktopQuestionSet {
  const apps = appCandidates(context, prefs);
  const sites = siteCandidates(prefs);
  const appEntries = [...apps].map(([id, value]): [string, string] => [
    id,
    `Application ${namesFor(value, prefs.apps) || value}${context.lastApp === value ? "; previous application (it/that)" : ""}`,
  ]);
  return {
    state: {
      input,
      lastApp: context.lastApp && appsHasValue(apps, context.lastApp) ? context.lastApp : null,
    },
    questions: {
      request: choice(
        "Classify the user's own intent. Supported actions are opening one configured app, opening one configured site, placing one app window in a fixed layout or on a monitor, and placing one app beside another. Choose single only for one explicit direct desktop action. A quoted, negated, hypothetical, or informational mention is not a direct request. Multiple separate actions are multi.",
        [
          ["single", "One explicit direct action supported by the listed operation types."],
          ["multi", "Multiple distinct actions or a sequence."],
          [
            "ambiguous",
            "An action is requested but the intended target or operation is ambiguous.",
          ],
          ["not_request", "No direct desktop action is requested."],
          ["unsupported", "An action is requested outside the supported operation types."],
        ],
      ),
      operation: choice(
        "Select exactly one supported operation requested by the user. A monitor move combined with a layout is one window.place operation; opening then placing is two actions.",
        OPERATION.map((id) => [id, id]),
      ),
      app: choice(
        "Select the requested application target. Use previous application only when the user refers to it and lastApp is available. Never substitute an allowed app for an unlisted one.",
        appEntries,
      ),
      site: choice(
        "Select the requested configured website; never substitute a listed site for an unlisted site.",
        [...sites].map(([id, url]): [string, string] => [
          id,
          `Website ${namesFor(url, prefs.sites) || url}`,
        ]),
      ),
      layout: choice(
        "Select the requested window layout. Keep fullscreen distinct from maximize. Select none if no layout is requested.",
        LAYOUTS.map((id) => [id, id]),
      ),
      monitor: choice(
        "Select the requested monitor. Current means no other monitor was specified; largest means the biggest display; primary means main display.",
        MONITORS.map((id) => [id, id]),
      ),
      anchor: choice(
        "For an adjacent placement, select the other application next to the target. Resolve it/that only from the available previous application.",
        appEntries,
      ),
    },
  };
}

function appsHasValue(apps: Map<string, string>, value: string): boolean {
  return [...apps.values()].includes(value);
}

function obviousRejection(
  input: string,
  prefs: Preferences,
): "clarify" | "unsupported" | undefined {
  if (!input.trim() || input.length > 4000) return "clarify";
  // These are narrow early rejections. They do not establish semantic correctness.
  if (/[;&`\n\r]|\|\||[“”"]/u.test(input) || /(^|[\s(])'[^']+'(?=$|[\s).!?])/u.test(input))
    return "unsupported";
  if (/\b(?:don['’]t|do not|never|not|without|instead of)\b/i.test(input)) return "unsupported";
  if (/\b(?:then|after that|also|plus)\b/i.test(input)) return "unsupported";
  if (
    /\band\b/i.test(input) &&
    !/\b(?:monitor|screen)\b.*\b(?:fullscreen|full screen|maximized|maximize)\b/i.test(input)
  )
    return "unsupported";
  // A bare named target can be checked without asking the model to infer a substitute.
  const namedOpen =
    /^(?:ellie[,!]?\s+)?(?:please\s+)?(?:open|launch|start|visit|bring up)\s+(?:app\s+)?([a-z0-9 -]+?)[.!?]?$/i.exec(
      input.trim(),
    );
  if (namedOpen) {
    const named = namedOpen[1]!
      .toLowerCase()
      .replace(/\s+(?:please|again|now|for me)$/, "")
      .replace(/^(?:the|my|that|this) /, "")
      .replace(/ (?:app|window|website|site)$/, "");
    const explicitlyApp =
      /\b(?:open|launch|start)\s+app\s+/i.test(input) || /\s+app[.!?]?$/i.test(input);
    const explicitlySite = /\bvisit\s+/i.test(input) || /\s+(?:website|site)[.!?]?$/i.test(input);
    if (
      (explicitlyApp && !Object.hasOwn(prefs.apps, named)) ||
      (explicitlySite && !Object.hasOwn(prefs.sites, named)) ||
      (/^[a-z0-9-]+$/.test(named) &&
        named !== "browser" &&
        !Object.hasOwn(prefs.apps, named) &&
        !Object.hasOwn(prefs.sites, named))
    )
      return "unsupported";
  }
  return undefined;
}

function referenceBindings(
  input: string,
  prefs: Preferences,
): {
  target: boolean;
  anchor: boolean;
  localApp?: string;
} {
  const reference = "(?:it|that(?: app| window)?|this(?: app| window)?|the window)";
  const end = "(?=\\s+(?:to|in|on|next|beside|fullscreen|full screen|maximized)|\\s*[.!?]?$)";
  const target = new RegExp(
    `\\b(?:put|move|make|maximize|open|launch|start|visit|place|tile)\\s+${reference}${end}`,
    "i",
  ).test(input);
  const anchor = new RegExp(`\\bnext to\\s+${reference}${end}`, "i").test(input);
  let localApp: string | undefined;
  if (target && /\b(?:monitor|screen)\b.*\band\s+(?:make|put)\s+it\b/i.test(input)) {
    const beforePronoun = input.split(/\band\s+(?:make|put)\s+it\b/i)[0] ?? "";
    const mentioned = new Set<string>();
    for (const [alias, app] of Object.entries(prefs.apps)) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(beforePronoun))
        mentioned.add(app);
    }
    if (mentioned.size === 1) localApp = [...mentioned][0];
  }
  return { target, anchor, ...(localApp ? { localApp } : {}) };
}

function selected(response: DecisionResponse, key: string): string {
  const answer = response.answers[key];
  if (!answer || answer.type !== "choice") throw new Error("Invalid desktop decision response.");
  return answer.choice;
}

function gate(
  response: DecisionResponse,
  keys: string[],
  minProbability: number,
  minMargin: number,
): { probability: number; margin: number } | undefined {
  let probability = 1;
  let margin = 1;
  for (const key of keys) {
    const answer = response.answers[key];
    if (!answer || answer.type !== "choice") return undefined;
    const p = answer.probabilities[answer.choice];
    if (p === undefined) return undefined;
    const runner = Math.max(
      0,
      ...Object.entries(answer.probabilities)
        .filter(([id]) => id !== answer.choice)
        .map(([, value]) => value),
    );
    probability = Math.min(probability, p);
    margin = Math.min(margin, p - runner);
  }
  return probability >= minProbability && margin >= minMargin ? { probability, margin } : undefined;
}

/** Propose at most one protocol action. The caller still authorizes it against node capabilities. */
export async function decideDesktop(
  input: string,
  context: Context,
  prefs: Preferences,
  provider: DecisionProvider,
  options: { signal: AbortSignal; minProbability?: number; minMargin?: number },
): Promise<DesktopDecision> {
  const early = obviousRejection(input, prefs);
  if (early) return { kind: early, message: early === "clarify" ? CLARIFY : UNSUPPORTED };
  if (options.signal.aborted) throw new Error("Desktop decision cancelled.");
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
    throw new Error("Invalid desktop decision threshold.");
  const request = buildDesktopQuestions(input, context, prefs);
  const priorApp = request.state.lastApp;
  const references = referenceBindings(input, prefs);
  if ((references.target && !references.localApp && !priorApp) || (references.anchor && !priorApp))
    return { kind: "clarify", message: CLARIFY };
  const response = validateDecisionResponse(
    request.questions,
    await provider.evaluate({ ...request, signal: options.signal }),
  );
  if (options.signal.aborted) throw new Error("Desktop decision cancelled.");
  if (!gate(response, ["request"], minProbability, minMargin))
    return { kind: "clarify", message: CLARIFY, response };
  const status = selected(response, "request");
  if (status === "multi" || status === "unsupported" || status === "not_request")
    return { kind: "unsupported", message: UNSUPPORTED, response };
  if (status !== "single") return { kind: "clarify", message: CLARIFY, response };
  if (!gate(response, ["operation"], minProbability, minMargin))
    return { kind: "clarify", message: CLARIFY, response };
  const operation = selected(response, "operation");
  const needed =
    operation === "app.open"
      ? ["app"]
      : operation === "url.open"
        ? ["site"]
        : operation === "window.place"
          ? ["app", "layout", "monitor"]
          : operation === "window.adjacent"
            ? ["app", "anchor"]
            : [];
  if (!needed.length || needed.some((key) => [UNKNOWN, NONE].includes(selected(response, key))))
    return { kind: "clarify", message: CLARIFY, response };
  const confidence = gate(response, ["request", "operation", ...needed], minProbability, minMargin);
  if (!confidence) return { kind: "clarify", message: CLARIFY, response };
  const apps = appCandidates(context, prefs);
  const sites = siteCandidates(prefs);
  const app = apps.get(selected(response, "app"));
  const site = sites.get(selected(response, "site"));
  const anchor = apps.get(selected(response, "anchor"));
  if (
    (references.target && app !== (references.localApp ?? priorApp)) ||
    (references.anchor && anchor !== priorApp)
  )
    return { kind: "clarify", message: CLARIFY, response };
  let plan: Plan | undefined;
  if (operation === "app.open" && app)
    plan = { actions: [action({ tool: "app.open", app })], nextContext: { lastApp: app } };
  else if (operation === "url.open" && site) {
    const browser = browserForSite(siteAliasForUrl(site, prefs), prefs);
    plan = {
      actions: [action({ tool: "url.open", app: browser, url: site })],
      nextContext: { lastApp: browser },
    };
  } else if (
    operation === "window.place" &&
    app &&
    LAYOUTS.includes(selected(response, "layout") as Layout) &&
    MONITORS.includes(selected(response, "monitor") as Monitor)
  )
    plan = {
      actions: [
        action({
          tool: "window.place",
          app,
          layout: selected(response, "layout"),
          monitor: selected(response, "monitor"),
        }),
      ],
      nextContext: { lastApp: app },
    };
  else if (operation === "window.adjacent" && app) {
    if (anchor && anchor !== app)
      plan = {
        actions: [action({ tool: "window.adjacent", app, anchor })],
        nextContext: { lastApp: app },
      };
  }
  if (!plan) return { kind: "clarify", message: CLARIFY, response };
  return { kind: "plan", plan, ...confidence, response };
}
