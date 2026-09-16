import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { handleLifeManagement } from "../apps/server/src/life-management.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import {
  NATIVE_LIFE_CAPABILITY,
  NativeLifeAuthority,
  NativeLifeError,
} from "../apps/server/src/native-life.ts";

const token = (value: string) => value.repeat(64);

async function fixture() {
  const ids = ["invitation-a", "client-a", "invitation-b", "client-b"];
  const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
    id: () => ids.shift()!,
    token: () => token("a"),
  });
  const invitationA = await auth.invite({
    label: "Phone",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const clientA = await auth.pair(invitationA.code, token("b"));
  const invitationB = await auth.invite({
    label: "Tablet",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const clientB = await auth.pair(invitationB.code, token("c"));
  const issued = [token("d"), token("e"), token("f")];
  const life = NativeLifeAuthority.memory(auth, ["owner"], { token: () => issued.shift()! });
  return {
    auth,
    life,
    clientA,
    clientB,
    bearerA: `Bearer ${token("b")}`,
    bearerB: `Bearer ${token("c")}`,
  };
}

function managementRequest(
  method: string,
  body?: unknown,
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  const value = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const request = Readable.from(value ? [value] : []) as IncomingMessage;
  request.method = method;
  request.rawHeaders = [
    "Authorization",
    "Bearer controller",
    "X-Ellie-Version",
    "1",
    ...(value ? ["Content-Type", "application/json", "Content-Length", String(value.length)] : []),
  ];
  request.headers = {};
  Object.defineProperty(request, "socket", { value: { remoteAddress } });
  return request;
}

test("Life authority is explicit, host-bound, and can share one actor across devices", async () => {
  const f = await fixture();
  await assert.rejects(
    f.life.session(f.bearerA),
    (error) => error instanceof NativeLifeError && error.kind === "forbidden",
  );
  await assert.rejects(
    f.life.grant({
      clientId: f.clientA.id,
      actorId: "someone-else",
      capability: NATIVE_LIFE_CAPABILITY,
    }),
    (error) => error instanceof NativeLifeError && error.kind === "forbidden",
  );
  assert.equal(
    await f.life.grant({
      clientId: f.clientA.id,
      actorId: "owner",
      capability: NATIVE_LIFE_CAPABILITY,
    }),
    true,
  );
  assert.equal(
    await f.life.grant({
      clientId: f.clientB.id,
      actorId: "owner",
      capability: NATIVE_LIFE_CAPABILITY,
    }),
    true,
  );
  assert.deepEqual(
    f.life.list().map(({ clientId, actorId, capability }) => ({ clientId, actorId, capability })),
    [
      { clientId: f.clientA.id, actorId: "owner", capability: "life.account" },
      { clientId: f.clientB.id, actorId: "owner", capability: "life.account" },
    ],
  );
  assert.equal((await f.life.session(f.bearerA)).entryPath, "/life/");
  assert.equal(await f.life.allowed(f.bearerA), true);
  assert.equal((await f.life.session(f.bearerB)).entryPath, "/life/");
  await f.life.close();
  await f.auth.close();
});

test("authority and native-session revocation abort active requests and invalidate web sessions", async () => {
  const f = await fixture();
  await f.life.grant({
    clientId: f.clientA.id,
    actorId: "owner",
    capability: NATIVE_LIFE_CAPABILITY,
  });
  const first = await f.life.session(f.bearerA),
    admitted = f.life.admit(first.sessionToken);
  assert.ok(admitted && admitted.status === "admitted");
  assert.equal(admitted.session.actorId, "owner");
  assert.equal(admitted.isCurrent(), true);
  assert.equal(await f.life.revoke(f.clientA.id), true);
  assert.equal(await f.life.allowed(f.bearerA), false);
  assert.equal(admitted.controller.signal.aborted, true);
  assert.equal(admitted.isCurrent(), false);
  assert.equal(f.life.admit(first.sessionToken), undefined);
  f.life.finish(f.clientA.id, admitted.controller);

  await f.life.grant({
    clientId: f.clientA.id,
    actorId: "owner",
    capability: NATIVE_LIFE_CAPABILITY,
  });
  const second = await f.life.session(f.bearerA),
    active = f.life.admit(second.sessionToken);
  assert.ok(active && active.status === "admitted");
  await f.auth.revoke(f.clientA.id);
  assert.equal(active.controller.signal.aborted, true);
  assert.equal(active.isCurrent(), false);
  assert.equal(f.life.admit(second.sessionToken), undefined);
  await f.life.close();
  await f.auth.close();
});

test("a fifth WebView opening retires the oldest per-client session", async () => {
  const f = await fixture();
  const values = ["d", "e", "f", "1", "2"].map(token);
  await f.life.close();
  const life = NativeLifeAuthority.memory(f.auth, ["owner"], { token: () => values.shift()! });
  await life.grant({
    clientId: f.clientA.id,
    actorId: "owner",
    capability: NATIVE_LIFE_CAPABILITY,
  });
  const sessions = [];
  for (let count = 0; count < 5; count++) sessions.push(await life.session(f.bearerA));
  assert.equal(life.admit(sessions[0]!.sessionToken), undefined);
  assert.equal(life.admit(sessions[4]!.sessionToken)?.status, "admitted");
  await life.close();
  await f.auth.close();
});

test("valid sessions report admission pressure separately from authentication", async () => {
  const f = await fixture();
  await f.life.grant({
    clientId: f.clientA.id,
    actorId: "owner",
    capability: NATIVE_LIFE_CAPABILITY,
  });
  const session = await f.life.session(f.bearerA);
  const admitted = Array.from({ length: 4 }, () => f.life.admit(session.sessionToken));
  assert.ok(admitted.every((item) => item?.status === "admitted"));
  assert.deepEqual(f.life.admission(session.sessionToken), { status: "busy" });
  for (const item of admitted)
    if (item?.status === "admitted") f.life.finish(item.session.clientId, item.controller);
  assert.equal(f.life.admit(session.sessionToken)?.status, "admitted");
  await f.life.close();
  await f.auth.close();
});

test("controller management returns the persisted revision and revokes idempotently", async () => {
  const f = await fixture();
  const control = {
    current: () => ({
      status: "ready" as const,
      origin: "https://localhost:8444",
      auth: undefined as never,
      nativeAuth: f.auth,
      nativeLife: f.life,
    }),
  };
  const grant = await handleLifeManagement(
    managementRequest("POST", {
      clientId: f.clientA.id,
      actorId: "owner",
      capability: NATIVE_LIFE_CAPABILITY,
    }),
    "/v1/life/authorities",
    "controller",
    control,
  );
  assert.deepEqual(grant, {
    status: 200,
    body: {
      ok: true,
      grant: {
        clientId: f.clientA.id,
        actorId: "owner",
        capability: NATIVE_LIFE_CAPABILITY,
        revision: 1,
      },
    },
  });
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("GET"),
      "/v1/life/authorities",
      "controller",
      control,
    ),
    { status: 200, body: { grants: [f.life.list()[0]] } },
  );
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("POST", { clientId: f.clientA.id }),
      "/v1/life/authorities/revoke",
      "controller",
      control,
    ),
    { status: 200, body: { ok: true, revoked: true } },
  );
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("POST", { clientId: f.clientA.id }),
      "/v1/life/authorities/revoke",
      "controller",
      control,
    ),
    { status: 200, body: { ok: true, revoked: false } },
  );
  await f.life.close();
  await f.auth.close();
});

test("local controller opens host settings without native-phone authority or serialized secrets", async () => {
  let opened = 0;
  const control = {
    current: () => ({
      status: "ready" as const,
      origin: "https://localhost:8444",
      auth: undefined as never,
      hostLife: {
        async handle() {
          return true;
        },
        async openOwnerSettings() {
          opened += 1;
          return "opened" as const;
        },
      },
    }),
  };
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("POST", {}),
      "/v1/life/owner-settings",
      "controller",
      control,
    ),
    { status: 200, body: { opened: true } },
  );
  assert.equal(opened, 1);
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("POST", {}, "192.0.2.10"),
      "/v1/life/owner-settings",
      "controller",
      control,
    ),
    { status: 403, body: { error: "Local owner command required." } },
  );
  assert.deepEqual(
    await handleLifeManagement(
      managementRequest("POST", { unexpected: true }),
      "/v1/life/owner-settings",
      "controller",
      control,
    ),
    { status: 400, body: { error: "Life owner request rejected." } },
  );
  assert.equal(opened, 1);
});
