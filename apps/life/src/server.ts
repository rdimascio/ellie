import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  TextSourceFormat,
} from "../../../packages/life-core/src/index.ts";
import { LifeAccessError, LifeConflictError } from "../../../packages/life-core/src/index.ts";
import type { ContextSignal } from "../../../packages/life-context/src/index.ts";
import {
  commitLifeImport,
  previewLifeImport,
  type LifeImportFormat,
} from "../../../packages/life-import/src/index.ts";
import { LifeLearning } from "../../../packages/life-learning/src/index.ts";
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
const DEADLINE_MS = 15_000;
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
  chat(input: {
    actor: LifeActor;
    scope: LifeScope;
    message: string;
    conversationId?: string;
  }): Promise<{
    reply: string;
    conversationId: string;
    actions?: Array<{ label: string; status: string }>;
  }>;
  buildPlugin?(input: { actor: LifeActor; scope: LifeScope; request: string }): Promise<LifePlugin>;
  revisePlugin?(input: {
    actor: LifeActor;
    scope: LifeScope;
    id: string;
    request: string;
    expectedVersion: number;
  }): Promise<LifePlugin>;
  invalidateContext?(actor: LifeActor, scope: LifeScope): void;
  rerunBackgroundSummary?(input: {
    actor: LifeActor;
    scope: LifeScope;
    taskId: string;
  }): TaskRecord;
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
  private readonly sessions = new Map<string, number>();
  private attempts: number[] = [];
  private contextTail: Promise<void> = Promise.resolve();
  private readonly activeRequests = new Set<Promise<void>>();
  private readonly extractionControllers = new Set<AbortController>();
  private accepting = true;
  private server?: Server;
  private bound?: ListeningLifeServer;
  private readonly now: () => number;
  private readonly actor: LifeActor;
  private readonly options: LifeServerOptions;
  private readonly learning: LifeLearning;
  constructor(options: LifeServerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.actor = { userId: identifier(options.userId ?? "local", "userId") };
    this.learning = new LifeLearning(options.store);
    this.token = options.token ?? randomBytes(32).toString("base64url");
    if (this.token.length < 32 || this.token.length > 256)
      throw new Error("Launch token is invalid.");
    this.tokenHash = digest(this.token);
    this.tokenCreatedAt = this.now();
    this.assertStateRoot();
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
  async listen(): Promise<ListeningLifeServer> {
    if (this.bound) return this.bound;
    const host = this.options.host ?? "127.0.0.1",
      port = this.options.port ?? 7440;
    if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("Invalid life listener.");
    this.accepting = true;
    this.server = createServer((request, response) => {
      if (!this.accepting) {
        this.send(response, 503, { error: "Service is shutting down." });
        return;
      }
      const active = this.handle(request, response);
      this.activeRequests.add(active);
      void active.finally(() => this.activeRequests.delete(active)).catch(() => {});
    });
    this.server.requestTimeout = DEADLINE_MS;
    this.server.headersTimeout = 10_000;
    this.server.maxConnections = 64;
    this.server.on("clientError", (_error, socket) => {
      if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(port, host, () => {
        this.server!.off("error", fail);
        ok();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Life listener did not bind.");
    const url = `http://${host}:${address.port}`;
    return (this.bound = {
      host,
      port: address.port,
      url,
      launchUrl: `${url}/#token=${encodeURIComponent(this.token)}`,
    });
  }
  async close(): Promise<void> {
    this.accepting = false;
    for (const controller of this.extractionControllers) controller.abort();
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
  }
  private headers(response: ServerResponse, extra: Record<string, string> = {}): void {
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
    this.send(response, status, {
      error:
        status === 500
          ? "Request failed."
          : error instanceof Error
            ? error.message
            : "Request failed.",
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
        const chunk = Buffer.from(part);
        size += chunk.length;
        if (size > limit) throw new HttpError(413, "Request body is too large.");
        parts.push(chunk);
      }
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
      const origin = this.validateHost(request);
      this.validateOrigin(request, origin);
      const url = new URL(request.url ?? "/", origin),
        path = url.pathname;
      if (path === "/api/life/session" && request.method === "POST") {
        await this.session(request, response);
        return;
      }
      if (path.startsWith("/api/life/") && !this.authenticated(request))
        throw new HttpError(401, "Authentication required.");
      if (path === "/api/life/bootstrap" && request.method === "GET")
        return await this.bootstrap(url, response);
      if (path === "/api/life/groups" && request.method === "POST")
        return await this.group(request, response);
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
      if (path === "/api/life/chat" && request.method === "POST")
        return await this.chat(request, response);
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
    if (
      typeof token !== "string" ||
      this.tokenUsed ||
      now - this.tokenCreatedAt > (this.options.tokenTtlMs ?? 600_000) ||
      !sameDigest(digest(token), this.tokenHash)
    )
      throw new HttpError(401, "Invalid or expired launch token.");
    this.tokenUsed = true;
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(
      digest(session).toString("hex"),
      now + (this.options.sessionTtlMs ?? 43_200_000),
    );
    this.send(response, 204, undefined, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((this.options.sessionTtlMs ?? 43_200_000) / 1000)}`,
    });
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
      records = recordsPage.items.map(serializeSummary),
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
        .filter(
          (record) =>
            record.kind === "feedback" &&
            record.data.notification === true &&
            record.data.dismissed !== true &&
            (typeof record.data.expiresAt !== "number" || record.data.expiresAt > this.now()),
        )
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
      groups: this.options.store.listGroups(this.actor).map(({ id, name }) => ({ id, name })),
      scope: ownerId,
      records,
      recordsPage: {
        hasMore: recordsPage.hasMore,
        ...(recordsPage.nextCursor ? { nextCursor: recordsPage.nextCursor } : {}),
      },
      agendaRecords: agendaPage.items.map(serializeSummary),
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
    });
  }
  private async group(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request));
    const group = this.options.store.createGroup(this.actor, {
      ...(body.id === undefined ? {} : { id: identifier(body.id) }),
      name: bounded(body.name, "name", 500),
    });
    this.send(response, 201, group);
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
      records: page.items.map(serializeSummary),
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
    this.send(response, 200, serializeRecord(record));
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
      const controller = new AbortController(),
        deadline = setTimeout(() => controller.abort(), DEADLINE_MS);
      this.extractionControllers.add(controller);
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
          throw new HttpError(422, "Source could not be extracted locally.");
        }
      } finally {
        clearTimeout(deadline);
        this.extractionControllers.delete(controller);
      }
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
    this.send(response, 201, serializeRecord(record));
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
    const record = this.options.store.recordFeedback(this.actor, {
      scope: this.scope(body.scope),
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
    });
    this.send(response, 201, serializeRecord(record));
  }
  private recordLearning(body: Record<string, unknown>): LifeRecord {
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
  private async chat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = jsonObject(await this.body(request)),
      scope = this.scope(body.scope),
      result = await this.options.harness.chat({
        actor: this.actor,
        scope,
        message: bounded(body.message, "message", 100_000),
        ...(body.conversationId === undefined
          ? {}
          : { conversationId: identifier(body.conversationId, "conversationId") }),
      });
    this.recheckOwner(owner(scope));
    this.send(response, 200, result);
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
    else if (this.options.harness.buildPlugin)
      try {
        plugin = await this.options.harness.buildPlugin({
          actor: this.actor,
          scope,
          request: requestText,
        });
      } catch (error) {
        if (error instanceof PluginError) throw error;
        throw new HttpError(
          422,
          "Connect a local model to build a custom app; arcade and MLB work now.",
        );
      }
    else throw new HttpError(503, "Custom plugin building is unavailable.");
    this.recheckOwner(owner(scope));
    this.send(response, 201, serializePlugin(plugin));
  }
  private pluginView(response: ServerResponse, path: string): void {
    const id = identifier(decodeURIComponent(path.split("/").at(-2)!)),
      found = this.findPlugin(id),
      pluginHtml = this.options.plugins.view(found.owner, id),
      childPolicy =
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'",
      childBootstrap = `<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(childPolicy)}><script>(()=>{const pluginId=${JSON.stringify(id)},channel=new MessageChannel();parent.postMessage({type:'ellie:child-port',pluginId},'*',[channel.port1]);addEventListener('ellie:deliver-port',()=>postMessage({type:'ellie:connect',pluginId},'*',[channel.port2]),{once:true})})()</script>`,
      childDelivery = `<script>dispatchEvent(new Event('ellie:deliver-port'))</script>`,
      encoded = Buffer.from(`${childBootstrap}${pluginHtml}${childDelivery}`).toString("base64"),
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
      plugin = await this.options.harness
        .revisePlugin({
          actor: this.actor,
          scope: { type: scopeType as "user" | "group", id: scopeId.join(":") },
          id,
          request: bounded(body.request, "request", 8000),
          expectedVersion: Number(body.expectedVersion),
        })
        .catch((error: unknown) => {
          if (error instanceof PluginError) throw error;
          throw new HttpError(422, "Connect a local model to revise this app.");
        });
    this.recheckOwner(found.owner);
    this.send(response, 200, serializePlugin(plugin));
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
      "cache-control": path.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    response.statusCode = 200;
    if (head) response.end();
    else {
      const stream = createReadStream(path);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    }
  }
}

export function createLifeServer(options: LifeServerOptions): LifeHttpServer {
  return new LifeHttpServer(options);
}
