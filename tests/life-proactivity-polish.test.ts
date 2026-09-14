import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeStore, type LifeScope } from "../packages/life-core/src/index.ts";
import {
  proactiveDismissalData,
  ProactivityEngine,
  recordProactiveDismissal,
} from "../packages/life-context/src/index.ts";

const hour = 60 * 60_000;
test("repeated dismissals exponentially delay the same suggestion without closing its need", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-proactivity-backoff-"));
  const store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  let now = Date.parse("2026-09-14T16:00:00Z");
  const engine = new ProactivityEngine(store, () => now);
  try {
    const need = store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Milk",
      data: { store: "Market" },
    });
    const first = engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now });
    assert.equal(first.length, 1);
    const notification = store.getRecord(actor, first[0]!.id)!;
    const dismissed = store.updateNotification(
      actor,
      notification.id,
      notification.revision,
      "dismiss",
      now,
    ).notification;
    assert.equal(recordProactiveDismissal(store, actor, dismissed, now), true);
    assert.equal(
      recordProactiveDismissal(store, actor, dismissed, now),
      true,
      "recording is idempotent",
    );

    now += 13 * hour;
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now }).length,
      0,
    );
    now += 12 * hour;
    const second = engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now });
    assert.equal(second.length, 1, "first dismissal backs off for 24 hours");
    const secondNotification = store.getRecord(actor, second[0]!.id)!;
    const secondDismissed = store.updateNotification(
      actor,
      secondNotification.id,
      secondNotification.revision,
      "dismiss",
      now,
    ).notification;
    assert.equal(recordProactiveDismissal(store, actor, secondDismissed, now), true);

    now += 13 * hour;
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now }).length,
      0,
    );
    assert.equal(store.getRecord(actor, need.id)?.data.completed, undefined);
    assert.equal(store.getRecord(actor, need.id)?.data.cancelled, undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("completion evidence is not dismissal evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-proactivity-complete-"));
  const store = new LifeStore(join(directory, "life.sqlite"));
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  let now = Date.parse("2026-09-14T16:00:00Z");
  try {
    const need = store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Tea",
      data: { store: "Market" },
    });
    const engine = new ProactivityEngine(store, () => now);
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now }).length,
      1,
    );
    store.createRecord(actor, {
      kind: "feedback",
      title: "Completed suggestion",
      scope,
      data: {
        ...proactiveDismissalData({
          sourceRecordId: need.id,
          sourceScope: scope,
          category: "shopping",
          dismissedAt: now,
        }),
        type: "proactive-completion-v1",
      },
    });
    now += 13 * hour;
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now }).length,
      1,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("group dismissal backoff remains private to its actor and cannot outlive access", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-proactivity-group-"));
  const store = new LifeStore(join(directory, "life.sqlite"));
  const alice = { userId: "alice" },
    bob = { userId: "bob" };
  let now = Date.parse("2026-09-14T16:00:00Z");
  try {
    store.createGroup(alice, { id: "family", name: "Family" });
    store.setGroupMember(alice, "family", { userId: "bob", role: "member" });
    const scope: LifeScope = { type: "group", id: "family" };
    const need = store.createRecord(alice, {
      kind: "need",
      scope,
      title: "Fruit",
      data: { store: "Market" },
    });
    const aliceEngine = new ProactivityEngine(store, () => now),
      bobEngine = new ProactivityEngine(store, () => now);
    const suggestion = aliceEngine.evaluate(alice, scope, {
      type: "shopping",
      store: "Market",
      at: now,
    });
    assert.equal(suggestion.length, 1);
    const notice = store.getRecord(alice, suggestion[0]!.id)!;
    const dismissed = store.updateNotification(
      alice,
      notice.id,
      notice.revision,
      "dismiss",
      now,
    ).notification;
    assert.equal(recordProactiveDismissal(store, alice, dismissed, now), true);
    now += 13 * hour;
    assert.equal(
      aliceEngine.evaluate(alice, scope, { type: "shopping", store: "Market", at: now }).length,
      0,
    );
    const bobSuggestion = bobEngine.evaluate(bob, scope, {
      type: "shopping",
      store: "Market",
      at: now,
    });
    assert.equal(bobSuggestion.length, 1);
    const bobNotice = store.getRecord(bob, bobSuggestion[0]!.id)!;
    const bobDismissed = store.updateNotification(
      bob,
      bobNotice.id,
      bobNotice.revision,
      "dismiss",
      now,
    ).notification;
    assert.equal(recordProactiveDismissal(store, bob, bobDismissed, now), true);
    store.setGroupMember(alice, "family", { userId: "bob", remove: true });
    now += 25 * hour;
    assert.throws(() =>
      bobEngine.evaluate(bob, scope, { type: "shopping", store: "Market", at: now }),
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unrelated feedback cannot hide dismissal backoff or defeat retention", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-proactivity-feedback-window-"));
  let now = Date.parse("2026-09-14T16:00:00Z");
  const store = new LifeStore(join(directory, "life.sqlite"), { now: () => now });
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" },
    engine = new ProactivityEngine(store, () => now);
  try {
    const need = store.createRecord(actor, {
      kind: "need",
      scope,
      title: "Coffee",
      data: { store: "Market" },
    });
    const suggestion = engine.evaluate(actor, scope, {
      type: "shopping",
      store: "Market",
      at: now,
    });
    const notice = store.getRecord(actor, suggestion[0]!.id)!;
    const dismissed = store.updateNotification(actor, notice.id, notice.revision, "dismiss", now);
    assert.equal(recordProactiveDismissal(store, actor, dismissed.notification, now), true);
    const oldest = store.listProactiveDismissalRecords(actor)[0]!;
    for (let index = 0; index < 127; index++)
      store.createRecord(actor, {
        kind: "feedback",
        scope,
        title: "Other dismissed suggestion",
        data: proactiveDismissalData({
          sourceRecordId: `other-source-${index}`,
          sourceScope: scope,
          category: "shopping",
          dismissedAt: now,
        }),
      });
    now += 13 * hour;
    for (let index = 0; index < 600; index++)
      store.createRecord(actor, {
        id: `unrelated-feedback-${index}`,
        kind: "feedback",
        scope,
        title: "Unrelated feedback",
        data: { type: "learning-feedback-v1" },
      });
    assert.equal(
      engine.evaluate(actor, scope, { type: "shopping", store: "Market", at: now }).length,
      0,
      "the dismissal survives a newer unrelated feedback window",
    );
    assert.equal(store.listProactiveDismissalRecords({ userId: "bob" }).length, 0);
    const nextDismissal = store.createRecord(actor, {
      kind: "feedback",
      scope,
      title: "Another dismissed suggestion",
      data: {
        notification: true,
        dismissed: true,
        relatedRecordId: need.id,
        category: "shopping",
      },
    });
    assert.equal(recordProactiveDismissal(store, actor, nextDismissal, now), true);
    assert.equal(store.listProactiveDismissalRecords(actor).length, 128);
    assert.equal(
      store.getRecord(actor, oldest.id),
      undefined,
      "same-clock insertion order is kept",
    );
    assert.ok(store.getRecord(actor, "unrelated-feedback-0"));
    assert.ok(store.getRecord(actor, "unrelated-feedback-599"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
