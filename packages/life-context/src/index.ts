import { createHash } from "node:crypto";
import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";
import { LifeStore } from "../../life-core/src/index.ts";
import {
  addCalendarDays,
  calendarDateKey,
  localParts,
  parseCalendarDate,
  parseInstant,
  startOfLocalDay,
} from "../../life-time/src/index.ts";

export type ContextSignal =
  | { type: "shopping"; store: string; at: number }
  | { type: "location"; latitude: number; longitude: number; accuracy: number; at: number }
  | { type: "price"; needId: string; price: number; currency: string; source: string; at: number }
  | { type: "check"; at: number };
export interface ContextSuggestion {
  id: string;
  recordId: string;
  title: string;
  reason: string;
  expiresAt: number;
}
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const open = (record: LifeRecord) =>
  record.data.completed !== true &&
  record.data.cancelled !== true &&
  !record.provenance.some((item) => item.invalidatedAt !== undefined);
const normalized = (value: string) => value.trim().toLocaleLowerCase();
const DISMISSAL_TYPE = "proactive-dismissal-v1";
const DISMISSAL_LOOKBACK_MS = 90 * 24 * 60 * 60_000;
const BASE_SUGGESTION_COOLDOWN_MS = 12 * 60 * 60_000;
const MAX_DISMISSAL_BACKOFF_MS = 30 * 24 * 60 * 60_000;
const MAX_DISMISSALS_PER_SOURCE = 8;
const MAX_RETAINED_DISMISSALS = 128;

/** Actor-private evidence written by the service after an explicit suggestion dismissal. */
export function proactiveDismissalData(input: {
  sourceRecordId: string;
  sourceScope: LifeScope;
  category: string;
  dismissedAt: number;
}): Record<string, unknown> {
  if (
    !input.sourceRecordId ||
    input.sourceRecordId.length > 200 ||
    !input.category ||
    input.category.length > 200 ||
    !number(input.dismissedAt) ||
    !input.sourceScope ||
    !(["user", "group"] as string[]).includes(input.sourceScope.type) ||
    !input.sourceScope.id ||
    input.sourceScope.id.length > 200
  )
    throw new TypeError("Proactive dismissal provenance is invalid.");
  return {
    type: DISMISSAL_TYPE,
    sourceRecordId: input.sourceRecordId,
    sourceScope: { ...input.sourceScope },
    category: input.category,
    dismissedAt: input.dismissedAt,
  };
}

/** Persist a dismissed proactive notification as bounded actor-private preference evidence. */
export function recordProactiveDismissal(
  store: LifeStore,
  actor: LifeActor,
  notification: LifeRecord,
  now: number,
): boolean {
  try {
    if (
      notification.kind !== "feedback" ||
      notification.data.notification !== true ||
      notification.data.dismissed !== true ||
      typeof notification.data.relatedRecordId !== "string" ||
      typeof notification.data.category !== "string" ||
      !number(now)
    )
      return false;
    const source = store.getRecord(actor, notification.data.relatedRecordId);
    if (
      !source ||
      source.scope.type !== notification.scope.type ||
      source.scope.id !== notification.scope.id
    )
      return false;
    const id = `pd-${createHash("sha256")
      .update(`${actor.userId}\0${notification.id}`)
      .digest("hex")
      .slice(0, 32)}`;
    const personalScope: LifeScope = { type: "user", id: actor.userId };
    if (store.getRecord(actor, id)) return true;
    const retained = store.listProactiveDismissalRecords(actor).reverse();
    // The extra row detects an already-overfull imported store without treating
    // a bounded page as the complete history or adding more retained evidence.
    if (retained.length > MAX_RETAINED_DISMISSALS) return false;
    while (retained.length >= MAX_RETAINED_DISMISSALS) {
      const oldest = retained.shift()!;
      try {
        store.deleteRecord(actor, oldest.id, oldest.revision);
      } catch {
        return false;
      }
    }
    store.createRecord(actor, {
      id,
      kind: "feedback",
      scope: personalScope,
      title: "Dismissed proactive suggestion",
      data: proactiveDismissalData({
        sourceRecordId: source.id,
        sourceScope: source.scope,
        category: notification.data.category,
        dismissedAt: now,
      }),
    });
    return true;
  } catch {
    // Dismissing the already-updated notification must not fail if preference retention is full.
    return false;
  }
}

function dismissalBackoffUntil(
  records: LifeRecord[],
  source: LifeRecord,
  category: string,
  now: number,
): number | undefined {
  const matches = records
    .flatMap((record) => {
      const data = record.data,
        scope = data.sourceScope;
      if (
        record.kind !== "feedback" ||
        data.type !== DISMISSAL_TYPE ||
        data.sourceRecordId !== source.id ||
        data.category !== category ||
        !scope ||
        typeof scope !== "object" ||
        Array.isArray(scope) ||
        (scope as Record<string, unknown>).type !== source.scope.type ||
        (scope as Record<string, unknown>).id !== source.scope.id ||
        !number(data.dismissedAt) ||
        data.dismissedAt > now + 60_000 ||
        now - data.dismissedAt > DISMISSAL_LOOKBACK_MS
      )
        return [];
      return [data.dismissedAt];
    })
    .sort((a, b) => b - a)
    .slice(0, MAX_DISMISSALS_PER_SOURCE);
  if (!matches.length) return undefined;
  const duration = Math.min(
    MAX_DISMISSAL_BACKOFF_MS,
    BASE_SUGGESTION_COOLDOWN_MS * 2 ** matches.length,
  );
  return matches[0]! + duration;
}

/** Interpret a current event without treating an all-day date as a UTC timestamp. */
export function eventPreparationWindow(
  record: Pick<LifeRecord, "kind" | "data">,
  now: number,
  zone: string,
  boundaries = new Map<string, number | undefined>(),
): { expiresAt: number; allDay: boolean; today: boolean } | undefined {
  if (record.kind !== "event" || record.data.completed === true || record.data.cancelled === true)
    return undefined;
  const raw = record.data.startAt ?? record.data.startDate ?? record.data.dueAt ?? record.data.date,
    date = parseCalendarDate(raw);
  if (date) {
    const current = localParts(now, zone),
      today = calendarDateKey(current),
      day = calendarDateKey(date);
    if (day < today || day > calendarDateKey(addCalendarDays(current, 2))) return undefined;
    const boundary = (value: typeof date) => {
      const key = `${zone}:${calendarDateKey(value)}`;
      if (!boundaries.has(key)) boundaries.set(key, startOfLocalDay(value, zone));
      return boundaries.get(key);
    };
    if (boundary(date) === undefined) return undefined;
    for (let offset = 1; offset <= 3; offset++) {
      const expiresAt = boundary(addCalendarDays(date, offset));
      if (expiresAt !== undefined)
        return expiresAt > now ? { expiresAt, allDay: true, today: day === today } : undefined;
    }
    return undefined;
  }
  const at = parseInstant(raw);
  return at !== undefined && at > now && at - now <= 48 * 60 * 60_000
    ? { expiresAt: at, allDay: false, today: false }
    : undefined;
}
export function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const radians = Math.PI / 180,
    dLat = (b.latitude - a.latitude) * radians,
    dLng = (b.longitude - a.longitude) * radians;
  const term =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(dLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, term)), Math.sqrt(Math.max(0, 1 - term)));
}

/** Deterministic opportunity matching. Signals contain observations, never executable instructions. */
export class ProactivityEngine {
  private readonly store: LifeStore;
  private readonly now: () => number;
  constructor(store: LifeStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }
  evaluate(actor: LifeActor, scope: LifeScope, signal: ContextSignal): ContextSuggestion[] {
    const now = this.now();
    this.validate(signal);
    // Stale positions and stale prices cannot turn into current claims.
    if (signal.at > now + 60_000 || now - signal.at > 15 * 60_000) return [];
    const settings = this.store.resolveSettings(
      actor,
      scope.type === "group" ? { groupId: scope.id } : {},
    ).values;
    if ((settings.proactiveSuggestions ?? settings.proactive) === false) return [];
    let zone =
      typeof settings.timeZone === "string"
        ? settings.timeZone
        : Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
    } catch {
      zone = "UTC";
    }
    const localHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(now),
    );
    const quiet = settings.quietHours;
    if (quiet && typeof quiet === "object" && !Array.isArray(quiet)) {
      const { start, end, enabled } = quiet as {
        start?: unknown;
        end?: unknown;
        enabled?: unknown;
      };
      if (
        enabled !== false &&
        number(start) &&
        number(end) &&
        start >= 0 &&
        start < 24 &&
        end >= 0 &&
        end <= 24 &&
        start !== end &&
        (start < end
          ? localHour >= start && localHour < end
          : localHour >= start || localHour < end)
      )
        return [];
    }
    const needs = this.store
      .listRecords(actor, { scope, kinds: ["need", "goal", "event"], limit: 500 })
      .filter(open);
    const places =
      signal.type === "location"
        ? this.store.listRecords(actor, { scope, kinds: ["place"], limit: 500 })
        : [];
    // Feedback is always actor-private. Source readability above is established before a match
    // can use it, so a revoked group cannot reuse historical dismissal evidence.
    const dismissals = this.store.listProactiveDismissalRecords(actor, MAX_RETAINED_DISMISSALS);
    const matches: Array<{
      record: LifeRecord;
      reason: string;
      expiresAt: number;
      category: string;
    }> = [];
    const dayBoundaries = new Map<string, number | undefined>();
    for (const record of needs) {
      if (number(record.data.deadlineAt) && record.data.deadlineAt < now) continue;
      if (signal.type === "shopping" || signal.type === "location") {
        if (record.kind !== "need") continue;
        const stores = Array.isArray(record.data.stores)
          ? record.data.stores.filter((x): x is string => typeof x === "string")
          : typeof record.data.store === "string"
            ? [record.data.store]
            : [];
        if (!stores.length) continue;
        let store: string | undefined;
        if (
          signal.type === "shopping" &&
          stores.some((x) => normalized(x) === normalized(signal.store))
        )
          store = signal.store;
        if (signal.type === "location" && signal.accuracy <= 500) {
          const place = places.find(
            (place) =>
              stores.some((name) => normalized(name) === normalized(place.title)) &&
              number(place.data.latitude) &&
              number(place.data.longitude) &&
              Math.abs(place.data.latitude) <= 90 &&
              Math.abs(place.data.longitude) <= 180 &&
              distanceMeters(signal, {
                latitude: place.data.latitude,
                longitude: place.data.longitude,
              }) +
                signal.accuracy <=
                (number(place.data.radiusMeters)
                  ? Math.min(2000, Math.max(50, place.data.radiusMeters))
                  : 300),
          );
          if (place) store = place.title;
        }
        if (store)
          matches.push({
            record,
            reason: `You have an unfinished errand linked to ${store}.`,
            expiresAt: now + 30 * 60_000,
            category: "shopping",
          });
      }
      if (signal.type === "price" && record.id === signal.needId && record.kind === "need") {
        const target = record.data.targetPrice ?? record.data.budget;
        if (!number(target) || target < 0 || signal.price > target) continue;
        const currency = typeof record.data.currency === "string" ? record.data.currency : "USD";
        if (currency.toUpperCase() !== signal.currency.toUpperCase()) continue;
        const old = record.data.lastNotifiedPrice;
        if (number(old) && signal.price >= old) continue;
        matches.push({
          record,
          reason: `${signal.source} reports ${signal.currency.toUpperCase()} ${signal.price.toFixed(2)}, within your ${target.toFixed(2)} limit.`,
          expiresAt: now + 6 * 60 * 60_000,
          category: "price",
        });
      }
      if (signal.type === "check" && record.kind === "event") {
        const window = eventPreparationWindow(record, now, zone, dayBoundaries);
        if (window)
          matches.push({
            record,
            reason: window.today
              ? "This all-day event is today. Check travel, forms, and anything you want to bring."
              : "This event is within the next two days. Check travel, forms, and anything you want to bring.",
            expiresAt: window.expiresAt,
            category: "preparation",
          });
      }
    }
    const results: ContextSuggestion[] = [];
    if (signal.type === "check") matches.sort((a, b) => a.expiresAt - b.expiresAt);
    // Surface at most three matches per event; the last-issued marker survives a restart.
    for (const match of matches) {
      if (results.length === 3) break;
      const last = match.record.data.lastSuggestionAt;
      if (number(last) && now - last < 12 * 60 * 60_000) continue;
      const current = this.store.getRecord(actor, match.record.id);
      if (!current || !open(current)) continue;
      const backoffUntil = dismissalBackoffUntil(dismissals, current, match.category, now);
      if (backoffUntil !== undefined && now < backoffUntil) continue;
      const item = this.store.createProactiveNotification(actor, {
        scope,
        recordId: current.id,
        expectedRevision: current.revision,
        reason: match.reason,
        category: match.category,
        expiresAt: match.expiresAt,
        at: now,
        ...(signal.type === "price" ? { lastNotifiedPrice: signal.price } : {}),
      });
      if (!item) continue;
      results.push({
        id: item.id,
        recordId: current.id,
        title: current.title,
        reason: match.reason,
        expiresAt: match.expiresAt,
      });
    }
    return results;
  }
  private validate(signal: ContextSignal): void {
    if (!signal || !number(signal.at)) throw new TypeError("Signal timestamp is invalid.");
    if (signal.type === "location") {
      if (
        !number(signal.latitude) ||
        Math.abs(signal.latitude) > 90 ||
        !number(signal.longitude) ||
        Math.abs(signal.longitude) > 180 ||
        !number(signal.accuracy) ||
        signal.accuracy < 0
      )
        throw new TypeError("Location signal is invalid.");
    } else if (signal.type === "shopping") {
      if (typeof signal.store !== "string" || !signal.store.trim() || signal.store.length > 200)
        throw new TypeError("Store is invalid.");
    } else if (signal.type === "price") {
      if (
        typeof signal.needId !== "string" ||
        signal.needId.length > 200 ||
        !number(signal.price) ||
        signal.price < 0 ||
        typeof signal.currency !== "string" ||
        !/^[A-Z]{3}$/i.test(signal.currency) ||
        typeof signal.source !== "string" ||
        !signal.source.trim() ||
        signal.source.length > 200
      )
        throw new TypeError("Price signal is invalid.");
    } else if (signal.type !== "check") throw new TypeError("Signal type is invalid.");
  }
}

export interface PreparationCheck {
  at: number;
  scopesChecked: number;
  suggestionsCreated: number;
  errors: number;
  skipped: boolean;
}

/** Local, bounded preparation checks. No model calls or external actions occur here. */
export class PreparationMonitor {
  private readonly engine: Pick<ProactivityEngine, "evaluate">;
  private readonly actor: LifeActor;
  private readonly scopes: () => LifeScope[];
  private readonly canEvaluate: () => boolean;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly maxScopesPerCheck: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextScope = 0;
  private checking = false;
  private lastCheck: PreparationCheck | undefined;

  constructor(options: {
    engine: Pick<ProactivityEngine, "evaluate">;
    actor: LifeActor;
    /** Resolve membership afresh on every pass; the engine enforces access again. */
    scopes: () => LifeScope[];
    /** Stop admitting work while personal reset or service shutdown is in progress. */
    canEvaluate?: () => boolean;
    now?: () => number;
    intervalMs?: number;
    maxScopesPerCheck?: number;
  }) {
    this.engine = options.engine;
    this.actor = { ...options.actor };
    this.scopes = options.scopes;
    this.canEvaluate = options.canEvaluate ?? (() => true);
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 15 * 60_000;
    this.maxScopesPerCheck = options.maxScopesPerCheck ?? 8;
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(this.maxScopesPerCheck) ||
      this.maxScopesPerCheck < 1 ||
      this.maxScopesPerCheck > 100
    )
      throw new TypeError("Preparation monitor bounds are invalid.");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.timer) this.checkNow();
    }, this.intervalMs);
    this.timer.unref();
    this.checkNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): { running: boolean; lastCheck?: PreparationCheck } {
    return {
      running: this.timer !== undefined,
      ...(this.lastCheck ? { lastCheck: { ...this.lastCheck } } : {}),
    };
  }

  /** Synchronous evaluation makes each pass atomic with respect to service admission changes. */
  checkNow(): PreparationCheck {
    const result: PreparationCheck = {
      at: this.now(),
      scopesChecked: 0,
      suggestionsCreated: 0,
      errors: 0,
      skipped: false,
    };
    if (this.checking) return { ...result, skipped: true };
    this.checking = true;
    try {
      if (!this.canEvaluate()) {
        result.skipped = true;
        return result;
      }
      const unique = new Map<string, LifeScope>();
      for (const scope of this.scopes()) unique.set(JSON.stringify([scope.type, scope.id]), scope);
      const scopes = [...unique.values()];
      if (!scopes.length) {
        result.skipped = true;
        return result;
      }
      this.nextScope %= scopes.length;
      const count = Math.min(scopes.length, this.maxScopesPerCheck);
      for (let index = 0; index < count; index++) {
        if (!this.canEvaluate()) {
          result.skipped = true;
          break;
        }
        const scope = scopes[this.nextScope]!;
        this.nextScope = (this.nextScope + 1) % scopes.length;
        result.scopesChecked++;
        try {
          result.suggestionsCreated += this.engine.evaluate(this.actor, scope, {
            type: "check",
            at: result.at,
          }).length;
        } catch {
          // A revoked group or one bad scope cannot starve the remaining checks.
          result.errors++;
        }
      }
    } catch {
      // Status includes counts only; private record titles and source text never become logs.
      result.errors++;
    } finally {
      this.checking = false;
      this.lastCheck = { ...result };
    }
    return result;
  }
}
