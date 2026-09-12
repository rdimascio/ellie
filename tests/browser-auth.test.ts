import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_AUTH_FILE,
  BROWSER_INVITATION_TTL_MS,
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_TTL_MS,
  BrowserAuth,
  MAX_BROWSER_AUTH_BYTES,
  MAX_BROWSER_INVITATIONS,
  MAX_BROWSER_SESSIONS,
  browserAuthState,
  browserInvitationSpec,
  browserRequestMatchesOrigin,
  browserSessionCookie,
  browserSessionToken,
  clearBrowserSessionCookie,
} from "../apps/server/src/browser-auth.ts";
import type { BrowserAuthState, BrowserInvitationSpec } from "../apps/server/src/browser-auth.ts";

const phone: BrowserInvitationSpec = {
  role: "phone_controller",
  label: "Kitchen phone",
  grants: [{ target: "living-room-mini", capabilities: ["app.open", "window.place"] }],
};
const tv: BrowserInvitationSpec = { role: "tv_viewer", label: "Living room TV", grants: [] };

function memoryFixture(initial: BrowserAuthState = BrowserAuth.empty()) {
  let now = 1_000;
  let sequence = 1;
  let failure: "none" | "before" | "after" = "none";
  let persisted = structuredClone(initial);
  const persist = async (state: BrowserAuthState) => {
    if (failure === "before") throw new Error("private path and secret must not escape");
    persisted = structuredClone(state);
    if (failure === "after") throw new Error("private path and secret must not escape");
  };
  const options = {
    now: () => now,
    token: () => (sequence++).toString(16).padStart(64, "0"),
    id: () => `browser-${sequence++}`,
  };
  const auth = new BrowserAuth(initial, persist, options);
  return {
    auth,
    reopen: () => new BrowserAuth(persisted, persist, options),
    now: (value: number) => {
      now = value;
    },
    fail: (value: "none" | "before" | "after") => {
      failure = value;
    },
    persisted: () => structuredClone(persisted),
  };
}

test("browser invitations fix private role, target and capability grants", async () => {
  const f = memoryFixture();
  const invitation = await f.auth.invite(phone);
  assert.equal(invitation.role, "phone_controller");
  assert.equal(invitation.label, "Kitchen phone");
  assert.deepEqual(invitation.grants, phone.grants);
  assert.match(invitation.code, /^[a-f0-9]{64}$/);

  const persistedInvitation = f.persisted().invitations[0]!;
  assert.notEqual(persistedInvitation.tokenHash, invitation.code);
  assert.doesNotMatch(JSON.stringify(f.persisted()), new RegExp(invitation.code));

  await assert.rejects(
    f.auth.pair({ code: invitation.code, role: "tv_viewer", grants: [] }),
    /invalid or expired/,
  );
  const session = await f.auth.pair({ code: invitation.code });
  assert.equal(session.client.role, "phone_controller");
  assert.equal(session.client.label, "Kitchen phone");
  assert.deepEqual(session.client.grants, phone.grants);
  assert.doesNotMatch(JSON.stringify(f.persisted()), new RegExp(session.token));

  session.client.grants[0]!.capabilities.length = 0;
  assert.deepEqual(f.auth.authenticate(session.token)?.grants, phone.grants);
});

test("browser invitation validation rejects escalation, ambiguity and non-printable labels", () => {
  const cases: unknown[] = [
    { ...tv, grants: [{ target: "node", capabilities: ["app.open"] }] },
    { ...phone, grants: [] },
    { ...phone, role: "controller" },
    { ...phone, admin: true },
    { ...phone, label: " hidden" },
    { ...phone, label: "phone\nadmin" },
    { ...phone, label: "x".repeat(65) },
    { ...phone, grants: [{ target: "node", capabilities: ["unknown"] }] },
    {
      ...phone,
      grants: [
        { target: "node", capabilities: ["app.open"] },
        { target: "node", capabilities: ["url.open"] },
      ],
    },
    { ...phone, grants: [{ target: "node", capabilities: ["app.open", "app.open"] }] },
  ];
  for (const value of cases) assert.throws(() => browserInvitationSpec(value));
  assert.deepEqual(browserInvitationSpec(tv), tv);
  assert.deepEqual(browserInvitationSpec(phone), phone);
});

test("a browser invitation is consumed exactly once under concurrent pairing", async () => {
  const f = memoryFixture();
  const invitation = await f.auth.invite(phone);
  const outcomes = await Promise.allSettled([
    f.auth.pair({ code: invitation.code }),
    f.auth.pair({ code: invitation.code }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  assert.equal(f.persisted().invitations.length, 0);
  assert.equal(f.persisted().sessions.length, 1);
});

test("browser invitation and session expiry use closed upper boundaries", async () => {
  const expiredInvite = memoryFixture();
  const invitation = await expiredInvite.auth.invite(phone);
  expiredInvite.now(invitation.expiresAt);
  await assert.rejects(expiredInvite.auth.pair({ code: invitation.code }), /invalid or expired/);

  const expiredSession = memoryFixture();
  const secondInvitation = await expiredSession.auth.invite(phone);
  const session = await expiredSession.auth.pair({ code: secondInvitation.code });
  expiredSession.now(session.client.expiresAt - 1);
  assert.equal(expiredSession.auth.authenticate(session.token)?.id, session.client.id);
  expiredSession.now(session.client.expiresAt);
  assert.equal(expiredSession.auth.authenticate(session.token), undefined);
  assert.deepEqual(expiredSession.auth.listClients(), []);
});

test("pairing persists invitation consumption before issuing a session", async () => {
  const f = memoryFixture();
  const invitation = await f.auth.invite(phone);
  f.fail("before");
  await assert.rejects(
    f.auth.pair({ code: invitation.code }),
    (error: Error) =>
      error.message === "Browser authorization state could not be saved." &&
      !error.message.includes("private path"),
  );
  assert.equal(f.persisted().invitations.length, 1);
  assert.equal(f.persisted().sessions.length, 0);
  assert.throws(() => f.auth.authenticate(invitation.code), /must be reopened/);
  f.fail("none");
  const reopened = f.reopen();
  const session = await reopened.pair({ code: invitation.code });
  assert.equal(reopened.authenticate(session.token)?.id, session.client.id);
  assert.equal(f.persisted().invitations.length, 0);
  assert.equal(f.persisted().sessions.length, 1);
});

test("an uncertain write poisons stale in-memory authorization until reopen", async () => {
  const f = memoryFixture();
  const invitation = await f.auth.invite(phone);
  f.fail("after");
  await assert.rejects(
    f.auth.pair({ code: invitation.code }),
    /Browser authorization state could not be saved/,
  );
  assert.equal(f.persisted().invitations.length, 0);
  assert.equal(f.persisted().sessions.length, 1);
  assert.throws(() => f.auth.listClients(), /must be reopened/);
  await assert.rejects(f.auth.invite(phone), /must be reopened/);

  f.fail("none");
  const reopened = f.reopen();
  assert.equal(reopened.listClients().length, 1);
});

test("revocation and logout invalidate sessions only after durable state succeeds", async () => {
  const f = memoryFixture();
  const first = await f.auth.pair({ code: (await f.auth.invite(phone)).code });
  const second = await f.auth.pair({ code: (await f.auth.invite(tv)).code });

  f.fail("after");
  await assert.rejects(
    f.auth.revoke(first.client.id),
    (error: Error) =>
      error.message === "Browser authorization state could not be saved." &&
      !error.message.includes("private path"),
  );
  assert.throws(() => f.auth.authenticate(first.token), /must be reopened/);

  f.fail("none");
  const reopened = f.reopen();
  assert.equal(reopened.authenticate(first.token), undefined);
  assert.equal(await reopened.revoke(first.client.id), false);

  assert.equal(await reopened.logout(second.token), true);
  assert.equal(reopened.authenticate(second.token), undefined);
  assert.equal(await reopened.logout(second.token), false);
});

test("browser state is versioned, bounded and stores fixed lifetimes", async () => {
  const f = memoryFixture();
  const invitation = await f.auth.invite(tv);
  assert.equal(invitation.expiresAt - invitation.createdAt, BROWSER_INVITATION_TTL_MS);
  const session = await f.auth.pair({ code: invitation.code });
  assert.equal(session.client.expiresAt - session.client.createdAt, BROWSER_SESSION_TTL_MS);

  assert.throws(() => browserAuthState({ version: 2, invitations: [], sessions: [] }));
  assert.throws(() => browserAuthState({ version: 1, invitations: [], sessions: [], token: "x" }));
  assert.throws(() =>
    browserAuthState({
      version: 1,
      invitations: Array.from({ length: MAX_BROWSER_INVITATIONS + 1 }, () => ({})),
      sessions: [],
    }),
  );
  assert.throws(() =>
    browserAuthState({
      version: 1,
      invitations: [],
      sessions: Array.from({ length: MAX_BROWSER_SESSIONS + 1 }, () => ({})),
    }),
  );
});

test("browser auth persistence uses its own private file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ellie-browser-auth-"));
  try {
    const existing = new Map([
      ["auth.json", "existing node verifier"],
      ["server.json", "existing coordinator config"],
      ["server-cert.pem", "existing pinned certificate"],
    ]);
    for (const [name, value] of existing) await writeFile(join(dir, name), value, { mode: 0o600 });
    await writeFile(join(dir, BROWSER_AUTH_FILE), JSON.stringify(BrowserAuth.empty()), {
      mode: 0o600,
    });
    const auth = await BrowserAuth.open(dir);
    const invitation = await auth.invite(tv);

    for (const [name, value] of existing)
      assert.equal(await readFile(join(dir, name), "utf8"), value);
    assert.equal((await stat(join(dir, BROWSER_AUTH_FILE))).mode & 0o777, 0o600);
    const stored = await readFile(join(dir, BROWSER_AUTH_FILE), "utf8");
    assert.doesNotMatch(stored, new RegExp(invitation.code));
    assert.equal(browserAuthState(JSON.parse(stored)).invitations.length, 1);
    assert.deepEqual(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser auth rejects unsafe or oversized private state files", async () => {
  async function expectUnsafe(setup: (dir: string, path: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ellie-browser-unsafe-"));
    try {
      const path = join(dir, BROWSER_AUTH_FILE);
      await setup(dir, path);
      await assert.rejects(BrowserAuth.open(dir), /could not be opened safely/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  await expectUnsafe(async (_dir, path) => {
    await writeFile(path, JSON.stringify(BrowserAuth.empty()), { mode: 0o644 });
  });
  await expectUnsafe(async (dir, path) => {
    await writeFile(path, JSON.stringify(BrowserAuth.empty()), { mode: 0o600 });
    await chmod(dir, 0o755);
  });
  await expectUnsafe(async (dir, path) => {
    const target = join(dir, "target.json");
    await writeFile(target, JSON.stringify(BrowserAuth.empty()), { mode: 0o600 });
    await symlink(target, path);
  });
  await expectUnsafe(async (dir, path) => {
    const target = join(dir, "target.json");
    await writeFile(target, JSON.stringify(BrowserAuth.empty()), { mode: 0o600 });
    await link(target, path);
  });
  await expectUnsafe(async (_dir, path) => {
    await mkdir(path, { mode: 0o700 });
  });
  await expectUnsafe(async (_dir, path) => {
    await writeFile(path, Buffer.alloc(MAX_BROWSER_AUTH_BYTES + 1), { mode: 0o600 });
  });
});

test("browser session cookies are host-only, strict and inaccessible to script", () => {
  const token = "a".repeat(64);
  assert.equal(
    browserSessionCookie(token),
    `${BROWSER_SESSION_COOKIE}=${token}; Path=/; Max-Age=1209600; Secure; HttpOnly; SameSite=Strict`,
  );
  assert.equal(
    clearBrowserSessionCookie(),
    `${BROWSER_SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
  );
  assert.doesNotMatch(browserSessionCookie(token), /Domain=/i);
  assert.equal(browserSessionToken(`theme=dark; ${BROWSER_SESSION_COOKIE}=${token}`), token);
  assert.equal(
    browserSessionToken([
      `${BROWSER_SESSION_COOKIE}=${token}`,
      `${BROWSER_SESSION_COOKIE}=${token}`,
    ]),
    undefined,
  );
  assert.equal(browserSessionToken(`${BROWSER_SESSION_COOKIE}=invalid`), undefined);
  assert.throws(() => browserSessionCookie("invalid"));
});

test("browser request guard enforces exact authority and mutation origin", () => {
  const expected = "https://ellie-coordinator.local:7443";
  const cases: Array<{
    name: string;
    request: { method: string; host?: string; origin?: string };
    allowed: boolean;
  }> = [
    {
      name: "same-origin mutation",
      request: { method: "POST", host: "ellie-coordinator.local:7443", origin: expected },
      allowed: true,
    },
    {
      name: "same-origin lowercase method",
      request: { method: "post", host: "ellie-coordinator.local:7443", origin: expected },
      allowed: true,
    },
    {
      name: "origin-less safe read",
      request: { method: "GET", host: "ellie-coordinator.local:7443" },
      allowed: true,
    },
    {
      name: "matching-origin safe read",
      request: { method: "HEAD", host: "ellie-coordinator.local:7443", origin: expected },
      allowed: true,
    },
    {
      name: "missing mutation origin",
      request: { method: "POST", host: "ellie-coordinator.local:7443" },
      allowed: false,
    },
    {
      name: "opaque mutation origin",
      request: { method: "POST", host: "ellie-coordinator.local:7443", origin: "null" },
      allowed: false,
    },
    {
      name: "cross-site mutation",
      request: {
        method: "POST",
        host: "ellie-coordinator.local:7443",
        origin: "https://attacker.example",
      },
      allowed: false,
    },
    {
      name: "cross-site read",
      request: {
        method: "GET",
        host: "ellie-coordinator.local:7443",
        origin: "https://attacker.example",
      },
      allowed: false,
    },
    {
      name: "wrong authority",
      request: { method: "POST", host: "ellie-coordinator.local", origin: expected },
      allowed: false,
    },
    {
      name: "wrong port",
      request: { method: "POST", host: "ellie-coordinator.local:7437", origin: expected },
      allowed: false,
    },
    {
      name: "host case change",
      request: { method: "POST", host: "Ellie-Coordinator.local:7443", origin: expected },
      allowed: false,
    },
    {
      name: "cross-origin preflight",
      request: {
        method: "OPTIONS",
        host: "ellie-coordinator.local:7443",
        origin: "https://attacker.example",
      },
      allowed: false,
    },
  ];
  for (const item of cases)
    assert.equal(browserRequestMatchesOrigin(expected, item.request), item.allowed, item.name);
  assert.throws(() =>
    browserRequestMatchesOrigin("http://ellie-coordinator.local:7443", cases[0]!.request),
  );
  assert.throws(() =>
    browserRequestMatchesOrigin("https://ellie-coordinator.local:7443/path", cases[0]!.request),
  );
});
