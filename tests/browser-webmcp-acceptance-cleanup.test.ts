import assert from "node:assert/strict";
import test from "node:test";
import {
  NativeJourneySetupCleanupError,
  settleFailedNativeJourneySetup,
} from "../scripts/browser-webmcp-acceptance.ts";

test("native journey setup preserves ownership uncertainty when its close also fails", async () => {
  const setup = new Error("synthetic setup failure");
  let closeCalls = 0;
  await assert.rejects(
    settleFailedNativeJourneySetup(setup, async () => {
      closeCalls++;
      throw new Error("synthetic close failure");
    }),
    (error: unknown) => {
      assert.ok(error instanceof NativeJourneySetupCleanupError);
      assert.equal(error.cause, setup);
      return true;
    },
  );
  assert.equal(closeCalls, 1);
});

test("confirmed native journey setup cleanup retains the original failure", async () => {
  const setup = new Error("synthetic setup failure");
  await assert.rejects(
    settleFailedNativeJourneySetup(setup, async () => {}),
    (error) => error === setup,
  );
});
