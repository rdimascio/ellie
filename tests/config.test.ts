import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureState, save, load, defaults, serverConfig, nodeConfig } from "@ellie/config";
import { Auth, newToken } from "../apps/server/src/auth.ts";

test("private state has restricted permissions and credentials are stored only as hashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-state-"));
  try {
    await save("sample.json", { version: 1 }, dir);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "sample.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await load("sample.json", dir), { version: 1 });
    const controller = newToken();
    await Auth.initialize(controller, dir);
    const auth = await Auth.open(dir);
    const invite = await auth.invite();
    const nodeToken = await auth.pair(invite.code, "test-node");
    const disk = await readFile(join(dir, "auth.json"), "utf8");
    assert.ok(
      !disk.includes(controller) && !disk.includes(nodeToken) && !disk.includes(invite.code),
    );
    assert.equal(auth.authenticate(`Bearer ${nodeToken}`)?.id, "test-node");
    await auth.revoke("test-node");
    assert.equal(auth.authenticate(`Bearer ${nodeToken}`), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("private state cannot be written into the checkout or traversed through a file name", async () => {
  await assert.rejects(ensureState(join(process.cwd(), ".ellie")), /outside/);
  await assert.rejects(save("../secret", {}), /identifier/);
});
test("config validates transport and version before use", () => {
  assert.throws(() =>
    serverConfig({ version: 1, host: "localhost", port: 70000, preferences: defaults }),
  );
  assert.throws(() =>
    nodeConfig({ version: 1, id: "test", serverUrl: "http://localhost", preferences: defaults }),
  );
  assert.throws(() =>
    nodeConfig({ version: 2, id: "test", serverUrl: "https://localhost", preferences: defaults }),
  );
});
test("pairing is single-use even under concurrency, and invitation replacement invalidates the old code", async () => {
  const auth = new Auth({ identities: [] }, async () => {});
  const stale = await auth.invite();
  const invite = await auth.invite();
  await assert.rejects(auth.pair(stale.code, "stale"));
  const results = await Promise.allSettled([
    auth.pair(invite.code, "first"),
    auth.pair(invite.code, "second"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
test("expired invitation is rejected", async () => {
  const auth = new Auth(
    { identities: [], invitation: { hash: "not-a-valid-hash", expiresAt: Date.now() - 1 } },
    async () => {},
  );
  await assert.rejects(auth.pair("code", "test"));
});
