import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { ProactivityEngine } from "../packages/life-context/src/index.ts";

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
