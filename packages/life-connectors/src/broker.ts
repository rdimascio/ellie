import { createHash } from "node:crypto";
import type { LifeRecord, LifeStore } from "../../life-core/src/index.ts";
import type { LifeAnticipationResult } from "../../life-anticipation/src/index.ts";
import type { TaskRuntime } from "../../task-runtime/src/index.ts";
import { ConnectorStore, type Connection, type ConnectionMode } from "./store.ts";
import {
  ProviderError,
  type LifeProviderAdapter,
  type ProviderCredential,
  type ProviderId,
} from "./provider-types.ts";
import { createConnectedResearch } from "./research.ts";
import { isGoogleOAuthProvider, type GoogleOAuthCredential } from "./oauth.ts";
import { ConnectedPreparations } from "./preparations.ts";

export interface CredentialVault {
  put(id: string, value: Record<string, unknown>): void;
  get<T extends object>(id: string): T | undefined;
  delete(id: string): void;
  deleteMatching?(predicate: (id: string, value: object) => boolean): number;
}
export interface ConnectedOAuth {
  cancelAuthorization?(state: string): void;
  begin(input: { actorId: string; provider: "google-calendar" | "gmail"; redirectUri: string }): {
    authorizationUrl: string;
    state: string;
  };
  complete(
    input: { state: string; code: string; redirectUri: string },
    signal?: AbortSignal,
  ): Promise<{
    actorId: string;
    provider: "google-calendar" | "gmail";
    credential: ProviderCredential & { refreshToken?: string; expiresAt?: number };
    grantedScopes: string[];
  }>;
  refreshCredential(
    credential: GoogleOAuthCredential,
    signal?: AbortSignal,
  ): Promise<GoogleOAuthCredential>;
}
type StoredCredential = ProviderCredential & {
  refreshToken?: string;
  expiresAt?: number;
  grantedScopes?: string[];
};
const DAY = 86_400_000;
const AGENDA_HORIZON = 30 * DAY;
const AGENDA_LIMIT = 20;
const civilDay = (value: string): number | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value
    ? instant
    : undefined;
};
/** Preserve complete Unicode scalars when bounding a host-owned display field by UTF-16 units. */
const boundedCalendarText = (value: string, maximum: number): string => {
  let result = "",
    units = 0;
  for (const scalar of value) {
    const point = scalar.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) continue;
    if (units + scalar.length > maximum) break;
    result += scalar;
    units += scalar.length;
  }
  return result;
};
const LABELS: Record<ProviderId, string> = {
  "google-calendar": "Google Calendar",
  gmail: "Gmail",
  plaid: "Financial accounts",
};
const labelFor = (id: string) => LABELS[id] ?? id;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceId = (id: string) => `connected-source-${id}`;
const credentialId = (id: string) => `account-${id}`;
const derivedId = (actor: string, id: string, key: string) =>
  `connected-${hash(`${actor}:${id}:${key}`)}`;

/** The trusted entry point for connected work. It never fabricates chat prompts. */
export class ConnectorBroker {
  readonly store: ConnectorStore;
  private readonly life: LifeStore;
  private readonly vault: CredentialVault;
  private readonly providers: Map<ProviderId, LifeProviderAdapter>;
  private readonly oauth?: ConnectedOAuth;
  private readonly now: () => number;
  private readonly research: ReturnType<typeof createConnectedResearch>;
  private readonly preparations: ConnectedPreparations;
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly pendingOAuthState = new Map<string, string>();
  private readonly blocked = new Set<string>();
  private closed = false;
  constructor(options: {
    store: ConnectorStore;
    life: LifeStore;
    vault: CredentialVault;
    providers: LifeProviderAdapter[];
    tasks: TaskRuntime;
    oauth?: ConnectedOAuth;
    now?: () => number;
  }) {
    this.store = options.store;
    this.life = options.life;
    this.vault = options.vault;
    this.oauth = options.oauth;
    this.now = options.now ?? Date.now;
    this.providers = new Map(options.providers.map((p) => [p.id, p]));
    this.preparations = new ConnectedPreparations({
      life: this.life,
      tasks: options.tasks,
      now: this.now,
      isCurrent: (actorId, id, refs) => {
        const c = this.store.get(actorId, id);
        return (
          !this.closed &&
          !this.blocked.has(actorId) &&
          c?.state === "connected" &&
          c.mode === "prepare" &&
          this.store.evidenceCurrent(actorId, refs)
        );
      },
    });
    this.research = createConnectedResearch({
      tasks: options.tasks,
      now: this.now,
      snapshot: (actorId, connectionId) => {
        const c = this.store.get(actorId, connectionId);
        if (!c || c.state === "revoked" || this.closed || this.blocked.has(actorId))
          return {
            generation: c?.generation ?? 0,
            observations: [],
            explicitSettings: {},
            timeZone: "UTC",
            mode: "revoked" as const,
          };
        const { settings, observations, dismissedKeys, contextRevision } = this.analysisContext(
          actorId,
          connectionId,
        );
        let timeZone =
          typeof settings.timeZone === "string"
            ? settings.timeZone
            : Intl.DateTimeFormat().resolvedOptions().timeZone;
        try {
          new Intl.DateTimeFormat("en", { timeZone }).format(0);
        } catch {
          timeZone = "UTC";
        }
        return {
          generation: c.generation,
          observations,
          explicitSettings: settings,
          timeZone,
          mode: c.state === "connected" ? c.mode : ("paused" as const),
          dismissedKeys,
          contextRevision,
        };
      },
      sync: (actorId, id, signal) => this.sync(actorId, id, signal),
      publish: (actorId, id, generation, result, signal, contextRevision) =>
        this.publish(actorId, id, generation, result, signal, contextRevision),
    });
  }
  private analysisContext(actorId: string, id: string) {
    const actor = { userId: actorId },
      scope = { type: "user" as const, id: actorId },
      settings = { ...this.life.resolveSettings(actor).values };
    const memoryPage = this.life.listAutomaticPromptMemories(actor, { scope, limit: 200 });
    const corrections = memoryPage.items.filter(
      (m) => !m.suppressed && (m.category === "correction" || m.category === "fact"),
    );
    const memoryRecords = this.life.listRecords(actor, { scope, kinds: ["memory"], limit: 100 });
    const explicitMemories = memoryRecords.filter((m) => m.data.explicit === true);
    if (memoryPage.hasMore || memoryRecords.length === 100)
      settings.appointmentPreferenceCoverage =
        "Older explicit preferences may be outside this bounded context.";
    const appointmentPreference = [
      ...corrections.map((m) => m.prompt),
      ...explicitMemories.map((m) => m.body ?? m.title),
    ].find(
      (value) =>
        /\b(?:prefer|preference|rather|instead|avoid|don't like|do not like)\b/i.test(value) &&
        /\b(?:appointments?|scheduling|bookings?)\b/i.test(value),
    );
    if (appointmentPreference)
      settings.appointmentPreferenceFromConversation = appointmentPreference.slice(0, 2000);
    const observations = this.store.observations(actorId, id),
      dismissedKeys = this.store.dismissed(actorId, id);
    return {
      settings,
      observations,
      dismissedKeys,
      contextRevision: hash(
        JSON.stringify({
          settings,
          observations,
          dismissedKeys,
          checkpoint: {
            cursor: this.store.require(actorId, id).cursor,
            continuation: this.store.require(actorId, id).continuation,
          },
          memoryRevision: this.life.automaticPromptMemoryRevision(actor, scope),
        }),
      ),
    };
  }
  private current(actorId: string, id: string, generation?: number): Connection {
    if (this.closed || this.blocked.has(actorId)) throw new Error("Connected work is unavailable.");
    return this.store.require(actorId, id, generation);
  }
  list(actorId: string) {
    return {
      connections: this.store
        .list(actorId)
        .map(({ id, provider, label, state, mode, lastSyncAt, error, selectedCalendarId }) => ({
          id,
          provider,
          label,
          state,
          mode,
          lastSyncAt,
          error,
          ...(provider === "google-calendar"
            ? { selectedCalendarId: selectedCalendarId ?? "primary" }
            : {}),
        })),
      providers: [...this.providers.keys()].map((id) => ({
        id,
        label: labelFor(id),
        configured: isGoogleOAuthProvider(id) && Boolean(this.oauth),
        ...(!isGoogleOAuthProvider(id)
          ? {
              setupMessage:
                id === "plaid"
                  ? "Plaid Link onboarding is not available yet. A host-provisioned account can sync transactions."
                  : "This integration requires host account provisioning.",
            }
          : !this.oauth
            ? {
                setupMessage:
                  "Register a Google desktop OAuth client in the host configuration to connect.",
              }
            : {}),
      })),
    };
  }
  async start(actorId: string, provider: ProviderId, mode: ConnectionMode, redirectUri: string) {
    if (!this.oauth || !isGoogleOAuthProvider(provider) || !this.providers.has(provider))
      throw new Error("This provider requires host setup.");
    if (this.closed || this.blocked.has(actorId)) throw new Error("Connected work is unavailable.");
    const c = this.store.create(actorId, provider, mode);
    let started: { authorizationUrl: string; state: string } | undefined;
    try {
      started = this.oauth.begin({ actorId, provider, redirectUri });
      this.vault.put(`link-${hash(started.state)}`, {
        actorId,
        connectionId: c.id,
        generation: c.generation,
        redirectUri,
      });
      this.pendingOAuthState.set(c.id, started.state);
      return { authorizationUrl: started.authorizationUrl, connectionId: c.id };
    } catch (error) {
      this.store.revoke(actorId, c.id);
      if (started) this.oauth.cancelAuthorization?.(started.state);
      throw error;
    }
  }
  async cancelAuthorization(state: string): Promise<void> {
    const key = `link-${hash(state)}`,
      link = this.vault.get<{ actorId: string; connectionId: string }>(key);
    if (!link) throw new Error("Connection authorization is unavailable.");
    this.vault.delete(key);
    this.pendingOAuthState.delete(link.connectionId);
    this.oauth?.cancelAuthorization?.(state);
    if (this.store.get(link.actorId, link.connectionId)?.state === "connecting")
      await this.revoke(link.actorId, link.connectionId);
  }
  async callback(
    state: string,
    code: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.oauth) throw new Error("Google connection is not configured.");
    const key = `link-${hash(state)}`;
    const link = this.vault.get<{
      actorId: string;
      connectionId: string;
      generation: number;
      redirectUri: string;
    }>(key);
    if (!link || link.redirectUri !== redirectUri)
      throw new Error("Connection authorization expired or was already used.");
    this.vault.delete(key);
    this.pendingOAuthState.delete(link.connectionId);
    this.current(link.actorId, link.connectionId, link.generation);
    try {
      const result = await this.oauth.complete({ state, code, redirectUri }, signal);
      const current = this.current(link.actorId, link.connectionId, link.generation);
      if (result.actorId !== link.actorId || result.provider !== current.provider)
        throw new Error("Connection identity changed.");
      await this.activate(
        link.actorId,
        link.connectionId,
        link.generation,
        result.credential,
        result.grantedScopes,
        signal,
      );
    } catch (error) {
      if (this.store.get(link.actorId, link.connectionId)?.state === "connecting")
        await this.revoke(link.actorId, link.connectionId);
      throw error;
    }
  }
  /** Host-only provisioning seam, also used by isolated provider fixtures. Never an HTTP token endpoint. */
  async connect(
    actorId: string,
    provider: ProviderId,
    credential: StoredCredential,
    mode: ConnectionMode,
    scopes: string[] = [],
  ): Promise<Connection> {
    if (this.closed || this.blocked.has(actorId)) throw new Error("Connected work is unavailable.");
    const c = this.store.create(actorId, provider, mode);
    try {
      await this.activate(actorId, c.id, c.generation, credential, scopes);
    } catch (error) {
      if (this.store.get(actorId, c.id)?.state === "connecting") await this.revoke(actorId, c.id);
      throw error;
    }
    return this.store.require(actorId, c.id);
  }
  private async activate(
    actorId: string,
    id: string,
    generation: number,
    credential: StoredCredential,
    scopes: string[],
    signal?: AbortSignal,
  ) {
    const c = this.current(actorId, id, generation),
      adapter = this.providers.get(c.provider);
    if (!adapter) throw new Error("Provider is not registered.");
    const identity = await adapter.identity(credential, signal ?? AbortSignal.timeout(30_000));
    signal?.throwIfAborted();
    this.current(actorId, id, generation);
    if (c.accountId && c.accountId !== identity.accountId)
      throw new Error("Provider account changed.");
    this.vault.put(credentialId(id), { ...credential });
    try {
      this.store.update(
        actorId,
        id,
        generation,
        {
          accountId: identity.accountId,
          label: identity.label ?? labelFor(c.provider),
          grantedScopes: scopes,
          state: "connected",
        },
        true,
      );
    } catch (error) {
      this.vault.delete(credentialId(id));
      throw error;
    }
    try {
      await this.research.connectionAdded(actorId, id);
    } catch {
      const current = this.current(actorId, id);
      this.store.update(
        actorId,
        id,
        current.generation,
        { error: "background_setup_failed" },
        false,
      );
    }
  }
  async resume(actorId: string): Promise<void> {
    for (const c of this.store.list(actorId))
      if (c.state === "connected") await this.research.connectionAdded(actorId, c.id);
  }
  async refresh(actorId: string, id: string): Promise<void> {
    const c = this.current(actorId, id);
    if (c.state !== "connected") throw new Error("Reconnect this account before refreshing.");
    await this.research.refresh(actorId, id);
  }
  private async currentCredential(actorId: string, c: Connection, signal: AbortSignal) {
    let credential = this.vault.get<StoredCredential>(credentialId(c.id));
    if (!credential) throw new ProviderError("revoked", "Reconnect this account.");
    if (credential.expiresAt !== undefined && credential.expiresAt <= this.now() + 60_000) {
      if (
        !this.oauth ||
        !isGoogleOAuthProvider(c.provider) ||
        !credential.refreshToken ||
        !credential.clientId ||
        !Array.isArray((credential as GoogleOAuthCredential).grantedScopes)
      )
        throw new ProviderError("revoked", "Reconnect this account.");
      credential = await this.oauth.refreshCredential(credential as GoogleOAuthCredential, signal);
      signal.throwIfAborted();
      this.current(actorId, c.id, c.generation);
      this.vault.put(credentialId(c.id), { ...credential });
    }
    signal.throwIfAborted();
    this.current(actorId, c.id, c.generation);
    return credential;
  }
  async calendars(actorId: string, id: string) {
    const c = this.current(actorId, id),
      adapter = this.providers.get(c.provider);
    if (c.state !== "connected" || c.provider !== "google-calendar" || !adapter?.calendars)
      throw new Error("Calendar connection is unavailable.");
    const signal = AbortSignal.timeout(30_000);
    const credential = await this.currentCredential(actorId, c, signal);
    const calendars = await adapter.calendars(credential, signal);
    signal.throwIfAborted();
    this.current(actorId, id, c.generation);
    return {
      calendars,
      selectedCalendarId:
        c.selectedCalendarId ?? calendars.find((item) => item.primary)?.id ?? "primary",
    };
  }
  async selectCalendar(actorId: string, id: string, calendarId: string): Promise<void> {
    if (!calendarId || calendarId.length > 1_024) throw new Error("Calendar selection is invalid.");
    const c = this.current(actorId, id);
    const available = await this.calendars(actorId, id);
    if (!available.calendars.some((item) => item.id === calendarId))
      throw new Error("Calendar selection is unavailable.");
    this.current(actorId, id, c.generation);
    if ((c.selectedCalendarId ?? "primary") === calendarId) return;
    this.active.get(id)?.controller.abort();
    await this.active.get(id)?.promise.catch(() => {});
    this.current(actorId, id, c.generation);
    this.store.selectCalendar(actorId, id, c.generation, calendarId);
    this.invalidateDerived(actorId, id, true);
    await this.refresh(actorId, id);
  }
  preview(actorId: string, id: string) {
    const c = this.current(actorId, id);
    if (c.state === "revoked") throw new Error("Connection is unavailable.");
    const items = this.store
      .observations(actorId, id)
      .filter((item) => !item.deleted && item.kind !== "deleted")
      .sort((a, b) => b.observedAt - a.observedAt)
      .slice(0, 10)
      .map((item) =>
        item.kind === "event"
          ? {
              kind: "event" as const,
              title: item.title.slice(0, 200),
              startAt: item.data.startAt,
              startDate: item.data.startDate,
            }
          : item.kind === "message"
            ? {
                kind: "message" as const,
                subject: item.data.subject.slice(0, 200),
                from: item.data.from.slice(0, 320),
                snippet: item.data.snippet?.slice(0, 500),
                sentAt: item.data.sentAt,
              }
            : null,
      )
      .filter((item) => item !== null);
    return { items, lastSyncAt: c.lastSyncAt, error: c.error, state: c.state };
  }
  /** A bounded projection of already imported events from this actor's selected calendar. */
  agenda(actorId: string, id: string, displayTimeZone: string) {
    const connection = this.current(actorId, id);
    if (connection.provider !== "google-calendar" || connection.state === "revoked")
      throw new Error("Calendar connection is unavailable.");
    const now = this.now();
    const horizonEnd = now + AGENDA_HORIZON;
    if (!/^[A-Za-z0-9_+./-]{1,80}$/.test(displayTimeZone))
      throw new Error("Calendar display time zone is invalid.");
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: displayTimeZone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch {
      throw new Error("Calendar display time zone is invalid.");
    }
    const civilDate = (instant: number) => {
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
      );
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    const firstDay = civilDate(now);
    const lastDay = civilDate(horizonEnd);
    const complete = connection.lastSyncAt !== undefined && !connection.continuation;
    type AgendaEvent = {
      title: string;
      status: "confirmed" | "tentative" | "cancelled";
      startAt?: number;
      endAt?: number;
      startDate?: string;
      endDate?: string;
      timeZone?: string;
      sortAt: number;
      tie: string;
    };
    const events = complete
      ? this.store
          .observations(actorId, id)
          .flatMap((item): AgendaEvent[] => {
            if (item.kind !== "event" || item.deleted || item.data.status === "cancelled")
              return [];
            const { startAt, endAt, startDate, endDate, timeZone, status } = item.data;
            const title = boundedCalendarText(item.title, 160);
            if (!title) return [];
            if (
              Number.isFinite(startAt) &&
              Number.isFinite(endAt) &&
              startAt! < endAt! &&
              endAt! > now &&
              startAt! < horizonEnd
            )
              return [
                {
                  title,
                  startAt: startAt!,
                  endAt: endAt!,
                  ...(timeZone ? { timeZone: boundedCalendarText(timeZone, 80) } : {}),
                  status,
                  sortAt: startAt!,
                  tie: item.sourceKey,
                },
              ];
            const day = startDate ? civilDay(startDate) : undefined;
            if (
              day !== undefined &&
              endDate &&
              civilDay(endDate) !== undefined &&
              startDate! < endDate &&
              endDate > firstDay &&
              startDate! <= lastDay
            )
              return [
                {
                  title,
                  startDate,
                  endDate,
                  status,
                  sortAt: day,
                  tie: item.sourceKey,
                },
              ];
            return [];
          })
          .sort((a, b) => a.sortAt - b.sortAt || a.tie.localeCompare(b.tie))
          .slice(0, AGENDA_LIMIT)
          .map(({ sortAt: _sortAt, tie: _tie, ...event }) => event)
      : [];
    return {
      connectionId: connection.id,
      label: boundedCalendarText(connection.label, 80),
      state: connection.state,
      selectedCalendarId: boundedCalendarText(connection.selectedCalendarId ?? "primary", 1_024),
      displayTimeZone,
      ...(connection.lastSyncAt !== undefined ? { lastSyncAt: connection.lastSyncAt } : {}),
      complete,
      horizonStart: now,
      horizonEnd,
      events,
    };
  }
  async setMode(actorId: string, id: string, mode: ConnectionMode): Promise<void> {
    if (!["observe", "prepare"].includes(mode)) throw new TypeError("Connection mode is invalid.");
    const c = this.current(actorId, id);
    this.store.update(actorId, id, c.generation, { mode }, true);
    this.active.get(id)?.controller.abort();
    if (mode === "observe")
      for (const mapping of this.store.derived(actorId, id))
        if (mapping.taskId) {
          this.preparations.invalidate(actorId, { ...mapping, taskId: mapping.taskId });
          this.store.removeDerived(actorId, id, mapping.key);
        }
    await this.research.refresh(actorId, id);
  }
  async sync(actorId: string, id: string, signal?: AbortSignal): Promise<void> {
    this.current(actorId, id);
    if (this.active.has(id)) return this.active.get(id)!.promise;
    const controller = new AbortController(),
      combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const promise = this.pull(actorId, id, combined);
    this.active.set(id, { controller, promise });
    try {
      await promise;
    } finally {
      this.active.delete(id);
    }
  }
  private async pull(actorId: string, id: string, signal: AbortSignal): Promise<void> {
    const c = this.current(actorId, id),
      generation = c.generation,
      adapter = this.providers.get(c.provider);
    if (c.state !== "connected" || !adapter) throw new Error("Connection is unavailable.");
    try {
      const credential = await this.currentCredential(actorId, c, signal);
      let resetCursor = false,
        restartedBatch = false;
      for (let page = 0; page < 20; page++) {
        signal.throwIfAborted();
        const current = this.current(actorId, id, generation);
        let result;
        try {
          result = await adapter.pull({
            credential,
            ...(c.provider === "google-calendar"
              ? { resourceId: current.selectedCalendarId ?? "primary" }
              : {}),
            cursor: current.cursor,
            continuation: current.continuation,
            window: { from: this.now() - 366 * DAY, to: this.now() + 366 * DAY },
            limit: 250,
            signal,
          });
        } catch (error) {
          if (error instanceof ProviderError && error.code === "restart_batch" && !restartedBatch) {
            this.current(actorId, id, generation);
            this.store.update(actorId, id, generation, { continuation: undefined }, false);
            restartedBatch = true;
            continue;
          }
          if (error instanceof ProviderError && error.code === "expired_cursor" && !resetCursor) {
            this.current(actorId, id, generation);
            this.store.clearEvidence(actorId, id, generation);
            this.invalidateDerived(actorId, id);
            this.store.update(
              actorId,
              id,
              generation,
              { cursor: undefined, continuation: undefined },
              false,
            );
            resetCursor = true;
            continue;
          }
          throw error;
        }
        signal.throwIfAborted();
        this.current(actorId, id, generation);
        this.store.ingest(actorId, id, generation, result, this.now());
        this.invalidateDerived(actorId, id);
        if (result.complete) return;
      }
      throw new ProviderError(
        "limit_exceeded",
        "Sync is partial; the next scheduled pass will continue.",
      );
    } catch (error) {
      if (!signal.aborted) {
        const current = this.store.get(actorId, id);
        if (current && current.generation === generation && current.state !== "revoked") {
          const code = error instanceof ProviderError ? error.code : "provider_error";
          this.store.update(
            actorId,
            id,
            generation,
            { error: code, ...(code === "revoked" ? { state: "error" as const } : {}) },
            code === "revoked",
          );
        }
      }
      throw error instanceof ProviderError ? error : new Error("Connected sync did not finish.");
    }
  }
  private ensureSource(actorId: string, c: Connection): string {
    const id = sourceId(c.id),
      actor = { userId: actorId };
    if (!this.life.getRecord(actor, id))
      this.life.ingestSource(actor, {
        id,
        scope: { type: "user", id: actorId },
        title: `Connected ${labelFor(c.provider)}`,
        format: "text",
        content:
          "Private connected activity. Conclusions below are inferred from current provider evidence and may be corrected.",
        metadata: { connectionId: c.id, provider: c.provider },
      });
    return id;
  }
  private invalidateDerived(
    actorId: string,
    id: string,
    all = false,
    eligibleKeys?: Set<string>,
  ): void {
    const actor = { userId: actorId };
    for (const mapping of this.store.derived(actorId, id)) {
      if (
        !all &&
        (!eligibleKeys || eligibleKeys.has(mapping.key)) &&
        mapping.expiresAt > this.now() &&
        this.store.evidenceCurrent(actorId, mapping.evidenceRefs)
      )
        continue;
      const record = this.life.getRecord(actor, mapping.recordId);
      if (mapping.taskId) {
        this.preparations.invalidate(actorId, { ...mapping, taskId: mapping.taskId });
        if (!record || record.revision === mapping.revision)
          this.store.removeDerived(actorId, id, mapping.key);
        continue;
      }
      if (!record) continue;
      if (record.revision === mapping.revision) {
        this.life.deleteRecord(actor, record.id, record.revision);
        this.store.removeDerived(actorId, id, mapping.key);
      } else if (record.provenance.some((p) => p.invalidatedAt === undefined))
        this.life.updateRecord(actor, record.id, record.revision, {
          provenance: record.provenance.map((p) => ({ ...p, invalidatedAt: this.now() })),
        });
    }
  }
  publish(
    actorId: string,
    id: string,
    generation: number,
    result: LifeAnticipationResult,
    signal?: AbortSignal,
    contextRevision?: string,
  ): void {
    signal?.throwIfAborted();
    const c = this.current(actorId, id, generation);
    if (c.state !== "connected" || c.continuation)
      throw new Error("Connection is not ready for analysis.");
    const settings = this.life.resolveSettings({ userId: actorId }).values;
    const prepareEnabled =
      c.mode === "prepare" && (settings.proactiveSuggestions ?? settings.proactive) !== false;
    if (
      contextRevision !== undefined &&
      this.analysisContext(actorId, id).contextRevision !== contextRevision
    )
      throw new Error("Connected analysis context changed.");
    const valid = {
      ...result,
      insights: result.insights.filter(
        (i) => i.validUntil > this.now() && this.store.evidenceCurrent(actorId, i.evidenceRefs),
      ),
      proposals: result.proposals.filter(
        (p) => p.expiresAt > this.now() && this.store.evidenceCurrent(actorId, p.evidenceRefs),
      ),
    };
    this.store.saveAnalysis(actorId, id, generation, valid);
    this.invalidateDerived(
      actorId,
      id,
      false,
      result.partial
        ? undefined
        : new Set([
            ...valid.insights.map((i) => i.key),
            ...valid.proposals.flatMap((p) => [
              p.key,
              ...(prepareEnabled ? [`reminder:${p.key}`] : []),
            ]),
          ]),
    );
    const source = this.ensureSource(actorId, c),
      actor = { userId: actorId },
      scope = { type: "user" as const, id: actorId },
      dismissed = new Set(this.store.dismissed(actorId, id));
    const apply = (
      key: string,
      expiresAt: number,
      evidenceRefs: Parameters<ConnectorStore["evidenceCurrent"]>[1],
      input: {
        kind: "memory" | "goal";
        title: string;
        body: string;
        data: Record<string, unknown>;
      },
    ) => {
      if (dismissed.has(key) || this.store.isDismissed(actorId, id, key)) return;
      const recordId = derivedId(actorId, id, key),
        old = this.life.getRecord(actor, recordId),
        mapping = this.store.derived(actorId, id).find((d) => d.key === key);
      // A user deletion or edit is a correction, and may not be silently overwritten.
      if (mapping && (!old || old.revision !== mapping.revision)) {
        this.store.dismiss(actorId, id, key);
        return;
      }
      const provenance = [
        {
          sourceId: source,
          reference: evidenceRefs
            .map((r) => `${r.sourceKey}@${r.sourceRevision}`)
            .join("; ")
            .slice(0, 500),
          derived: true,
        },
      ];
      const data = {
        ...input.data,
        connected: { connectionId: id, key, evidenceRefs, expiresAt },
        explicit: false,
      };
      if (
        old &&
        !mapping &&
        (old.revision !== 1 ||
          JSON.stringify(old.data) !== JSON.stringify(data) ||
          old.body !== input.body)
      ) {
        this.store.dismiss(actorId, id, key);
        return;
      }
      let record: LifeRecord;
      if (old) {
        if (JSON.stringify(old.data) === JSON.stringify(data) && old.body === input.body) {
          this.store.saveDerived(actorId, id, {
            key,
            recordId,
            revision: old.revision,
            evidenceRefs,
            expiresAt,
          });
          return;
        }
        record = this.life.updateRecord(actor, recordId, old.revision, {
          title: input.title,
          body: input.body,
          data,
          provenance,
        });
      } else
        record = this.life.createRecord(actor, { id: recordId, scope, ...input, data, provenance });
      this.store.saveDerived(actorId, id, {
        key,
        recordId,
        revision: record.revision,
        evidenceRefs,
        expiresAt,
      });
    };
    for (const i of valid.insights)
      apply(i.key, i.validUntil, i.evidenceRefs, {
        kind: "memory",
        title: i.statement.slice(0, 200),
        body: `Inferred: ${i.statement}\n${i.caveats.join("\n")}\nExplicit preferences take precedence.`,
        data: { type: "connected-insight-v1", confidence: i.confidence },
      });
    if (prepareEnabled)
      for (const p of valid.proposals) {
        if (
          this.life.listPlanRecords(actor, { scope, limit: 65 }).length >= 64 &&
          !this.life.getRecord(actor, derivedId(actorId, id, p.key))
        )
          continue;
        apply(p.key, p.expiresAt, p.evidenceRefs, {
          kind: "goal",
          title: p.title.slice(0, 200),
          body: p.reason,
          data: {
            type: "life-plan-v1",
            steps: p.steps.map((title, index) => ({
              id: `step-${index + 1}`,
              title,
              completed: false,
            })),
            completed: false,
            reason: p.reason,
            confidence: p.confidence,
            horizon: p.horizon,
          },
        });
        const reminderKey = `reminder:${p.key}`;
        if (
          !this.store.isDismissed(actorId, id, p.key) &&
          !this.store.isDismissed(actorId, id, reminderKey)
        ) {
          const mapping = this.store.derived(actorId, id).find((m) => m.key === reminderKey),
            current = mapping ? this.life.getRecord(actor, mapping.recordId) : undefined;
          if (mapping && (!current || current.revision !== mapping.revision)) {
            this.store.dismiss(actorId, id, reminderKey);
            continue;
          }
          const reminder = this.preparations.apply(actorId, id, p, source, c.generation);
          if (reminder) {
            if (mapping?.taskId && mapping.taskId !== reminder.taskId) {
              try {
                this.preparations.invalidate(actorId, { ...mapping, taskId: mapping.taskId });
              } catch (error) {
                this.preparations.invalidate(actorId, reminder);
                throw error;
              }
            }
            this.store.saveDerived(actorId, id, reminder);
          }
        }
      }
  }
  async revoke(actorId: string, id: string): Promise<void> {
    if (!this.store.get(actorId, id)) throw new Error("Connection unavailable.");
    this.store.revoke(actorId, id);
    this.active.get(id)?.controller.abort();
    this.vault.delete(credentialId(id));
    // A stopped setup cannot later exchange a code. The in-memory state handles the current
    // process; the encrypted vault scan also covers a pending setup restored after restart.
    const state = this.pendingOAuthState.get(id);
    this.pendingOAuthState.delete(id);
    if (state) {
      this.vault.delete(`link-${hash(state)}`);
      this.oauth?.cancelAuthorization?.(state);
    }
    const pendingHashes: string[] = [];
    this.vault.deleteMatching?.((key, value) => {
      if (!/^link-[0-9a-f]{64}$/.test(key)) return false;
      const link = value as { actorId?: unknown; connectionId?: unknown };
      if (link.actorId !== actorId || link.connectionId !== id) return false;
      pendingHashes.push(key.slice(5));
      return true;
    });
    for (const digest of pendingHashes) this.vault.delete(`oauth-state:${digest}`);
    await this.research.revoke(actorId, id);
    await this.active.get(id)?.promise.catch(() => {});
    this.invalidateDerived(actorId, id, true);
    const source = this.life.getRecord({ userId: actorId }, sourceId(id));
    if (source) this.life.deleteSource({ userId: actorId }, source.id, source.revision);
  }
  block(actorId: string): void {
    this.blocked.add(actorId);
    for (const c of this.store.list(actorId)) this.active.get(c.id)?.controller.abort();
  }
  unblock(actorId: string): void {
    this.blocked.delete(actorId);
  }
  async deletePersonal(actorId: string): Promise<void> {
    this.block(actorId);
    for (const c of this.store.list(actorId)) await this.revoke(actorId, c.id);
    this.vault.deleteMatching?.(
      (_id, value) => (value as Record<string, unknown>).actorId === actorId,
    );
    this.store.deletePersonal(actorId);
  }
  async close(): Promise<void> {
    this.closed = true;
    this.pendingOAuthState.clear();
    for (const active of this.active.values()) active.controller.abort();
    await this.research.close();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
  }
}
