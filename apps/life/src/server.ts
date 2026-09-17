import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createReadStream, lstatSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LifeActor,
  LifeRecord,
  LifeRecordKind,
  LifeRecordSummary,
  LifeScope,
  LifeStore,
  ConversationPreferenceState,
  ConversationPreferences,
  PendingLifeIntent,
  PendingTemporalSpec,
  TextSourceFormat,
} from "../../../packages/life-core/src/index.ts";
import { LifeAccessError, LifeConflictError } from "../../../packages/life-core/src/index.ts";
import type { ConnectorBroker } from "../../../packages/life-connectors/src/broker.ts";
import {
  eventPreparationWindow,
  recordProactiveDismissal,
  type ContextSignal,
} from "../../../packages/life-context/src/index.ts";
import {
  commitLifeImport,
  previewLifeImport,
  type LifeImportFormat,
} from "../../../packages/life-import/src/index.ts";
import { LifeLearning } from "../../../packages/life-learning/src/index.ts";
import { LifeTeaching } from "../../../packages/life-teaching/src/index.ts";
import { LifeAutoMemory } from "../../../packages/life-auto-memory/src/index.ts";
import { LifePlanError, LifePlans, type LifePlan } from "../../../packages/life-plans/src/index.ts";
import { PluginBuildError } from "../../../packages/life-harness/src/build.ts";
import type { LifeModelProgress } from "../../../packages/life-harness/src/model.ts";
import {
  ScheduledDeliveries,
  ScheduledDeliveryError,
} from "../../../packages/life-harness/src/schedules.ts";
import type { ModelStatus } from "./model-status.ts";
import { pluginChildDocument } from "./plugin-bootstrap.ts";
import type { LifePlugin, PluginStore } from "../../../packages/life-plugins/src/index.ts";
import {
  PluginError,
  builtInManifest,
  groupStorageKey,
} from "../../../packages/life-plugins/src/index.ts";
import type {
  OwnerScope,
  TaskRecord,
  TaskRuntime,
} from "../../../packages/task-runtime/src/index.ts";

const ORDINARY_LIMIT = 128 * 1024;
const SOURCE_LIMIT = 2 * 1024 * 1024;
const BINARY_SOURCE_LIMIT = 50_000_000;
const DEADLINE_MS = 15_000;
const BINARY_DEADLINE_MS = 60_000;
const SESSION_COOKIE = "ellie_life_session";
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'none'; form-action 'self'";
const PLUGIN_HOST_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self' data:; connect-src 'none'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox allow-scripts";
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export interface LifeHarnessLike {
  improvements?: {
    modelAvailable: boolean;
    list(actor: LifeActor): ImprovementProposalLike[];
    get(actor: LifeActor, id: string): ImprovementProposalLike;
    propose(
      actor: LifeActor,
      input: {
        feedback: Array<{ id: string; revision: number }>;
        goal?: string;
        signal?: AbortSignal;
        isContextCurrent?: () => boolean;
      },
    ): Promise<ImprovementProposalLike>;
    adopt(actor: LifeActor, id: string, expectedRevision: number): ImprovementProposalLike;
    dismiss(actor: LifeActor, id: string, expectedRevision: number): ImprovementProposalLike;
    settleActive(timeoutMs?: number): Promise<boolean>;
  };
  chat(input: {
    actor: LifeActor;
    scope: LifeScope;
    message: string;
    conversationId?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    automaticMemory?: { markdown: string; revision: string; partial: boolean };
    automaticMemoryForgotten?: number;
    onProgress?: (progress: LifeModelProgress) => void;
    isContextCurrent?: () => boolean;
    pendingIntent?: PendingLifeIntent;
    conversationPreferences?: ConversationPreferenceState;
    signal?: AbortSignal;
    recentOperation?: {
      kind: "reminder" | "event";
      recordId: string;
      expectedRevision: number;
      taskId?: string;
    };
  }): Promise<{
    reply: string;
    conversationId: string;
    actions?: Array<{ label: string; status: string }>;
    records?: LifeRecord[];
    taskIds?: string[];
    evidence?: Array<{ sourceId: string; title: string; reference?: string }>;
    continuation?:
      | {
          action: "create" | "replace";
          intent: PendingLifeIntent["intent"];
          missing: PendingLifeIntent["missing"];
          question: string;
          target?: PendingLifeIntent["target"];
          answer?: { when: PendingTemporalSpec } | { start: PendingTemporalSpec };
        }
      | {
          action: "answer";
          pendingIntentId: string;
          expectedRevision: number;
          answer: { when: PendingTemporalSpec } | { start: PendingTemporalSpec };
        }
      | { action: "cancel"; pendingIntentId: string; expectedRevision: number };
    conversationPreferenceUpdate?: {
      set?: ConversationPreferences;
      clear?: Array<"tone" | "verbosity">;
      expectedRevision: number;
    };
    createdGroup?: { id: string; name: string };
  }>;
  continuePendingIntent?(input: {
    actor: LifeActor;
    scope: LifeScope;
    pendingIntent: PendingLifeIntent;
    answer?: { when: PendingTemporalSpec } | { start: PendingTemporalSpec };
    isContextCurrent?: () => boolean;
    replacementJournal?: {
      prepared(value: { operationId: string; replacementTaskId: string; dueAt: number }): void;
      recordUpdated(value: { recordId: string; revision: number; replacementTaskId: string }): void;
    };
  }): Promise<{
    reply: string;
    conversationId: string;
    actions?: Array<{ label: string; status: string }>;
    records?: LifeRecord[];
    taskIds?: string[];
    evidence?: Array<{ sourceId: string; title: string; reference?: string }>;
    operationOutcome?: "completed" | "scheduled" | "queued" | "clarify" | "rejected";
    conversationPreferenceUpdate?: {
      set?: ConversationPreferences;
      clear?: Array<"tone" | "verbosity">;
      expectedRevision: number;
    };
    createdGroup?: { id: string; name: string };
  }>;
  buildPlugin?(input: {
    actor: LifeActor;
    scope: LifeScope;
    request: string;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LifePlugin>;
  revisePlugin?(input: {
    actor: LifeActor;
    scope: LifeScope;
    id: string;
    request: string;
    expectedVersion: number;
    isContextCurrent?: () => boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<LifePlugin>;
  invalidateContext?(actor: LifeActor, scope: LifeScope): void;
  invalidateActorContext?(actor: LifeActor): void;
  rerunBackgroundSummary?(input: {
    actor: LifeActor;
    scope: LifeScope;
    taskId: string;
  }): TaskRecord;
}
interface ImprovementProposalLike {
  record: LifeRecord;
  status: "ready" | "adopted" | "dismissed" | "stale";
  instructions: string;
  rationale: string;
  feedback: Array<{ id: string; revision: number }>;
  previews: Array<{
    feedbackId: string;
    prompt: string;
    recordedResponse: string;
    preferredResponse?: string;
    candidateResponse: string;
  }>;
  guideId?: string;
}
export interface MlbLike {
  snapshot(date?: string): Promise<unknown>;
}
export interface ContextLike {
  evaluate(actor: LifeActor, scope: LifeScope, signal: ContextSignal): unknown[];
}
export interface LifeServerOptions {
  stateDir: string;
  assetsDir?: string;
  store: LifeStore;
  tasks: TaskRuntime;
  plugins: PluginStore;
  harness: LifeHarnessLike;
  mlb?: MlbLike;
  context?: ContextLike;
  preparationMonitor?: { start(): void; stop(): void };
  connectors?: ConnectorBroker;
  openAuthorizationUrl?: (url: string) => Promise<boolean>;
  modelStatus?: () => Promise<ModelStatus>;
  host?: "127.0.0.1";
  port?: number;
  userId?: string;
  userName?: string;
  timeZone?: string;
  now?: () => number;
  token?: string;
  tokenTtlMs?: number;
  sessionTtlMs?: number;
  closeDrainMs?: number;
  extractor?: (input: {
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }) => Promise<{ text: string; metadata?: Record<string, unknown> }>;
}
export interface ListeningLifeServer {
  host: string;
  port: number;
  url: string;
  launchUrl: string;
}
export interface OwnerSettingsLaunch {
  url: string;
  origin: string;
  cancel(): void;
  complete(): boolean;
}
/** Supplied only by the authenticated coordinator gateway, never by HTTP payloads. */
export interface LifeEmbeddedContext {
  actorId: string;
  clientId: string;
  origin: string;
  signal: AbortSignal;
  isCurrent(): boolean;
}
interface EmbeddedRequest {
  context: LifeEmbeddedContext;
  cleanups: Set<() => void>;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function sameDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
function identifier(value: unknown, label = "identifier"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/.test(value))
    throw new HttpError(400, `${label} is invalid.`);
  return value;
}
function bounded(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit)
    throw new HttpError(400, `${label} is invalid.`);
  return value;
}
function presentation(value: unknown, limit: number, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "JSON object required.");
  return value as Record<string, unknown>;
}
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
function serializeRecord(record: LifeRecord): Record<string, unknown> {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}
function serializeSummary(record: LifeRecordSummary): Record<string, unknown> {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
  };
}
function serializeTask(
  task: TaskRecord,
  records: Array<Pick<LifeRecord, "id" | "title">> = [],
): Record<string, unknown> {
  const input =
      task.input && typeof task.input === "object" ? (task.input as Record<string, unknown>) : {},
    linked =
      typeof input.recordId === "string"
        ? records.find((record) => record.id === input.recordId)
        : undefined,
    source =
      typeof input.sourceId === "string"
        ? records.find((record) => record.id === input.sourceId)
        : undefined;
  let title: string;
  if (task.handler === "reminder.notify") title = linked?.title ?? "Reminder";
  else if (task.handler === "knowledge.aggregate")
    title =
      typeof input.query === "string" && input.query.trim()
        ? `Summarize ${input.query.trim().slice(0, 160)}`
        : "Summarize sources";
  else if (task.handler === "knowledge.summarize-source")
    title = source ? `Read ${source.title}` : "Read source";
  else
    title =
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim().slice(0, 200)
        : "Background work";
  const actions =
    task.state === "queued" || task.state === "scheduled" || task.state === "waiting"
      ? ["pause", "cancel", "run"]
      : task.state === "paused"
        ? ["resume", "cancel", "run"]
        : task.state === "running"
          ? ["cancel"]
          : task.handler === "knowledge.aggregate"
            ? ["rerun"]
            : [];
  return {
    id: task.id,
    title,
    status: task.state,
    actions,
    ...(typeof input.detail === "string"
      ? { detail: input.detail }
      : task.scheduledFor
        ? { detail: `Scheduled for ${new Date(task.scheduledFor).toISOString()}` }
        : {}),
    updatedAt: new Date(task.updatedAt).toISOString(),
  };
}
function serializePlugin(plugin: LifePlugin): Record<string, unknown> {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    kind: plugin.kind,
    status: plugin.status,
    version: String(plugin.version),
    data: {
      capabilities: plugin.capabilities,
      updatedAt: new Date(plugin.updatedAt).toISOString(),
    },
  };
}
function mime(path: string): string {
  return (
    (
      {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      } as Record<string, string>
    )[extname(path)] ?? "application/octet-stream"
  );
}
function owner(scope: LifeScope): OwnerScope {
  return `${scope.type}:${scope.id}`;
}

export class LifeHttpServer {
  readonly token: string;
  private readonly tokenHash: Buffer;
  private tokenUsed = false;
  private readonly tokenCreatedAt: number;
  // Local UI cookies are host-scoped across loopback ports. The existing Life threat model trusts
  // same-user local processes; this listener is local-owner authority, not process isolation.
  private readonly sessions = new Map<string, number>();
  private ownerLaunch?: {
    hash: Buffer;
    expiresAt: number;
    opened: boolean;
    used: boolean;
    sessionHash?: string;
  };
  private ownerIssuing = false;
  private listenerStarting?: Promise<ListeningLifeServer>;
  private lifecycleGeneration = 0;
  private closed = false;
  private attempts: number[] = [];
  private contextTail: Promise<void> = Promise.resolve();
  private readonly activeRequests = new Set<Promise<void>>();
  private readonly extractionControllers = new Set<AbortController>();
  private readonly pluginBuildControllers = new Set<AbortController>();
  private binaryUploads = 0;
  private readonly mutationRequests = new Set<Promise<void>>();
  private readonly personalReviews = new Map<
    string,
    { expiresAt: number; life: number; tasks: number; plugins: number; connectors?: number }
  >();
  private readonly chatProgress = new Map<
    string,
    {
      conversationId: string;
      turnId: string;
      revision: number;
      phase: LifeModelProgress["phase"];
      text?: string;
      current: () => boolean;
    }
  >();
  private personalResetActive = false;
  private resetInFlight?: {
    operationId: string;
    promise: Promise<ReturnType<LifeStore["getPersonalReset"]>>;
  };
  private accepting = true;
  private embeddedReady = false;
  private readonly embeddedRequest = new AsyncLocalStorage<EmbeddedRequest | undefined>();
  private server?: Server;
  private bound?: ListeningLifeServer;
  private readonly now: () => number;
  private readonly actor: LifeActor;
  private readonly options: LifeServerOptions;
  private readonly learning: LifeLearning;
  private readonly teaching: LifeTeaching;
  private readonly plans: LifePlans;
  private readonly deliveries: ScheduledDeliveries;
  private readonly automaticMemory: LifeAutoMemory;
  constructor(options: LifeServerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.actor = { userId: identifier(options.userId ?? "local", "userId") };
    this.learning = new LifeLearning(options.store);
    this.teaching = new LifeTeaching(options.store, this.now);
    this.plans = new LifePlans(options.store);
    this.deliveries = new ScheduledDeliveries(options.store, options.tasks);
    this.recoverReminderReschedules();
    const pendingReset = options.store.getPersonalReset(this.actor);
    this.personalResetActive = Boolean(pendingReset && pendingReset.state !== "completed");
    if (pendingReset && pendingReset.state !== "completed") {
      options.tasks.beginPersonalDeletion(`user:${this.actor.userId}`, pendingReset.operationId);
      options.harness.invalidateActorContext?.(this.actor);
    }
    this.token = options.token ?? randomBytes(32).toString("base64url");
    if (this.token.length < 32 || this.token.length > 256)
      throw new Error("Launch token is invalid.");
    this.tokenHash = digest(this.token);
    this.tokenCreatedAt = this.now();
    this.assertStateRoot();
    this.automaticMemory = new LifeAutoMemory(options.store, {
      directory: join(options.stateDir, "memory"),
    });
  }
  recoverReminderReschedules(): { recovered: number; blocked: number } {
    let recovered = 0,
      blocked = 0;
    for (const initial of this.options.store.listReminderReschedules(this.actor, {
      activeOnly: true,
    })) {
      try {
        let journal = initial;
        const replacement = this.options.tasks.getReplacement(
          journal.operationId,
          owner(journal.scope),
        );
        if (!replacement) {
          if (journal.state === "begun") {
            this.options.store.interruptReminderReschedule(this.actor, journal.operationId);
            recovered += 1;
          } else blocked += 1;
          continue;
        }
        const replacementTask =
            replacement.task ??
            this.options.tasks.get(replacement.replacementTaskId, owner(journal.scope)),
          record = this.options.store.getRecord(this.actor, journal.recordId),
          pointsAtReplacement = Boolean(
            record &&
            record.scope.type === journal.scope.type &&
            record.scope.id === journal.scope.id &&
            record.data.taskId === replacement.replacementTaskId &&
            record.data.rescheduleOperationId === journal.operationId,
          );
        if (!pointsAtReplacement) {
          if (replacement.state === "prepared") {
            this.options.tasks.discardReplacement(journal.operationId, owner(journal.scope));
            this.options.store.interruptReminderReschedule(this.actor, journal.operationId);
            recovered += 1;
          } else blocked += 1;
          continue;
        }
        if (journal.state === "begun") {
          if (!replacementTask?.scheduledFor)
            throw new Error("Replacement schedule is unavailable.");
          journal = this.options.store.markReminderReschedulePrepared(
            this.actor,
            journal.operationId,
            {
              replacementTaskId: replacement.replacementTaskId,
              dueAt: replacementTask.scheduledFor,
            },
          );
        }
        if (journal.state === "prepared")
          journal = this.options.store.markReminderRescheduleRecordUpdated(
            this.actor,
            journal.operationId,
            {
              recordId: record!.id,
              revision: record!.revision,
              replacementTaskId: replacement.replacementTaskId,
            },
          );
        if (replacement.state === "prepared")
          this.options.tasks.activateReplacement(journal.operationId, owner(journal.scope));
        this.options.store.completeReminderReschedule(this.actor, journal.operationId);
        recovered += 1;
      } catch {
        blocked += 1;
      }
    }
    return { recovered, blocked };
  }
  private assertStateRoot(): void {
    const state = resolve(this.options.stateDir);
    if (state === REPOSITORY_ROOT || state.startsWith(`${REPOSITORY_ROOT}${sep}`))
      throw new Error("Life state must be outside the source checkout.");
    const info = lstatSync(state);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o700 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Life state directory failed private ownership checks.");
  }
  canEvaluateBackground(): boolean {
    return this.accepting && !this.personalResetActive;
  }
  private prepareMemory(): void {
    if (!this.personalResetActive) {
      // Only retained, actor-owned conversations are backfilled. The store bounds
      // history; each batch is bounded and inaccessible groups are excluded in SQL.
      for (;;) {
        const batch = this.automaticMemory.backfill(this.actor, { limit: 200 });
        if (!batch.hasMore) break;
        if (batch.captured === 0) throw new Error("Automatic memory backfill made no progress.");
      }
      this.automaticMemory.clearActor(this.actor);
      this.automaticMemory.sync(this.actor, { type: "user", id: this.actor.userId });
      for (const group of this.options.store.listGroups(this.actor))
        this.automaticMemory.sync(this.actor, { type: "group", id: group.id });
    }
  }
  async prepareEmbedded(): Promise<void> {
    if (this.embeddedReady) return;
    this.prepareMemory();
    this.accepting = true;
    this.embeddedReady = true;
    this.options.preparationMonitor?.start();
  }
  private track(request: IncomingMessage, active: Promise<void>): Promise<void> {
    this.activeRequests.add(active);
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    const mutation =
      ((request.method !== "GET" && request.method !== "HEAD") ||
        path === "/api/connections/callback") &&
      !path.startsWith("/api/life/personal-data/reset");
    if (mutation) this.mutationRequests.add(active);
    void active
      .finally(() => {
        this.activeRequests.delete(active);
        if (mutation) this.mutationRequests.delete(active);
      })
      .catch(() => {});
    return active;
  }
  async handleEmbedded(
    request: IncomingMessage,
    response: ServerResponse,
    context: LifeEmbeddedContext,
  ): Promise<boolean> {
    const origin = new URL(context.origin);
    if (origin.protocol !== "https:" || origin.origin !== context.origin)
      throw new Error("Invalid embedded Life origin.");
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin.origin) throw new Error("Invalid embedded Life route.");
    if (
      url.pathname !== "/life/" &&
      !/^\/life\/assets\/[A-Za-z0-9._-]+$/.test(url.pathname) &&
      !url.pathname.startsWith("/api/life/") &&
      url.pathname !== "/api/connections" &&
      !url.pathname.startsWith("/api/connections/")
    )
      return false;
    if (!this.embeddedReady || !this.accepting) {
      this.send(response, 503, { error: "Life is not ready." });
      return true;
    }
    const captured: LifeEmbeddedContext = { ...context, isCurrent: () => context.isCurrent() };
    const state: EmbeddedRequest = { context: captured, cleanups: new Set() };
    await this.embeddedRequest.run(state, async () => {
      try {
        this.assertRequestAuthority();
        await this.track(request, this.handle(request, response));
      } catch (error) {
        this.fail(response, error);
      } finally {
        for (const cleanup of state.cleanups) cleanup();
      }
    });
    return true;
  }
  async listen(): Promise<ListeningLifeServer> {
    if (this.closed) throw new Error("Life is closed.");
    if (!this.embeddedReady) this.prepareMemory();
    const bound = await this.ensureListener(this.options.port ?? 7440);
    this.options.preparationMonitor?.start();
    return bound;
  }
  private async ensureListener(port: number): Promise<ListeningLifeServer> {
    if (this.closed) throw new Error("Life is closed.");
    if (this.bound) return this.bound;
    if (this.listenerStarting) return this.listenerStarting;
    const host = this.options.host ?? "127.0.0.1";
    if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid life listener.");
    const generation = this.lifecycleGeneration,
      starting = (async () => {
        const candidate = createServer((request, response) => {
          if (!this.accepting) {
            this.send(response, 503, { error: "Service is shutting down." });
            return;
          }
          void this.track(request, this.handle(request, response));
        });
        candidate.requestTimeout = BINARY_DEADLINE_MS;
        candidate.headersTimeout = 10_000;
        candidate.maxConnections = 64;
        candidate.on("clientError", (_error, socket) => {
          if (!socket.destroyed)
            socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        });
        try {
          await new Promise<void>((ok, fail) => {
            candidate.once("error", fail);
            candidate.listen(port, host, () => {
              candidate.off("error", fail);
              ok();
            });
          });
          const address = candidate.address();
          if (!address || typeof address === "string")
            throw new Error("Life listener did not bind.");
          if (this.closed || this.lifecycleGeneration !== generation)
            throw new Error("Life listener preparation was cancelled.");
          const url = `http://${host}:${address.port}`;
          this.accepting = true;
          this.server = candidate;
          this.bound = {
            host,
            port: address.port,
            url,
            launchUrl: `${url}/#token=${encodeURIComponent(this.token)}`,
          };
          return this.bound;
        } catch (error) {
          candidate.closeAllConnections();
          if (candidate.listening)
            await new Promise<void>((resolve) => candidate.close(() => resolve()));
          throw error;
        }
      })();
    this.listenerStarting = starting;
    try {
      return await starting;
    } finally {
      if (this.listenerStarting === starting) this.listenerStarting = undefined;
    }
  }
  async createOwnerSettingsLaunch(): Promise<OwnerSettingsLaunch> {
    if (this.ownerIssuing) throw new Error("Owner settings are already opening.");
    this.ownerIssuing = true;
    try {
      const now = this.now();
      if (this.ownerLaunch && this.ownerLaunch.expiresAt > now)
        throw new Error("Owner settings are already opening.");
      this.ownerLaunch = undefined;
      const bound = await this.ensureListener(0),
        token = randomBytes(32).toString("base64url"),
        hash = digest(token),
        launch = {
          hash,
          expiresAt: now + 120_000,
          opened: false,
          used: false,
          sessionHash: undefined as string | undefined,
        };
      this.ownerLaunch = launch;
      return {
        url: `${bound.url}/?view=settings&section=connections#token=${encodeURIComponent(token)}`,
        origin: bound.url,
        cancel: () => {
          if (this.ownerLaunch !== launch) return;
          if (launch.sessionHash) this.sessions.delete(launch.sessionHash);
          this.ownerLaunch = undefined;
        },
        complete: () => {
          if (this.ownerLaunch !== launch || this.closed) return false;
          launch.opened = true;
          if (launch.used) this.ownerLaunch = undefined;
          return true;
        },
      };
    } finally {
      this.ownerIssuing = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifecycleGeneration += 1;
    this.accepting = false;
    this.embeddedReady = false;
    this.ownerLaunch = undefined;
    this.sessions.clear();
    this.options.preparationMonitor?.stop();
    await this.listenerStarting?.catch(() => {});
    for (const controller of this.extractionControllers) controller.abort();
    for (const controller of this.pluginBuildControllers) controller.abort();
    this.chatProgress.clear();
    if (this.server) {
      const closing = this.server;
      await new Promise<void>((ok, fail) => {
        closing.close((error) => (error ? fail(error) : ok()));
        closing.closeIdleConnections();
        closing.closeAllConnections();
      });
      this.server = undefined;
    }
    this.bound = undefined;
    if (this.activeRequests.size) {
      const settled = Promise.allSettled(this.activeRequests),
        deadline = this.options.closeDrainMs ?? 5_000;
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        settled.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), deadline);
          timer.unref();
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!drained)
        throw new Error("Life requests are still active; retry close after they settle.");
    }
    if (
      this.options.harness.improvements &&
      !(await this.options.harness.improvements.settleActive(this.options.closeDrainMs ?? 5_000))
    )
      throw new Error("Improvement reviews are still active; retry close after they settle.");
  }
  private authorityCurrent(): boolean {
    return this.captureAuthority()();
  }
  private captureAuthority(): () => boolean {
    const context = this.embeddedRequest.getStore()?.context;
    return () => this.contextIsCurrent(context);
  }
  private contextIsCurrent(context?: LifeEmbeddedContext): boolean {
    if (!context) return true;
    try {
      return (
        context.actorId === this.actor.userId && !context.signal.aborted && context.isCurrent()
      );
    } catch {
      return false;
    }
  }
  private assertRequestAuthority(): void {
    if (!this.authorityCurrent()) throw new HttpError(401, "Life access is no longer available.");
  }
  private requestController(): AbortController {
    const controller = new AbortController();
    const state = this.embeddedRequest.getStore();
    if (state) {
      const abort = () => controller.abort(new Error("Life access is no longer available."));
      if (!this.authorityCurrent()) abort();
      else {
        state.context.signal.addEventListener("abort", abort, { once: true });
        state.cleanups.add(() => state.context.signal.removeEventListener("abort", abort));
      }
    }
    return controller;
  }
  private headers(response: ServerResponse, extra: Record<string, string> = {}): void {
    this.assertRequestAuthority();
    for (const [key, value] of Object.entries({ ...BASE_HEADERS, ...extra }))
      response.setHeader(key, value);
  }
  private send(
    response: ServerResponse,
    status: number,
    value?: unknown,
    extra: Record<string, string> = {},
  ): void {
    this.headers(response, { ...JSON_HEADERS, ...extra });
    response.statusCode = status;
    response.end(value === undefined ? undefined : JSON.stringify(value));
  }
  private fail(response: ServerResponse, error: unknown): void {
    if (response.destroyed || response.writableEnded) return;
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof LifeAccessError ||
            (error instanceof PluginError && error.code === "forbidden")
          ? 403
          : error instanceof LifeConflictError ||
              (error instanceof PluginError && error.code === "conflict")
            ? 409
            : error instanceof PluginError && error.code === "not_found"
              ? 404
              : error instanceof TypeError || error instanceof PluginError
                ? 400
                : 500;
    const authorized = this.authorityCurrent();
    this.embeddedRequest.run(undefined, () => {
      this.send(response, authorized ? status : 401, {
        error: !authorized
          ? "Life access is no longer available."
          : status === 500
            ? "Request failed."
            : error instanceof Error
              ? error.message
              : "Request failed.",
      });
    });
  }
  private validateHost(request: IncomingMessage): string {
    if (!this.bound) throw new HttpError(503, "Not ready.");
    const expected = `${this.bound.host}:${this.bound.port}`;
    if (request.headers.host !== expected) throw new HttpError(400, "Invalid Host header.");
    return this.bound.url;
  }
  private validateOrigin(request: IncomingMessage, url: string): void {
    if (request.method !== "GET" && request.method !== "HEAD" && request.headers.origin !== url)
      throw new HttpError(403, "Valid local Origin required.");
  }
  private cookie(request: IncomingMessage): string | undefined {
    const raw = request.headers.cookie ?? "";
    for (const part of raw.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === SESSION_COOKIE) return rest.join("=");
    }
    return undefined;
  }
  private authenticated(request: IncomingMessage): boolean {
    const value = this.cookie(request);
    if (!value || value.length > 256) return false;
    const expires = this.sessions.get(digest(value).toString("hex"));
    if (!expires || expires <= this.now()) {
      if (expires) this.sessions.delete(digest(value).toString("hex"));
      return false;
    }
    return true;
  }
  private async body(request: IncomingMessage, limit = ORDINARY_LIMIT): Promise<unknown> {
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    )
      throw new HttpError(415, "Content-Type must be application/json.");
    const declared = Number(request.headers["content-length"] ?? 0);
    if (declared > limit) throw new HttpError(413, "Request body is too large.");
    const parts: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => request.destroy(new Error("deadline")), DEADLINE_MS);
    try {
      for await (const part of request) {
        this.assertRequestAuthority();
        const chunk = Buffer.from(part);
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "Request body is too large.");
        parts.push(chunk);
      }
      this.assertRequestAuthority();
      try {
        return JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        throw new HttpError(400, "Malformed JSON.");
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  private scope(value: unknown): LifeScope {
    this.assertRequestAuthority();
    let type: unknown, id: unknown;
    if (typeof value === "string") {
      const split = value.indexOf(":");
      type = value.slice(0, split);
      id = value.slice(split + 1);
    } else {
      const object = jsonObject(value);
      type = object.type;
      id = object.id;
    }
    if (type !== "user" && type !== "group") throw new HttpError(400, "Scope is invalid.");
    const scope = { type, id: identifier(id, "scope id") } as LifeScope;
    if (scope.type === "user" && scope.id !== this.actor.userId)
      throw new HttpError(403, "Scope is unavailable.");
    if (
      scope.type === "group" &&
      !this.options.store.listGroups(this.actor).some((group) => group.id === scope.id)
    )
      throw new HttpError(403, "Scope is unavailable.");
    return scope;
  }
  private authorizedOwners(): OwnerScope[] {
    return [
      `user:${this.actor.userId}`,
      ...this.options.store
        .listGroups(this.actor)
        .map((group) => `group:${group.id}` as OwnerScope),
    ];
  }
  private dateForScope(scope: LifeScope): string {
    const configured = this.timeZoneForScope(scope);
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: configured,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    }
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(this.now()))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  private timeZoneForScope(scope: LifeScope): string {
    const settings = this.options.store.resolveSettings(
        this.actor,
        scope.type === "group" ? { groupId: scope.id } : {},
      ).values,
      configured =
        typeof settings.timeZone === "string"
          ? settings.timeZone
          : (this.options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured }).format(0);
      return configured;
    } catch {
      return "UTC";
    }
  }
  private recheckOwner(ownerId: OwnerScope): void {
    const split = ownerId.indexOf(":"),
      type = ownerId.slice(0, split) as "user" | "group",
      id = ownerId.slice(split + 1);
    this.scope({ type, id });
  }
  private findPlugin(id: string): { plugin: LifePlugin; owner: OwnerScope } {
    for (const candidate of this.authorizedOwners()) {
      const found = this.options.plugins.list(candidate).find((plugin) => plugin.id === id);
      if (found) return { plugin: found, owner: candidate };
    }
    throw new HttpError(404, "Plugin not found.");
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.assertRequestAuthority();
      const embedded = this.embeddedRequest.getStore()?.context;
      const origin = embedded?.origin ?? this.validateHost(request);
      if (!embedded) this.validateOrigin(request, origin);
      const url = new URL(request.url ?? "/", origin),
        path = url.pathname;
      if (embedded) {
        if (path === "/api/life/session") throw new HttpError(404, "Route not found.");
        if (path === "/api/connections/start" || path === "/api/connections/callback")
          throw new HttpError(409, "Connect accounts directly on the Mac hosting Ellie.");
        if (path === "/life/" || path.startsWith("/life/assets/")) {
          if (request.method !== "GET" && request.method !== "HEAD")
            throw new HttpError(405, "Method not allowed.");
          return await this.static(
            response,
            path === "/life/" ? "/" : path.slice("/life".length),
            request.method === "HEAD",
          );
        }
      }
      if (
        request.method === "GET" &&
        (path === "/connections/complete" || path === "/connections/cancelled")
      ) {
        const cancelled = path === "/connections/cancelled";
        response.writeHead(200, {
          ...BASE_HEADERS,
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
        });
        response.end(
          `<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Return to Ellie</title><style>body{font:20px system-ui;background:#eef5f5;color:#173c42;max-width:32rem;margin:15vh auto;padding:2rem}h1{font-size:32px}</style><h1>${cancelled ? "Connection canceled." : "Return to Ellie."}</h1><p>${cancelled ? "You can try connecting again from Settings." : "Your connection status will update there automatically. You can close this tab."}</p>`,
        );
        return;
      }
      if (path === "/api/connections/callback" && request.method === "GET") {
        if (this.personalResetActive || !this.options.connectors)
          throw new HttpError(423, "Connected work is unavailable.");
        if (url.searchParams.has("error")) {
          try {
            await this.options.connectors.cancelAuthorization(
              bounded(url.searchParams.get("state"), "OAuth state", 256),
            );
          } catch {
            throw new HttpError(400, "Connection authorization is unavailable.");
          }
          response.writeHead(303, { ...BASE_HEADERS, location: "/connections/cancelled" });
          response.end();
          return;
        }
        try {
          await this.options.connectors.callback(
            bounded(url.searchParams.get("state"), "OAuth state", 256),
            bounded(url.searchParams.get("code"), "OAuth code", 4096),
            `${origin}/api/connections/callback`,
            AbortSignal.timeout(30_000),
          );
        } catch {
          throw new HttpError(
            400,
            "Account connection did not finish. Return to Settings and try again.",
          );
        }
        if (this.options.openAuthorizationUrl) {
          response.writeHead(303, { ...BASE_HEADERS, location: "/connections/complete" });
          response.end();
        } else {
          response.writeHead(303, { ...BASE_HEADERS, location: "/?connected=1" });
          response.end();
        }
        return;
      }
      if (path === "/api/life/session" && request.method === "POST") {
        await this.session(request, response);
        return;
      }
      if (
        (path.startsWith("/api/life/") || path.startsWith("/api/connections")) &&
        !embedded &&
        !this.authenticated(request)
      )
        throw new HttpError(401, "Authentication required.");
      if (
        this.personalResetActive &&
        request.method !== "GET" &&
        !path.startsWith("/api/life/personal-data/reset")
      )
        throw new HttpError(423, "Personal reset is in progress.");
      if (path === "/api/connections" && request.method === "GET") {
        const listing = this.options.connectors?.list(this.actor.userId) ?? {
          connections: [],
          providers: [],
        };
        this.send(
          response,
          200,
          embedded
            ? {
                ...listing,
                providers: listing.providers.map((provider) => ({
                  ...provider,
                  configured: false,
                  setupMessage: "Connect accounts directly on the Mac hosting Ellie.",
                })),
              }
            : listing,
        );
        return;
      }
      const connectionRead = /^\/api\/connections\/([^/]+)\/(calendars|preview|agenda)$/.exec(path);
      if (connectionRead && request.method === "GET") {
        const connectors = this.options.connectors;
        if (!connectors) throw new HttpError(503, "Connected accounts are unavailable.");
        const id = identifier(decodeURIComponent(connectionRead[1]!));
        const connection = connectors.store.get(this.actor.userId, id);
        if (!connection || connection.state === "revoked")
          throw new HttpError(404, "Connection is unavailable.");
        const displayTimeZone = url.searchParams.get("timeZone");
        if (
          connectionRead[2] === "agenda" &&
          (url.searchParams.size !== 1 ||
            !displayTimeZone ||
            !/^[A-Za-z0-9_+./-]{1,80}$/.test(displayTimeZone))
        )
          throw new HttpError(400, "Calendar display time zone is invalid.");
        this.send(
          response,
          200,
          connectionRead[2] === "calendars"
            ? await connectors.calendars(this.actor.userId, id)
            : connectionRead[2] === "agenda"
              ? connectors.agenda(this.actor.userId, id, displayTimeZone!)
              : connectors.preview(this.actor.userId, id),
        );
        return;
      }
      if (path.startsWith("/api/connections/") && request.method === "POST") {
        const connectors = this.options.connectors;
        if (!connectors) throw new HttpError(503, "Connected accounts are unavailable.");
        const body = jsonObject(await this.body(request));
        const mode = () => {
          if (body.mode !== "observe" && body.mode !== "prepare")
            throw new HttpError(400, "Connection mode is invalid.");
          return body.mode;
        };
        if (path === "/api/connections/start") {
          if (body.provider !== "google-calendar" && body.provider !== "gmail")
            throw new HttpError(400, "Provider requires host setup.");
          if (
            !connectors.list(this.actor.userId).providers.find((p) => p.id === body.provider)
              ?.configured
          )
            throw new HttpError(
              409,
              "Register a Google desktop OAuth client in host configuration first.",
            );
          const started = await connectors.start(
            this.actor.userId,
            body.provider,
            mode(),
            `${origin}/api/connections/callback`,
          );
          const openedExternally = this.options.openAuthorizationUrl
            ? await this.options.openAuthorizationUrl(started.authorizationUrl).catch(() => false)
            : false;
          this.send(response, 200, { ...started, openedExternally });
          return;
        }
        const calendarSelection = /^\/api\/connections\/([^/]+)\/calendar$/.exec(path);
        if (calendarSelection) {
          const id = identifier(decodeURIComponent(calendarSelection[1]!));
          const connection = connectors.store.get(this.actor.userId, id);
          if (!connection || connection.state === "revoked")
            throw new HttpError(404, "Connection is unavailable.");
          if (typeof body.calendarId !== "string" || body.calendarId.length > 1_024)
            throw new HttpError(400, "Calendar selection is invalid.");
          await connectors.selectCalendar(this.actor.userId, id, body.calendarId);
          this.options.harness.invalidateActorContext?.(this.actor);
          this.send(response, 200, { ok: true });
          return;
        }
        const match = /^\/api\/connections\/([^/]+)\/(refresh|revoke|mode)$/.exec(path);
        if (!match) throw new HttpError(404, "Connection route is unavailable.");
        const id = identifier(decodeURIComponent(match[1]!));
        if (!connectors.store.get(this.actor.userId, id))
          throw new HttpError(404, "Connection is unavailable.");
        if (match[2] === "refresh") await connectors.refresh(this.actor.userId, id);
        else if (match[2] === "revoke") await connectors.revoke(this.actor.userId, id);
        else await connectors.setMode(this.actor.userId, id, mode());
        this.options.harness.invalidateActorContext?.(this.actor);
        this.send(response, 200, { ok: true });
        return;
      }
      if (path === "/api/life/personal-data/review" && request.method === "GET")
        return this.personalDataReview(response);
      if (path === "/api/life/personal-data/export" && request.method === "GET")
        return this.personalDataExport(url, response);
      if (path === "/api/life/personal-data/reset" && request.method === "POST")
        return await this.personalDataReset(request, response);
      if (path === "/api/life/personal-data/reset" && request.method === "GET")
        return this.personalDataCurrentReset(response);
      if (/^\/api\/life\/personal-data\/reset\/[^/]+$/.test(path) && request.method === "GET")
        return this.personalDataResetStatus(path, response);
      if (
        /^\/api\/life\/personal-data\/reset\/[^/]+\/retry$/.test(path) &&
        request.method === "POST"
      )
        return await this.personalDataResetRetry(request, path, response);
      if (path === "/api/life/bootstrap" && request.method === "GET")
        return await this.bootstrap(url, response);
      if (path === "/api/life/model/status" && request.method === "GET")
        return await this.modelStatus(response);
      if (path === "/api/life/groups" && request.method === "POST")
        return await this.group(request, response);
      if (path === "/api/life/groups" && request.method === "GET") return this.groups(response);
      if (/^\/api\/life\/groups\/[^/]+$/.test(path) && request.method === "PATCH")
        return await this.renameGroup(request, response, path);
      if (path === "/api/life/plans" && request.method === "GET")
        return this.planList(url, response);
      if (path === "/api/life/plans" && request.method === "POST")
        return await this.planCreate(request, response);
      if (/^\/api\/life\/plans\/[^/]+$/.test(path) && request.method === "GET")
        return this.planDetail(path, response);
      if (/^\/api\/life\/plans\/[^/]+\/steps\/[^/]+$/.test(path) && request.method === "POST")
        return await this.planStep(request, path, response);
      if (path === "/api/life/records" && request.method === "POST")
        return await this.createRecord(request, response);
      if (path === "/api/life/records" && request.method === "GET")
        return this.records(url, response);
      if (/^\/api\/life\/records\/[^/]+$/.test(path) && request.method === "GET")
        return this.recordDetail(response, path);
      if (path === "/api/life/search" && request.method === "GET")
        return this.search(url, response);
      if (
        path.startsWith("/api/life/records/") &&
        (request.method === "PATCH" || request.method === "DELETE")
      )
        return await this.recordMutation(request, response, url);
      if (path === "/api/life/sources" && request.method === "POST")
        return await this.source(request, response);
      if (path === "/api/life/sources/binary" && request.method === "POST")
        return await this.binarySource(request, response, url);
      if (path === "/api/life/import/preview" && request.method === "POST")
        return await this.importPreview(request, response);
      if (path === "/api/life/import/commit" && request.method === "POST")
        return await this.importCommit(request, response);
      if (path === "/api/life/settings" && request.method === "POST")
        return await this.settings(request, response);
      if (path === "/api/life/feedback" && request.method === "POST")
        return await this.feedback(request, response);
      if (path === "/api/life/learning" && request.method === "GET")
        return this.learningList(url, response);
      if (path === "/api/life/learning" && request.method === "POST")
        return await this.learningRecord(request, response);
      if (/^\/api\/life\/learning\/[^/]+\/selection$/.test(path) && request.method === "POST")
        return await this.learningSelection(request, response, path);
      if (path === "/api/life/learning/export" && request.method === "POST")
        return await this.learningExport(request, response);
      if (path === "/api/life/improvements" && request.method === "GET")
        return this.improvementsList(response);
      if (path === "/api/life/improvements" && request.method === "POST")
        return await this.improvementPropose(request, response);
      if (/^\/api\/life\/improvements\/[^/]+$/.test(path) && request.method === "GET")
        return this.improvementDetail(path, response);
      if (
        /^\/api\/life\/improvements\/[^/]+\/(adopt|dismiss)$/.test(path) &&
        request.method === "POST"
      )
        return await this.improvementMutation(request, response, path);
      if (path === "/api/life/teaching" && request.method === "GET")
        return this.teachingList(url, response);
      if (path === "/api/life/teaching" && request.method === "POST")
        return await this.teachingCreate(request, response);
      if (/^\/api\/life\/teaching\/[^/]+$/.test(path) && request.method === "GET")
        return this.teachingDetail(path, response);
      if (
        /^\/api\/life\/teaching\/[^/]+\/(revise|enabled|rollback)$/.test(path) &&
        request.method === "POST"
      )
        return await this.teachingMutation(request, response, path);
      if (path === "/api/life/chat" && request.method === "POST")
        return await this.chat(request, response);
      if (/^\/api\/life\/chat\/requests\/[^/]+$/.test(path) && request.method === "GET")
        return this.chatRequest(path, response);
      if (path === "/api/life/memory" && request.method === "GET") {
        const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
          memory = this.automaticMemory.context(this.actor, { scope, maxBytes: 16 * 1024 });
        this.send(response, 200, {
          summary: memory.summaryMarkdown,
          entries: memory.entries,
          partial: memory.partial,
          revision: memory.revision,
        });
        return;
      }
      if (path === "/api/life/conversations" && request.method === "GET")
        return this.conversations(url, response);
      if (
        /^\/api\/life\/conversations\/[^/]+\/pending-intent$/.test(path) &&
        request.method === "GET"
      )
        return this.pendingIntentDetail(path, response);
      if (
        /^\/api\/life\/conversations\/[^/]+\/pending-intent$/.test(path) &&
        request.method === "DELETE"
      )
        return this.pendingIntentDelete(path, url, response);
      if (/^\/api\/life\/conversations\/[^/]+$/.test(path) && request.method === "GET")
        return this.conversation(path, url, response);
      if (/^\/api\/life\/conversations\/[^/]+$/.test(path) && request.method === "DELETE")
        return this.conversationDelete(path, url, response);
      if (path === "/api/life/signals" && request.method === "POST")
        return await this.signal(request, response);
      if (
        /^\/api\/life\/notifications\/[^/]+\/(dismiss|complete)$/.test(path) &&
        request.method === "POST"
      )
        return await this.notification(request, response, path);
      if (
        /^\/api\/life\/tasks\/[^/]+\/(pause|resume|cancel|run)$/.test(path) &&
        request.method === "POST"
      )
        return await this.task(request, response, path);
      if (/^\/api\/life\/tasks\/[^/]+\/detail$/.test(path) && request.method === "GET")
        return this.taskDetail(response, path);
      if (path === "/api/life/plugins/build" && request.method === "POST")
        return await this.build(request, response);
      if (/^\/api\/life\/plugins\/[^/]+\/view$/.test(path) && request.method === "GET")
        return this.pluginView(response, path);
      if (/^\/api\/life\/plugins\/[^/]+\/history$/.test(path) && request.method === "GET")
        return this.pluginHistory(response, path);
      if (/^\/api\/life\/plugins\/[^/]+\/action$/.test(path) && request.method === "POST")
        return await this.pluginAction(request, response, path);
      if (/^\/api\/life\/plugins\/[^/]+\/rollback$/.test(path) && request.method === "POST")
        return await this.pluginRollback(request, response, path);
      if (/^\/api\/life\/plugins\/[^/]+\/revise$/.test(path) && request.method === "POST")
        return await this.pluginRevise(request, response, path);
      if (/^\/api\/life\/plugins\/[^/]+$/.test(path) && request.method === "DELETE")
        return this.pluginDelete(response, path);
      if (path.startsWith("/api/")) throw new HttpError(404, "Route not found.");
      if (request.method !== "GET" && request.method !== "HEAD")
        throw new HttpError(405, "Method not allowed.");
      return await this.static(response, path, request.method === "HEAD");
    } catch (error) {
      this.fail(response, error);
    }
  }
  private async session(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const now = this.now();
    this.attempts = this.attempts.filter((at) => at > now - 60_000);
    if (this.attempts.length >= 20) throw new HttpError(429, "Too many session attempts.");
    this.attempts.push(now);
    const token = jsonObject(await this.body(request)).token;
    if (typeof token !== "string") throw new HttpError(401, "Invalid or expired launch token.");
    const candidate = digest(token),
      owner = this.ownerLaunch,
      ownerMatch = Boolean(
        owner && !owner.used && owner.expiresAt >= now && sameDigest(candidate, owner.hash),
      ),
      standaloneMatch =
        !this.tokenUsed &&
        now - this.tokenCreatedAt <= (this.options.tokenTtlMs ?? 600_000) &&
        sameDigest(candidate, this.tokenHash);
    if (!ownerMatch && !standaloneMatch)
      throw new HttpError(401, "Invalid or expired launch token.");
    if (ownerMatch) owner!.used = true;
    else this.tokenUsed = true;
    const session = randomBytes(32).toString("base64url");
    const sessionTtlMs = ownerMatch ? 1_800_000 : (this.options.sessionTtlMs ?? 43_200_000);
    const sessionHash = digest(session).toString("hex");
    this.sessions.set(sessionHash, now + sessionTtlMs);
    if (ownerMatch) {
      owner!.sessionHash = sessionHash;
      if (owner!.opened) this.ownerLaunch = undefined;
    }
    this.send(response, 204, undefined, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
    });
  }
  private taskPersonalSummary(expectedGeneration?: number): {
    generation: number;
    tasks: number;
    watches: number;
    watchEvents: number;
    progress: number;
    bytes: number;
    truncated: boolean;
  } {
    const summary = this.options.tasks.personalSummary(`user:${this.actor.userId}`);
    if (expectedGeneration !== undefined && summary.generation !== expectedGeneration)
      throw new LifeConflictError("Personal task data changed; review again.");
    return { ...summary, truncated: false };
  }
  private personalDataReview(response: ServerResponse): void {
    if (this.personalResetActive)
      throw new HttpError(409, "A personal reset is already in progress.");
    const life = this.options.store.personalSummary(this.actor),
      tasks = this.taskPersonalSummary(),
      plugins = this.options.plugins.personalSummary(this.actor.userId),
      token = randomBytes(32).toString("base64url"),
      expiresAt = this.now() + 600_000;
    const connectors = this.options.connectors?.store.summary(this.actor.userId);
    this.personalReviews.clear();
    this.personalReviews.set(digest(token).toString("hex"), {
      expiresAt,
      life: life.generation,
      tasks: tasks.generation,
      plugins: plugins.generation,
      ...(connectors ? { connectors: connectors.generation } : {}),
    });
    this.send(response, 200, {
      reviewToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
      generations: {
        life: life.generation,
        tasks: tasks.generation,
        plugins: plugins.generation,
        ...(connectors ? { connectors: connectors.generation } : {}),
      },
      counts: {
        privateRecords: life.records,
        sources: life.sources,
        feedback: life.feedback,
        guidance: life.guidance,
        userSettings: life.settings,
        conversations: life.conversations,
        conversationTurns: life.conversationTurns,
        conversationPreferences: life.conversationPreferences,
        pendingIntents: life.pendingIntents,
        tasks: tasks.tasks,
        watches: tasks.watches,
        watchEvents: tasks.watchEvents,
        taskProgress: tasks.progress,
        plugins: plugins.plugins,
        pluginVersions: plugins.versions,
        pluginStorageKeys: plugins.storageKeys,
        sharedPluginStorageKeys: plugins.sharedStorageKeys,
        ...(connectors
          ? { connections: connectors.connections, connectedEvidence: connectors.evidence }
          : {}),
      },
      bytes: life.bytes + tasks.bytes + plugins.bytes + (connectors?.bytes ?? 0),
      truncated: tasks.truncated,
      preserves: ["group memberships", "shared records", "shared apps", "shared tasks"],
    });
  }
  private personalReview(token: unknown): {
    expiresAt: number;
    life: number;
    tasks: number;
    plugins: number;
    connectors?: number;
  } {
    if (typeof token !== "string" || token.length > 256)
      throw new HttpError(403, "A fresh personal-data review is required.");
    const found = this.personalReviews.get(digest(token).toString("hex"));
    if (!found || found.expiresAt <= this.now())
      throw new HttpError(403, "A fresh personal-data review is required.");
    return found;
  }
  private personalDataExport(url: URL, response: ServerResponse): void {
    const review = this.personalReview(url.searchParams.get("reviewToken")),
      store = url.searchParams.get("store"),
      cursor = url.searchParams.get("cursor") ?? undefined,
      rawLimit = url.searchParams.get("limit"),
      limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
      throw new HttpError(400, "Export limit must be from 1 through 100.");
    let page: unknown;
    if (store === "life")
      page = this.options.store.exportPersonalPage(this.actor, {
        cursor,
        limit,
        expectedGeneration: review.life,
      });
    else if (store === "tasks")
      page = this.options.tasks.exportPersonal({
        owner: `user:${this.actor.userId}`,
        cursor,
        limit,
        expectedGeneration: review.tasks,
      });
    else if (store === "plugins")
      page = this.options.plugins.exportPersonal(this.actor.userId, {
        cursor,
        limit,
        expectedGeneration: review.plugins,
      });
    else if (store === "connectors" && this.options.connectors && review.connectors !== undefined) {
      if (this.options.connectors.store.generation(this.actor.userId) !== review.connectors)
        throw new HttpError(409, "Connected data changed; review again before exporting.");
      page = this.options.connectors.store.exportPage(this.actor.userId, {
        expectedGeneration: review.connectors,
        cursor,
        limit,
      });
    } else throw new HttpError(400, "Export store must be life, tasks, plugins, or connectors.");
    this.send(response, 200, page);
  }
  private resetStatus(
    value: NonNullable<ReturnType<LifeStore["getPersonalReset"]>>,
  ): Record<string, unknown> {
    const runtime = this.options.tasks.getPersonalDeletion(`user:${this.actor.userId}`);
    return {
      operationId: value.operationId,
      state: value.state,
      requestedAt: new Date(value.requestedAt).toISOString(),
      updatedAt: new Date(value.updatedAt).toISOString(),
      runtimeState: runtime?.state,
      unknownTaskIds: runtime?.unknownTaskIds ?? [],
    };
  }
  private async settleActorMutations(): Promise<boolean> {
    for (const controller of this.extractionControllers) controller.abort();
    for (const controller of this.pluginBuildControllers) controller.abort();
    this.chatProgress.clear();
    if (!this.mutationRequests.size)
      return this.options.harness.improvements
        ? await this.options.harness.improvements.settleActive(5_000)
        : true;
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.allSettled(this.mutationRequests).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) return false;
    return this.options.harness.improvements
      ? await this.options.harness.improvements.settleActive(5_000)
      : true;
  }
  private async continuePersonalReset(
    operationId: string,
    requireReviewedTaskGeneration = false,
  ): Promise<ReturnType<LifeStore["getPersonalReset"]>> {
    if (this.resetInFlight) {
      if (this.resetInFlight.operationId !== operationId)
        throw new HttpError(409, "Another personal reset is in progress.");
      return this.resetInFlight.promise;
    }
    const promise = this.performPersonalReset(operationId, requireReviewedTaskGeneration);
    this.resetInFlight = { operationId, promise };
    try {
      return await promise;
    } finally {
      if (this.resetInFlight?.promise === promise) this.resetInFlight = undefined;
    }
  }
  private async performPersonalReset(
    operationId: string,
    requireReviewedTaskGeneration: boolean,
  ): Promise<ReturnType<LifeStore["getPersonalReset"]>> {
    const ownerId = `user:${this.actor.userId}` as const;
    let journal = this.options.store.getPersonalReset(this.actor);
    if (!journal || journal.operationId !== operationId)
      throw new HttpError(404, "Personal reset is unavailable.");
    if (journal.state === "completed") {
      return journal;
    }
    this.personalResetActive = true;
    this.options.preparationMonitor?.stop();
    this.options.connectors?.block(this.actor.userId);
    this.options.harness.invalidateActorContext?.(this.actor);
    const runtimeDeletion = this.options.tasks.getPersonalDeletion(ownerId);
    this.options.tasks.beginPersonalDeletion(
      ownerId,
      operationId,
      runtimeDeletion?.operationId === operationId || !requireReviewedTaskGeneration
        ? {}
        : { expectedGeneration: journal.taskGeneration },
    );
    if (journal.state === "draining") {
      if (!(await this.settleActorMutations())) return journal;
      const runtime = await this.options.tasks.drainPersonalDeletion(ownerId, operationId, {
        timeoutMs: 5_000,
      });
      if (runtime.state !== "ready" && runtime.state !== "completed") return journal;
      journal = this.options.store.advancePersonalReset(this.actor, operationId, "tasks-deleted");
    }
    if (journal.state === "tasks-deleted") {
      await this.options.connectors?.deletePersonal(this.actor.userId);
      this.options.plugins.deletePersonal(this.actor.userId);
      journal = this.options.store.advancePersonalReset(this.actor, operationId, "plugins-deleted");
    }
    if (journal.state === "plugins-deleted") {
      this.options.store.deletePersonal(this.actor, { preserveMemberships: true });
      journal = this.options.store.advancePersonalReset(this.actor, operationId, "life-deleted");
    }
    if (journal.state === "life-deleted") {
      this.automaticMemory.clearActor(this.actor);
      this.options.harness.invalidateActorContext?.(this.actor);
      this.options.tasks.completePersonalDeletion(ownerId, operationId);
      journal = this.options.store.advancePersonalReset(this.actor, operationId, "completed");
      this.personalResetActive = false;
      this.options.connectors?.unblock(this.actor.userId);
      if (this.bound || this.embeddedReady) this.options.preparationMonitor?.start();
      this.personalReviews.clear();
    }
    return journal;
  }
  private async personalDataReset(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = jsonObject(await this.body(request)),
      review = this.personalReview(body.reviewToken),
      operationId = randomUUID();
    if (this.personalResetActive || this.resetInFlight)
      throw new HttpError(409, "A personal reset is already in progress.");
    if (this.recoverReminderReschedules().blocked)
      throw new HttpError(
        409,
        "A shared reminder reschedule needs authorized recovery before personal reset.",
      );
    this.personalResetActive = true;
    this.options.preparationMonitor?.stop();
    this.options.connectors?.block(this.actor.userId);
    this.options.harness.invalidateActorContext?.(this.actor);
    if (!(await this.settleActorMutations())) {
      this.personalResetActive = false;
      this.options.connectors?.unblock(this.actor.userId);
      if (this.bound || this.embeddedReady) this.options.preparationMonitor?.start();
      throw new HttpError(409, "Active personal work did not settle; review reset again.");
    }
    // Preflight every generation before creating the durable authorization journal.
    try {
      this.options.store.exportPersonalPage(this.actor, {
        limit: 1,
        expectedGeneration: review.life,
      });
      this.taskPersonalSummary(review.tasks);
      this.options.plugins.exportPersonal(this.actor.userId, {
        limit: 1,
        expectedGeneration: review.plugins,
      });
      if (
        this.options.connectors &&
        this.options.connectors.store.generation(this.actor.userId) !== review.connectors
      )
        throw new HttpError(409, "Connected data changed; review reset again.");
      this.assertRequestAuthority();
      this.options.store.beginPersonalReset(this.actor, {
        operationId,
        reviewTokenHash: digest(String(body.reviewToken)).toString("hex"),
        lifeGeneration: review.life,
        taskGeneration: review.tasks,
        pluginGeneration: review.plugins,
      });
    } catch (error) {
      this.personalResetActive = false;
      this.options.connectors?.unblock(this.actor.userId);
      if (this.bound || this.embeddedReady) this.options.preparationMonitor?.start();
      throw error;
    }
    const journal = await this.embeddedRequest.run(undefined, () =>
      this.continuePersonalReset(operationId, true),
    );
    this.send(response, journal?.state === "completed" ? 200 : 202, this.resetStatus(journal!));
  }
  private personalDataResetStatus(path: string, response: ServerResponse): void {
    const operationId = identifier(decodeURIComponent(path.split("/").at(-1)!), "operationId"),
      journal = this.options.store.getPersonalReset(this.actor);
    if (!journal || journal.operationId !== operationId)
      throw new HttpError(404, "Personal reset is unavailable.");
    this.send(response, 200, this.resetStatus(journal));
  }
  private personalDataCurrentReset(response: ServerResponse): void {
    const journal = this.options.store.getPersonalReset(this.actor);
    this.send(response, 200, {
      reset: journal && journal.state !== "completed" ? this.resetStatus(journal) : null,
    });
  }
  private async personalDataResetRetry(
    request: IncomingMessage,
    path: string,
    response: ServerResponse,
  ): Promise<void> {
    jsonObject(await this.body(request));
    const operationId = identifier(decodeURIComponent(path.split("/").at(-2)!), "operationId");
    const journal = await this.embeddedRequest.run(undefined, () =>
      this.continuePersonalReset(operationId),
    );
    this.send(response, journal?.state === "completed" ? 200 : 202, this.resetStatus(journal!));
  }
  private async bootstrap(url: URL, response: ServerResponse): Promise<void> {
    const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
      ownerId = owner(scope);
    const recordsPage = this.options.store.listRecordSummaries(this.actor, { scope, limit: 100 }),
      agendaKinds: LifeRecordKind[] = ["reminder", "timer", "event", "birthday", "holiday"],
      agendaPage = this.options.store.listRecordSummaries(this.actor, {
        scope,
        kinds: agendaKinds,
        limit: 100,
      }),
      notificationPage = this.options.store.listRecordSummaries(this.actor, {
        scope,
        kinds: ["event", "feedback"],
        limit: 500,
      }),
      needRecords = this.options.store.listRecordSummaries(this.actor, {
        scope,
        kinds: ["need"],
        limit: 500,
      }).items,
      supportingRecords = this.options.store.listRecordSummaries(this.actor, {
        scope,
        limit: 500,
      }).items,
      records = recordsPage.items.map((record) => this.recordDto(record, true)),
      tasks = this.options.tasks
        .list({ owner: ownerId })
        .map((task) => serializeTask(task, supportingRecords)),
      ownedPlugins = this.options.plugins.list(ownerId),
      settings = this.options.store.resolveSettings(
        this.actor,
        scope.type === "group" ? { groupId: scope.id } : {},
      );
    const plugins = await Promise.all(
      ownedPlugins.map(async (plugin) => {
        const summary = serializePlugin(plugin);
        if (plugin.kind === "arcade")
          summary.data = {
            ...(summary.data as Record<string, unknown>),
            highScore:
              this.options.plugins.storageGet(
                ownerId,
                plugin.id,
                ownerId.startsWith("group:")
                  ? groupStorageKey(this.actor.userId, "highScore")
                  : "highScore",
              ) ?? 0,
          };
        if (plugin.kind === "mlb")
          summary.data = {
            ...(summary.data as Record<string, unknown>),
            snapshot: this.options.mlb
              ? await this.options.mlb.snapshot(this.dateForScope(scope))
              : { stale: true, error: "MLB data is unavailable." },
          };
        return summary;
      }),
    );
    const reminderNotifications = notificationPage.items
        .filter(
          (record) =>
            record.kind === "event" &&
            record.data.type === "notification" &&
            record.data.dismissed !== true,
        )
        .map((record) => ({
          id: record.id,
          title: record.title,
          body: record.bodyPreview,
          revision: record.revision,
          reminderId: record.data.reminderId,
          deliveredAt: record.data.deliveredAt,
        })),
      proactiveNotifications = notificationPage.items
        .filter((record) => {
          if (
            record.kind !== "feedback" ||
            record.data.notification !== true ||
            record.data.dismissed === true ||
            (typeof record.data.expiresAt === "number" && record.data.expiresAt <= this.now())
          )
            return false;
          if (record.data.category !== "preparation") return true;
          if (typeof record.data.relatedRecordId !== "string") return false;
          const event = this.options.store.getRecord(this.actor, record.data.relatedRecordId);
          return Boolean(
            event &&
            event.kind === "event" &&
            event.scope.type === scope.type &&
            event.scope.id === scope.id &&
            eventPreparationWindow(event, this.now(), this.timeZoneForScope(scope)),
          );
        })
        .map((record) => ({
          id: record.id,
          title: record.title,
          body: record.bodyPreview,
          revision: record.revision,
          ...(needRecords.some((candidate) => candidate.id === record.data.relatedRecordId)
            ? { needId: record.data.relatedRecordId }
            : {}),
          ...record.data,
        })),
      notifications = [...reminderNotifications, ...proactiveNotifications];
    this.recheckOwner(ownerId);
    this.send(response, 200, {
      profile: {
        id: this.actor.userId,
        name: this.options.userName ?? "You",
        timeZone: this.timeZoneForScope(scope),
      },
      groups: this.options.store.listGroups(this.actor).map((group) => this.groupDto(group)),
      scope: ownerId,
      records,
      recordsPage: {
        hasMore: recordsPage.hasMore,
        ...(recordsPage.nextCursor ? { nextCursor: recordsPage.nextCursor } : {}),
      },
      agendaRecords: agendaPage.items.map((record) => this.recordDto(record, true)),
      agendaPage: {
        hasMore: agendaPage.hasMore,
        ...(agendaPage.nextCursor ? { nextCursor: agendaPage.nextCursor } : {}),
      },
      tasks,
      plugins,
      settings,
      notifications,
      notificationsPage: {
        hasMore: notificationPage.hasMore,
        ...(notificationPage.nextCursor ? { nextCursor: notificationPage.nextCursor } : {}),
      },
      capabilities: { sources: true, plugins: true, tasks: true },
      chatEpoch: this.options.store.chatEpoch(this.actor),
    });
  }
  private async modelStatus(response: ServerResponse): Promise<void> {
    const status = this.options.modelStatus
      ? await this.options.modelStatus()
      : {
          mode: "deterministic" as const,
          configured: false,
          available: true,
          checkedAt: this.now(),
          capabilities: { chat: true, customApps: false },
          reason: "not-configured" as const,
        };
    this.send(response, 200, { ...status, checkedAt: new Date(status.checkedAt).toISOString() });
  }
  private async group(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    if (body.id !== undefined) throw new HttpError(400, "Group ids are generated by Ellie.");
    const group = this.options.store.createGroup(this.actor, {
      name: bounded(body.name, "name", 100),
    });
    this.send(response, 201, this.groupDto(group));
  }
  private groups(response: ServerResponse): void {
    this.send(response, 200, {
      groups: this.options.store.listGroups(this.actor).map((group) => this.groupDto(group)),
    });
  }
  private async renameGroup(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "group id"),
      body = jsonObject(await this.body(request)),
      group = this.options.store.renameGroup(
        this.actor,
        id,
        Number(body.expectedRevision),
        bounded(body.name, "name", 100),
      );
    this.send(response, 200, this.groupDto(group));
  }
  private groupDto(group: ReturnType<LifeStore["listGroups"]>[number]): Record<string, unknown> {
    return {
      id: group.id,
      name: group.name,
      role: group.role,
      revision: group.revision,
      createdAt: new Date(group.createdAt).toISOString(),
      updatedAt: new Date(group.updatedAt).toISOString(),
    };
  }
  private planDto(value: LifePlan): Record<string, unknown> {
    return { ...value, record: serializeRecord(value.record) };
  }
  private planList(url: URL, response: ServerResponse): void {
    const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
      page = this.plans.list(this.actor, {
        scope,
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      });
    this.send(response, 200, {
      plans: page.plans.map((value) => this.planDto(value)),
      hasMore: page.hasMore,
      unavailableCount: page.unavailableCount,
    });
  }
  private planDetail(path: string, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "plan id");
    try {
      this.send(response, 200, this.planDto(this.plans.get(this.actor, id)));
    } catch (error) {
      if (error instanceof LifeAccessError) throw new HttpError(404, "Plan is unavailable.");
      if (error instanceof LifePlanError && error.code === "invalid_plan")
        throw new HttpError(422, "Plan data is invalid.");
      throw error;
    }
  }
  private async planCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    if (Object.keys(body).some((key) => !["scope", "title", "steps"].includes(key)))
      throw new HttpError(400, "Plan request contains an unknown field.");
    if (!Array.isArray(body.steps)) throw new HttpError(400, "Plan steps are invalid.");
    try {
      const created = this.plans.create(this.actor, {
        scope: this.scope(body.scope),
        title: bounded(body.title, "title", 200),
        steps: body.steps as string[],
      });
      this.options.harness.invalidateContext?.(this.actor, created.record.scope);
      this.send(response, 201, this.planDto(created));
    } catch (error) {
      if (error instanceof LifePlanError && error.code === "capacity")
        throw new HttpError(409, error.message);
      throw error;
    }
  }
  private async planStep(
    request: IncomingMessage,
    path: string,
    response: ServerResponse,
  ): Promise<void> {
    const parts = path.split("/"),
      id = identifier(decodeURIComponent(parts.at(-3)!), "plan id"),
      stepId = identifier(decodeURIComponent(parts.at(-1)!), "step id"),
      body = jsonObject(await this.body(request));
    if (Object.keys(body).some((key) => key !== "completed" && key !== "expectedRevision"))
      throw new HttpError(400, "Plan step request contains an unknown field.");
    if (typeof body.completed !== "boolean") throw new HttpError(400, "completed is invalid.");
    if (
      typeof body.expectedRevision !== "number" ||
      !Number.isSafeInteger(body.expectedRevision) ||
      body.expectedRevision < 1
    )
      throw new HttpError(400, "expectedRevision is invalid.");
    try {
      const updated = this.plans.setStep(this.actor, {
        id,
        stepId,
        completed: body.completed,
        expectedRevision: body.expectedRevision,
      });
      this.options.harness.invalidateContext?.(this.actor, updated.record.scope);
      this.send(response, 200, this.planDto(updated));
    } catch (error) {
      if (error instanceof LifeAccessError) throw new HttpError(404, "Plan is unavailable.");
      if (error instanceof LifePlanError && error.code === "invalid_plan")
        throw new HttpError(422, "Plan data is invalid.");
      throw error;
    }
  }
  private async createRecord(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    const record = this.options.store.createRecord(this.actor, {
      kind: body.kind as never,
      title: bounded(body.title, "title", 2000),
      ...(body.body === undefined ? {} : { body: bounded(body.body, "body", 100_000) }),
      scope: this.scope(body.scope),
      data: jsonObject(body.data ?? {}),
    });
    this.send(response, 201, serializeRecord(record));
  }
  private records(url: URL, response: ServerResponse): void {
    const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
      kindsValue = url.searchParams.get("kinds"),
      kinds = kindsValue
        ? kindsValue.split(",").map((kind) => identifier(kind, "record kind") as LifeRecordKind)
        : undefined,
      page = this.options.store.listRecordSummaries(this.actor, {
        scope,
        ...(kinds ? { kinds } : {}),
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
        ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      });
    this.send(response, 200, {
      records: page.items.map((record) => this.recordDto(record, true)),
      page: {
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
    });
  }
  private recordDetail(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!)),
      record = this.options.store.getRecord(this.actor, id);
    if (!record) throw new HttpError(404, "Record not found.");
    this.send(response, 200, this.recordDto(record));
  }

  private recordDto(
    record: LifeRecord | LifeRecordSummary,
    summary = false,
  ): Record<string, unknown> {
    const serialized = summary
      ? serializeSummary(record as LifeRecordSummary)
      : serializeRecord(record as LifeRecord);
    if (
      (record.kind === "reminder" || record.kind === "timer" || record.kind === "routine") &&
      typeof record.data.taskId === "string"
    )
      try {
        serialized.delivery = this.deliveries.statusFor(record);
      } catch (error) {
        if (!(error instanceof ScheduledDeliveryError) || error.code !== "invalid_binding")
          throw error;
        serialized.delivery = {
          taskId: record.data.taskId,
          status: "unknown",
          actions: [],
        };
      }
    return serialized;
  }
  private search(url: URL, response: ServerResponse): void {
    const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
      query = bounded(url.searchParams.get("q"), "q", 1000),
      results = this.options.store.search(this.actor, {
        scope,
        query,
        ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      });
    this.send(response, 200, { results });
  }
  private async recordMutation(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const id = identifier(decodeURIComponent(url.pathname.slice("/api/life/records/".length)));
    const current = this.options.store.getRecord(this.actor, id);
    if (!current) throw new HttpError(404, "Record not found.");
    if (request.method === "DELETE") {
      const revision = Number(url.searchParams.get("revision"));
      const linkedTasks = this.options.tasks
        .list({ owner: owner(current.scope) })
        .filter(
          (task) =>
            task.input !== null &&
            typeof task.input === "object" &&
            (task.input as Record<string, unknown>).recordId === current.id,
        );
      this.options.store.deleteRecord(this.actor, id, revision);
      this.options.harness.invalidateContext?.(this.actor, current.scope);
      for (const task of linkedTasks) this.options.tasks.cancel(task.id, task.owner);
      this.send(response, 204);
      return;
    }
    const body = jsonObject(await this.body(request)),
      revision = Number(body.expectedRevision ?? body.revision);
    const updated = this.options.store.updateRecord(this.actor, id, revision, {
      ...(body.title === undefined ? {} : { title: bounded(body.title, "title", 2000) }),
      ...(body.body === undefined
        ? {}
        : { body: body.body === null ? null : bounded(body.body, "body", 100_000) }),
      ...(body.data === undefined ? {} : { data: jsonObject(body.data) }),
    });
    this.options.harness.invalidateContext?.(this.actor, current.scope);
    this.send(response, 200, serializeRecord(updated));
  }
  private async source(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request, SOURCE_LIMIT));
    const filename = bounded(body.filename, "filename", 1000),
      mimeType = bounded(body.mimeType, "mimeType", 200),
      scope = this.scope(body.scope),
      content = bounded(body.content, "content", SOURCE_LIMIT);
    let record: LifeRecord;
    if (body.encoding === "base64") {
      if (!this.options.extractor)
        throw new HttpError(415, "Binary source extraction is unavailable.");
      let bytes: Buffer;
      try {
        bytes = Buffer.from(content, "base64");
        if (bytes.toString("base64").replace(/=+$/, "") !== content.replace(/=+$/, ""))
          throw new Error();
      } catch {
        throw new HttpError(400, "Invalid base64 source.");
      }
      const controller = this.requestController(),
        deadline = setTimeout(() => controller.abort(), DEADLINE_MS),
        disconnect = () => {
          if (!response.writableFinished)
            controller.abort(new Error("Source upload client disconnected."));
        };
      this.extractionControllers.add(controller);
      response.once("close", disconnect);
      let extraction: { text: string; metadata?: Record<string, unknown> };
      try {
        try {
          extraction = await this.options.extractor({
            filename,
            mimeType,
            bytes,
            signal: controller.signal,
          });
        } catch {
          if (controller.signal.aborted)
            throw new HttpError(408, "Source extraction was cancelled.");
          throw new HttpError(422, "Source could not be extracted locally.");
        }
        if (controller.signal.aborted) throw new HttpError(408, "Source extraction was cancelled.");
      } finally {
        clearTimeout(deadline);
        response.off("close", disconnect);
        this.extractionControllers.delete(controller);
      }
      this.scope(scope);
      record = this.options.store.ingestSource(this.actor, {
        title: filename,
        scope,
        format: "text",
        content: extraction.text,
        metadata: { filename, mimeType, ...extraction.metadata, extracted: true },
      });
    } else {
      const format = this.sourceFormat(mimeType, filename);
      record = this.options.store.ingestSource(this.actor, {
        title: filename,
        scope,
        format,
        content,
        metadata: { filename, mimeType },
      });
    }
    this.options.harness.invalidateContext?.(this.actor, scope);
    this.send(response, 201, serializeRecord(record));
  }
  private async binarySource(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!this.options.extractor)
      throw new HttpError(415, "Binary source extraction is unavailable.");
    if (request.headers["content-type"] !== "application/octet-stream")
      throw new HttpError(415, "Binary uploads require Content-Type application/octet-stream.");
    const rawLength = request.headers["content-length"];
    if (typeof rawLength !== "string" || !/^[1-9][0-9]*$/.test(rawLength))
      throw new HttpError(411, "A valid Content-Length is required.");
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > BINARY_SOURCE_LIMIT)
      throw new HttpError(413, "Binary source is too large.");
    if (this.binaryUploads >= 2) throw new HttpError(429, "Too many binary uploads are active.");
    const scope = this.scope(url.searchParams.get("scope")),
      filename = bounded(url.searchParams.get("filename"), "filename", 1000),
      mimeType = bounded(url.searchParams.get("mimeType"), "mimeType", 200),
      title = url.searchParams.has("title")
        ? bounded(url.searchParams.get("title"), "title", 2000)
        : filename,
      bytes = Buffer.allocUnsafe(length),
      controller = this.requestController();
    let offset = 0;
    const deadline = setTimeout(
        () => controller.abort(new Error("Binary upload deadline exceeded.")),
        BINARY_DEADLINE_MS,
      ),
      abortRequest = () => {
        if (offset < length) request.destroy(new Error("Binary upload cancelled."));
      },
      disconnect = () => {
        if (!response.writableFinished)
          controller.abort(new Error("Binary upload client disconnected."));
      };
    deadline.unref();
    controller.signal.addEventListener("abort", abortRequest, { once: true });
    response.once("close", disconnect);
    this.binaryUploads++;
    this.extractionControllers.add(controller);
    try {
      for await (const part of request) {
        if (controller.signal.aborted) throw new HttpError(408, "Binary upload was cancelled.");
        const chunk = Buffer.from(part);
        if (offset + chunk.length > length)
          throw new HttpError(400, "Binary body exceeds Content-Length.");
        chunk.copy(bytes, offset);
        offset += chunk.length;
      }
      if (offset !== length) throw new HttpError(400, "Binary body does not match Content-Length.");
      let extraction: { text: string; metadata?: Record<string, unknown> };
      try {
        extraction = await this.options.extractor({
          filename,
          mimeType,
          bytes,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new HttpError(408, "Binary extraction was cancelled.");
        throw new HttpError(422, "Source could not be extracted locally.");
      }
      if (controller.signal.aborted) throw new HttpError(408, "Binary extraction was cancelled.");
      if (!extraction.text || extraction.text.length > 5_000_000)
        throw new HttpError(422, "Extracted source text is empty or too large.");
      this.scope(scope);
      const record = this.options.store.ingestSource(this.actor, {
        title,
        scope,
        format: "text",
        content: extraction.text,
        metadata: { filename, mimeType, ...extraction.metadata, extracted: true },
      });
      this.options.harness.invalidateContext?.(this.actor, scope);
      const serialized = serializeRecord(record);
      delete serialized.body;
      this.send(response, 201, {
        ...serialized,
        bodyPreview: record.body?.slice(0, 240),
        hasMoreBody: (record.body?.length ?? 0) > 240,
      });
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", abortRequest);
      response.off("close", disconnect);
      this.extractionControllers.delete(controller);
      this.binaryUploads--;
    }
  }
  private sourceFormat(mimeType: string, filename: string): TextSourceFormat {
    if (mimeType === "text/html" || /\.html?$/.test(filename)) return "html";
    if (mimeType === "text/markdown" || filename.endsWith(".md")) return "markdown";
    if (mimeType === "message/rfc822" || filename.endsWith(".eml")) return "email";
    if (mimeType.startsWith("text/")) return mimeType.includes("vtt") ? "transcript" : "text";
    throw new HttpError(415, "This source type is not supported yet.");
  }
  private importInput(body: Record<string, unknown>): {
    scope: LifeScope;
    format: LifeImportFormat;
    content: string;
    fileName?: string;
    defaultTimeZone?: string;
  } {
    if (body.format !== "ics" && body.format !== "vcard")
      throw new HttpError(400, "Import format must be ics or vcard.");
    return {
      scope: this.scope(body.scope),
      format: body.format,
      content: bounded(body.content, "content", SOURCE_LIMIT).trim(),
      ...(body.fileName === undefined ? {} : { fileName: bounded(body.fileName, "fileName", 500) }),
      ...(body.defaultTimeZone === undefined
        ? {}
        : { defaultTimeZone: bounded(body.defaultTimeZone, "defaultTimeZone", 200) }),
    };
  }
  private async importPreview(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = this.importInput(jsonObject(await this.body(request, SOURCE_LIMIT))),
      preview = previewLifeImport(input);
    this.send(response, 200, preview);
  }
  private async importCommit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request, SOURCE_LIMIT)),
      input = this.importInput(body),
      selectedKeys =
        body.selectedKeys === undefined
          ? undefined
          : Array.isArray(body.selectedKeys)
            ? body.selectedKeys.map((key) => bounded(key, "selected key", 200))
            : (() => {
                throw new HttpError(400, "selectedKeys must be an array.");
              })(),
      result = commitLifeImport({
        store: this.options.store,
        actor: this.actor,
        ...input,
        ...(selectedKeys === undefined ? {} : { selectedKeys }),
        ...(body.sourceId === undefined ? {} : { sourceId: identifier(body.sourceId, "sourceId") }),
      });
    this.options.harness.invalidateContext?.(this.actor, input.scope);
    this.send(response, 200, {
      ...result,
      source: serializeRecord(result.source),
      records: result.records.map(serializeRecord),
    });
  }
  private async settings(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request)),
      scopeValue = body.scope,
      values = jsonObject(body.values);
    let activeGroup: string | undefined;
    if (scopeValue === "default") {
      if (this.actor.userId !== "local")
        throw new HttpError(403, "Only the local bootstrap owner can change defaults.");
      this.options.store.setSettings(this.actor, { level: "default", values });
    } else {
      const scope = this.scope(scopeValue);
      if (scope.type === "group") activeGroup = scope.id;
      this.options.store.setSettings(this.actor, {
        level: scope.type,
        ...(scope.type === "group" ? { groupId: scope.id } : {}),
        values,
      });
    }
    this.send(
      response,
      200,
      this.options.store.resolveSettings(this.actor, activeGroup ? { groupId: activeGroup } : {})
        .values,
    );
  }
  private async feedback(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    if (
      body.rating !== undefined ||
      body.example !== undefined ||
      body.trainingEligible !== undefined ||
      body.relatedRecordId !== undefined
    ) {
      const record = this.recordLearning(body);
      this.send(response, 201, serializeRecord(record));
      return;
    }
    const requestedScope = this.scope(body.scope),
      shared = requestedScope.type === "group" && body.sharedSetting === true,
      scope = shared ? requestedScope : { type: "user" as const, id: this.actor.userId },
      record = this.options.store.recordFeedback(this.actor, {
        scope,
        message: bounded(body.text, "text", 100_000),
        ...(body.runId === undefined ? {} : { target: identifier(body.runId, "runId") }),
        ...(body.explicitPreference === undefined
          ? {}
          : {
              explicitPreference: jsonObject(body.explicitPreference) as {
                key: string;
                value: unknown;
              },
            }),
        ...(body.explicitPreference === undefined
          ? {}
          : {
              preferenceLevel: shared ? "group" : "user",
            }),
      });
    this.send(response, 201, serializeRecord(record));
  }
  private recordLearning(body: Record<string, unknown>): LifeRecord {
    if (body.conversationId !== undefined) {
      const conversationId = identifier(body.conversationId, "conversationId"),
        turnId = identifier(body.turnId, "turnId"),
        conversation = this.options.store.getConversation(this.actor, conversationId, {
          limit: 1,
        }).conversation,
        turn = this.options.store.getConversationTurn(this.actor, conversationId, turnId);
      if (turn.status !== "completed" || !turn.assistant)
        throw new HttpError(409, "Only a completed conversation response can be rated.");
      if (body.scope !== undefined) {
        const supplied = this.scope(body.scope);
        if (supplied.type !== conversation.scope.type || supplied.id !== conversation.scope.id)
          throw new HttpError(400, "Feedback conversation scope does not match.");
      }
      const example = jsonObject(body.example ?? {});
      return this.learning.record(this.actor, {
        scope: { type: "user", id: this.actor.userId },
        message: bounded(body.message ?? body.text, "message", 8_000),
        ...(body.rating === undefined ? {} : { rating: Number(body.rating) as -1 | 0 | 1 }),
        example: {
          prompt: turn.user,
          response: turn.assistant,
          ...(example.preferredResponse === undefined
            ? {}
            : {
                preferredResponse: bounded(example.preferredResponse, "preferredResponse", 8_000),
              }),
        },
        trainingEligible: false,
      });
    }
    return this.learning.record(this.actor, {
      scope: this.scope(body.scope),
      message: bounded(body.message ?? body.text, "message", 8_000),
      ...(body.rating === undefined ? {} : { rating: Number(body.rating) as -1 | 0 | 1 }),
      ...(body.example === undefined
        ? {}
        : {
            example: jsonObject(body.example) as unknown as {
              prompt: string;
              response: string;
              preferredResponse?: string;
            },
          }),
      ...(body.trainingEligible === undefined
        ? {}
        : { trainingEligible: body.trainingEligible as boolean }),
      ...(body.relatedRecordId === undefined
        ? {}
        : { relatedRecordId: identifier(body.relatedRecordId, "relatedRecordId") }),
    });
  }
  private async learningRecord(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const record = this.recordLearning(jsonObject(await this.body(request)));
    this.send(response, 201, serializeRecord(record));
  }
  private improvements() {
    if (!this.options.harness.improvements)
      throw new HttpError(503, "Feedback improvement review is unavailable.");
    return this.options.harness.improvements;
  }
  private improvementDto(value: ImprovementProposalLike): Record<string, unknown> {
    const record = serializeRecord(value.record),
      data = record.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const safeData = { ...(data as Record<string, unknown>) };
      delete safeData.previews;
      if (
        safeData.improvementAudit &&
        typeof safeData.improvementAudit === "object" &&
        !Array.isArray(safeData.improvementAudit)
      ) {
        const audit = { ...(safeData.improvementAudit as Record<string, unknown>) };
        delete audit.previews;
        safeData.improvementAudit = audit;
      }
      record.data = safeData;
    }
    return {
      ...value,
      record,
      ...(value.status === "stale" ? { previews: [] } : {}),
    };
  }
  private improvementsList(response: ServerResponse): void {
    const engine = this.improvements();
    this.send(response, 200, {
      proposals: engine.list(this.actor).map((proposal) => this.improvementDto(proposal)),
      modelAvailable: engine.modelAvailable,
    });
  }
  private improvementDetail(path: string, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "improvement id");
    try {
      this.send(response, 200, this.improvementDto(this.improvements().get(this.actor, id)));
    } catch (error) {
      throw this.improvementError(error);
    }
  }
  private async improvementPropose(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = jsonObject(await this.body(request));
    if (Object.keys(body).some((key) => key !== "feedback" && key !== "goal"))
      throw new HttpError(400, "Improvement request contains an unknown field.");
    if (!Array.isArray(body.feedback) || body.feedback.length < 1 || body.feedback.length > 3)
      throw new HttpError(400, "Select one through three feedback examples.");
    const feedback = body.feedback.map((value) => {
      const item = jsonObject(value);
      if (Object.keys(item).some((key) => key !== "id" && key !== "revision"))
        throw new HttpError(400, "Feedback selection is invalid.");
      if (
        typeof item.revision !== "number" ||
        !Number.isSafeInteger(item.revision) ||
        item.revision < 1
      )
        throw new HttpError(400, "Feedback revision is invalid.");
      return {
        id: identifier(item.id, "feedback id"),
        revision: item.revision,
      };
    });
    if (new Set(feedback.map(({ id }) => id)).size !== feedback.length)
      throw new HttpError(400, "Feedback selection must be distinct.");
    const controller = this.requestController(),
      disconnect = () => {
        if (!response.writableFinished)
          controller.abort(new Error("Improvement review client disconnected."));
      },
      epoch = this.options.store.chatEpoch(this.actor),
      currentAuthority = this.captureAuthority(),
      isContextCurrent = () =>
        !controller.signal.aborted &&
        currentAuthority() &&
        this.accepting &&
        !this.personalResetActive &&
        this.options.store.chatEpoch(this.actor) === epoch;
    this.pluginBuildControllers.add(controller);
    response.once("close", disconnect);
    try {
      const proposal = await this.improvements()
        .propose(this.actor, {
          feedback,
          ...(body.goal === undefined ? {} : { goal: bounded(body.goal, "goal", 1_000) }),
          signal: controller.signal,
          isContextCurrent,
        })
        .catch((error: unknown) => {
          throw this.improvementError(error);
        });
      if (!isContextCurrent())
        throw new HttpError(409, "Private feedback changed before the proposal was saved.");
      this.send(response, 201, this.improvementDto(proposal));
    } finally {
      response.off("close", disconnect);
      this.pluginBuildControllers.delete(controller);
    }
  }
  private async improvementMutation(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const parts = path.split("/"),
      action = parts.at(-1),
      id = identifier(decodeURIComponent(parts.at(-2)!), "improvement id"),
      body = jsonObject(await this.body(request));
    if (Object.keys(body).some((key) => key !== "expectedRevision"))
      throw new HttpError(400, "Improvement mutation contains an unknown field.");
    const revision = body.expectedRevision;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1)
      throw new HttpError(400, "expectedRevision is invalid.");
    let proposal: ImprovementProposalLike;
    try {
      proposal =
        action === "adopt"
          ? this.improvements().adopt(this.actor, id, revision)
          : this.improvements().dismiss(this.actor, id, revision);
    } catch (error) {
      throw this.improvementError(error);
    }
    this.options.harness.invalidateContext?.(this.actor, {
      type: "user",
      id: this.actor.userId,
    });
    this.send(response, 200, this.improvementDto(proposal));
  }
  private improvementError(error: unknown): Error {
    if (error instanceof LifeAccessError || error instanceof LifeConflictError) return error;
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    if (code === "model_unavailable")
      return new HttpError(422, "Connect an available local model to propose an improvement.");
    if (code === "busy")
      return new HttpError(429, "Two improvement reviews are already running. Try again shortly.");
    if (code === "capacity")
      return new HttpError(429, "Delete an old improvement proposal before creating another.");
    if (code === "timeout")
      return new HttpError(504, "The local model took too long to review these examples.");
    if (code === "cancelled") return new HttpError(408, "The improvement review was cancelled.");
    if (code === "invalid_candidate")
      return new HttpError(502, "The local model returned an invalid improvement proposal.");
    if (code === "model_transport")
      return new HttpError(
        503,
        "The local model runner is unavailable. Try again when it is ready.",
      );
    if (code === "stale" || code === "context_changed")
      return new HttpError(409, "Private feedback changed. Refresh the examples and try again.");
    if (code === "invalid_input") return new HttpError(400, "Feedback selection is invalid.");
    if (code === "unavailable") return new HttpError(404, "Improvement proposal is unavailable.");
    return error instanceof Error ? error : new Error("Improvement review failed.");
  }
  private learningList(url: URL, response: ServerResponse): void {
    const result = this.learning.list(
      this.actor,
      this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
    );
    this.send(response, 200, { ...result, records: result.records.map(serializeRecord) });
  }
  private async learningSelection(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      body = jsonObject(await this.body(request)),
      record = this.learning.selectForExport(
        this.actor,
        id,
        Number(body.expectedRevision),
        body.selected as boolean,
      );
    this.send(response, 200, serializeRecord(record));
  }
  private async learningExport(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    if (!Array.isArray(body.ids)) throw new HttpError(400, "ids must be an array.");
    const ids = body.ids.map((id) => identifier(id, "feedback id"));
    this.send(response, 200, this.learning.exportExamples(this.actor, ids));
  }
  private teachingGuide(value: ReturnType<LifeTeaching["get"]>): Record<string, unknown> {
    return {
      record: serializeRecord(value.record),
      version: value.version,
      enabled: value.enabled,
      status: value.status,
      versions: value.versions.map((version) => ({
        ...version,
        adoptedAt: new Date(version.adoptedAt).toISOString(),
      })),
    };
  }
  private teachingList(url: URL, response: ServerResponse): void {
    const scope = this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`);
    this.send(response, 200, {
      guides: this.teaching.list(this.actor, scope).map((guide) => this.teachingGuide(guide)),
    });
  }
  private teachingDetail(path: string, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "teaching id");
    this.send(response, 200, this.teachingGuide(this.teaching.get(this.actor, id)));
  }
  private async teachingCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request)),
      scope = this.scope(body.scope),
      guide = this.teaching.create(this.actor, {
        scope,
        title: bounded(body.title, "title", 200),
        instructions: bounded(body.instructions, "instructions", 4_000),
        ...(body.sources === undefined ? {} : { sources: body.sources as never }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }),
      });
    this.options.harness.invalidateContext?.(this.actor, scope);
    this.send(response, 201, this.teachingGuide(guide));
  }
  private async teachingMutation(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const parts = path.split("/"),
      action = parts.at(-1)!,
      id = identifier(decodeURIComponent(parts.at(-2)!), "teaching id"),
      body = jsonObject(await this.body(request));
    let guide;
    if (action === "revise")
      guide = this.teaching.revise(this.actor, id, Number(body.expectedRevision), {
        instructions: bounded(body.instructions, "instructions", 4_000),
        ...(body.sources === undefined ? {} : { sources: body.sources as never }),
      });
    else if (action === "enabled")
      guide = this.teaching.setEnabled(
        this.actor,
        id,
        Number(body.expectedRevision),
        body.enabled as boolean,
      );
    else
      guide = this.teaching.rollback(
        this.actor,
        id,
        Number(body.expectedRevision),
        Number(body.targetVersion),
      );
    this.options.harness.invalidateContext?.(this.actor, guide.record.scope);
    this.send(response, 200, this.teachingGuide(guide));
  }
  private async chat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request)),
      scope = this.scope(body.scope),
      message = bounded(body.message, "message", 8000),
      requestId = identifier(body.requestId, "requestId"),
      chatEpoch = Number(body.chatEpoch),
      conversationId =
        body.conversationId === undefined
          ? undefined
          : identifier(body.conversationId, "conversationId"),
      begun = this.options.store.beginConversationTurn(this.actor, {
        scope,
        message,
        requestId,
        chatEpoch,
        ...(conversationId ? { conversationId } : {}),
      });
    let automaticMemoryForgotten = 0;
    try {
      this.automaticMemory.captureTurn(this.actor, {
        conversationId: begun.conversation.id,
        turnId: begun.turn.id,
      });
      const forget =
        /^(?:please\s+)?(?:forget|do not remember|don't remember)\s+(?:that\s+)?(.+?)[.!?]*$/i.exec(
          message.trim(),
        );
      if (forget && begun.status === "new") {
        this.automaticMemory.suppressTurn(this.actor, begun.turn.id);
        const query = forget[1]!.trim();
        if (query.length <= 500)
          automaticMemoryForgotten = this.automaticMemory.forget(this.actor, { scope, query });
      }
      this.automaticMemory.sync(this.actor, scope);
    } catch (error) {
      if (begun.status === "new")
        this.options.store.interruptConversationTurn(this.actor, {
          conversationId: begun.conversation.id,
          turnId: begun.turn.id,
          requestId,
        });
      throw error;
    }
    if (begun.status !== "new") {
      this.send(
        response,
        200,
        this.conversationChatEnvelope(begun.conversation, begun.turn, begun.result),
      );
      return;
    }
    const controller = this.requestController();
    this.pluginBuildControllers.add(controller);
    const memory = this.automaticMemory.modelContext(this.actor, {
        scope,
        query: message,
        excludeTurnId: begun.turn.id,
        maxBytes: 6 * 1024,
      }),
      conversationPreferences = this.options.store.getConversationPreferences(
        this.actor,
        begun.conversation.id,
      ),
      fingerprint = begun.contextFingerprint,
      currentAuthority = this.captureAuthority(),
      contextCurrent = () => {
        if (
          controller.signal.aborted ||
          !currentAuthority() ||
          this.personalResetActive ||
          !this.accepting
        )
          return false;
        try {
          return (
            this.options.store.conversationContextFingerprint(this.actor, begun.conversation.id) ===
              fingerprint &&
            this.options.store.getConversationPreferences(this.actor, begun.conversation.id)
              .revision === conversationPreferences.revision &&
            this.options.store.automaticPromptMemoryRevision(this.actor, scope) === memory.revision
          );
        } catch {
          return false;
        }
      },
      history = this.options.store.conversationHistory(
        this.actor,
        begun.conversation.id,
        12,
        fingerprint,
      ),
      pendingIntent = this.options.store.getPendingIntent(this.actor, begun.conversation.id),
      recentOperation = this.options.store.recentConversationOperation(
        this.actor,
        begun.conversation.id,
      );
    const progressEntry = {
      conversationId: begun.conversation.id,
      turnId: begun.turn.id,
      revision: 0,
      phase: "queued" as LifeModelProgress["phase"],
      current: contextCurrent,
    };
    if (this.chatProgress.size < 16) this.chatProgress.set(requestId, progressEntry);
    const onProgress = (progress: LifeModelProgress) => {
      const entry = this.chatProgress.get(requestId);
      if (entry !== progressEntry) return;
      if (!contextCurrent()) {
        this.chatProgress.delete(requestId);
        return;
      }
      if (!progress || !["queued", "drafting", "validating"].includes(progress.phase)) return;
      let text: string | undefined;
      if (typeof progress.text === "string") {
        let bytes = 0;
        text = "";
        for (const point of progress.text) {
          bytes += Buffer.byteLength(point, "utf8");
          if (bytes > 8192) break;
          text += point;
        }
      }
      if (entry.phase === progress.phase && entry.text === text) return;
      entry.phase = progress.phase;
      entry.text = text;
      entry.revision++;
    };
    let executingIntent: PendingLifeIntent | undefined, activeRescheduleId: string | undefined;
    const executePending = async (
      answered: PendingLifeIntent,
    ): Promise<Awaited<ReturnType<LifeHarnessLike["chat"]>>> => {
      if (!this.options.harness.continuePendingIntent)
        throw new HttpError(503, "Pending reminder continuation is unavailable.");
      executingIntent = this.options.store.claimPendingIntent(
        this.actor,
        answered.id,
        answered.revision,
      );
      let replacementJournal:
        | NonNullable<
            Parameters<
              NonNullable<LifeHarnessLike["continuePendingIntent"]>
            >[0]["replacementJournal"]
          >
        | undefined;
      if (executingIntent.intent.kind === "reschedule-reminder") {
        const target = executingIntent.target;
        if (!target?.taskId)
          throw new LifeConflictError("The reminder task changed before rescheduling.");
        activeRescheduleId = executingIntent.id;
        this.options.store.beginReminderReschedule(this.actor, {
          operationId: activeRescheduleId,
          scope,
          pendingIntentId: executingIntent.id,
          recordId: target.recordId,
          expectedRevision: target.expectedRevision,
          replacesTaskId: target.taskId,
        });
        replacementJournal = {
          prepared: (value) => {
            this.options.store.markReminderReschedulePrepared(
              this.actor,
              activeRescheduleId!,
              value,
            );
          },
          recordUpdated: (value) => {
            this.options.store.markReminderRescheduleRecordUpdated(
              this.actor,
              activeRescheduleId!,
              value,
            );
          },
        };
      }
      const continued = await this.options.harness.continuePendingIntent({
        actor: this.actor,
        scope,
        pendingIntent: executingIntent,
        isContextCurrent: contextCurrent,
        ...(replacementJournal ? { replacementJournal } : {}),
      });
      this.recheckOwner(owner(scope));
      if (continued.operationOutcome === "clarify" || continued.operationOutcome === "rejected") {
        if (activeRescheduleId) {
          this.recoverReminderReschedules();
          activeRescheduleId = undefined;
        }
        this.options.store.interruptPendingIntent(
          this.actor,
          executingIntent.id,
          executingIntent.revision,
        );
        executingIntent = undefined;
        return continued;
      }
      if (activeRescheduleId) {
        this.options.store.completeReminderReschedule(this.actor, activeRescheduleId);
        activeRescheduleId = undefined;
      }
      this.options.store.finishPendingIntent(
        this.actor,
        executingIntent.id,
        executingIntent.revision,
        {
          recordIds: (continued.records ?? []).slice(0, 100).map((record) => record.id),
          taskIds: (continued.taskIds ?? []).slice(0, 100),
        },
      );
      executingIntent = undefined;
      return continued;
    };
    try {
      let result = await this.options.harness.chat({
        actor: this.actor,
        scope,
        message,
        conversationId: begun.conversation.id,
        history,
        automaticMemory: {
          markdown: memory.markdown,
          revision: memory.revision,
          partial: memory.partial,
        },
        ...(automaticMemoryForgotten ? { automaticMemoryForgotten } : {}),
        isContextCurrent: contextCurrent,
        ...(pendingIntent ? { pendingIntent } : {}),
        ...(recentOperation ? { recentOperation } : {}),
        conversationPreferences,
        signal: controller.signal,
        onProgress,
      });
      this.recheckOwner(owner(scope));
      const directive = result.continuation;
      if (directive?.action === "create" || directive?.action === "replace") {
        const created = this.options.store.createPendingIntent(this.actor, {
          conversationId: begun.conversation.id,
          scope,
          chatEpoch,
          originTurnId: begun.turn.id,
          originRequestId: requestId,
          intent: directive.intent,
          missing: directive.missing,
          question: directive.question,
          contextFingerprint: fingerprint,
          ...(directive.target ? { target: directive.target } : {}),
        });
        if (directive.answer) {
          const answered = this.options.store.answerPendingIntent(this.actor, {
            id: created.id,
            expectedRevision: created.revision,
            answerTurnId: begun.turn.id,
            answerRequestId: requestId,
            answer: directive.answer,
          });
          result = await executePending(answered);
        }
      } else if (directive?.action === "cancel")
        this.options.store.cancelPendingIntent(
          this.actor,
          directive.pendingIntentId,
          directive.expectedRevision,
        );
      else if (directive?.action === "answer") {
        const answered = this.options.store.answerPendingIntent(this.actor, {
          id: directive.pendingIntentId,
          expectedRevision: directive.expectedRevision,
          answerTurnId: begun.turn.id,
          answerRequestId: requestId,
          answer: directive.answer,
        });
        result = await executePending(answered);
      }
      const normalized = this.conversationResult(scope, result),
        completed = this.options.store.completeConversationTurn(this.actor, {
          conversationId: begun.conversation.id,
          turnId: begun.turn.id,
          requestId,
          result: normalized,
          ...(result.conversationPreferenceUpdate
            ? {
                preferenceUpdate: {
                  ...result.conversationPreferenceUpdate,
                  chatEpoch,
                  contextFingerprint: fingerprint,
                },
              }
            : {}),
        });
      this.send(
        response,
        200,
        this.conversationChatEnvelope(completed.conversation, completed.turn, completed.result),
      );
    } catch (error) {
      if (activeRescheduleId) {
        // Reconcile the record pointer before deciding whether a prepared replacement may
        // be discarded. A callback can fail after the record CAS has already succeeded.
        this.recoverReminderReschedules();
      }
      if (executingIntent)
        try {
          this.options.store.interruptPendingIntent(
            this.actor,
            executingIntent.id,
            executingIntent.revision,
          );
        } catch {}
      try {
        this.options.store.interruptConversationTurn(this.actor, {
          conversationId: begun.conversation.id,
          turnId: begun.turn.id,
          requestId,
        });
      } catch {}
      throw error;
    } finally {
      this.chatProgress.delete(requestId);
      this.pluginBuildControllers.delete(controller);
    }
  }
  private conversationResult(
    scope: LifeScope,
    result: Awaited<ReturnType<LifeHarnessLike["chat"]>>,
  ): import("../../../packages/life-core/src/index.ts").ConversationResult {
    const evidence =
      result.evidence?.slice(0, 50).flatMap((item) => {
        const source = this.options.store.currentSourceReference(this.actor, scope, item.sourceId);
        return source
          ? [
              {
                ...source,
                title: presentation(source.title, 500, "Source"),
                ...(item.reference
                  ? { reference: presentation(item.reference, 1000, "Reference") }
                  : {}),
              },
            ]
          : [];
      }) ?? [];
    return {
      reply: presentation(result.reply, 8000, "Done."),
      actions: (result.actions ?? []).slice(0, 20).map((action) => ({
        label: presentation(action.label, 500, "Completed"),
        status: presentation(action.status, 50, "completed"),
      })),
      recordIds: (result.records ?? []).slice(0, 100).map((record) => record.id),
      recordReceipts: [
        ...new Map(
          (result.records ?? [])
            .filter((record) => record.kind === "reminder" || record.kind === "event")
            .map((record) => [
              record.id,
              {
                id: record.id,
                kind: record.kind as "reminder" | "event",
                revision: record.revision,
              },
            ]),
        ).values(),
      ].slice(0, 100),
      taskIds: (result.taskIds ?? []).slice(0, 100),
      evidence,
      ...(result.createdGroup
        ? {
            createdGroup: {
              id: identifier(result.createdGroup.id, "created group id"),
              name: presentation(result.createdGroup.name, 100, "Shared space"),
            },
          }
        : {}),
    };
  }
  private conversationChatEnvelope(
    conversation: import("../../../packages/life-core/src/index.ts").ConversationSummary,
    turn: import("../../../packages/life-core/src/index.ts").ConversationTurn,
    result?: import("../../../packages/life-core/src/index.ts").ConversationResult,
  ): Record<string, unknown> {
    return {
      status: turn.status,
      conversationId: conversation.id,
      turnId: turn.id,
      pendingIntent: this.pendingIntentProjection(
        this.options.store.getPendingIntent(this.actor, conversation.id),
      ),
      conversationPreferences: this.options.store.getConversationPreferences(
        this.actor,
        conversation.id,
      ),
      ...(result
        ? {
            reply: result.reply,
            actions: result.actions,
            records: result.recordIds.flatMap((id) => {
              const record = this.options.store.getRecord(this.actor, id);
              return record ? [serializeRecord(record)] : [];
            }),
            taskIds: result.taskIds,
            evidence: result.evidence,
            ...(result.createdGroup ? { createdGroup: result.createdGroup } : {}),
          }
        : {}),
    };
  }
  private pendingIntentProjection(value?: PendingLifeIntent): Record<string, unknown> | null {
    if (!value || value.state === "completed" || value.state === "cancelled") return null;
    const kind =
        value.intent.kind === "schedule-reminder" || value.intent.kind === "reschedule-reminder"
          ? "reminder"
          : value.intent.kind === "create-event" || value.intent.kind === "reschedule-event"
            ? "event"
            : "need",
      title =
        "title" in value.intent
          ? value.intent.title
          : value.target
            ? (this.options.store.getRecord(this.actor, value.target.recordId)?.title ?? kind)
            : kind;
    return {
      id: value.id,
      kind,
      title: presentation(title, 240, kind),
      state: value.state,
      question: value.question,
      missing: value.missing,
      expiresAt: new Date(value.expiresAt).toISOString(),
      revision: value.revision,
    };
  }
  private pendingIntentDetail(path: string, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!), "conversationId"),
      pending = this.options.store.getPendingIntent(this.actor, id);
    this.send(response, 200, { pendingIntent: this.pendingIntentProjection(pending) });
  }
  private pendingIntentDelete(path: string, url: URL, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!), "conversationId"),
      pending = this.options.store.getPendingIntent(this.actor, id);
    if (!pending) throw new HttpError(404, "Pending intent not found.");
    this.options.store.cancelPendingIntent(
      this.actor,
      pending.id,
      Number(url.searchParams.get("revision")),
    );
    this.send(response, 204);
  }
  private chatRequest(path: string, response: ServerResponse): void {
    const requestId = identifier(decodeURIComponent(path.split("/").at(-1)!), "requestId"),
      found = this.options.store.getConversationRequest(this.actor, requestId);
    if (!found) throw new HttpError(404, "Chat request not found.");
    this.send(response, 200, {
      ...this.conversationChatEnvelope(found.conversation, found.turn, found.result),
      ...(() => {
        const entry = this.chatProgress.get(requestId);
        if (!entry) return {};
        if (
          found.turn.status !== "pending" ||
          entry.turnId !== found.turn.id ||
          entry.conversationId !== found.conversation.id ||
          !entry.current()
        ) {
          this.chatProgress.delete(requestId);
          return {};
        }
        return {
          progress: {
            phase: entry.phase,
            revision: entry.revision,
            ...(entry.text === undefined ? {} : { text: entry.text }),
          },
        };
      })(),
    });
  }
  private conversationSummary(
    value: import("../../../packages/life-core/src/index.ts").ConversationSummary,
  ): Record<string, unknown> {
    return {
      ...value,
      createdAt: new Date(value.createdAt).toISOString(),
      updatedAt: new Date(value.updatedAt).toISOString(),
    };
  }
  private conversationTurn(
    value: import("../../../packages/life-core/src/index.ts").ConversationTurn,
  ): Record<string, unknown> {
    return {
      ...value,
      createdAt: new Date(value.createdAt).toISOString(),
      updatedAt: new Date(value.updatedAt).toISOString(),
    };
  }
  private conversations(url: URL, response: ServerResponse): void {
    const page = this.options.store.listConversations(this.actor, {
      scope: this.scope(url.searchParams.get("scope") ?? `user:${this.actor.userId}`),
      ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
      ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    });
    this.send(response, 200, {
      conversations: page.items.map((item) => this.conversationSummary(item)),
      chatEpoch: this.options.store.chatEpoch(this.actor),
      page: { hasMore: page.hasMore, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
    });
  }
  private conversation(path: string, url: URL, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "conversationId"),
      result = this.options.store.getConversation(this.actor, id, {
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      });
    this.send(response, 200, {
      conversation: this.conversationSummary(result.conversation),
      conversationPreferences: this.options.store.getConversationPreferences(this.actor, id),
      turns: result.turns.items.map((item) => this.conversationTurn(item)),
      page: {
        hasMore: result.turns.hasMore,
        ...(result.turns.nextCursor ? { nextCursor: result.turns.nextCursor } : {}),
      },
    });
  }
  private conversationDelete(path: string, url: URL, response: ServerResponse): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!), "conversationId"),
      conversation = this.options.store.getConversation(this.actor, id).conversation;
    this.options.store.deleteConversation(this.actor, id, Number(url.searchParams.get("revision")));
    this.options.harness.invalidateContext?.(this.actor, conversation.scope);
    this.automaticMemory.sync(this.actor, conversation.scope);
    this.send(response, 204);
  }
  private async signal(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.context) throw new HttpError(503, "Context suggestions are unavailable.");
    const body = jsonObject(await this.body(request)),
      scope = this.scope(body.scope);
    let release!: () => void;
    const previous = this.contextTail;
    this.contextTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertRequestAuthority();
      const suggestions = this.options.context.evaluate(
        this.actor,
        scope,
        body.signal as ContextSignal,
      );
      this.send(response, 200, { suggestions });
    } finally {
      release();
    }
  }
  private async notification(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const match = /\/notifications\/([^/]+)\/(dismiss|complete)$/.exec(path)!,
      id = identifier(decodeURIComponent(match[1]!)),
      action = match[2] as "dismiss" | "complete",
      body = jsonObject(await this.body(request)),
      result = this.options.store.updateNotification(
        this.actor,
        id,
        Number(body.expectedRevision),
        action,
        this.now(),
      );
    if (action === "dismiss")
      recordProactiveDismissal(this.options.store, this.actor, result.notification, this.now());
    this.options.harness.invalidateContext?.(this.actor, result.notification.scope);
    if (result.linked) {
      const linkedIds = new Set([result.linked.id]);
      if (result.linked.kind === "need" || result.linked.kind === "goal")
        for (const record of this.options.store.listRecords(this.actor, {
          scope: result.linked.scope,
          kinds: ["reminder"],
          limit: 500,
        }))
          if (
            record.relationships.some((relationship) => relationship.targetId === result.linked!.id)
          )
            linkedIds.add(record.id);
      for (const task of this.options.tasks.list({ owner: owner(result.linked.scope) }))
        if (
          task.input &&
          typeof task.input === "object" &&
          linkedIds.has(String((task.input as Record<string, unknown>).recordId))
        )
          this.options.tasks.cancel(task.id, task.owner);
    }
    this.send(response, 200, {
      notification: serializeRecord(result.notification),
      ...(result.linked ? { linked: serializeRecord(result.linked) } : {}),
    });
  }
  private async task(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    await this.body(request);
    const [, id, action] = /\/tasks\/([^/]+)\/(pause|resume|cancel|run)$/.exec(path)!,
      decoded = identifier(decodeURIComponent(id!)),
      found = this.authorizedOwners()
        .map((candidate) => ({ candidate, task: this.options.tasks.get(decoded, candidate) }))
        .find((item) => item.task);
    if (!found) throw new HttpError(404, "Task not found.");
    if (
      action === "run" &&
      ["succeeded", "failed", "cancelled", "expired", "unknown"].includes(found.task!.state)
    ) {
      if (
        found.task!.handler !== "knowledge.aggregate" ||
        !this.options.harness.rerunBackgroundSummary
      )
        throw new HttpError(409, "This completed task cannot be run again.");
      const split = found.candidate.indexOf(":"),
        scope = {
          type: found.candidate.slice(0, split) as "user" | "group",
          id: found.candidate.slice(split + 1),
        },
        rerun = (() => {
          try {
            return this.options.harness.rerunBackgroundSummary!({
              actor: this.actor,
              scope,
              taskId: decoded,
            });
          } catch {
            throw new HttpError(409, "This summary cannot be rerun with current sources.");
          }
        })();
      this.send(response, 200, serializeTask(rerun));
      return;
    }
    if (action === "run")
      try {
        await this.options.tasks.runNow(decoded, found.candidate);
      } catch {
        throw new HttpError(409, "Task state did not allow this action.");
      }
    else {
      const changed =
        action === "pause"
          ? this.options.tasks.pause(decoded, found.candidate)
          : action === "resume"
            ? this.options.tasks.resume(decoded, found.candidate)
            : this.options.tasks.cancel(decoded, found.candidate);
      if (!changed) throw new HttpError(409, "Task state did not allow this action.");
    }
    this.send(response, 200, serializeTask(this.options.tasks.get(decoded, found.candidate)!));
  }
  private taskDetail(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.authorizedOwners()
        .map((candidate) => ({ owner: candidate, task: this.options.tasks.get(id, candidate) }))
        .find((item) => item.task);
    if (!found?.task) throw new HttpError(404, "Task not found.");
    const [scopeType, ...scopeId] = found.owner.split(":"),
      scope = { type: scopeType as "user" | "group", id: scopeId.join(":") },
      records = this.options.store.listRecordSummaries(this.actor, { scope, limit: 500 }).items,
      progress = this.options.tasks
        .progress(id, found.owner)
        .slice(-100)
        .map((item) => ({ ...item, at: new Date(item.at).toISOString() })),
      children = this.options.tasks
        .list({ owner: found.owner, parentId: id, limit: 500 })
        .map((child) => serializeTask(child, records));
    this.send(response, 200, {
      task: serializeTask(found.task, records),
      progress,
      children,
      ...this.verifiedTaskResult(found.task, scope),
    });
  }
  private verifiedTaskResult(
    task: TaskRecord,
    scope: LifeScope,
  ):
    | { result: Record<string, unknown>; stale: false }
    | { stale: true; staleReason: string }
    | undefined {
    if (!task.result || typeof task.result !== "object" || Array.isArray(task.result)) return;
    const value = task.result as Record<string, unknown>;
    if (value.status !== "complete" || !Array.isArray(value.citations)) return;
    const citations: Array<{
      sourceId: string;
      sourceRevision: number;
      title: string;
      references: string[];
    }> = [];
    let stale = false;
    for (const raw of value.citations) {
      try {
        const citation = jsonObject(raw),
          sourceId = identifier(citation.sourceId, "sourceId"),
          sourceRevision = Number(citation.sourceRevision),
          source = this.options.store.getRecord(this.actor, sourceId),
          references = Array.isArray(citation.references)
            ? citation.references.slice(0, 100).map((item) => bounded(item, "reference", 1000))
            : (() => {
                throw new HttpError(400, "Invalid stored citation.");
              })();
        if (
          !Number.isSafeInteger(sourceRevision) ||
          !source ||
          source.kind !== "source" ||
          source.scope.type !== scope.type ||
          source.scope.id !== scope.id ||
          source.revision !== sourceRevision
        ) {
          stale = true;
          continue;
        }
        citations.push({
          sourceId,
          sourceRevision,
          title: bounded(citation.title, "citation title", 2000),
          references,
        });
      } catch {
        stale = true;
      }
    }
    if (stale)
      return {
        stale: true,
        staleReason: "A cited source changed or is unavailable. Run this task again.",
      };
    try {
      return {
        result: {
          status: "complete",
          summary: bounded(value.summary, "task summary", 100_000),
          citations,
          omitted: Number.isSafeInteger(value.omitted) ? value.omitted : 0,
          ...(value.reason === "no_current_sources" ? { reason: value.reason } : {}),
        },
        stale: false,
      };
    } catch {
      return;
    }
  }
  private async build(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request)),
      scope = this.scope(body.scope),
      requestText = bounded(body.request, "request", 8000),
      manifest = builtInManifest(requestText);
    let plugin: LifePlugin;
    if (manifest) plugin = this.options.plugins.install(owner(scope), manifest);
    else if (this.options.harness.buildPlugin) {
      const controller = this.requestController(),
        disconnect = () => {
          if (!response.writableFinished)
            controller.abort(new Error("Plugin build client disconnected."));
        },
        currentAuthority = this.captureAuthority(),
        isContextCurrent = () => {
          if (
            controller.signal.aborted ||
            !currentAuthority() ||
            this.personalResetActive ||
            !this.accepting
          )
            return false;
          try {
            this.recheckOwner(owner(scope));
            return true;
          } catch {
            return false;
          }
        };
      this.pluginBuildControllers.add(controller);
      response.once("close", disconnect);
      try {
        plugin = await this.options.harness.buildPlugin({
          actor: this.actor,
          scope,
          request: requestText,
          signal: controller.signal,
          isContextCurrent,
        });
      } catch (error) {
        if (error instanceof PluginError) throw error;
        throw this.pluginBuildError(error);
      } finally {
        response.off("close", disconnect);
        this.pluginBuildControllers.delete(controller);
      }
    } else throw new HttpError(503, "Custom plugin building is unavailable.");
    this.recheckOwner(owner(scope));
    this.send(response, 201, serializePlugin(plugin));
  }
  private pluginView(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id),
      pluginHtml = this.options.plugins.view(found.owner, id),
      encoded = Buffer.from(pluginChildDocument(id, pluginHtml)).toString("base64"),
      html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body>
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:transparent}body{overflow:hidden}</style>
<script>(()=>{const pluginId=${JSON.stringify(id)},frame=document.createElement('iframe');frame.title='Plugin';frame.sandbox='allow-scripts';let hostPort,childPort,loaded=false,connected=false;
const stop=()=>{try{hostPort&&hostPort.close()}catch{}try{childPort&&childPort.close()}catch{}};
const connect=()=>{if(!hostPort||!childPort||connected)return;connected=true;hostPort.onmessage=event=>childPort.postMessage(event.data);childPort.onmessage=event=>hostPort.postMessage(event.data);hostPort.start();childPort.start()};
addEventListener('message',event=>{if(event.source===parent&&event.data?.type==='ellie:connect'&&event.data?.pluginId===pluginId&&event.ports.length===1&&!hostPort){hostPort=event.ports[0];connect();return}if(event.source===frame.contentWindow&&event.data?.type==='ellie:child-port'&&event.data?.pluginId===pluginId&&event.ports.length===1&&!childPort){childPort=event.ports[0];connect()}});
frame.addEventListener('load',()=>{if(loaded){stop();frame.remove();return}loaded=true});
frame.srcdoc=new TextDecoder().decode(Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0)));document.body.append(frame)})();</script>`;
    this.headers(response, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": PLUGIN_HOST_CSP,
    });
    response.statusCode = 200;
    response.end(html);
  }
  private pluginHistory(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id);
    this.send(response, 200, { revisions: this.options.plugins.history(found.owner, id) });
  }
  private async pluginAction(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id),
      body = jsonObject(await this.body(request)),
      action = bounded(body.action, "action", 100);
    if (action !== "storage.get" && action !== "storage.set" && action !== "mlb.snapshot")
      throw new HttpError(400, "Plugin action is invalid.");
    let result: unknown;
    if (action === "mlb.snapshot") {
      this.options.plugins.authorize(found.owner, id, "mlb.read");
      if (!this.options.mlb) throw new HttpError(503, "MLB data is unavailable.");
      const [scopeType, ...scopeId] = found.owner.split(":");
      result = await this.options.mlb.snapshot(
        typeof (body.payload as Record<string, unknown> | undefined)?.date === "string"
          ? String((body.payload as Record<string, unknown>).date)
          : this.dateForScope({
              type: scopeType as "user" | "group",
              id: scopeId.join(":"),
            }),
      );
      this.recheckOwner(found.owner);
    } else {
      this.options.plugins.authorize(found.owner, id, "storage");
      const payload = jsonObject(body.payload ?? {}),
        key = identifier(payload.key, "storage key"),
        storageKey = found.owner.startsWith("group:")
          ? groupStorageKey(this.actor.userId, key)
          : key;
      result =
        action === "storage.get"
          ? this.options.plugins.storageGet(found.owner, id, storageKey)
          : this.options.plugins.storageSet(found.owner, id, storageKey, payload.value);
    }
    this.send(response, 200, { value: result });
  }
  private async pluginRollback(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id),
      body = jsonObject(await this.body(request)),
      plugin = this.options.plugins.rollback(
        found.owner,
        id,
        Number(body.expectedVersion),
        Number(body.targetVersion),
      );
    this.send(response, 200, serializePlugin(plugin));
  }
  private async pluginRevise(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    if (!this.options.harness.revisePlugin)
      throw new HttpError(503, "Plugin revision is unavailable without a local model.");
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id),
      body = jsonObject(await this.body(request)),
      [scopeType, ...scopeId] = found.owner.split(":"),
      scope = { type: scopeType as "user" | "group", id: scopeId.join(":") },
      controller = this.requestController(),
      disconnect = () => {
        if (!response.writableFinished)
          controller.abort(new Error("Plugin revision client disconnected."));
      },
      currentAuthority = this.captureAuthority(),
      isContextCurrent = () => {
        if (
          controller.signal.aborted ||
          !currentAuthority() ||
          this.personalResetActive ||
          !this.accepting
        )
          return false;
        try {
          this.recheckOwner(found.owner);
          return true;
        } catch {
          return false;
        }
      };
    this.pluginBuildControllers.add(controller);
    response.once("close", disconnect);
    let plugin: LifePlugin;
    try {
      plugin = await this.options.harness.revisePlugin({
        actor: this.actor,
        scope,
        id,
        request: bounded(body.request, "request", 8000),
        expectedVersion: Number(body.expectedVersion),
        signal: controller.signal,
        isContextCurrent,
      });
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw this.pluginBuildError(error);
    } finally {
      response.off("close", disconnect);
      this.pluginBuildControllers.delete(controller);
    }
    this.recheckOwner(found.owner);
    this.send(response, 200, serializePlugin(plugin));
  }
  private pluginBuildError(error: unknown): Error {
    if (!(error instanceof PluginBuildError))
      return error instanceof Error ? error : new Error("Custom app operation failed.");
    if (error.code === "timeout")
      return new HttpError(504, "The local model took too long. Try a smaller app request.");
    if (error.code === "cancelled")
      return new HttpError(408, "The custom app request was cancelled.");
    if (error.code === "model_unavailable") return new HttpError(422, error.message);
    if (error.code === "access_revoked")
      return new HttpError(403, "Access changed before the custom app was saved.");
    if (error.code === "context_changed" || error.code === "conflict")
      return new HttpError(409, "The app or its context changed. Review it and try again.");
    return new HttpError(
      422,
      "The local model returned an invalid custom app. Refine the request.",
    );
  }
  private pluginDelete(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-1)!)),
      found = this.findPlugin(id);
    this.options.plugins.remove(found.owner, id);
    this.send(response, 204);
  }
  private async static(response: ServerResponse, urlPath: string, head = false): Promise<void> {
    if (!this.options.assetsDir) throw new HttpError(404, "UI assets are unavailable.");
    const root = await realpath(this.options.assetsDir),
      requested = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
    if (requested.includes("\0")) throw new HttpError(400, "Invalid path.");
    const path = resolve(root, requested),
      rel = relative(root, path);
    if (rel.startsWith("..") || rel.includes(`${sep}..${sep}`) || resolve(path) === root)
      throw new HttpError(404, "Asset not found.");
    let info;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new HttpError(404, "Asset not found.");
      const canonicalPath = await realpath(path),
        canonicalRelative = relative(root, canonicalPath);
      if (canonicalRelative.startsWith("..") || canonicalRelative === "")
        throw new HttpError(404, "Asset not found.");
      info = statSync(canonicalPath);
    } catch {
      if (!extname(requested)) {
        return this.static(response, "/", head);
      }
      throw new HttpError(404, "Asset not found.");
    }
    if (!info.isFile() || info.size > 10_000_000) throw new HttpError(404, "Asset not found.");
    this.headers(response, {
      "content-type": mime(path),
      "content-security-policy": APP_CSP,
      "cache-control":
        this.embeddedRequest.getStore() || path.endsWith("index.html")
          ? "no-store"
          : "public, max-age=3600",
    });
    response.statusCode = 200;
    if (head) response.end();
    else {
      const stream = createReadStream(path);
      await new Promise<void>((done) => {
        const settled = () => {
          response.off("finish", settled);
          response.off("close", settled);
          stream.off("error", failed);
          stream.destroy();
          done();
        };
        const failed = () => {
          response.destroy();
          settled();
        };
        response.once("finish", settled);
        response.once("close", settled);
        stream.once("error", failed);
        stream.pipe(response);
      });
    }
  }
}

export function createLifeServer(options: LifeServerOptions): LifeHttpServer {
  return new LifeHttpServer(options);
}
