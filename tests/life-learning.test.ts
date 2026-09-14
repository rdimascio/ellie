import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { LifeLearning } from "../packages/life-learning/src/index.ts";

test("feedback stays inspectable without silently changing preferences or opting examples into export", () => {
  const dir = mkdtempSync(join(tmpdir(), "ellie-learning-"));
  const store = new LifeStore(join(dir, "life.sqlite")),
    learning = new LifeLearning(store);
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    store.setUserSetting(actor, "tone", "warm");
    const feedback = learning.record(actor, {
      scope,
      message: "Use shorter answers",
      rating: -1,
      example: { prompt: "When?", response: "A long response", preferredResponse: "Tomorrow." },
    });
    assert.equal(store.resolveSettings(actor).values.tone, "warm");
    assert.equal(learning.list(actor, scope).records.length, 1);
    assert.throws(() => learning.exportExamples(actor, [feedback.id]), /not selected/);
    const selected = learning.selectForExport(actor, feedback.id, feedback.revision, true);
    const exported = learning.exportExamples(actor, [feedback.id]);
    assert.equal(exported.count, 1);
    assert.equal(JSON.parse(exported.jsonl).preferredOutput, "Tomorrow.");
    assert.throws(
      () => learning.selectForExport(actor, feedback.id, feedback.revision, false),
      /changed/,
    );
    learning.selectForExport(actor, feedback.id, selected.revision, false);
    assert.throws(() => learning.exportExamples(actor, [feedback.id]), /not selected/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exports reject private cross-user, group, deleted, unselected and forged examples", () => {
  const dir = mkdtempSync(join(tmpdir(), "ellie-learning-scope-"));
  const store = new LifeStore(join(dir, "life.sqlite")),
    learning = new LifeLearning(store);
  const actor = { userId: "alice" },
    bob = { userId: "bob" },
    scope = { type: "user" as const, id: "alice" };
  const example = { prompt: "Question", response: "Answer" };
  try {
    const feedback = learning.record(actor, {
      scope,
      message: "Useful",
      rating: 1,
      example,
      trainingEligible: true,
    });
    assert.throws(() => learning.exportExamples(bob, [feedback.id]), /unavailable/);
    const group = store.createGroup(actor, { name: "Household" }),
      shared = { type: "group" as const, id: group.id };
    assert.throws(
      () =>
        learning.record(actor, {
          scope: shared,
          message: "Useful",
          example,
          trainingEligible: true,
        }),
      /personal/,
    );
    const sharedRecord = learning.record(actor, { scope: shared, message: "Useful", example });
    assert.throws(() => learning.selectForExport(actor, sharedRecord.id, 1, true), /unavailable/);
    const forged = store.createRecord(actor, {
      kind: "memory",
      scope,
      title: "Not feedback",
      data: { type: "learning-feedback-v1", example, authorId: "alice", trainingEligible: true },
    });
    assert.throws(() => learning.exportExamples(actor, [feedback.id, forged.id]), /unavailable/);
    assert.throws(() => learning.exportExamples(actor, [feedback.id, feedback.id]), /distinct/);
    store.deleteRecord(actor, feedback.id, 1);
    assert.throws(() => learning.exportExamples(actor, [feedback.id]), /unavailable/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feedback targets cannot widen visibility and malformed or oversized payloads do not write", () => {
  const dir = mkdtempSync(join(tmpdir(), "ellie-learning-input-"));
  const store = new LifeStore(join(dir, "life.sqlite")),
    learning = new LifeLearning(store);
  const actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    const privateRecord = store.createRecord(actor, { kind: "memory", scope, title: "Private" });
    const group = store.createGroup(actor, { name: "Household" });
    assert.throws(
      () =>
        learning.record(actor, {
          scope: { type: "group", id: group.id },
          message: "Oops",
          relatedRecordId: privateRecord.id,
        }),
      /unavailable/,
    );
    assert.throws(
      () => learning.record(actor, { scope, message: "Oops", rating: 8 as -1 }),
      /Rating/,
    );
    assert.throws(
      () =>
        learning.record(actor, {
          scope,
          message: "Oops",
          example: { prompt: "x".repeat(8001), response: "x" },
        }),
      /characters/,
    );
    assert.equal(learning.list(actor, scope).records.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
