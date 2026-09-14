import assert from "node:assert/strict";
import { readFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LifeAutoMemory } from "../packages/life-auto-memory/src/index.ts";
import { LifeAccessError, LifeStore } from "../packages/life-core/src/index.ts";

function turn(
  store: LifeStore,
  actor: { userId: string },
  scope: { type: "user" | "group"; id: string },
  message: string,
  requestId: string,
) {
  const begun = store.beginConversationTurn(actor, {
    scope,
    requestId,
    message,
    chatEpoch: store.chatEpoch(actor),
  });
  return begun;
}

function complete(store: LifeStore, actor: { userId: string }, begun: ReturnType<typeof turn>) {
  return store.completeConversationTurn(actor, {
    conversationId: begun.conversation.id,
    turnId: begun.turn.id,
    requestId: begun.turn.requestId,
    result: { reply: "Acknowledged.", actions: [], recordIds: [], taskIds: [], evidence: [] },
  });
}

test("captures every authoritative prompt once and keeps summaries scope exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-auto-memory-"));
  await chmod(root, 0o700);
  const store = new LifeStore(join(root, "life.sqlite"), { now: 1_000 }),
    memory = new LifeAutoMemory(store, { directory: join(root, "markdown") }),
    alice = { userId: "alice" },
    personal = { type: "user" as const, id: "alice" },
    groupId = store.createGroup(alice, { name: "Family" }).id,
    group = { type: "group" as const, id: groupId };
  try {
    const fact = turn(store, alice, personal, "I prefer morning appointments.", "request-1"),
      transient = turn(store, alice, personal, "In this conversation, be brief.", "request-2"),
      shared = turn(store, alice, group, "Our door code is 1234.", "request-3");
    const first = memory.captureTurn(alice, {
      conversationId: fact.conversation.id,
      turnId: fact.turn.id,
    });
    assert.equal(
      memory.captureTurn(alice, { conversationId: fact.conversation.id, turnId: fact.turn.id }).id,
      first.id,
    );
    memory.captureTurn(alice, {
      conversationId: transient.conversation.id,
      turnId: transient.turn.id,
    });
    memory.captureTurn(alice, { conversationId: shared.conversation.id, turnId: shared.turn.id });
    const context = memory.context(alice, { scope: personal });
    assert.match(context.summaryMarkdown, /prefer morning appointments/);
    assert.doesNotMatch(context.summaryMarkdown, /be brief|door code/);
    assert.match(context.journalMarkdown, /In this conversation, be brief/);
    const materialized = await memory.sync(alice, personal);
    assert.match(await readFile(materialized.path, "utf8"), /Prompt journal/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backfill, suppression, conversation deletion, reset, and revoked groups stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-auto-memory-life-"));
  await chmod(root, 0o700);
  const store = new LifeStore(join(root, "life.sqlite")),
    memory = new LifeAutoMemory(store),
    alice = { userId: "alice" },
    bob = { userId: "bob" },
    personal = { type: "user" as const, id: "alice" },
    personalTurn = turn(store, alice, personal, "Actually I prefer afternoons.", "request-a");
  try {
    assert.deepEqual(memory.backfill(alice), { captured: 1, scanned: 1, hasMore: false });
    assert.match(memory.context(alice, { scope: personal }).summaryMarkdown, /prefer afternoons/);
    assert.equal(memory.forget(alice, { scope: personal, query: "afternoons" }), 1);
    assert.doesNotMatch(memory.context(alice, { scope: personal }).summaryMarkdown, /afternoons/);
    assert.throws(() => memory.context(bob, { scope: personal }), LifeAccessError);
    const groupId = store.createGroup(alice, { name: "Shared" }).id;
    store.setGroupMember(alice, groupId, { userId: "bob", role: "member" });
    const group = { type: "group" as const, id: groupId },
      groupTurn = turn(store, bob, group, "I prefer tea.", "request-group");
    memory.captureTurn(bob, {
      conversationId: groupTurn.conversation.id,
      turnId: groupTurn.turn.id,
    });
    assert.match(memory.context(bob, { scope: group }).summaryMarkdown, /prefer tea/);
    store.setGroupMember(alice, groupId, { userId: "bob", remove: true });
    assert.throws(() => memory.context(bob, { scope: group }), LifeAccessError);
    store.interruptConversationTurn(alice, {
      conversationId: personalTurn.conversation.id,
      turnId: personalTurn.turn.id,
      requestId: personalTurn.turn.requestId,
    });
    store.deleteConversation(
      alice,
      personalTurn.conversation.id,
      personalTurn.conversation.revision,
    );
    assert.equal(memory.context(alice, { scope: personal }).entries, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-clock corrections outrank filler, invalidate history, and export exact journals", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-auto-memory-order-"));
  await chmod(root, 0o700);
  const store = new LifeStore(join(root, "life.sqlite"), { now: 5_000 }),
    memory = new LifeAutoMemory(store),
    actor = { userId: "alice" },
    scope = { type: "user" as const, id: "alice" };
  try {
    const original = turn(store, actor, scope, "I prefer mornings, except on Fridays.", "fact");
    complete(store, actor, original);
    memory.captureTurn(actor, {
      conversationId: original.conversation.id,
      turnId: original.turn.id,
    });
    for (let index = 0; index < 101; index++) {
      const filler = store.beginConversationTurn(actor, {
        scope,
        conversationId: original.conversation.id,
        requestId: `filler-${index}`,
        message: `Can you explain item ${index}?`,
        chatEpoch: store.chatEpoch(actor),
      });
      complete(store, actor, filler);
      memory.captureTurn(actor, { conversationId: filler.conversation.id, turnId: filler.turn.id });
    }
    const correction = store.beginConversationTurn(actor, {
      scope,
      conversationId: original.conversation.id,
      requestId: "correction",
      message: "Actually I prefer afternoons, but Friday mornings still work.",
      chatEpoch: store.chatEpoch(actor),
    });
    complete(store, actor, correction);
    memory.captureTurn(actor, {
      conversationId: correction.conversation.id,
      turnId: correction.turn.id,
    });
    const context = memory.context(actor, { scope, maxEntries: 100, maxBytes: 16_384 });
    assert.ok(
      context.summaryMarkdown.indexOf("prefer afternoons") <
        context.summaryMarkdown.indexOf("prefer mornings"),
    );
    assert.match(context.summaryMarkdown, /except on Fridays/);
    assert.ok(
      Buffer.byteLength(context.summaryMarkdown + "\n\n" + context.journalMarkdown) <= 16_384,
    );
    assert.equal(context.partial, true);
    assert.ok(store.conversationHistory(actor, original.conversation.id).length > 0);
    assert.equal(memory.forget(actor, { scope, query: "prefer" }), 2);
    assert.equal(store.conversationHistory(actor, original.conversation.id).length, 0);
    assert.doesNotMatch(
      memory.context(actor, { scope }).journalMarkdown,
      /prefer mornings|prefer afternoons/,
    );
    let cursor: string | undefined,
      exportedMemory = false;
    do {
      const exported = store.exportPersonalPage(actor, {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      exportedMemory ||= exported.items.some((item) => item.type === "automatic-prompt-memory");
      cursor = exported.nextCursor;
    } while (cursor && !exportedMemory);
    assert.equal(exportedMemory, true);
    assert.equal(store.personalSummary(actor).automaticPromptMemories, 103);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
