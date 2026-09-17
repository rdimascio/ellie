import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserConfig,
  ensureState,
  save,
  load,
  defaults,
  serverConfig,
  nodeConfig,
  Keychain,
  KeychainFailure,
  nativeHelperPath,
} from "@ellie/config";
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
test("Keychain presence checks reject unknown helper responses", async () => {
  class InvalidPresenceKeychain extends Keychain {
    override async call(): Promise<string> {
      return "unexpected";
    }
  }
  await assert.rejects(new InvalidPresenceKeychain().has("browser-ca-key"), /invalid presence/);
});
test(
  "Keychain classifies missing and rejecting synthetic helpers without exposing their output",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ellie-keychain-helper-"));
    const previous = process.env.ELLIE_MACOS_HELPER;
    try {
      process.env.ELLIE_MACOS_HELPER = join(dir, "missing-helper");
      await assert.rejects(
        new Keychain().get("synthetic.account"),
        (error: unknown) =>
          error instanceof KeychainFailure && error.reason === "helper_unavailable",
      );
      const helper = join(dir, "rejecting-helper");
      await writeFile(helper, "#!/bin/sh\nprintf 'synthetic-private-output'\nexit 1\n", {
        mode: 0o700,
      });
      process.env.ELLIE_MACOS_HELPER = helper;
      await assert.rejects(
        new Keychain().get("synthetic.account"),
        (error: unknown) =>
          error instanceof KeychainFailure &&
          error.reason === "access_unavailable" &&
          !error.message.includes("synthetic-private-output") &&
          !error.message.includes("synthetic.account"),
      );
    } finally {
      if (previous === undefined) delete process.env.ELLIE_MACOS_HELPER;
      else process.env.ELLIE_MACOS_HELPER = previous;
      await rm(dir, { recursive: true, force: true });
    }
  },
);
test("packaged helper resolution is explicit, absolute, and preserves the developer fallback", () => {
  assert.equal(nativeHelperPath({}, "/synthetic/.ellie"), "/synthetic/.ellie/bin/ellie-macos");
  assert.equal(
    nativeHelperPath({ ELLIE_MACOS_HELPER: "/release/payload/helpers/ellie-macos" }),
    "/release/payload/helpers/ellie-macos",
  );
  assert.throws(() => nativeHelperPath({ ELLIE_MACOS_HELPER: "relative/helper" }), /invalid/);
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
  assert.throws(() =>
    browserConfig({
      version: 1,
      hostname: "Other.local",
      port: 8444,
      createdAt: new Date().toISOString(),
      caFingerprint: "AA",
    }),
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
