import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { HouseholdState, HouseholdStateError } from "../apps/server/src/household-state.ts";

const token = (character: string) => character.repeat(64);
async function clients(now: () => number = () => 1_000) {
  const ids = ["invite-a", "client-a", "invite-b", "client-b"];
  const codes = [token("a"), token("b")];
  const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
    now,
    id: () => ids.shift()!,
    token: () => codes.shift()!,
  });
  await auth.invite({ label: "A", grants: [{ target: "mac", capabilities: ["app.open"] }] });
  const a = await auth.pair(token("a"), token("c"));
  await auth.invite({ label: "B", grants: [{ target: "mac", capabilities: ["app.open"] }] });
  const b = await auth.pair(token("b"), token("d"));
  return { auth, a, b, bearerA: `Bearer ${token("c")}`, bearerB: `Bearer ${token("d")}` };
}
const dashboard = (name: string) => ({
  version: 1,
  dashboards: [{ id: "home", name, widgets: [] }],
});

test("two clients use conditional shared revisions and private isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-household-state-"));
  try {
    const state = await HouseholdState.openOrInitialize(directory);
    const { auth, a, b, bearerA, bearerB } = await clients();
    await assert.rejects(
      state.read(auth, bearerA, "shared", "dashboards"),
      (error) => error instanceof HouseholdStateError && error.kind === "forbidden",
    );
    await state.grant(auth, {
      clientId: a.id,
      profile: "shared",
      kind: "dashboards",
      access: "write",
    });
    await state.grant(auth, {
      clientId: b.id,
      profile: "shared",
      kind: "dashboards",
      access: "write",
    });
    assert.equal(
      (await state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("One"))).document
        ?.revision,
      1,
    );
    assert.equal((await state.read(auth, bearerB, "shared", "dashboards")).document?.revision, 1);
    assert.equal(
      (await state.write(auth, bearerA, "shared", "dashboards", 1, dashboard("Two"))).document
        ?.revision,
      2,
    );
    const stale = await state.write(auth, bearerB, "shared", "dashboards", 1, dashboard("Lost"));
    assert.deepEqual(stale, { client: b, conflictRevision: 2 });
    assert.deepEqual(
      (await state.read(auth, bearerB, "shared", "dashboards")).document?.value,
      dashboard("Two"),
    );

    await state.grant(auth, {
      clientId: a.id,
      profile: "private",
      kind: "chores",
      access: "write",
    });
    await state.grant(auth, {
      clientId: b.id,
      profile: "private",
      kind: "chores",
      access: "write",
    });
    const chores = {
      version: 1,
      householdTimeZone: "UTC",
      chores: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          title: "A only",
          member: "A",
          body: "",
          dueDay: "2030-01-01",
          completedDay: null,
        },
      ],
    };
    await state.write(auth, bearerA, "private", "chores", 0, chores);
    assert.equal((await state.read(auth, bearerB, "private", "chores")).document?.revision, 0);
    assert.deepEqual((await state.read(auth, bearerB, "private", "chores")).document?.value, {
      version: 1,
      householdTimeZone: "UTC",
      chores: [],
    });

    await state.revoke({ clientId: a.id, profile: "shared", kind: "dashboards" });
    await assert.rejects(
      state.read(auth, bearerA, "shared", "dashboards"),
      (error) => error instanceof HouseholdStateError && error.kind === "forbidden",
    );
    assert.ok(
      auth
        .authenticateBearer(bearerA)
        ?.grants.some((grant) => grant.capabilities.includes("app.open")),
    );
    await auth.revoke(a.id);
    assert.deepEqual(await state.read(auth, bearerA, "private", "chores"), {});

    const reopened = await HouseholdState.openOrInitialize(directory);
    assert.equal(
      (await reopened.read(auth, bearerB, "shared", "dashboards")).document?.revision,
      2,
    );
    assert.equal((await reopened.read(auth, bearerB, "private", "chores")).document?.revision, 0);
    assert.match(await readFile(join(directory, "data-authority.json"), "utf8"), /"version": 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session revocation orders after an accepted durable write", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = HouseholdState.memory({
    documentPersist: async () => {
      entered();
      await gate;
    },
  });
  const { auth, a, bearerA } = await clients();
  await state.grant(auth, {
    clientId: a.id,
    profile: "shared",
    kind: "dashboards",
    access: "write",
  });
  const write = state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("Committed"));
  await started;
  const revoke = auth.revoke(a.id);
  assert.ok(auth.authenticateBearer(bearerA));
  release();
  assert.equal((await write).document?.revision, 1);
  assert.equal(await revoke, true);
  assert.deepEqual(await state.read(auth, bearerA, "shared", "dashboards"), {});
});

for (const operation of ["read", "write", "grant"] as const) {
  test(`queued ${operation} rechecks session expiry at the household serialization point`, async () => {
    let clock = 1_000;
    let saves = 0;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = HouseholdState.memory({
      authorityPersist: async () => {
        saves += 1;
        if (saves === 3) {
          entered();
          await gate;
        }
      },
    });
    const { auth, a, b, bearerA } = await clients(() => clock);
    await state.grant(auth, {
      clientId: a.id,
      profile: "shared",
      kind: "dashboards",
      access: "write",
    });
    await state.grant(auth, { clientId: a.id, profile: "shared", kind: "chores", access: "read" });
    const blocker = state.revoke({ clientId: a.id, profile: "shared", kind: "chores" });
    await started;
    const queued =
      operation === "read"
        ? state.read(auth, bearerA, "shared", "dashboards")
        : operation === "write"
          ? state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("Expired"))
          : state.grant(auth, {
              clientId: b.id,
              profile: "shared",
              kind: "dashboards",
              access: "read",
            });
    clock = 1_000 + 90 * 24 * 60 * 60 * 1_000;
    release();
    await blocker;
    assert.deepEqual(await queued, operation === "grant" ? false : {});
  });
}

test("a failed durable commit publishes nothing and poisons later access", async () => {
  const state = HouseholdState.memory({
    documentPersist: async () => {
      throw new Error("synthetic");
    },
  });
  const { auth, a, bearerA } = await clients();
  await state.grant(auth, {
    clientId: a.id,
    profile: "shared",
    kind: "dashboards",
    access: "write",
  });
  await assert.rejects(
    state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("Never published")),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
  await assert.rejects(
    state.read(auth, bearerA, "shared", "dashboards"),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
});

test("serialized file capacity rejection does not poison the prior state", async () => {
  const state = HouseholdState.memory({ documentFileBytes: 260 });
  const { auth, a, bearerA } = await clients();
  await state.grant(auth, {
    clientId: a.id,
    profile: "shared",
    kind: "dashboards",
    access: "write",
  });
  await assert.rejects(
    state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("x".repeat(80))),
    (error) => error instanceof HouseholdStateError && error.kind === "invalid",
  );
  assert.equal((await state.read(auth, bearerA, "shared", "dashboards")).document?.revision, 0);
  assert.equal(
    (await state.write(auth, bearerA, "shared", "dashboards", 0, { version: 1, dashboards: [] }))
      .document?.revision,
    1,
  );
});

test("close drains the accepted mutation and rejects list and later work", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = HouseholdState.memory({
    documentPersist: async () => {
      entered();
      await gate;
    },
  });
  const { auth, a, bearerA } = await clients();
  await state.grant(auth, {
    clientId: a.id,
    profile: "shared",
    kind: "dashboards",
    access: "write",
  });
  const write = state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("Before close"));
  await started;
  let closed = false;
  const closing = state.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  assert.equal((await write).document?.revision, 1);
  await closing;
  assert.throws(
    () => state.list(),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
  await assert.rejects(
    state.read(auth, bearerA, "shared", "dashboards"),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
});

test("authority persistence failure poisons grants and reads", async () => {
  const state = HouseholdState.memory({
    authorityPersist: async () => {
      throw new Error("synthetic");
    },
  });
  const { auth, a } = await clients();
  await assert.rejects(
    state.grant(auth, { clientId: a.id, profile: "shared", kind: "dashboards", access: "read" }),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
  assert.throws(
    () => state.list(),
    (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
  );
});

test("authority and global document row limits reject without changing prior state", async () => {
  const active = (id: string) => ({
    id,
    role: "native_phone_controller",
    label: id,
    grants: [],
    createdAt: 1,
    expiresAt: 2,
  });
  let bearerId = "client-0";
  let activeId = bearerId;
  const auth = {
    withActiveClient: async (id: string, work: (client: unknown) => unknown) => {
      activeId = id;
      return work(active(id));
    },
    listClients: () => [active(activeId)],
    withAuthenticated: async (_bearer: string, work: (client: unknown) => unknown) =>
      work(active(bearerId)),
    authenticateBearer: () => active(bearerId),
  } as unknown as NativeAuth;
  const authority = HouseholdState.memory();
  for (let index = 0; index < 128; index += 1) {
    assert.equal(
      await authority.grant(auth, {
        clientId: `client-${index}`,
        profile: "shared",
        kind: "dashboards",
        access: "read",
      }),
      true,
    );
  }
  await assert.rejects(
    authority.grant(auth, {
      clientId: "client-128",
      profile: "shared",
      kind: "dashboards",
      access: "read",
    }),
    (error) => error instanceof HouseholdStateError && error.kind === "invalid",
  );
  assert.equal(authority.list().length, 128);

  const documents = HouseholdState.memory();
  for (let index = 0; index < 256; index += 1) {
    bearerId = `owner-${index}`;
    await documents.grant(auth, {
      clientId: bearerId,
      profile: "private",
      kind: "dashboards",
      access: "write",
    });
    assert.equal(
      (
        await documents.write(auth, "Bearer synthetic", "private", "dashboards", 0, {
          version: 1,
          dashboards: [],
        })
      ).document?.revision,
      1,
    );
    await documents.revoke({ clientId: bearerId, profile: "private", kind: "dashboards" });
  }
  bearerId = "owner-256";
  await documents.grant(auth, {
    clientId: bearerId,
    profile: "private",
    kind: "dashboards",
    access: "write",
  });
  await assert.rejects(
    documents.write(auth, "Bearer synthetic", "private", "dashboards", 0, {
      version: 1,
      dashboards: [],
    }),
    (error) => error instanceof HouseholdStateError && error.kind === "invalid",
  );
  assert.equal(
    (await documents.read(auth, "Bearer synthetic", "private", "dashboards")).document?.revision,
    0,
  );
  bearerId = "owner-0";
  await documents.grant(auth, {
    clientId: bearerId,
    profile: "private",
    kind: "dashboards",
    access: "write",
  });
  assert.equal(
    (
      await documents.write(
        auth,
        "Bearer synthetic",
        "private",
        "dashboards",
        1,
        dashboard("Still usable"),
      )
    ).document?.revision,
    2,
  );
});

test("a lost write response is recovered by one read without replay", async () => {
  let saves = 0;
  const state = HouseholdState.memory({
    documentPersist: async () => {
      saves += 1;
    },
  });
  const { auth, a, bearerA } = await clients();
  await state.grant(auth, {
    clientId: a.id,
    profile: "shared",
    kind: "dashboards",
    access: "write",
  });
  await state.write(auth, bearerA, "shared", "dashboards", 0, dashboard("Saved once"));
  const recovered = await state.read(auth, bearerA, "shared", "dashboards");
  assert.equal(recovered.document?.revision, 1);
  assert.deepEqual(recovered.document?.value, dashboard("Saved once"));
  assert.equal(saves, 1);
});

test("a maximum safe persisted revision cannot wrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-household-exhausted-"));
  try {
    await chmod(directory, 0o700);
    await writeFile(
      join(directory, "data-authority.json"),
      JSON.stringify({
        version: 1,
        grants: [{ clientId: "client-a", profile: "shared", kind: "dashboards", access: "write" }],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "household-documents.json"),
      JSON.stringify({
        version: 1,
        documents: [
          {
            profile: "shared",
            kind: "dashboards",
            revision: Number.MAX_SAFE_INTEGER,
            value: dashboard("Last"),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const state = await HouseholdState.openOrInitialize(directory);
    const { auth, bearerA } = await clients();
    await assert.rejects(
      state.write(
        auth,
        bearerA,
        "shared",
        "dashboards",
        Number.MAX_SAFE_INTEGER,
        dashboard("Wrap"),
      ),
      (error) => error instanceof HouseholdStateError && error.kind === "exhausted",
    );
    assert.equal(
      (await state.read(auth, bearerA, "shared", "dashboards")).document?.revision,
      Number.MAX_SAFE_INTEGER,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-revision concurrent writers have one winner and missing reads stay revision zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-household-race-"));
  try {
    const state = await HouseholdState.openOrInitialize(directory);
    const { auth, a, bearerA } = await clients();
    await state.grant(auth, { clientId: a.id, profile: "shared", kind: "chores", access: "write" });
    assert.equal((await state.read(auth, bearerA, "shared", "chores")).document?.revision, 0);
    const value = { version: 1, householdTimeZone: "UTC", chores: [] };
    const results = await Promise.all([
      state.write(auth, bearerA, "shared", "chores", 0, value),
      state.write(auth, bearerA, "shared", "chores", 0, value),
    ]);
    assert.deepEqual(
      results.map((result) => result.document?.revision ?? result.conflictRevision).sort(),
      [1, 1],
    );
    assert.equal(results.filter((result) => result.document).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsafe and unsupported store files are preserved without replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-household-unsafe-"));
  try {
    await chmod(directory, 0o700);
    const target = join(directory, "outside.json");
    await writeFile(target, "sentinel");
    await symlink(target, join(directory, "data-authority.json"));
    await assert.rejects(
      HouseholdState.openOrInitialize(directory),
      (error) => error instanceof HouseholdStateError && error.kind === "unavailable",
    );
    assert.equal(await readFile(target, "utf8"), "sentinel");
    await rm(join(directory, "data-authority.json"));
    await writeFile(join(directory, "hardlink-source"), '{"version":1,"grants":[]}\n', {
      mode: 0o600,
    });
    await link(join(directory, "hardlink-source"), join(directory, "data-authority.json"));
    await assert.rejects(HouseholdState.openOrInitialize(directory));
    assert.equal(
      await readFile(join(directory, "hardlink-source"), "utf8"),
      '{"version":1,"grants":[]}\n',
    );
    await rm(join(directory, "data-authority.json"));
    await rm(join(directory, "hardlink-source"));
    await writeFile(join(directory, "data-authority.json"), '{"version":1,"grants":[]}\n', {
      mode: 0o644,
    });
    await assert.rejects(HouseholdState.openOrInitialize(directory));
    await rm(join(directory, "data-authority.json"));
    assert.equal(spawnSync("/usr/bin/mkfifo", [join(directory, "data-authority.json")]).status, 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(
        Promise.race([
          HouseholdState.openOrInitialize(directory),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("FIFO read blocked")), 500);
          }),
        ]),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    await rm(join(directory, "data-authority.json"));
    const oversized = "x".repeat(1024 * 1024 + 1);
    await writeFile(join(directory, "data-authority.json"), oversized, { mode: 0o600 });
    await assert.rejects(HouseholdState.openOrInitialize(directory));
    assert.equal(
      (await readFile(join(directory, "data-authority.json"), "utf8")).length,
      oversized.length,
    );
    await rm(join(directory, "data-authority.json"));
    const future = '{"version":2,"grants":[]}\n';
    await writeFile(join(directory, "data-authority.json"), future, { mode: 0o600 });
    await assert.rejects(HouseholdState.openOrInitialize(directory));
    assert.equal(await readFile(join(directory, "data-authority.json"), "utf8"), future);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
