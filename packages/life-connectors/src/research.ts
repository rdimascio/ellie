import { createHash } from "node:crypto";
import {
  analyzeLife,
  type ConnectorObservation,
  type LifeAnticipationResult,
} from "../../life-anticipation/src/index.ts";
import { type HandlerContext, type TaskRecord, TaskRuntime } from "../../task-runtime/src/index.ts";

export const CONNECTED_RESEARCH_PERSONAS = {
  calendar:
    "Find supported scheduling patterns and prepare for confirmed appointments. Keep explicit preferences authoritative; calendar time passing is not completion evidence.",
  communication:
    "Find supported communication cadence and useful follow-up opportunities. Literal addresses do not prove family relationships, and message snippets do not prove task completion.",
  spending:
    "Find recurring settled expenses using exact supported currency amounts. Do not infer income, balances, subscriptions or purchases from missing or pending evidence.",
} as const;

export interface ConnectedResearchSnapshot {
  generation: number;
  /** Revision of evidence, explicit settings and dismissals, checked again at publication. */
  contextRevision?: string;
  observations: ConnectorObservation[];
  explicitSettings: Record<string, unknown>;
  timeZone: string;
  mode: "observe" | "prepare" | "paused" | "revoked";
  dismissedKeys?: string[];
}

export interface ConnectedResearchOptions {
  tasks: TaskRuntime;
  snapshot(
    actorId: string,
    connectionId: string,
  ): ConnectedResearchSnapshot | Promise<ConnectedResearchSnapshot>;
  sync(actorId: string, connectionId: string, signal: AbortSignal): unknown | Promise<unknown>;
  /** Atomically recheck generation, source access and standing grant before publication. */
  publish(
    actorId: string,
    connectionId: string,
    generation: number,
    result: LifeAnticipationResult,
    signal: AbortSignal,
    contextRevision?: string,
  ): boolean | void | Promise<boolean | void>;
  now?: () => number;
}

type Persona = keyof typeof CONNECTED_RESEARCH_PERSONAS;
interface Job {
  actorId: string;
  connectionId: string;
  generation?: number;
  contextRevision?: string;
  persona?: Persona;
  children?: string[];
}
interface Outcome {
  status: "queued" | "analyzed" | "published" | "skipped";
  generation?: number;
  result?: LifeAnticipationResult;
  proposals?: number;
  insights?: number;
}
const CAPABILITIES = ["life.connections.read", "life.connections.write"] as const;
const HANDLERS = {
  sync: "life.connected.sync",
  horizon: "life.connected.horizon",
  specialist: "life.connected.specialist",
  publish: "life.connected.publish",
} as const;
const PERSONAS = Object.keys(CONNECTED_RESEARCH_PERSONAS) as Persona[];
const ACTIVE = new Set(["queued", "running", "waiting", "scheduled", "paused"]);
const enabled = (snapshot: ConnectedResearchSnapshot) =>
  snapshot.mode === "observe" || snapshot.mode === "prepare";
const hash = (...values: string[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 40);
const owner = (actorId: string): `user:${string}` => `user:${actorId}`;

function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value))
    throw new TypeError("Connected research identity is invalid.");
  return value;
}

function jobInput(value: unknown, context: HandlerContext): Job {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Connected research input is invalid.");
  const input = value as Job;
  identity(input.actorId);
  identity(input.connectionId);
  if (context.task.owner !== owner(input.actorId))
    throw new Error("Connected research owner is invalid.");
  return input;
}

function generation(snapshot: ConnectedResearchSnapshot): number {
  if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0)
    throw new Error("Connected research generation is invalid.");
  return snapshot.generation;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Connected research was cancelled.");
}

/** Local deterministic specialist jobs; persona prompts do not imply model-based research. */
export function createConnectedResearch(options: ConnectedResearchOptions) {
  const { tasks } = options,
    now = options.now ?? Date.now,
    shutdown = new AbortController(),
    active = new Set<Promise<Outcome>>(),
    activeConnections = new Map<string, Set<AbortController>>();
  let closed = false;
  const rootIds = (actorId: string, connectionId: string) => {
    const key = hash(identity(actorId), identity(connectionId));
    return { initial: `cr-initial-${key}`, hourly: `cr-hourly-${key}`, daily: `cr-daily-${key}` };
  };
  const snapshot = async (input: Job, signal: AbortSignal) => {
    abort(signal);
    const result = await options.snapshot(input.actorId, input.connectionId);
    abort(signal);
    generation(result);
    return result;
  };
  const perform = (
    context: HandlerContext,
    raw: unknown,
    action: (input: Job, signal: AbortSignal) => Promise<Outcome>,
  ): Promise<Outcome> => {
    const input = jobInput(raw, context),
      controller = new AbortController(),
      key = hash(input.actorId, input.connectionId),
      signal = AbortSignal.any([context.signal, shutdown.signal, controller.signal]);
    const controllers = activeConnections.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    activeConnections.set(key, controllers);
    const work = Promise.resolve().then(() => {
      abort(signal);
      return action(input, signal);
    });
    active.add(work);
    void work
      .finally(() => {
        active.delete(work);
        controllers.delete(controller);
        if (!controllers.size) activeConnections.delete(key);
      })
      .catch(() => {});
    return work;
  };
  const createChildren = (
    context: HandlerContext,
    input: Job,
    current: ConnectedResearchSnapshot,
  ) => {
    const currentGeneration = generation(current),
      batch = hash(context.task.id, String(currentGeneration), current.contextRevision ?? ""),
      children: string[] = [];
    for (const persona of PERSONAS) {
      const id = `cr-persona-${hash(batch, persona)}`;
      children.push(id);
      if (!tasks.get(id, context.task.owner))
        context.enqueueChild({
          id,
          handler: HANDLERS.specialist,
          input: {
            actorId: input.actorId,
            connectionId: input.connectionId,
            generation: currentGeneration,
            ...(current.contextRevision === undefined
              ? {}
              : { contextRevision: current.contextRevision }),
            persona,
          } satisfies Job,
          retry: { maxAttempts: 2, delayMs: 1_000 },
        });
    }
    const id = `cr-publish-${batch}`;
    if (!tasks.get(id, context.task.owner))
      context.enqueueChild({
        id,
        handler: HANDLERS.publish,
        input: {
          actorId: input.actorId,
          connectionId: input.connectionId,
          generation: currentGeneration,
          ...(current.contextRevision === undefined
            ? {}
            : { contextRevision: current.contextRevision }),
          children,
        } satisfies Job,
        dependsOn: children,
        retry: { maxAttempts: 2, delayMs: 1_000 },
      });
    return currentGeneration;
  };
  const verified = (_context: HandlerContext, result: Outcome) =>
    ["queued", "analyzed", "published", "skipped"].includes(result.status);

  tasks.registerHandler<Job, Outcome>({
    name: HANDLERS.sync,
    requiredCapabilities: CAPABILITIES,
    resumable: true,
    checkOutcome: verified,
    run: (context, raw) =>
      perform(context, raw, async (input, signal) => {
        if (!enabled(await snapshot(input, signal))) return { status: "skipped" };
        await options.sync(input.actorId, input.connectionId, signal);
        const current = await snapshot(input, signal);
        if (!enabled(current)) return { status: "skipped" };
        const currentGeneration = createChildren(context, input, current);
        context.progress({ message: "Connected evidence synced; three specialist checks queued." });
        return { status: "queued", generation: currentGeneration };
      }),
  });
  tasks.registerHandler<Job, Outcome>({
    name: HANDLERS.horizon,
    requiredCapabilities: CAPABILITIES,
    resumable: true,
    checkOutcome: verified,
    run: (context, raw) =>
      perform(context, raw, async (input, signal) => {
        const current = await snapshot(input, signal);
        if (!enabled(current)) return { status: "skipped" };
        return { status: "queued", generation: createChildren(context, input, current) };
      }),
  });
  tasks.registerHandler<Job, Outcome>({
    name: HANDLERS.specialist,
    requiredCapabilities: [CAPABILITIES[0]],
    resumable: true,
    checkOutcome: verified,
    run: (context, raw) =>
      perform(context, raw, async (input, signal) => {
        const current = await snapshot(input, signal);
        if (
          !enabled(current) ||
          generation(current) !== input.generation ||
          current.contextRevision !== input.contextRevision
        )
          return { status: "skipped" };
        if (!input.persona || !PERSONAS.includes(input.persona))
          throw new Error("Connected specialist is invalid.");
        const kind =
          input.persona === "calendar"
            ? "event"
            : input.persona === "communication"
              ? "message"
              : "transaction";
        const observations = current.observations.filter(
          (item) =>
            item.connectionId === input.connectionId &&
            (item.kind === kind || (item.kind === "deleted" && item.data.previousKind === kind)),
        );
        const result = analyzeLife({
          observations,
          explicitSettings: current.explicitSettings,
          timeZone: current.timeZone,
          now: now(),
          horizons: ["day", "month", "quarter", "year"],
          ...(current.dismissedKeys ? { dismissedKeys: current.dismissedKeys } : {}),
        });
        abort(signal);
        return { status: "analyzed", generation: input.generation, result };
      }),
  });
  tasks.registerHandler<Job, Outcome>({
    name: HANDLERS.publish,
    requiredCapabilities: CAPABILITIES,
    resumable: true,
    checkOutcome: verified,
    run: (context, raw) =>
      perform(context, raw, async (input, signal) => {
        const current = await snapshot(input, signal);
        if (
          !enabled(current) ||
          generation(current) !== input.generation ||
          current.contextRevision !== input.contextRevision
        )
          return { status: "skipped" };
        if (!Array.isArray(input.children) || input.children.length !== 3)
          throw new Error("Connected research children are invalid.");
        const batch = hash(
          context.task.parentId ?? "",
          String(input.generation),
          input.contextRevision ?? "",
        );
        if (
          input.children.some((id, index) => id !== `cr-persona-${hash(batch, PERSONAS[index]!)}`)
        )
          throw new Error("Connected research child identities are invalid.");
        const results = input.children.map((id) => tasks.get(id, context.task.owner));
        if (
          results.some(
            (task) =>
              task?.state !== "succeeded" ||
              task.parentId !== context.task.parentId ||
              task.handler !== HANDLERS.specialist,
          )
        )
          return { status: "skipped" };
        const analyses = results.map((task) => task!.result as Outcome);
        if (
          analyses.some(
            (item) =>
              item.status !== "analyzed" || item.generation !== input.generation || !item.result,
          )
        )
          return { status: "skipped" };
        const validRefs = new Set(
          current.observations
            .filter(
              (item) =>
                item.connectionId === input.connectionId &&
                item.kind !== "deleted" &&
                !item.deleted,
            )
            .map((item) =>
              JSON.stringify([item.connectionId, item.sourceKey, item.sourceRevision]),
            ),
        );
        const referencesCurrent = (
          refs: LifeAnticipationResult["insights"][number]["evidenceRefs"],
        ) =>
          refs.length > 0 &&
          refs.length <= 8 &&
          refs.every((ref) =>
            validRefs.has(JSON.stringify([ref.connectionId, ref.sourceKey, ref.sourceRevision])),
          );
        const insights = [
          ...new Map(
            analyses
              .flatMap((item) => item.result!.insights)
              .filter((item) => item.validUntil > now() && referencesCurrent(item.evidenceRefs))
              .map((item) => [item.key, item]),
          ).values(),
        ];
        const proposals = [
          ...new Map(
            analyses
              .flatMap((item) => item.result!.proposals)
              .filter((item) => item.expiresAt > now() && referencesCurrent(item.evidenceRefs))
              .map((item) => [item.key, item]),
          ).values(),
        ];
        const result: LifeAnticipationResult = {
          insights: insights.slice(0, 32),
          proposals: proposals.slice(0, 12),
          partial:
            analyses.some((item) => item.result!.partial) ||
            insights.length > 32 ||
            proposals.length > 12,
        };
        abort(signal);
        const saved = await options.publish(
          input.actorId,
          input.connectionId,
          input.generation!,
          result,
          signal,
          input.contextRevision,
        );
        abort(signal);
        return saved === false
          ? { status: "skipped" }
          : {
              status: "published",
              generation: input.generation,
              proposals: result.proposals.length,
              insights: result.insights.length,
            };
      }),
  });

  async function connectionAdded(actorId: string, connectionId: string): Promise<TaskRecord> {
    if (closed) throw new Error("Connected research is closed.");
    const ids = rootIds(actorId, connectionId),
      input: Job = { actorId, connectionId },
      current = await snapshot(input, shutdown.signal);
    if (!enabled(current)) throw new Error("Connected research is unavailable.");
    const taskOwner = owner(actorId);
    for (const [id, handler, schedule] of [
      [
        ids.hourly,
        HANDLERS.sync,
        { kind: "interval", everyMs: 3_600_000, anchor: now() + 3_600_000 },
      ],
      [ids.daily, HANDLERS.horizon, { kind: "daily", time: "06:00", timeZone: current.timeZone }],
    ] as const) {
      const prior = tasks.get(id, taskOwner);
      if (prior && !ACTIVE.has(prior.state))
        throw new Error("Revoked research requires a newly linked connection.");
      if (!prior)
        tasks.schedule({
          id,
          owner: taskOwner,
          handler,
          input,
          schedule,
          missedRunPolicy: { kind: "latest" },
          allowedCapabilities: CAPABILITIES,
          budget: { maxConcurrency: 2, maxRuntimeMs: 60_000 },
          retry: { maxAttempts: 2, delayMs: 1_000 },
        });
    }
    return (
      tasks.get(ids.initial, taskOwner) ??
      tasks.enqueue({
        id: ids.initial,
        owner: taskOwner,
        handler: HANDLERS.sync,
        input,
        allowedCapabilities: CAPABILITIES,
        // One initial batch and, if interrupted evidence changed, one replacement batch.
        budget: { maxTasks: 9, maxConcurrency: 2, maxRuntimeMs: 60_000 },
        retry: { maxAttempts: 2, delayMs: 1_000 },
      })
    );
  }

  return {
    connectionAdded,
    async refresh(actorId: string, connectionId: string): Promise<TaskRecord> {
      await connectionAdded(actorId, connectionId);
      const current = await snapshot({ actorId, connectionId }, shutdown.signal);
      if (!enabled(current)) throw new Error("Connected research is unavailable.");
      const ids = rootIds(actorId, connectionId),
        taskOwner = owner(actorId),
        id = `cr-refresh-${hash(actorId, connectionId, String(Math.floor(now() / 60_000)), String(current.generation), current.contextRevision ?? "")}`;
      return (
        tasks.get(id, taskOwner) ??
        tasks.enqueue({
          id,
          owner: taskOwner,
          parentId: ids.hourly,
          handler: HANDLERS.sync,
          input: { actorId, connectionId } satisfies Job,
          deadlineAt: now() + 120_000,
          retry: { maxAttempts: 2, delayMs: 1_000 },
        })
      );
    },
    revoke(actorId: string, connectionId: string): void {
      const key = hash(identity(actorId), identity(connectionId));
      for (const controller of activeConnections.get(key) ?? []) controller.abort();
      for (const id of Object.values(rootIds(actorId, connectionId)))
        if (tasks.get(id, owner(actorId))) tasks.cancel(id, owner(actorId));
    },
    async close(): Promise<void> {
      closed = true;
      shutdown.abort();
      if (!active.size) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        Promise.allSettled(active).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 5_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained)
        throw new Error("Connected research is still active; retry close after it settles.");
    },
  };
}
