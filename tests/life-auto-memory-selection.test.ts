import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeAutoMemory } from "../packages/life-auto-memory/src/index.ts";
import { LifeAccessError, LifeStore } from "../packages/life-core/src/index.ts";

test("model memory selects exact-deduplicated relevant, recent, and corrective observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-memory-selection-"));
  await chmod(root, 0o700);
  let now = 1_000;
  const store = new LifeStore(join(root, "life.sqlite"), { now: () => now++ });
  const memory = new LifeAutoMemory(store),
    actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  const capture = (message: string, requestId: string) => {
    const begun = store.beginConversationTurn(actor, {
      scope,
      message,
      requestId,
      chatEpoch: store.chatEpoch(actor),
    });
    memory.captureTurn(actor, { conversationId: begun.conversation.id, turnId: begun.turn.id });
    return begun;
  };
  try {
    capture("I prefer window seats on flights.", "old-flight");
    capture("I do not prefer window seats on trains.", "qualified-negation");
    capture("I prefer jasmine tea after lunch.", "duplicate-old");
    capture("  i   PREFER jasmine tea AFTER lunch.  ", "duplicate-new");
    capture("Actually I prefer mint tea after lunch, except on Sundays.", "correction");
    for (let index = 0; index < 8; index++)
      capture(`My recent project note ${index} has qualification ${index}.`, `recent-${index}`);

    const selected = memory.modelContext(actor, {
      scope,
      query: "Which tea should I serve after lunch?",
      maxBytes: 4_096,
    });
    assert.match(selected.markdown, /jasmine tea AFTER lunch/);
    assert.doesNotMatch(selected.markdown, /prefer jasmine tea after lunch/);
    assert.match(selected.markdown, /mint tea after lunch, except on Sundays/);
    assert.match(selected.markdown, /recent project note 7 has qualification 7/);
    assert.match(selected.markdown, /do not prefer window seats on trains/);
    assert.ok(Buffer.byteLength(selected.markdown) <= 4_096);
    assert.equal(selected.entries, 12);

    const current = capture("My current prompt should already be direct input.", "current");
    const withoutCurrent = memory.modelContext(actor, {
      scope,
      query: "current prompt",
      excludeTurnId: current.turn.id,
    });
    assert.doesNotMatch(withoutCurrent.markdown, /current prompt should/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("model memory revision covers unselected changes and access checks precede bounded selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-memory-revision-"));
  await chmod(root, 0o700);
  const store = new LifeStore(join(root, "life.sqlite")),
    memory = new LifeAutoMemory(store),
    alice = { userId: "alice" },
    bob = { userId: "bob" },
    scope = { type: "user" as const, id: "alice" };
  const capture = (message: string, requestId: string) => {
    const begun = store.beginConversationTurn(alice, {
      scope,
      message,
      requestId,
      chatEpoch: store.chatEpoch(alice),
    });
    memory.captureTurn(alice, { conversationId: begun.conversation.id, turnId: begun.turn.id });
    return begun;
  };
  try {
    const hidden = capture(`My archive code is ${"whole qualification ".repeat(80)}end.`, "hidden");
    capture("I prefer concise travel plans.", "relevant");
    const first = memory.modelContext(alice, {
      scope,
      query: "travel plans",
      maxBytes: 1_024,
    });
    assert.match(first.markdown, /concise travel plans/);
    assert.doesNotMatch(first.markdown, /archive code/);
    assert.equal(first.partial, true);
    store.beginConversationTurn(alice, {
      scope,
      message: "An unrelated pending turn without captured memory.",
      requestId: "unrelated-pending",
      chatEpoch: store.chatEpoch(alice),
    });
    assert.equal(
      store.automaticPromptMemoryRevision(alice, scope),
      first.revision,
      "ordinary conversation and pending-intent state must not self-invalidate memory",
    );

    memory.suppressTurn(alice, hidden.turn.id);
    const suppressed = memory.modelContext(alice, {
      scope,
      query: "travel plans",
      maxBytes: 1_024,
    });
    assert.notEqual(suppressed.revision, first.revision);
    assert.equal(
      suppressed.revision,
      store.automaticPromptMemoryRevision(alice, scope),
      "selection and hot-path validity checks share the full authoritative revision",
    );

    const deletable = capture("My unselected obsolete detail is blue.", "delete-me");
    const beforeDelete = memory.modelContext(alice, { scope, query: "travel plans" }).revision;
    store.interruptConversationTurn(alice, {
      conversationId: deletable.conversation.id,
      turnId: deletable.turn.id,
      requestId: deletable.turn.requestId,
    });
    store.deleteConversation(alice, deletable.conversation.id, deletable.conversation.revision);
    assert.notEqual(
      memory.modelContext(alice, { scope, query: "travel plans" }).revision,
      beforeDelete,
    );

    assert.throws(
      () =>
        memory.modelContext(bob, {
          scope,
          query: "x".repeat(8_001),
          maxBytes: 99_999,
        }),
      LifeAccessError,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
