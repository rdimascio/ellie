import type { LifeIntent } from "./operations.ts";
import { planMessages } from "./model-context.ts";

export interface LifeModelRequest {
  message: string;
  evidence: Array<{
    sourceId: string;
    title: string;
    text: string;
    reference?: string;
  }>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  preferences?: Record<string, unknown>;
  memories?: Array<{ id: string; text: string; explicit: boolean }>;
  adoptedGuidance?: Array<{
    id: string;
    title: string;
    instructions: string;
    version: number;
  }>;
  tone?: {
    tone: "neutral" | "frustrated" | "urgent" | "positive";
    confidence: number;
    temporary: true;
  };
  now?: number;
  timeZone?: string;
}

export type LifeModelAction =
  | { type: "reply"; text: string }
  | { type: "search_sources"; query: string }
  | { type: "create_memory"; title: string; body: string }
  | { type: "life_operation"; intent: LifeIntent }
  | { type: "draft_life_operation"; intent: DraftLifeIntent };

// A draft may omit only the required temporal value. It is not executable and
// must never be passed to LifeOperations without a separately validated answer.
export type DraftLifeIntent =
  | { kind: "schedule_reminder"; title: string }
  | { kind: "create_event"; title: string; durationMinutes?: number };

export interface LifeModelPlan {
  reply: string;
  actions: LifeModelAction[];
}

export interface LifeModel {
  plan(request: LifeModelRequest, signal?: AbortSignal): Promise<LifeModelPlan>;
  build?(
    request: string | LifePluginBuildRequest,
    signal?: AbortSignal,
  ): Promise<{ name: string; description: string; html: string }>;
}

export interface LifePluginBuildRequest {
  request: string;
  previous: { name: string; description: string; html: string };
}

const bounded = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid model response.");
  return value.trim();
};
const row = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model action.");
  return value as Record<string, unknown>;
};
const keys = (value: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Invalid model action.");
};
const temporal = (value: unknown) => {
  const item = row(value);
  if (item.type === "instant") {
    keys(item, ["type", "at"]);
    if (!Number.isSafeInteger(item.at)) throw new Error("Invalid model action.");
    return;
  }
  keys(item, ["type", "date", "clock", "timeZone"]);
  if (item.type !== "local") throw new Error("Invalid model action.");
  const date = row(item.date),
    clock = row(item.clock);
  keys(date, ["year", "month", "day"]);
  keys(clock, ["hour", "minute"]);
  if (![date.year, date.month, date.day, clock.hour, clock.minute].every(Number.isInteger))
    throw new Error("Invalid model action.");
  if (item.timeZone !== undefined) bounded(item.timeZone, 200);
};
export function validateLifeIntent(value: unknown): LifeIntent {
  const item = row(value);
  switch (item.kind) {
    case "schedule_reminder":
      keys(item, ["kind", "title", "when"]);
      bounded(item.title, 2000);
      temporal(item.when);
      break;
    case "create_event":
      keys(item, ["kind", "title", "start", "durationMinutes"]);
      bounded(item.title, 2000);
      temporal(item.start);
      if (item.durationMinutes !== undefined && !Number.isInteger(item.durationMinutes))
        throw new Error("Invalid model action.");
      break;
    case "create_need":
      keys(item, ["kind", "title", "due", "budget", "currency"]);
      bounded(item.title, 2000);
      if (item.due !== undefined) temporal(item.due);
      if (
        item.budget !== undefined &&
        (typeof item.budget !== "number" || !Number.isFinite(item.budget))
      )
        throw new Error("Invalid model action.");
      if (item.currency !== undefined) bounded(item.currency, 8);
      break;
    case "resolve_need":
      keys(item, ["kind", "operation", "title"]);
      bounded(item.title, 500);
      if (!["complete", "cancel"].includes(String(item.operation)))
        throw new Error("Invalid model action.");
      break;
    case "create_contact": {
      keys(item, ["kind", "name", "interests", "birthday"]);
      bounded(item.name, 500);
      if (
        item.interests !== undefined &&
        (!Array.isArray(item.interests) || item.interests.length > 20)
      )
        throw new Error("Invalid model action.");
      if (Array.isArray(item.interests))
        item.interests.forEach((interest) => bounded(interest, 200));
      if (item.birthday !== undefined) {
        const birthday = row(item.birthday);
        keys(birthday, ["month", "day", "year"]);
        if (
          ![birthday.month, birthday.day].every(Number.isInteger) ||
          (birthday.year !== undefined && !Number.isInteger(birthday.year))
        )
          throw new Error("Invalid model action.");
      }
      break;
    }
    case "query":
      keys(item, ["kind", "view"]);
      if (!["today", "upcoming", "birthdays"].includes(String(item.view)))
        throw new Error("Invalid model action.");
      break;
    case "summarize_sources":
      keys(item, ["kind", "query"]);
      bounded(item.query, 1000);
      break;
    case "clarify":
      keys(item, ["kind", "question", "missing"]);
      bounded(item.question, 1000);
      if (!Array.isArray(item.missing) || item.missing.length > 8)
        throw new Error("Invalid model action.");
      item.missing.forEach((missing) => bounded(missing, 100));
      break;
    default:
      throw new Error("Invalid model action.");
  }
  return structuredClone(item) as unknown as LifeIntent;
}

export function validateDraftLifeIntent(value: unknown): DraftLifeIntent {
  const item = row(value);
  bounded(item.title, 2000);
  if (item.kind === "schedule_reminder") {
    keys(item, ["kind", "title"]);
  } else if (item.kind === "create_event") {
    keys(item, ["kind", "title", "durationMinutes"]);
    if (
      item.durationMinutes !== undefined &&
      (!Number.isInteger(item.durationMinutes) ||
        Number(item.durationMinutes) < 1 ||
        Number(item.durationMinutes) > 10_080)
    )
      throw new Error("Invalid model draft.");
  } else throw new Error("Invalid model draft.");
  return structuredClone(item) as unknown as DraftLifeIntent;
}

export function validateModelPlan(value: unknown): LifeModelPlan {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid model plan.");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => key !== "reply" && key !== "actions") ||
    !Array.isArray(row.actions) ||
    row.actions.length > 8
  )
    throw new Error("Invalid model plan.");
  const actions = row.actions.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid model action.");
    const action = item as Record<string, unknown>;
    if (
      action.type === "reply" &&
      Object.keys(action).every((key) => ["type", "text"].includes(key))
    )
      return { type: "reply" as const, text: bounded(action.text, 4000) };
    if (
      action.type === "search_sources" &&
      Object.keys(action).every((key) => ["type", "query"].includes(key))
    )
      return {
        type: "search_sources" as const,
        query: bounded(action.query, 1000),
      };
    if (
      action.type === "create_memory" &&
      Object.keys(action).every((key) => ["type", "title", "body"].includes(key))
    )
      return {
        type: "create_memory" as const,
        title: bounded(action.title, 500),
        body: bounded(action.body, 10_000),
      };
    if (
      action.type === "life_operation" &&
      Object.keys(action).every((key) => ["type", "intent"].includes(key))
    )
      return { type: "life_operation" as const, intent: validateLifeIntent(action.intent) };
    if (
      action.type === "draft_life_operation" &&
      Object.keys(action).every((key) => ["type", "intent"].includes(key))
    )
      return {
        type: "draft_life_operation" as const,
        intent: validateDraftLifeIntent(action.intent),
      };
    throw new Error("Invalid model action.");
  });
  if (
    actions.filter(
      (action) =>
        action.type === "create_memory" ||
        action.type === "draft_life_operation" ||
        (action.type === "life_operation" && !["query", "clarify"].includes(action.intent.kind)),
    ).length > 1
  )
    throw new Error("Invalid model plan: only one mutation is allowed.");
  return { reply: bounded(row.reply, 8000), actions };
}

function loopback(url: URL): void {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "::1"].includes(host) ||
    url.username ||
    url.password
  )
    throw new Error("Local model URL must be an unauthenticated HTTP loopback address.");
}

export class LocalOpenAIModel implements LifeModel {
  private readonly endpoint: URL;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private activeCalls = 0;
  constructor(
    endpoint: string,
    model: string,
    fetcher: typeof fetch = fetch,
    options: { timeoutMs?: number } = {},
  ) {
    this.endpoint = new URL("chat/completions", endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
    this.model = model;
    this.fetcher = fetcher;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000)
      throw new Error("Local model timeout must be between 1 and 30000 milliseconds.");
    loopback(this.endpoint);
    bounded(model, 200);
  }

  async plan(request: LifeModelRequest, signal?: AbortSignal): Promise<LifeModelPlan> {
    const deadline = new AbortController(),
      timer = setTimeout(
        () => deadline.abort(new Error("Local model request deadline exceeded.")),
        this.timeoutMs,
      ),
      combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      const response = await this.call(planMessages(request), combined);
      try {
        return validateModelPlan(JSON.parse(response));
      } catch (error) {
        if (combined.aborted) throw cancellation(combined);
        // One schema repair is allowed before the host receives any proposal.
        // Transport failures are outside this catch and never cause an inference retry.
        let messages;
        try {
          messages = planMessages(request, {
            repair: {
              candidate: response,
              reason: error instanceof SyntaxError ? "invalid-json" : "invalid-action-plan",
            },
          });
        } catch {
          throw error;
        }
        const repaired = await this.call(messages, combined);
        return validateModelPlan(JSON.parse(repaired));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async build(
    request: string | LifePluginBuildRequest,
    signal?: AbortSignal,
  ): Promise<{ name: string; description: string; html: string }> {
    const instruction =
      typeof request === "string"
        ? { request: bounded(request, 8_000) }
        : {
            request: bounded(request.request, 8_000),
            previous: {
              name: bounded(request.previous.name, 120),
              description: bounded(request.previous.description, 1_000),
              html: bounded(request.previous.html, 160_000),
            },
          };
    const value = JSON.parse(
      await this.call(
        [
          {
            role: "system",
            content:
              "Return JSON only: {name,description,html}. Produce complete raw self-contained HTML in html, never a patch. It runs in a sandbox with storage only. A trusted bootstrap posts a window message {type:'ellie:connect'} with one MessagePort into this same window (event.source === window); accept it, then send {id,method:'storage.get',key} or {id,method:'storage.set',key,value} and receive {id,ok,result|error}. Use no external scripts, styles, images, fonts, modules, dynamic imports, eval, Function constructor, network, filesystem, native app, or server access.",
          },
          { role: "user", content: JSON.stringify(instruction) },
        ],
        signal,
        32_768,
      ),
    ) as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["name", "description", "html"].includes(key)))
      throw new Error("Invalid plugin model response.");
    return {
      name: bounded(value.name, 120),
      description: bounded(value.description, 1000),
      html: bounded(value.html, 160_000),
    };
  }

  private async call(
    messages: Array<{ role: string; content: string }>,
    signal?: AbortSignal,
    maxTokens = 2_048,
  ): Promise<string> {
    if (signal?.aborted) throw cancellation(signal);
    if (this.activeCalls >= 4)
      throw new Error("The local model is busy. Wait for an active request to settle.");
    const deadline = new AbortController(),
      timer = setTimeout(
        () => deadline.abort(new Error("Local model request deadline exceeded.")),
        this.timeoutMs,
      ),
      combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(cancellation(combined));
      combined.addEventListener("abort", onAbort, { once: true });
    });
    this.activeCalls++;
    const work = this.performCall(messages, combined, maxTokens);
    // A transport that ignores cancellation still occupies its slot until its
    // actual work settles. Deadlines must not permit unlimited orphan requests.
    void work.then(
      () => {
        this.activeCalls--;
      },
      () => {
        this.activeCalls--;
      },
    );
    try {
      return await Promise.race([work, aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener("abort", onAbort);
    }
  }

  private async performCall(
    messages: Array<{ role: string; content: string }>,
    signal: AbortSignal,
    maxTokens: number,
  ): Promise<string> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
      }),
    });
    if (signal.aborted) {
      void response.body?.cancel().catch(() => {});
      throw cancellation(signal);
    }
    if (!response.ok || Number(response.headers.get("content-length")) > 256_000) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Local model unavailable.");
    }
    if (!response.body) throw new Error("Local model response is empty.");
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [],
      cancel = () => {
        void reader.cancel().catch(() => {});
      };
    signal.addEventListener("abort", cancel, { once: true });
    let size = 0;
    try {
      for (;;) {
        if (signal.aborted) throw cancellation(signal);
        const { value, done } = await reader.read();
        if (signal.aborted) throw cancellation(signal);
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) throw new Error("Local model response exceeds limit.");
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const value = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    return bounded(value.choices?.[0]?.message?.content, 200_000);
  }
}

function cancellation(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Local model request cancelled.");
}
