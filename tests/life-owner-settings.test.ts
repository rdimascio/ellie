import assert from "node:assert/strict";
import test from "node:test";
import { openLifeOwnerSettings } from "../apps/cli/src/life-owner-settings.ts";

test("owner settings makes one exact controller call and never returns a URL", async () => {
  const calls: unknown[][] = [];
  assert.equal(
    await openLifeOwnerSettings({
      async call(method, path, body) {
        calls.push([method, path, body]);
        return { opened: true };
      },
    }),
    "Ellie account settings opened.",
  );
  assert.deepEqual(calls, [["POST", "/v1/life/owner-settings", {}]]);
  await assert.rejects(
    openLifeOwnerSettings({ call: async () => ({ opened: true, url: "secret" }) }),
    /did not open/,
  );
});
