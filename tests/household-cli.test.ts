import assert from "node:assert/strict";
import test from "node:test";
import { parseHouseholdCommand, runHouseholdCommand } from "../apps/cli/src/household-commands.ts";

test("uncertain household authority mutations do not retry or print server details", async () => {
  for (const args of [
    ["grant", "phone", "shared", "dashboards", "write"],
    ["revoke", "phone", "shared", "dashboards"],
  ]) {
    let requests = 0;
    const client = {
      async call() {
        requests++;
        throw new Error("Synthetic private upstream detail");
      },
    };
    await assert.rejects(
      runHouseholdCommand(client, parseHouseholdCommand(args)),
      (error: Error) => {
        assert.match(error.message, /not confirmed\. Run household grants before retrying\./);
        assert.doesNotMatch(error.message, /private upstream/);
        return true;
      },
    );
    assert.equal(requests, 1);
  }
});

test("household authority listing rejects duplicates and excess rows", async () => {
  const grant = { clientId: "phone", profile: "shared", kind: "dashboards", access: "read" };
  for (const grants of [
    [grant, grant],
    Array.from({ length: 129 }, (_, index) => ({ ...grant, clientId: `phone-${index}` })),
  ]) {
    await assert.rejects(
      runHouseholdCommand(
        {
          async call() {
            return { grants };
          },
        },
        { action: "list" },
      ),
      /Invalid household authority list/,
    );
  }
});
