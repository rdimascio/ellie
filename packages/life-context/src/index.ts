import type { LifeActor, LifeRecord, LifeScope } from "../../life-core/src/index.ts";
import { LifeStore } from "../../life-core/src/index.ts";

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
    const matches: Array<{
      record: LifeRecord;
      reason: string;
      expiresAt: number;
      category: string;
    }> = [];
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
        const at = record.data.startAt ?? record.data.dueAt;
        if (number(at) && at > now && at - now <= 48 * 60 * 60_000)
          matches.push({
            record,
            reason:
              "This event is within the next two days. Check travel, forms, and anything you want to bring.",
            expiresAt: at,
            category: "preparation",
          });
      }
    }
    const results: ContextSuggestion[] = [];
    // Surface at most three matches per event; the last-issued marker survives a restart.
    for (const match of matches) {
      if (results.length === 3) break;
      const last = match.record.data.lastSuggestionAt;
      if (number(last) && now - last < 12 * 60 * 60_000) continue;
      const current = this.store.getRecord(actor, match.record.id);
      if (!current || !open(current)) continue;
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
