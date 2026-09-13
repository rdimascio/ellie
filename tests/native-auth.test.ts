import test from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeAuth,
  NATIVE_INVITATION_TTL_MS,
  NATIVE_SESSION_TTL_MS,
} from "../apps/server/src/native-auth.ts";

const code = "a".repeat(64);
const sessionToken = "b".repeat(64);
const spec = {
  label: "Ryan’s iPhone",
  grants: [{ target: "studio-mac", capabilities: ["app.open"] }],
};

function fixture() {
  let now = 1_000_000;
  let state = NativeAuth.empty();
  let fail = false;
  let token = code;
  let id = 0;
  const auth = new NativeAuth(
    state,
    async (next) => {
      if (fail) throw new Error("secret persistence path");
      state = structuredClone(next);
    },
    { now: () => now, token: () => token, id: () => `native-${++id}` },
  );
  return {
    auth,
    state: () => structuredClone(state),
    now: (value: number) => {
      now = value;
    },
    token: (value: string) => {
      token = value;
    },
    fail: () => {
      fail = true;
    },
  };
}

test("native invitation pairs once and candidate bearer recovers a lost response", async () => {
  const f = fixture();
  const invitation = await f.auth.invite(spec);
  assert.equal(invitation.code, code);
  const client = await f.auth.pair(code, sessionToken);
  assert.deepEqual(f.auth.authenticateBearer(`Bearer ${sessionToken}`), client);
  await assert.rejects(f.auth.pair(code, "c".repeat(64)), /rejected/);
  assert.equal(f.auth.authenticateBearer(`Bearer ${code}`), undefined);
  assert.doesNotMatch(JSON.stringify(f.state()), new RegExp(`${code}|${sessionToken}`));
  client.grants[0]!.capabilities.length = 0;
  assert.deepEqual(f.auth.authenticateBearer(`Bearer ${sessionToken}`)?.grants, spec.grants);
});

test("native credentials expire and revoke without browser or agent authority", async () => {
  const f = fixture();
  const invitation = await f.auth.invite(spec);
  f.now(invitation.createdAt + NATIVE_INVITATION_TTL_MS);
  await assert.rejects(f.auth.pair(code, sessionToken), /rejected/);

  f.now(2_000_000);
  f.token("d".repeat(64));
  const fresh = await f.auth.invite(spec);
  const client = await f.auth.pair(fresh.code, sessionToken);
  assert.equal(
    f.auth.authenticateBearer(`Bearer ${sessionToken}`)?.role,
    "native_phone_controller",
  );
  assert.equal(await f.auth.revoke(client.id), true);
  assert.equal(f.auth.authenticateBearer(`Bearer ${sessionToken}`), undefined);

  f.token("e".repeat(64));
  const next = await f.auth.invite(spec);
  await f.auth.pair(next.code, "f".repeat(64));
  f.now(2_000_000 + NATIVE_SESSION_TTL_MS);
  assert.equal(f.auth.authenticateBearer(`Bearer ${"f".repeat(64)}`), undefined);
});

test("native persistence failure is fail closed and does not publish mutated state", async () => {
  const f = fixture();
  f.fail();
  await assert.rejects(f.auth.invite(spec), /unavailable/);
  assert.deepEqual(f.state(), NativeAuth.empty());
  await assert.rejects(f.auth.invite(spec), /unavailable/);
});

test("native grants and tokens are finite and collision checked", async () => {
  const f = fixture();
  await assert.rejects(
    f.auth.invite({ label: "Admin", grants: [{ target: "mac", capabilities: ["window.place"] }] }),
  );
  const invitation = await f.auth.invite(spec);
  await assert.rejects(f.auth.pair(invitation.code, invitation.code), /rejected/);
  assert.equal(f.auth.authenticateBearer("Bearer not-a-token"), undefined);
});

test("native auth uses a distinct private state file and rejects unsafe files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-native-auth-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  const auth = await NativeAuth.openOrInitialize(dir);
  await auth.close();
  const file = await lstat(join(dir, "native-auth.json"));
  assert.equal(file.mode & 0o777, 0o600);

  const unsafe = await mkdtemp(join(tmpdir(), "ellie-native-auth-link-"));
  t.after(() => rm(unsafe, { recursive: true, force: true }));
  await chmod(unsafe, 0o700);
  const target = join(unsafe, "target");
  await writeFile(target, JSON.stringify(NativeAuth.empty()));
  await symlink(target, join(unsafe, "native-auth.json"));
  await assert.rejects(NativeAuth.openOrInitialize(unsafe), /unavailable|ELOOP/);

  const malformed = await mkdtemp(join(tmpdir(), "ellie-native-auth-malformed-"));
  t.after(() => rm(malformed, { recursive: true, force: true }));
  await chmod(malformed, 0o700);
  const malformedPath = join(malformed, "native-auth.json");
  const bytes = Buffer.from([0xff, 0xfe, 0xfd]);
  await writeFile(malformedPath, bytes, { mode: 0o600 });
  await assert.rejects(NativeAuth.openOrInitialize(malformed), /unavailable/);
  assert.deepEqual(await readFile(malformedPath), bytes);
});

test("private native state preserves pair recovery and one-use invitations across reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-native-pair-reopen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  let auth = await NativeAuth.openOrInitialize(dir);
  const invitation = await auth.invite(spec);
  const candidate = "c".repeat(64);
  const client = await auth.pair(invitation.code, candidate);
  await auth.close();

  auth = await NativeAuth.openOrInitialize(dir);
  assert.deepEqual(auth.authenticateBearer(`Bearer ${candidate}`), client);
  await assert.rejects(auth.pair(invitation.code, "d".repeat(64)), /rejected/);
  await auth.close();
});

test("private native state preserves revocation across reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-native-revoke-reopen-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o700);
  let auth = await NativeAuth.openOrInitialize(dir);
  const invitation = await auth.invite(spec);
  const candidate = "e".repeat(64);
  const client = await auth.pair(invitation.code, candidate);
  assert.equal(await auth.revoke(client.id), true);
  await auth.close();

  auth = await NativeAuth.openOrInitialize(dir);
  assert.equal(auth.authenticateBearer(`Bearer ${candidate}`), undefined);
  await auth.close();
});

test("failed private pair persistence poisons the instance and publishes no candidate", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-native-pair-failure-"));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await chmod(dir, 0o700);
  const auth = await NativeAuth.openOrInitialize(dir);
  const invitation = await auth.invite(spec);
  const candidate = "f".repeat(64);
  await chmod(dir, 0o500);
  await assert.rejects(auth.pair(invitation.code, candidate), /unavailable/);
  assert.throws(() => auth.authenticateBearer(`Bearer ${candidate}`), /unavailable/);
  await chmod(dir, 0o700);
  await auth.close();

  const reopened = await NativeAuth.openOrInitialize(dir);
  assert.equal(reopened.authenticateBearer(`Bearer ${candidate}`), undefined);
  await reopened.pair(invitation.code, candidate);
  assert.ok(reopened.authenticateBearer(`Bearer ${candidate}`));
  await reopened.close();
});

test("failed private revoke persistence is fail closed and leaves durable authority", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-native-revoke-failure-"));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  await chmod(dir, 0o700);
  const auth = await NativeAuth.openOrInitialize(dir);
  const invitation = await auth.invite(spec);
  const candidate = "1".repeat(64);
  const client = await auth.pair(invitation.code, candidate);
  await chmod(dir, 0o500);
  await assert.rejects(auth.revoke(client.id), /unavailable/);
  assert.throws(() => auth.authenticateBearer(`Bearer ${candidate}`), /unavailable/);
  await chmod(dir, 0o700);
  await auth.close();

  const reopened = await NativeAuth.openOrInitialize(dir);
  assert.deepEqual(reopened.authenticateBearer(`Bearer ${candidate}`), client);
  await reopened.close();
});
