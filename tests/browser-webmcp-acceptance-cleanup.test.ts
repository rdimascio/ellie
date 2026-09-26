import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NativeJourneySetupCleanupError,
  settleAcceptanceOutcome,
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
