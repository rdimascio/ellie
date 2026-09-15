import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LifeStore } from "../packages/life-core/src/index.ts";

const actor = { userId: "history-barrier-fixture" };
const scope = { type: "user" as const, id: actor.userId };

for (const barrier of ["fingerprint", "evidence"] as const) {
  test(`a suppressed turn retains its ${barrier} barrier while legacy history remains eligible`, () => {
    const directory = mkdtempSync(join(tmpdir(), `ellie-history-${barrier}-`));
    const databasePath = join(directory, "life.sqlite");
    let now = Date.parse("2026-09-15T04:15:00Z");
    let store: LifeStore | undefined;
    const mutate = (action: (database: DatabaseSync) => void) => {
      const database = new DatabaseSync(databasePath);
      try {
        action(database);
      } finally {
        database.close();
      }
    };
    try {
      store = new LifeStore(databasePath, { now: () => now });
      const complete = (
        message: string,
        requestId: string,
        conversationId?: string,
        captureMemory = true,
      ) => {
        now += 1;
        const begun = store!.beginConversationTurn(actor, {
          scope,
          requestId,
          message,
          chatEpoch: store!.chatEpoch(actor),
          ...(conversationId ? { conversationId } : {}),
        });
        store!.completeConversationTurn(actor, {
          conversationId: begun.conversation.id,
          turnId: begun.turn.id,
          requestId,
          result: {
            reply: `Reply to ${message}`,
            actions: [],
            evidence: [],
            recordIds: [],
            taskIds: [],
          },
        });
        if (captureMemory)
          store!.captureAutomaticPromptMemory(actor, {
            conversationId: begun.conversation.id,
            turnId: begun.turn.id,
          });
        return begun;
      };

      const oldest = complete("Oldest valid turn", "oldest");
      const middle = complete("Suppressed stale barrier", "barrier", oldest.conversation.id);
      store.suppressAutomaticPromptMemory(actor, middle.turn.id);
      complete("Legacy valid turn", "legacy", oldest.conversation.id, false);
      const newest = complete("Newest valid turn", "newest", oldest.conversation.id);
      const currentFingerprint = store.conversationContextFingerprint(
        actor,
        oldest.conversation.id,
      );
      store.close();
      store = undefined;

      // Public APIs intentionally create current snapshots. This isolated persisted-state
      // fixture first normalizes this conversation after suppression, then mutates only one
      // completed row to represent a retained stale snapshot after restart.
      mutate((database) =>
        database
          .prepare("UPDATE conversation_turns SET context_fingerprint=? WHERE conversation_id=?")
          .run(currentFingerprint, oldest.conversation.id),
      );

      store = new LifeStore(databasePath, { now: () => now });
      const validSuppressed = store
        .conversationHistory(actor, oldest.conversation.id, 12, currentFingerprint)
        .map((item) => item.content)
        .join("\n");
      assert.doesNotMatch(validSuppressed, /Suppressed stale barrier/);
      assert.match(
        validSuppressed,
        /Oldest valid turn/,
        "suppression alone hides content without becoming a barrier",
      );
      assert.match(validSuppressed, /Legacy valid turn/);
      assert.match(validSuppressed, /Newest valid turn/);
      for (const turn of [oldest.turn, middle.turn, newest.turn])
        assert.equal(
          store.getConversationTurn(actor, oldest.conversation.id, turn.id).outdated,
          false,
        );
      store.close();
      store = undefined;

      mutate((database) => {
        if (barrier === "fingerprint")
          database
            .prepare("UPDATE conversation_turns SET context_fingerprint=? WHERE id=?")
            .run("deliberately-stale", middle.turn.id);
        else
          database
            .prepare("UPDATE conversation_turns SET evidence_json=? WHERE id=?")
            .run(
              JSON.stringify([
                { sourceId: "missing-source", sourceRevision: 1, title: "Retired source" },
              ]),
              middle.turn.id,
            );
      });

      store = new LifeStore(databasePath, { now: () => now });
      assert.equal(
        store.getConversationTurn(actor, newest.conversation.id, middle.turn.id).outdated,
        true,
      );
      assert.equal(
        store.getConversationTurn(actor, newest.conversation.id, oldest.turn.id).outdated,
        false,
      );
      assert.equal(
        store.getConversationTurn(actor, newest.conversation.id, newest.turn.id).outdated,
        false,
      );
      const history = store.conversationHistory(
        actor,
        newest.conversation.id,
        12,
        currentFingerprint,
      );
      const content = history.map((item) => item.content).join("\n");
      assert.match(content, /Newest valid turn/);
      assert.match(content, /Legacy valid turn/, "a missing memory row is not suppressed");
      assert.doesNotMatch(content, /Suppressed stale barrier/);
      assert.doesNotMatch(
        content,
        /Oldest valid turn/,
        "the stale middle row remains a barrier even though its content is suppressed",
      );
    } finally {
      try {
        store?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}
