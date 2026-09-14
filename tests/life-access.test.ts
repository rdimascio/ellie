import assert from "node:assert/strict";
import test from "node:test";
import { parseLifeAccessCommand, runLifeAccessCommand } from "../apps/cli/src/life-access.ts";

test("Life access commands parse exact forms", () => {
  assert.deepEqual(parseLifeAccessCommand(["grants"]), { action: "list" });
  assert.deepEqual(parseLifeAccessCommand(["grant", "phone-1", "owner"]), {
    action: "grant",
    clientId: "phone-1",
    actorId: "owner",
  });
  assert.deepEqual(parseLifeAccessCommand(["revoke", "phone-1"]), {
    action: "revoke",
    clientId: "phone-1",
  });
  assert.throws(() => parseLifeAccessCommand(["grant", "phone-1"]), /Use:/);
});

test("Life access validates exact authority responses and reports ambiguous writes", async () => {
  const calls: unknown[][] = [];
  const client = {
    call: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (method === "GET")
        return {
          grants: [
            { clientId: "phone-1", actorId: "owner", capability: "life.account", revision: 1 },
          ],
        };
      return path.endsWith("revoke")
        ? { ok: true, revoked: true }
        : {
            ok: true,
            grant: {
              clientId: "phone-1",
              actorId: "owner",
              capability: "life.account",
              revision: 2,
            },
          };
    },
  };
  assert.match(await runLifeAccessCommand(client, parseLifeAccessCommand(["grants"])), /phone-1/);
  assert.equal(
    await runLifeAccessCommand(client, parseLifeAccessCommand(["grant", "phone-1", "owner"])),
    "Life account access granted.",
  );
  assert.equal(
    await runLifeAccessCommand(client, parseLifeAccessCommand(["revoke", "phone-1"])),
    "Life account access revoked.",
  );
  await assert.rejects(
    runLifeAccessCommand(
      { call: async () => ({ ok: true }) },
      parseLifeAccessCommand(["grant", "phone-1", "owner"]),
    ),
    /Run life-access grants/,
  );
});
