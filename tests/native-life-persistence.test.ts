import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import {
  NATIVE_LIFE_AUTHORITY_FILE,
  NativeLifeAuthority,
  NativeLifeError,
} from "../apps/server/src/native-life.ts";

async function enrollment() {
  const auth = new NativeAuth(NativeAuth.empty(), async () => {});
  const token = "a".repeat(64);
  const invitation = await auth.invite({
    label: "Synthetic phone",
    grants: [{ target: "synthetic-mac", capabilities: ["app.open"] }],
  });
  const client = await auth.pair(invitation.code, token);
  return { auth, bearer: `Bearer ${token}`, clientId: client.id };
}

test("persisted Life authority survives reopen while sessions and revoked revisions do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-life-authority-"));
  await chmod(directory, 0o700);
  const { auth, bearer, clientId } = await enrollment();
  let authority: NativeLifeAuthority | undefined;
  try {
    authority = await NativeLifeAuthority.open(auth, ["owner"], directory);
    await authority.grant({ clientId, actorId: "owner", capability: "life.account" });
    const original = await authority.session(bearer);
    const revision = authority.list()[0]!.revision;
    const persisted = await readFile(join(directory, NATIVE_LIFE_AUTHORITY_FILE), "utf8");
    assert.ok(!persisted.includes(original.sessionToken));
    assert.ok(!persisted.includes(bearer));
    await authority.close();

    authority = await NativeLifeAuthority.open(auth, ["owner"], directory);
    assert.equal(await authority.allowed(bearer), true);
    assert.equal(authority.admit(original.sessionToken), undefined);
    const afterRestart = await authority.session(bearer);
    assert.ok(authority.admit(afterRestart.sessionToken));
    await authority.revoke(clientId);
    assert.equal(authority.admit(afterRestart.sessionToken), undefined);
    await authority.close();

    authority = await NativeLifeAuthority.open(auth, ["owner"], directory);
    assert.equal(await authority.allowed(bearer), false);
    await authority.grant({ clientId, actorId: "owner", capability: "life.account" });
    assert.ok(authority.list()[0]!.revision > revision);
    assert.equal(authority.admit(afterRestart.sessionToken), undefined);
    assert.equal(authority.admit(original.sessionToken), undefined);
    await authority.close();
    authority = undefined;
    await assert.rejects(NativeLifeAuthority.open(auth, ["another-owner"], directory));
    await chmod(join(directory, NATIVE_LIFE_AUTHORITY_FILE), 0o644);
    await assert.rejects(NativeLifeAuthority.open(auth, ["owner"], directory));
  } finally {
    await authority?.close();
    await auth.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncertain authority persistence prevents new and existing access until recovery", async () => {
  const { auth, bearer, clientId } = await enrollment();
  let unavailable = false;
  const authority = new NativeLifeAuthority(
    auth,
    ["owner"],
    { version: 1, grants: [], revisions: {} },
    async () => {
      if (unavailable) throw new Error("Synthetic persistence failure.");
    },
  );
  try {
    await authority.grant({ clientId, actorId: "owner", capability: "life.account" });
    const session = await authority.session(bearer);
    const active = authority.admit(session.sessionToken);
    assert.ok(active);
    assert.equal(active.isCurrent(), true);
    unavailable = true;
    await assert.rejects(authority.revoke(clientId));
    assert.equal(active.isCurrent(), false);
    assert.throws(
      () => authority.admit(session.sessionToken),
      (error) => error instanceof NativeLifeError && error.kind === "unavailable",
    );
    await assert.rejects(authority.session(bearer));
    await assert.rejects(authority.allowed(bearer));
  } finally {
    await authority.close();
    await auth.close();
  }
});
