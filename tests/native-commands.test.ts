import test from "node:test";
import assert from "node:assert/strict";
import { parseNativeCommand, runNativeCommand } from "../apps/cli/src/native-commands.ts";

test("native CLI requires explicit finite scope and renders the issued trusted payload", async () => {
  const command = parseNativeCommand([
    "invite",
    "--label",
    "Ryan’s iPhone",
    "--node",
    "studio-mac",
    "--allow",
    "browser.control,app.open,browser.read",
  ]);
  let request: unknown;
  const lines = await runNativeCommand(
    {
      call: async (method, path, body) => {
        request = { method, path, body };
        return {
          version: 1,
          origin: "https://ellie.local:8444",
          certificateSha256: "a".repeat(64),
          invitation: "b".repeat(64),
          expiresAt: 1_000_000,
          label: "Ryan’s iPhone",
          grants: [
            {
              target: "studio-mac",
              capabilities: ["app.open", "browser.read", "browser.control"],
            },
          ],
        };
      },
    },
    command,
  );
  assert.deepEqual(request, {
    method: "POST",
    path: "/v1/native/invitations",
    body: {
      label: "Ryan’s iPhone",
      grants: [
        {
          target: "studio-mac",
          capabilities: ["app.open", "browser.read", "browser.control"],
        },
      ],
    },
  });
  assert.match(lines.join("\n"), /Origin: https:\/\/ellie\.local:8444/);
  assert.match(
    lines.join("\n"),
    /Access: app\.open, browser\.read, browser\.control on studio-mac/,
  );
  assert.doesNotMatch(lines.join("\n"), /bbbbbbbbbbbbbbbb/);
});

test("native CLI rejects ambient or broadened authority", () => {
  for (const args of [
    ["invite", "--label", "Phone", "--node", "mac"],
    ["invite", "--label", "Phone", "--node", "mac", "--allow", "window.place"],
    ["invite", "--label", "Phone", "--node", "mac", "--allow", ""],
    ["invite", "--label", "Phone", "--node", "mac", "--allow", "app.open,app.open"],
    ["invite", "--label", "Phone", "--node", "mac", "--allow", "browser.read,unknown"],
    ["invite", "--label", "Phone", "--node", "bad id", "--allow", "app.open"],
    ["invite", "--label", "Phone", "--label", "Other", "--node", "mac", "--allow", "app.open"],
    ["invite", "--label", " ", "--node", "mac", "--allow", "app.open"],
  ])
    assert.throws(() => parseNativeCommand(args), /Use: bun run ellie native/);
});

test("native CLI local validation fails before a request without uncertainty guidance", async () => {
  let requests = 0;
  await assert.rejects(
    runNativeCommand(
      {
        call: async () => {
          requests++;
          throw new Error();
        },
      },
      { action: "invite", label: " ", node: "mac", capabilities: ["app.open"] },
    ),
    (error: Error) =>
      /Invalid native label/.test(error.message) && !/10 minutes/.test(error.message),
  );
  assert.equal(requests, 0);
});

test("native CLI validates client and revoke responses before display", async () => {
  await assert.rejects(
    runNativeCommand(
      { call: async () => [{ id: "x", tokenHash: "secret" }] },
      { action: "clients" },
    ),
    /Invalid/,
  );
  await assert.rejects(
    runNativeCommand(
      { call: async () => ({ ok: true, revoked: true, secret: "x" }) },
      { action: "revoke", id: "client" },
    ),
    /not confirmed/,
  );
});

test("native CLI lists existing browser-scoped clients", async () => {
  const createdAt = 1_000;
  const expiresAt = createdAt + 90 * 24 * 60 * 60 * 1_000;
  const lines = await runNativeCommand(
    {
      call: async () => [
        {
          id: "phone",
          role: "native_phone_controller",
          label: "Phone",
          grants: [{ target: "mac", capabilities: ["browser.control", "browser.read"] }],
          createdAt,
          expiresAt,
        },
      ],
    },
    { action: "clients" },
  );
  assert.match(lines.join("\n"), /browser\.read/);
  assert.match(lines.join("\n"), /browser\.control/);
});

test("native CLI treats a mismatched issued browser scope as uncertain", async () => {
  await assert.rejects(
    runNativeCommand(
      {
        call: async () => ({
          version: 1,
          origin: "https://ellie.local:8444",
          certificateSha256: "a".repeat(64),
          invitation: "b".repeat(64),
          expiresAt: 1_000_000,
          label: "Phone",
          grants: [{ target: "mac", capabilities: ["browser.read"] }],
        }),
      },
      {
        action: "invite",
        label: "Phone",
        node: "mac",
        capabilities: ["browser.read", "browser.control"],
      },
    ),
    /not confirmed.*Do not retry for 10 minutes/,
  );
});
