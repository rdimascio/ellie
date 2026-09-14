import assert from "node:assert/strict";
import test from "node:test";
import { EmbeddedLifeLifecycle } from "../apps/cli/src/life-lifecycle.ts";

test("shutdown waits for a held factory and closes its late result before releasing", async () => {
  let resolveHeld!: (value: { close(): Promise<void> }) => void, resolveClose!: () => void;
  const held = new Promise<{ close(): Promise<void> }>((resolve) => {
      resolveHeld = resolve;
    }),
    close = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
  const events: string[] = [];
  const owner = new EmbeddedLifeLifecycle<{ close(): Promise<void> }>();
  const starting = owner.start(
    () => held,
    () => {
      events.push("activated");
    },
  );
  const stopping = owner.shutdown(() => events.push("released"));
  resolveHeld({
    async close() {
      events.push("closing");
      await close;
      events.push("closed");
    },
  });
  await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  assert.deepEqual(events, ["closing"]);
  resolveClose();
  await Promise.all([starting, stopping]);
  assert.deepEqual(events, ["closing", "closed", "released"]);
});

test("failed embedded close retains coordinator lock", async () => {
  const events: string[] = [];
  const owner = new EmbeddedLifeLifecycle<{ close(): Promise<void> }>();
  await owner.start(
    async () => ({
      async close() {
        events.push("closing");
        throw new Error("held callbacks");
      },
    }),
    () => {
      events.push("activated");
    },
  );
  await assert.rejects(
    owner.shutdown(() => events.push("released")),
    /held callbacks/,
  );
  assert.deepEqual(events, ["activated", "closing"]);
});

test("failed activation with an undrained application retains coordinator lock", async () => {
  const events: string[] = [];
  const owner = new EmbeddedLifeLifecycle<{ close(): Promise<void> }>();
  await assert.rejects(
    owner.start(
      async () => ({
        async close() {
          events.push("closing");
          throw new Error("held callbacks");
        },
      }),
      async () => {
        events.push("activating");
        throw new Error("prepare failed");
      },
    ),
    /prepare failed/,
  );
  await assert.rejects(
    owner.shutdown(() => events.push("released")),
    /held callbacks/,
  );
  assert.deepEqual(events, ["activating", "closing"]);
});

test("factory failure still permits coordinator cleanup", async () => {
  const events: string[] = [];
  const owner = new EmbeddedLifeLifecycle<{ close(): void }>();
  await assert.rejects(
    owner.start(
      async () => {
        throw new Error("factory failed");
      },
      () => {},
    ),
    /factory failed/,
  );
  await owner.shutdown(() => events.push("released"));
  assert.deepEqual(events, ["released"]);
});
