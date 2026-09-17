import { createHash } from "node:crypto";
import {
  ProviderError,
  type LifeProviderAdapter,
  type ProviderCredential,
  type ProviderObservation,
  type ProviderPullInput,
  type ProviderPullResult,
} from "./provider-types.ts";

const GOOGLE_CALENDAR = "https://www.googleapis.com",
  GMAIL = "https://gmail.googleapis.com",
  PLAID_ORIGINS = {
    sandbox: "https://sandbox.plaid.com",
    development: "https://development.plaid.com",
    production: "https://production.plaid.com",
  } as const,
  MAX_RESPONSE_BYTES = 1_048_576,
  MAX_ITEMS = 250,
  DEFAULT_DEADLINE_MS = 15_000;

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

export interface ProviderAdapterOptions {
  fetch?: Fetch;
  now?: () => number;
  deadlineMs?: number;
  plaidEnvironment?: keyof typeof PLAID_ORIGINS;
}

function text(value: unknown, max = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return clean ? clean.slice(0, max) : undefined;
}
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError("invalid_response", "The provider returned an invalid response.");
  return value as Json;
}
function array(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new ProviderError("invalid_response", "The provider returned an invalid response.");
  return value;
}
function requiredText(value: unknown, max = 2_000): string {
  const result = text(value, max);
  if (!result)
    throw new ProviderError("invalid_response", "The provider returned an invalid response.");
  return result;
}
function calendarId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1_024 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new ProviderError("invalid_response", "Calendar identifier is invalid.");
  return value;
}
function instant(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function date(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === value ? value : undefined;
}
function decimal(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const result = Object.is(value, -0) ? "0" : String(value);
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(result) ? result : undefined;
}
function revision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function boundedInput(input: ProviderPullInput): void {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_ITEMS)
    throw new ProviderError("limit_exceeded", `Provider pulls accept 1-${MAX_ITEMS} items.`);
  if (
    !Number.isSafeInteger(input.window.from) ||
    !Number.isSafeInteger(input.window.to) ||
    input.window.from >= input.window.to
  )
    throw new ProviderError("invalid_response", "The provider window is invalid.");
  for (const value of [input.cursor, input.continuation])
    if (value !== undefined && (typeof value !== "string" || value.length > 4_096))
      throw new ProviderError("invalid_response", "The provider cursor is invalid.");
}
function continuation(value: unknown, provider: string): Json | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = object(
      JSON.parse(Buffer.from(requiredText(value, 4_096), "base64url").toString()),
    );
    if (parsed.provider !== provider) throw new Error("provider");
    return parsed;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("invalid_response", "The provider continuation is invalid.");
  }
}
function encodeContinuation(value: Json): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function auth(credential: ProviderCredential): Record<string, string> {
  if (!credential.accessToken || credential.accessToken.length > 8_192)
    throw new ProviderError("unavailable", "This provider is not connected.");
  return { authorization: `Bearer ${credential.accessToken}` };
}

class Client {
  readonly fetch: Fetch;
  readonly now: () => number;
  readonly deadlineMs: number;
  constructor(options: ProviderAdapterOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    if (!Number.isInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 60_000)
      throw new TypeError("Provider deadline must be 1-60000ms.");
  }
  private async errorCode(
    response: Response,
    stopped: Promise<never>,
  ): Promise<string | undefined> {
    if (!response.body) return;
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await Promise.race([reader.read(), stopped]);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1_024) {
        await reader.cancel();
        return;
      }
      chunks.push(part.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return text(
        object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined))).error_code,
        200,
      );
    } catch {
      return;
    }
  }
  async json(url: string, init: RequestInit, signal: AbortSignal, expired = false): Promise<Json> {
    if (signal.aborted) throw new ProviderError("cancelled", "Provider sync was cancelled.");
    const controller = new AbortController();
    let stop!: (error: ProviderError) => void;
    const stopped = new Promise<never>((_resolve, reject) => {
        stop = reject;
      }),
      abort = () => {
        controller.abort();
        stop(new ProviderError("cancelled", "Provider sync was cancelled."));
      },
      timer = setTimeout(() => {
        controller.abort();
        stop(new ProviderError("timeout", "Provider sync timed out."));
      }, this.deadlineMs);
    void stopped.catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      let response: Response;
      try {
        const operation = this.fetch(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        });
        void operation.catch(() => {});
        response = await Promise.race([operation, stopped]);
      } catch (error) {
        if (signal.aborted)
          throw new ProviderError("cancelled", "Provider sync was cancelled.", { cause: error });
        if (controller.signal.aborted)
          throw new ProviderError("timeout", "Provider sync timed out.", { cause: error });
        throw new ProviderError("provider_error", "The provider could not be reached.", {
          cause: error,
        });
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403)
          throw new ProviderError("revoked", "The provider connection is no longer authorized.");
        if (response.status === 429)
          throw new ProviderError("rate_limited", "The provider rate limit was reached.");
        if (expired && (response.status === 404 || response.status === 410))
          throw new ProviderError("expired_cursor", "The provider cursor has expired.");
        if (
          response.status === 400 &&
          url.endsWith("/transactions/sync") &&
          (await this.errorCode(response, stopped)) ===
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"
        )
          throw new ProviderError(
            "restart_batch",
            "The provider transaction batch changed and must restart from its stable cursor.",
          );
        throw new ProviderError(
          "provider_error",
          `The provider request failed (${response.status}).`,
        );
      }
      if (!response.body)
        throw new ProviderError("invalid_response", "The provider returned an invalid response.");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await Promise.race([reader.read(), stopped]);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new ProviderError("limit_exceeded", "The provider response was too large.");
        }
        chunks.push(part.value);
      }
      const joined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined)));
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError("invalid_response", "The provider returned invalid JSON.");
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}

export class GoogleCalendarProvider implements LifeProviderAdapter {
  readonly id = "google-calendar" as const;
  private readonly client: Client;
  constructor(options: ProviderAdapterOptions = {}) {
    this.client = new Client(options);
  }
  async calendars(credential: ProviderCredential, signal: AbortSignal) {
    const calendars: { id: string; label: string; primary: boolean }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = new URL(`${GOOGLE_CALENDAR}/calendar/v3/users/me/calendarList`);
      url.searchParams.set("maxResults", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const value = await this.client.json(url.href, { headers: auth(credential) }, signal);
      for (const raw of array(value.items)) {
        const item = object(raw),
          id = calendarId(item.id);
        calendars.push({
          id,
          label: text(item.summary, 200) ?? "Calendar",
          primary: item.primary === true,
        });
      }
      if (calendars.length > 500)
        throw new ProviderError("limit_exceeded", "Calendar list is too large.");
      pageToken = text(value.nextPageToken, 4_096);
      if (!pageToken) return calendars;
    }
    throw new ProviderError("limit_exceeded", "Calendar list is partial.");
  }
  async identity(credential: ProviderCredential, signal: AbortSignal) {
    const value = await this.client.json(
      `${GOOGLE_CALENDAR}/calendar/v3/calendars/primary`,
      { headers: auth(credential) },
      signal,
    );
    return {
      accountId: requiredText(value.id, 1_024),
      ...(text(value.summary) ? { label: text(value.summary) } : {}),
    };
  }
  async pull(input: ProviderPullInput): Promise<ProviderPullResult> {
    boundedInput(input);
    const resourceId = input.resourceId ?? "primary";
    calendarId(resourceId);
    const identity = await this.identity(input.credential, input.signal),
      saved = continuation(input.continuation, this.id),
      baseCursor = text(saved?.cursor, 4_096) ?? input.cursor,
      pageToken = text(saved?.pageToken, 4_096),
      windowFrom = typeof saved?.windowFrom === "number" ? saved.windowFrom : input.window.from,
      windowTo = typeof saved?.windowTo === "number" ? saved.windowTo : input.window.to,
      url = new URL(
        `${GOOGLE_CALENDAR}/calendar/v3/calendars/${encodeURIComponent(resourceId)}/events`,
      );
    if (
      (saved?.windowFrom !== undefined && typeof saved.windowFrom !== "number") ||
      (saved?.windowTo !== undefined && typeof saved.windowTo !== "number") ||
      !Number.isSafeInteger(windowFrom) ||
      !Number.isSafeInteger(windowTo) ||
      windowFrom >= windowTo
    )
      throw new ProviderError("invalid_response", "The provider continuation is invalid.");
    url.searchParams.set("maxResults", String(input.limit));
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "true");
    if (baseCursor) url.searchParams.set("syncToken", baseCursor);
    else {
      url.searchParams.set("timeMin", new Date(windowFrom).toISOString());
      url.searchParams.set("timeMax", new Date(windowTo).toISOString());
    }
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const value = await this.client.json(
        url.href,
        { headers: auth(input.credential) },
        input.signal,
        Boolean(baseCursor),
      ),
      observedAt = this.client.now(),
      items = array(value.items).map((raw): ProviderObservation => {
        const event = object(raw),
          id = requiredText(event.id, 1_024),
          status: "confirmed" | "tentative" | "cancelled" =
            event.status === "cancelled" || event.status === "tentative"
              ? event.status
              : "confirmed",
          start = object(event.start ?? {}),
          end = object(event.end ?? {}),
          selected = {
            etag: text(event.etag),
            sequence: event.sequence,
            updated: text(event.updated),
            status,
          };
        if (status === "cancelled")
          return {
            sourceKey: id,
            sourceRevision: revision(selected),
            observedAt,
            title: "Deleted calendar event",
            deleted: true,
            kind: "deleted",
            data: { previousKind: "event" },
          };
        const data = {
          ...(instant(start.dateTime) !== undefined ? { startAt: instant(start.dateTime) } : {}),
          ...(instant(end.dateTime) !== undefined ? { endAt: instant(end.dateTime) } : {}),
          ...(date(start.date) ? { startDate: date(start.date) } : {}),
          ...(date(end.date) ? { endDate: date(end.date) } : {}),
          ...(text(start.timeZone, 128) ? { timeZone: text(start.timeZone, 128) } : {}),
          status,
          ...(text(event.location) ? { location: text(event.location) } : {}),
          ...(typeof object(event.organizer ?? {}).self === "boolean"
            ? { organizerIsSelf: object(event.organizer ?? {}).self as boolean }
            : {}),
        };
        return {
          sourceKey: id,
          sourceRevision: revision({ selected, data, summary: text(event.summary) }),
          observedAt,
          title: text(event.summary) ?? "Calendar event",
          kind: "event",
          data,
        };
      });
    if (items.length > input.limit)
      throw new ProviderError("limit_exceeded", "The provider returned too many changes.");
    const next = text(value.nextPageToken, 4_096);
    if (next)
      return {
        accountId: identity.accountId,
        items,
        continuation: encodeContinuation({
          provider: this.id,
          ...(baseCursor ? { cursor: baseCursor } : {}),
          ...(!baseCursor ? { windowFrom, windowTo } : {}),
          pageToken: next,
        }),
        complete: false,
      };
    return {
      accountId: identity.accountId,
      items,
      cursor: requiredText(value.nextSyncToken, 4_096),
      complete: true,
    };
  }
}

function header(message: Json, name: string): string | undefined {
  const payload = object(message.payload ?? {});
  for (const raw of array(payload.headers)) {
    const candidate = object(raw);
    if (text(candidate.name, 100)?.toLowerCase() === name.toLowerCase())
      return text(candidate.value);
  }
  return undefined;
}

export class GmailProvider implements LifeProviderAdapter {
  readonly id = "gmail" as const;
  private readonly client: Client;
  constructor(options: ProviderAdapterOptions = {}) {
    this.client = new Client(options);
  }
  private async profile(credential: ProviderCredential, signal: AbortSignal) {
    const value = await this.client.json(
      `${GMAIL}/gmail/v1/users/me/profile`,
      { headers: auth(credential) },
      signal,
    );
    return {
      accountId: requiredText(value.emailAddress, 320),
      label: requiredText(value.emailAddress, 320),
      cursor: requiredText(value.historyId, 4_096),
    };
  }
  async identity(credential: ProviderCredential, signal: AbortSignal) {
    const { accountId, label } = await this.profile(credential, signal);
    return { accountId, label };
  }
  private async message(
    id: string,
    credential: ProviderCredential,
    signal: AbortSignal,
    accountId: string,
  ): Promise<ProviderObservation> {
    const url = new URL(`${GMAIL}/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
    url.searchParams.set("format", "metadata");
    for (const name of ["From", "To", "Subject", "Date"])
      url.searchParams.append("metadataHeaders", name);
    const value = await this.client.json(url.href, { headers: auth(credential) }, signal),
      sentAt = Number(value.internalDate),
      from = header(value, "From") ?? "",
      to = (header(value, "To") ?? "")
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 50),
      labels = array(value.labelIds)
        .flatMap((label) => (text(label, 100) ? [text(label, 100)!] : []))
        .slice(0, 100),
      data = {
        sentAt: Number.isSafeInteger(sentAt) ? sentAt : (instant(header(value, "Date")) ?? 0),
        from,
        to,
        subject: header(value, "Subject") ?? "(no subject)",
        ...(text(value.snippet, 1_000) ? { snippet: text(value.snippet, 1_000) } : {}),
        direction: labels.includes("SENT")
          ? ("outgoing" as const)
          : labels.includes("INBOX")
            ? ("incoming" as const)
            : ("unknown" as const),
        ...(labels.length ? { labels } : {}),
      };
    return {
      sourceKey: id,
      sourceRevision: revision({ historyId: value.historyId, threadId: value.threadId, data }),
      observedAt: this.client.now(),
      title: data.subject,
      kind: "message",
      data,
    };
  }
  async pull(input: ProviderPullInput): Promise<ProviderPullResult> {
    boundedInput(input);
    const identity = await this.profile(input.credential, input.signal),
      saved = continuation(input.continuation, this.id),
      baseCursor = text(saved?.cursor, 4_096) ?? input.cursor,
      initialCursor = text(saved?.initialCursor, 4_096) ?? identity.cursor,
      pageToken = text(saved?.pageToken, 4_096),
      windowFrom = typeof saved?.windowFrom === "number" ? saved.windowFrom : input.window.from,
      windowTo = typeof saved?.windowTo === "number" ? saved.windowTo : input.window.to,
      url = new URL(
        baseCursor ? `${GMAIL}/gmail/v1/users/me/history` : `${GMAIL}/gmail/v1/users/me/messages`,
      );
    if (
      (saved?.windowFrom !== undefined && typeof saved.windowFrom !== "number") ||
      (saved?.windowTo !== undefined && typeof saved.windowTo !== "number") ||
      !Number.isSafeInteger(windowFrom) ||
      !Number.isSafeInteger(windowTo) ||
      windowFrom >= windowTo
    )
      throw new ProviderError("invalid_response", "The provider continuation is invalid.");
    url.searchParams.set("maxResults", String(Math.min(input.limit, 100)));
    if (baseCursor) {
      url.searchParams.set("startHistoryId", baseCursor);
      for (const type of ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"])
        url.searchParams.append("historyTypes", type);
    } else
      url.searchParams.set(
        "q",
        `after:${Math.floor(windowFrom / 1_000)} before:${Math.ceil(windowTo / 1_000)}`,
      );
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const value = await this.client.json(
      url.href,
      { headers: auth(input.credential) },
      input.signal,
      Boolean(baseCursor),
    );
    const additions = new Set<string>(),
      deletions = new Set<string>();
    if (baseCursor)
      for (const raw of array(value.history)) {
        const history = object(raw);
        for (const added of array(history.messagesAdded))
          additions.add(
            requiredText(object(added).message && object(object(added).message).id, 1_024),
          );
        for (const removed of array(history.messagesDeleted))
          deletions.add(
            requiredText(object(removed).message && object(object(removed).message).id, 1_024),
          );
        for (const changed of [...array(history.labelsAdded), ...array(history.labelsRemoved)])
          additions.add(
            requiredText(object(changed).message && object(object(changed).message).id, 1_024),
          );
      }
    else
      for (const raw of array(value.messages)) additions.add(requiredText(object(raw).id, 1_024));
    if (additions.size + deletions.size > input.limit)
      throw new ProviderError("limit_exceeded", "The provider returned too many changes.");
    const items: ProviderObservation[] = [];
    for (const id of [...additions].slice(0, input.limit))
      if (!deletions.has(id))
        items.push(await this.message(id, input.credential, input.signal, identity.accountId));
    for (const id of deletions)
      items.push({
        sourceKey: id,
        sourceRevision: revision({ deleted: true, historyId: value.historyId }),
        observedAt: this.client.now(),
        title: "Deleted message",
        deleted: true,
        kind: "deleted",
        data: { previousKind: "message" },
      });
    const next = text(value.nextPageToken, 4_096);
    if (next)
      return {
        accountId: identity.accountId,
        items,
        continuation: encodeContinuation({
          provider: this.id,
          ...(baseCursor ? { cursor: baseCursor } : {}),
          ...(!baseCursor ? { initialCursor } : {}),
          ...(!baseCursor ? { windowFrom, windowTo } : {}),
          pageToken: next,
        }),
        complete: false,
      };
    return {
      accountId: identity.accountId,
      items,
      cursor: baseCursor ? requiredText(value.historyId, 4_096) : initialCursor,
      complete: true,
    };
  }
}

export class PlaidProvider implements LifeProviderAdapter {
  readonly id = "plaid" as const;
  private readonly client: Client;
  private readonly origin: string;
  constructor(options: ProviderAdapterOptions = {}) {
    this.client = new Client(options);
    this.origin = PLAID_ORIGINS[options.plaidEnvironment ?? "production"];
  }
  private body(credential: ProviderCredential, extra: Json = {}): string {
    if (!credential.accessToken || !credential.clientId || !credential.clientSecret)
      throw new ProviderError("unavailable", "This provider is not connected.");
    return JSON.stringify({
      access_token: credential.accessToken,
      client_id: credential.clientId,
      secret: credential.clientSecret,
      ...extra,
    });
  }
  async identity(credential: ProviderCredential, signal: AbortSignal) {
    const value = await this.client.json(
      `${this.origin}/item/get`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: this.body(credential),
      },
      signal,
    );
    return {
      accountId: requiredText(object(value.item).item_id, 1_024),
      ...(text(object(value.item).institution_id)
        ? { label: text(object(value.item).institution_id) }
        : {}),
    };
  }
  async pull(input: ProviderPullInput): Promise<ProviderPullResult> {
    boundedInput(input);
    const identity = await this.identity(input.credential, input.signal),
      saved = continuation(input.continuation, this.id),
      cursor = text(saved?.cursor, 4_096) ?? input.cursor,
      value = await this.client.json(
        `${this.origin}/transactions/sync`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: this.body(input.credential, { ...(cursor ? { cursor } : {}), count: input.limit }),
        },
        input.signal,
      ),
      observedAt = this.client.now(),
      transaction = (raw: unknown): ProviderObservation => {
        const item = object(raw),
          id = requiredText(item.transaction_id, 1_024),
          posted = date(item.date),
          amountDecimal = decimal(item.amount),
          currency = text(item.iso_currency_code, 16) ?? text(item.unofficial_currency_code, 16);
        if (!posted || !amountDecimal || !currency)
          throw new ProviderError(
            "invalid_response",
            "The provider returned an invalid transaction.",
          );
        const data = {
          postedAt: Date.parse(`${posted}T00:00:00Z`),
          amountDecimal,
          currency,
          ...((text(item.merchant_name) ?? text(item.name))
            ? { merchant: text(item.merchant_name) ?? text(item.name) }
            : {}),
          ...(text(object(item.personal_finance_category ?? {}).primary, 200)
            ? { category: text(object(item.personal_finance_category ?? {}).primary, 200) }
            : {}),
          pending: item.pending === true,
        };
        return {
          sourceKey: id,
          sourceRevision: revision(data),
          observedAt,
          title: data.merchant ?? "Transaction",
          kind: "transaction",
          data,
        };
      },
      items = [...array(value.added), ...array(value.modified)].map(transaction);
    for (const raw of array(value.removed)) {
      const id = requiredText(object(raw).transaction_id, 1_024);
      items.push({
        sourceKey: id,
        sourceRevision: revision({ deleted: true }),
        observedAt,
        title: "Deleted transaction",
        deleted: true,
        kind: "deleted",
        data: { previousKind: "transaction" },
      });
    }
    if (items.length > input.limit)
      throw new ProviderError("limit_exceeded", "The provider returned too many changes.");
    const next = text(value.next_cursor, 4_096);
    if (!next) throw new ProviderError("not_ready", "Provider transactions are not ready yet.");
    if (value.has_more === true)
      return {
        accountId: identity.accountId,
        items,
        continuation: encodeContinuation({ provider: this.id, cursor: next }),
        complete: false,
      };
    return { accountId: identity.accountId, items, cursor: next, complete: true };
  }
}
