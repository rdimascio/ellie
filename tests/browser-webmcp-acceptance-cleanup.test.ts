import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptanceEnvironmentSetupFailureReport,
  AcceptanceEnvironmentSetupCleanupError,
  NativeJourneySetupCleanupError,
  settleFailedAcceptanceEnvironmentSetup,
  settleAcceptanceOutcome,
  settleFailedNativeJourneySetup,
} from "../scripts/browser-webmcp-acceptance.ts";

test("acceptance environment setup preserves first failure and every uncertain owner", async () => {
  const setup = new Error("synthetic environment setup failure");
  let removeCalls = 0;
  await assert.rejects(
    settleFailedAcceptanceEnvironmentSetup(setup, {
      ownedRoot: "/owned/retained-state",
      closeBridge: async () => {
        throw new Error("bridge close failed");
      },
      closeServer: async () => {
        throw new Error("server close failed");
      },
      removeOwnedRoot: async () => {
        removeCalls++;
      },
      cleanupDeadlineMs: 50,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AcceptanceEnvironmentSetupCleanupError);
      assert.equal(error.cause, setup);
      assert.equal(error.retainedRoot, "/owned/retained-state");
      assert.equal(error.cleanupFailures.length, 2);
      assert.match(error.cleanupFailures[0] ?? "", /^bridge:/);
      assert.match(error.cleanupFailures[1] ?? "", /^server:/);
      assert.deepEqual(acceptanceEnvironmentSetupFailureReport(error), {
        version: 1,
        status: "fail",
        phase: "acceptance-environment-setup",
        error: "synthetic environment setup failure",
        cleanup: {
          certain: false,
          retainedRoot: "/owned/retained-state",
          failures: error.cleanupFailures,
        },
        replayAttempted: false,
        accessibilityFallbackAttempted: false,
      });
      return true;
    },
  );
  assert.equal(removeCalls, 0, "uncertain state must remain available for inspection");
});

test("acceptance environment setup removes owned state only after confirmed cleanup", async () => {
  const setup = new Error("synthetic environment setup failure");
  let removeCalls = 0;
  await assert.rejects(
    settleFailedAcceptanceEnvironmentSetup(setup, {
      ownedRoot: "/owned/confirmed-state",
      closeBridge: async () => {},
      closeServer: async () => {},
      removeOwnedRoot: async () => {
        removeCalls++;
      },
      cleanupDeadlineMs: 50,
    }),
    (error) => error === setup,
  );
  assert.equal(removeCalls, 1);
});

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

test("bind-only mode reaches the common cleanup outcome gate", async () => {
  const runner = await readFile(
    fileURLToPath(new URL("../scripts/browser-webmcp-acceptance.ts", import.meta.url)),
    "utf8",
  );
  const bindOnlyStart = runner.indexOf("    if (bindOnly) {");
  const composedStart = runner.indexOf("    } else if (composed) {");
  assert.ok(bindOnlyStart >= 0 && composedStart > bindOnlyStart);
  const bindOnly = runner.slice(bindOnlyStart, composedStart);
  assert.doesNotMatch(bindOnly, /\breturn\b/);

  const imported = new URL("../scripts/browser-webmcp-acceptance.ts", import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { settleAcceptanceOutcome } from ${JSON.stringify(imported)}; settleAcceptanceOutcome(undefined, "synthetic cleanup uncertainty");`,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(child.status, 0, "cleanup uncertainty must fail the acceptance process");
  assert.match(child.stderr, /synthetic cleanup uncertainty/);
});

test("the common cleanup outcome gate preserves success and the original failure", () => {
  assert.doesNotThrow(() => settleAcceptanceOutcome(undefined, undefined));
  const failure = new Error("synthetic acceptance failure");
  assert.throws(
    () => settleAcceptanceOutcome(failure, undefined),
    (error) => error === failure,
  );
});
