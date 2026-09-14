import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserCommand, runBrowserCommand } from "../apps/cli/src/browser-commands.ts";
import {
  BROWSER_INVITATION_TTL_MS,
  BROWSER_SESSION_TTL_MS,
} from "../apps/server/src/browser-auth.ts";

test("browser invite CLI requires fixed explicit phone grants and grant-free TV", () => {
  assert.deepEqual(
    parseBrowserCommand([
      "invite",
      "phone",
      "--label",
      "Family phone",
      "--node",
      "living-room-mini",
      "--allow",
      "app.open, window.place",
    ]),
    {
      action: "invite",
      invitation: {
        role: "phone_controller",
        label: "Family phone",
        grants: [
          {
            target: "living-room-mini",
            capabilities: ["app.open", "window.place"],
          },
        ],
      },
    },
  );
  assert.deepEqual(parseBrowserCommand(["invite", "tv", "--label", "Living room TV"]), {
    action: "invite",
    invitation: { role: "tv_viewer", label: "Living room TV", grants: [] },
  });

  for (const args of [
    ["invite", "phone", "--label", "Phone"],
    ["invite", "phone", "--label", "Phone", "--node", "mini"],
    ["invite", "phone", "--label", "Phone", "--node", "mini", "--allow", "app.open,app.open"],
    ["invite", "tv", "--label", "TV", "--node", "mini"],
    ["invite", "tv", "--label", "TV", "--allow", "app.open"],
    ["invite", "tv", "--label", "TV\nAdmin"],
    ["invite", "admin", "--label", "Admin"],
    ["clients", "extra"],
    ["revoke", "bad id"],
    ["connection", "extra"],
  ])
    assert.throws(() => parseBrowserCommand(args));
});

test("browser CLI prints only a deliberate invitation code and validates its authority", async () => {
  const command = parseBrowserCommand([
    "invite",
    "phone",
    "--label",
    "Family phone",
    "--node",
    "living-room-mini",
    "--allow",
    "app.open",
  ]);
  const now = Date.now();
  const code = "a".repeat(64);
  const client = {
    async call(_method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
      assert.equal(path, "/v1/browser/invitations");
      assert.deepEqual(body, command.action === "invite" ? command.invitation : undefined);
      return {
        id: "browser-1",
        ...(body as object),
        createdAt: now,
        expiresAt: now + BROWSER_INVITATION_TTL_MS,
        code,
      };
    },
  };
  const lines = await runBrowserCommand(client, command);
  assert.equal(lines.filter((line) => line.includes(code)).length, 1);
  assert.match(lines[0]!, /trusted Ellie pairing page.*Scan QR code/);
  assert.match(lines[1]!, /\n/);
  assert.equal(lines[2], `Manual pairing code: ${code}`);
  assert.doesNotMatch(lines.join("\n"), /https?:.*code|tokenHash|session/i);

  const escalated = {
    ...client,
    async call(): Promise<unknown> {
      return {
        id: "browser-1",
        role: "phone_controller",
        label: "Family phone",
        grants: [{ target: "other-node", capabilities: ["app.open"] }],
        createdAt: now,
        expiresAt: now + BROWSER_INVITATION_TTL_MS,
        code,
      };
    },
  };
  await assert.rejects(
    runBrowserCommand(escalated, command),
    /not confirmed.*Do not retry for 10 minutes/,
  );
  await assert.rejects(
    runBrowserCommand({ call: async () => Promise.reject(new Error("private detail")) }, command),
    (error: Error) =>
      /not confirmed.*Do not retry for 10 minutes/.test(error.message) &&
      !error.message.includes("private detail"),
  );
});

test("browser clients and revocation validate coordinator responses before printing", async () => {
  const now = Date.now();
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
      calls.push({ method, path, body });
      if (path.endsWith("clients"))
        return [
          {
            id: "browser-1",
            role: "tv_viewer",
            label: "Living room TV",
            grants: [],
            createdAt: now,
            expiresAt: now + BROWSER_SESSION_TTL_MS,
          },
        ];
      return { ok: true, revoked: true };
    },
  };
  const clients = await runBrowserCommand(client, parseBrowserCommand(["clients"]));
  assert.match(clients[0]!, /Living room TV/);
  assert.doesNotMatch(clients[0]!, /token|code/i);
  assert.deepEqual(await runBrowserCommand(client, parseBrowserCommand(["revoke", "browser-1"])), [
    "Browser client browser-1 revoked.",
  ]);
  assert.deepEqual(calls, [
    { method: "GET", path: "/v1/browser/clients", body: undefined },
    { method: "POST", path: "/v1/browser/revoke", body: { id: "browser-1" } },
  ]);

  await assert.rejects(
    runBrowserCommand(
      { call: async () => [{ id: "browser-1", label: "secret\nline" }] },
      { action: "clients" },
    ),
    /invalid browser management data|Expected an object/,
  );
  await assert.rejects(
    runBrowserCommand(
      { call: async () => Promise.reject(new Error("private transport detail")) },
      { action: "revoke", id: "browser-1" },
    ),
    (error: Error) =>
      /revocation was not confirmed.*browser clients/.test(error.message) &&
      !error.message.includes("private transport detail"),
  );
});

test("browser connection gives fixed recovery for every unavailable reason", async () => {
  const expected: Record<string, RegExp> = {
    identity_unavailable: /browser status/,
    assets_unavailable: /demo:build/,
    auth_unavailable: /stop the coordinator.*authorization file/,
    listener_unavailable: /port 8444/,
  };
  for (const [reason, pattern] of Object.entries(expected)) {
    const lines = await runBrowserCommand(
      { call: async () => ({ status: "unavailable", reason }) },
      { action: "connection" },
    );
    assert.match(lines[0]!, pattern);
  }
  assert.deepEqual(
    await runBrowserCommand(
      { call: async () => ({ status: "ready", origin: "https://host.local:8444" }) },
      { action: "connection" },
    ),
    ["Browser listener ready at https://host.local:8444."],
  );
  await assert.rejects(
    runBrowserCommand(
      { call: async () => ({ status: "unavailable", reason: "private-detail" }) },
      { action: "connection" },
    ),
    /invalid browser connection status/,
  );
});
