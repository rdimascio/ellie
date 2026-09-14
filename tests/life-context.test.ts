import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { PreparationMonitor, ProactivityEngine } from "../packages/life-context/src/index.ts";

test("shopping opportunities are relevant, scoped, quiet, persistent and stop after completion", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-context-test-"));
  let now = Date.parse("2026-09-14T16:00:00Z");
  let store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    let engine = new ProactivityEngine(store, () => now);
    const need = store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Garden gift",
      data: { store: "Target", budget: 40, currency: "USD", completed: false },
    });
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Other store", at: now }).length,
      0,
    );
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now - 3600000 })
        .length,
      0,
    );
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      1,
    );
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      0,
    );
    assert.throws(() =>
      engine.evaluate({ userId: "bob" }, scope, { type: "shopping", store: "Target", at: now }),
    );
    store.close();
    store = new LifeStore(join(directory, "life.sqlite"));
    engine = new ProactivityEngine(store, () => now);
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      0,
    );
    now += 13 * 3600000;
    const current = store.getRecord(actor, need.id)!;
    store.updateRecord(actor, need.id, current.revision, {
      data: { ...current.data, completed: true },
    });
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("location requires fresh accurate matching and prices respect budget/currency", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-context-signals-"));
  const now = Date.parse("2026-09-14T16:00:00Z");
  const store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" },
    engine = new ProactivityEngine(store, () => now);
  try {
    store.createRecord(actor, {
      kind: "place",
      scope,
      title: "Hardware",
      data: { latitude: 37, longitude: -122, radiusMeters: 300 },
    });
    store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Air filter",
      data: { store: "Hardware" },
    });
    assert.equal(
      engine.evaluate(actor, scope, {
        type: "location",
        latitude: 37,
        longitude: -122,
        accuracy: 900,
        at: now,
      }).length,
      0,
    );
    assert.equal(
      engine.evaluate(actor, scope, {
        type: "location",
        latitude: 37,
        longitude: -122,
        accuracy: 25,
        at: now,
      }).length,
      1,
    );
    const need = store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Garden gloves",
      data: { budget: 40, currency: "USD" },
    });
    assert.equal(
      engine.evaluate(actor, scope, {
        type: "price",
        needId: need.id,
        price: 30,
        currency: "EUR",
        source: "A provided offer",
        at: now,
      }).length,
      0,
    );
    assert.equal(
      engine.evaluate(actor, scope, {
        type: "price",
        needId: need.id,
        price: 50,
        currency: "USD",
        source: "A provided offer",
        at: now,
      }).length,
      0,
    );
    assert.equal(
      engine.evaluate(actor, scope, {
        type: "price",
        needId: need.id,
        price: 30,
        currency: "USD",
        source: "A provided offer",
        at: now,
      }).length,
      1,
    );
    store.setUserSetting(actor, "proactive", false);
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Hardware", at: now }).length,
      0,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid zones are rejected and quiet-hour checks use the chosen zone", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-context-quiet-"));
  const now = Date.parse("2026-09-14T06:00:00Z");
  const store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    const engine = new ProactivityEngine(store, () => now);
    store.createRecord(actor, { kind: "need", scope, title: "Milk", data: { store: "Target" } });
    store.setUserSetting(actor, "timeZone", "America/Los_Angeles");
    store.setUserSetting(actor, "quietHours", { start: 22, end: 7 });
    assert.deepEqual(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }),
      [],
    );
    assert.throws(() => store.setUserSetting(actor, "timeZone", "NoSuchZone"), /IANA/);
    assert.deepEqual(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }),
      [],
    );
    store.setUserSetting(actor, "quietHours", { enabled: false, start: 22, end: 7 });
    store.setUserSetting(actor, "proactiveSuggestions", false);
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      0,
    );
    store.setUserSetting(actor, "proactiveSuggestions", true);
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Target", at: now }).length,
      1,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("changed source evidence stops proactive event preparation until reviewed", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-context-provenance-"));
  const now = Date.parse("2026-09-14T16:00:00Z");
  const store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    const source = store.ingestSource(actor, {
      title: "Appointment note",
      scope,
      format: "text",
      content: "Appointment tomorrow.",
    });
    store.createRecord(actor, {
      title: "Appointment",
      kind: "event",
      scope,
      data: { startAt: now + 86400000 },
      provenance: [{ sourceId: source.id, derived: true }],
    });
    store.deleteSource(actor, source.id, source.revision);
    assert.deepEqual(
      new ProactivityEngine(store, () => now).evaluate(actor, scope, { type: "check", at: now }),
      [],
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preparation monitoring creates notices on startup, respects privacy admission, and survives restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-preparation-monitor-"));
  const now = Date.parse("2026-09-14T16:00:00Z");
  let store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  let admitted = false;
  let monitor: PreparationMonitor | undefined;
  const makeMonitor = () =>
    new PreparationMonitor({
      engine: new ProactivityEngine(store, () => now),
      actor,
      scopes: () => [scope],
      canEvaluate: () => admitted,
      now: () => now,
    });
  try {
    store.createRecord(actor, {
      kind: "event",
      scope,
      title: "Dentist",
      data: { startAt: now + 86400000 },
    });
    monitor = makeMonitor();
    monitor.start();
    assert.equal(monitor.status().running, true);
    assert.equal(monitor.status().lastCheck?.skipped, true);
    assert.equal(store.listRecords(actor, { scope, kinds: ["feedback"] }).length, 0);
    admitted = true;
    assert.equal(monitor.checkNow().suggestionsCreated, 1);
    assert.equal(store.listRecords(actor, { scope, kinds: ["feedback"] })[0]?.title, "Dentist");
    monitor.stop();
    assert.equal(monitor.status().running, false);
    store.close();
    store = new LifeStore(join(directory, "life.sqlite"));
    monitor = makeMonitor();
    monitor.start();
    assert.equal(monitor.status().lastCheck?.suggestionsCreated, 0);
    assert.equal(store.listRecords(actor, { scope, kinds: ["feedback"] }).length, 1);
    store.createRecord(actor, {
      kind: "event",
      scope,
      title: "Eye exam",
      data: { startAt: now + 3600000 },
    });
    store.setUserSetting(actor, "proactiveSuggestions", false);
    assert.equal(monitor.checkNow().suggestionsCreated, 0);
    store.setUserSetting(actor, "proactiveSuggestions", true);
    assert.equal(monitor.checkNow().suggestionsCreated, 1);
  } finally {
    monitor?.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("preparation checks rotate bounded scopes, refresh membership, and isolate errors", () => {
  let scopes = ["one", "revoked", "three", "four"].map((id) => ({
    type: "group" as const,
    id,
  }));
  const calls: string[] = [];
  let admitted = true;
  const monitor = new PreparationMonitor({
    actor: { userId: "alice" },
    scopes: () => scopes,
    canEvaluate: () => admitted,
    maxScopesPerCheck: 2,
    now: () => 12345,
    engine: {
      evaluate: (_actor, scope, signal) => {
        assert.deepEqual(signal, { type: "check", at: 12345 });
        calls.push(scope.id);
        if (scope.id === "revoked") throw new Error("Private group details must not escape.");
        return [];
      },
    },
  });
  assert.deepEqual(monitor.checkNow(), {
    at: 12345,
    scopesChecked: 2,
    suggestionsCreated: 0,
    errors: 1,
    skipped: false,
  });
  assert.equal(monitor.checkNow().scopesChecked, 2);
  assert.deepEqual(calls, ["one", "revoked", "three", "four"]);
  scopes = [{ type: "group", id: "new-group" }];
  monitor.checkNow();
  assert.equal(calls.at(-1), "new-group");
  admitted = false;
  assert.equal(monitor.checkNow().scopesChecked, 0);
  assert.equal(calls.length, 5);
  assert.equal(JSON.stringify(monitor.status()).includes("Private"), false);
  const snapshot = monitor.status();
  snapshot.lastCheck!.errors = 100;
  assert.equal(monitor.status().lastCheck?.errors, 0);
});

test("stopping the monitor prevents subsequent interval work", async () => {
  let checks = 0;
  const monitor = new PreparationMonitor({
    actor: { userId: "alice" },
    scopes: () => [{ type: "user", id: "alice" }],
    intervalMs: 100,
    engine: {
      evaluate: () => {
        checks++;
        return [];
      },
    },
  });
  monitor.start();
  monitor.start();
  assert.equal(checks, 1);
  monitor.stop();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(checks, 1);
  monitor.start();
  assert.equal(checks, 2);
  monitor.stop();
});
