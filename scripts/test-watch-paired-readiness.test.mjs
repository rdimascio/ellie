import assert from "node:assert/strict";
import { test } from "node:test";
import { ownedCleanupTargets } from "./watch-paired-owned-process.mjs";
import { parsePhoneReadiness, waitForPhoneReadiness } from "./watch-paired-readiness.mjs";

const phone = "11111111-1111-1111-1111-111111111111";
const watch = "22222222-2222-2222-2222-222222222222";
const state = (overrides = {}) =>
  JSON.stringify({
    version: 1,
    activation: "activated",
    paired: true,
    watchAppInstalled: true,
    reachable: false,
    foreground: true,
    enabledTarget: "watch-fixture-mac-a",
    recordedAtMilliseconds: 1_789_683_600_000,
    ...overrides,
  });

test("paired phone readiness requires installed Watch, foreground app, and exact target", async () => {
  let now = 0;
  const rows = [
    state({ activation: "not_activated" }),
    state({ paired: false }),
    state({ watchAppInstalled: false }),
    state({ foreground: false }),
    state({ enabledTarget: "watch-fixture-mac-b" }),
    state(),
  ];
  const ready = await waitForPhoneReadiness("unused", "watch-fixture-mac-a", {
    timeoutMs: 800,
    now: () => now,
    read: async () => rows.shift() ?? state(),
    wait: async (ms) => {
      now += ms;
    },
  });
  assert.equal(ready.enabledTarget, "watch-fixture-mac-a");
  assert.equal(ready.reachable, false, "Watch reachability is observed after its app launches");
});

test("missing readiness has a finite primary failure and leaves exact owned cleanup targets", async () => {
  let now = 0;
  await assert.rejects(
    waitForPhoneReadiness("unused", "watch-fixture-mac-a", {
      timeoutMs: 300,
      now: () => now,
      read: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
      wait: async (ms) => {
        now += ms;
      },
    }),
    /not ready by deadline: missing/,
  );
  assert.equal(now, 300);
  assert.deepEqual(ownedCleanupTargets(watch, phone), [
    ["watch", watch],
    ["phone", phone],
  ]);
});

test("malformed or foreign readiness cannot authorize a paired Watch test", async () => {
  for (const value of [
    state({ version: true }),
    state({ enabledTarget: "another-mac" }),
    state({ extra: "not admitted" }),
    "{",
  ]) {
    await assert.rejects(
      waitForPhoneReadiness("unused", "watch-fixture-mac-a", {
        timeoutMs: 100,
        read: async () => value,
      }),
    );
  }
  assert.equal(parsePhoneReadiness(state()).enabledTarget, "watch-fixture-mac-a");
});
