import test from "node:test";
import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { defaults } from "@ellie/config";
import { VERSION } from "@ellie/protocol";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import type { BrowserAuthState } from "../apps/server/src/browser-auth.ts";
import type {
  BrowserControl,
  BrowserControlSnapshot,
} from "../apps/server/src/browser-management.ts";
import { createEllieServer } from "../apps/server/src/index.ts";
import { JobStore } from "../apps/server/src/jobs.ts";

async function fixture(options: { initial?: BrowserControlSnapshot; omitBrowser?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ellie-browser-management-"));
  const { key, cert } = await generateCertificate();
  const controllerToken = newToken();
  await Auth.initialize(controllerToken, dir);
  const agentAuth = await Auth.open(dir);
  const nodeInvitation = await agentAuth.invite();
  const nodeToken = await agentAuth.pair(nodeInvitation.code, "living-room-mini");
  let browserState: BrowserAuthState = BrowserAuth.empty();
  let failBrowserSave = false;
  const browserAuth = new BrowserAuth(browserState, async (next) => {
    if (failBrowserSave) throw new Error("private persistence detail");
    browserState = structuredClone(next);
  });
  let nativeState = NativeAuth.empty();
  const nativeAuth = new NativeAuth(nativeState, async (next) => {
    nativeState = structuredClone(next);
  });
  let current =
    options.initial ??
    ({
      status: "ready",
      origin: "https://coordinator.local:8444",
      auth: browserAuth,
      nativeAuth,
      certificateSha256: "a".repeat(64),
    } satisfies BrowserControlSnapshot);
  const browser: BrowserControl = { current: () => current };
  const jobStore = new JobStore(join(dir, "jobs.sqlite"));
  const app = createEllieServer({
    key,
    cert,
    auth: agentAuth,
    ...(options.omitBrowser ? {} : { browser }),
    preferences: defaults,
    jobStore,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const port = (app.server.address() as AddressInfo).port;

  async function call(
    token: string | undefined,
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: string;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: unknown; text: string }> {
    const data =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          servername: "ellie.local",
          ca: cert,
          rejectUnauthorized: true,
          checkServerIdentity: () => undefined,
          method,
          path,
          headers: {
            "x-ellie-version": String(VERSION),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(data === undefined
              ? {}
              : {
                  "content-type": options.contentType ?? "application/json",
                  "content-length": Buffer.byteLength(data),
                }),
            ...options.headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(text) as unknown,
              text,
            });
          });
        },
      );
      request.once("error", reject);
      request.end(data);
    });
  }

  return {
    browserAuth,
    nativeAuth,
    controllerToken,
    nodeToken,
    call,
    setCurrent(value: BrowserControlSnapshot) {
      current = value;
    },
    failBrowserSave() {
      failBrowserSave = true;
    },
    persistedBrowserState() {
      return structuredClone(browserState);
    },
    persistedNativeState() {
      return structuredClone(nativeState);
    },
    async close() {
      app.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("browser management status exposes only fixed public state to the controller", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  assert.deepEqual((await f.call(f.controllerToken, "GET", "/v1/browser")).body, {
    status: "ready",
    origin: "https://coordinator.local:8444",
  });

  f.setCurrent({ status: "unavailable", reason: "auth_unavailable" });
  assert.deepEqual((await f.call(f.controllerToken, "GET", "/v1/browser")).body, {
    status: "unavailable",
    reason: "auth_unavailable",
  });
  f.setCurrent({
    status: "unavailable",
    reason: "auth_unavailable",
    privateDetail: "must not escape",
  } as BrowserControlSnapshot);
  assert.doesNotMatch(
    (await f.call(f.controllerToken, "GET", "/v1/browser")).text,
    /privateDetail|must not escape/,
  );
  f.setCurrent({ status: "disabled" });
  assert.deepEqual((await f.call(f.controllerToken, "GET", "/v1/browser")).body, {
    status: "disabled",
  });

  assert.equal((await f.call(f.nodeToken, "GET", "/v1/browser")).status, 403);
  assert.equal(
    (
      await f.call(undefined, "GET", "/v1/browser", {
        headers: { cookie: "__Host-ellie-session=a".repeat(64) },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(f.controllerToken, "GET", "/v1/browser", {
        headers: { origin: "https://coordinator.local:8444" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(f.controllerToken, "GET", "/v1/browser", {
        headers: { origin: "" },
      })
    ).status,
    403,
  );

  const absent = await fixture({ omitBrowser: true });
  t.after(() => absent.close());
  assert.deepEqual((await absent.call(absent.controllerToken, "GET", "/v1/browser")).body, {
    status: "disabled",
  });
});

test("only controller manages native invitations, clients and revocation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const specification = {
    label: "Family iPhone",
    grants: [{ target: "living-room-mini", capabilities: ["app.open"] }],
  };
  assert.equal(
    (await f.call(f.nodeToken, "POST", "/v1/native/invitations", { body: specification })).status,
    403,
  );
  const overQrCapacity = await f.call(f.controllerToken, "POST", "/v1/native/invitations", {
    body: {
      label: "x".repeat(64),
      grants: Array.from({ length: 16 }, (_, index) => ({
        target: `${String(index).padStart(2, "0")}${"x".repeat(97)}`,
        capabilities: ["app.open"],
      })),
    },
  });
  assert.equal(overQrCapacity.status, 400);
  assert.deepEqual(f.persistedNativeState(), NativeAuth.empty());
  const issued = await f.call(f.controllerToken, "POST", "/v1/native/invitations", {
    body: specification,
  });
  assert.equal(issued.status, 200);
  const payload = issued.body as { invitation: string; origin: string; certificateSha256: string };
  assert.equal(payload.origin, "https://coordinator.local:8444");
  assert.equal(payload.certificateSha256, "a".repeat(64));
  assert.match(payload.invitation, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(issued.text, /tokenHash/);
  const client = await f.nativeAuth.pair(payload.invitation, "7".repeat(64));
  const clients = await f.call(f.controllerToken, "GET", "/v1/native/clients");
  assert.deepEqual(clients.body, [client]);
  assert.doesNotMatch(clients.text, /tokenHash|7777777777/);
  assert.equal(
    (await f.call(f.controllerToken, "POST", "/v1/native/revoke", { body: { id: client.id } }))
      .status,
    200,
  );
  assert.deepEqual((await f.call(f.controllerToken, "GET", "/v1/native/clients")).body, []);
});

test("controller issues fixed browser invitations, lists public clients, and revokes durably", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const specification = {
    role: "phone_controller",
    label: "Family phone",
    grants: [{ target: "living-room-mini", capabilities: ["app.open"] }],
  };
  const issued = await f.call(f.controllerToken, "POST", "/v1/browser/invitations", {
    body: specification,
  });
  assert.equal(issued.status, 200);
  const invitation = issued.body as { code: string };
  assert.match(invitation.code, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(issued.text, /tokenHash|"auth"/);

  const session = await f.browserAuth.pair({ code: invitation.code });
  const clients = await f.call(f.controllerToken, "GET", "/v1/browser/clients");
  assert.equal(clients.status, 200);
  assert.deepEqual(clients.body, [session.client]);
  assert.doesNotMatch(clients.text, new RegExp(session.token));
  assert.doesNotMatch(clients.text, /tokenHash|"auth"/);

  assert.equal(
    (
      await f.call(f.nodeToken, "POST", "/v1/browser/revoke", {
        body: { id: session.client.id },
      })
    ).status,
    403,
  );
  const revoked = await f.call(f.controllerToken, "POST", "/v1/browser/revoke", {
    body: { id: session.client.id },
  });
  assert.deepEqual(revoked.body, { ok: true, revoked: true });
  assert.equal(f.browserAuth.authenticate(session.token), undefined);
  assert.deepEqual(
    (
      await f.call(f.controllerToken, "POST", "/v1/browser/revoke", {
        body: { id: session.client.id },
      })
    ).body,
    { ok: true, revoked: false },
  );
});

test("browser management rejects invalid bounded requests and unavailable mutations", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const valid = {
    role: "tv_viewer",
    label: "Living room TV",
    grants: [],
  };
  const invalid = [
    await f.call(f.controllerToken, "POST", "/v1/browser/invitations", {
      body: { ...valid, admin: true },
    }),
    await f.call(f.controllerToken, "POST", "/v1/browser/invitations", {
      body: { ...valid, grants: [{ target: "living-room-mini", capabilities: ["app.open"] }] },
    }),
    await f.call(f.controllerToken, "POST", "/v1/browser/revoke", {
      body: { id: "browser-id", extra: true },
    }),
    await f.call(f.controllerToken, "POST", "/v1/browser/invitations", {
      rawBody: JSON.stringify({ value: "secret-should-not-escape".repeat(400) }),
    }),
    await f.call(f.controllerToken, "POST", "/v1/browser/invitations", {
      body: valid,
      contentType: "application/jsonx",
    }),
  ];
  assert.deepEqual(
    invalid.map((response) => response.status),
    [400, 400, 400, 400, 415],
  );
  for (const response of invalid) assert.doesNotMatch(response.text, /secret-should-not-escape/);

  const invitation = await f.browserAuth.invite({
    role: "tv_viewer",
    label: "TV to revoke",
    grants: [],
  });
  const session = await f.browserAuth.pair({ code: invitation.code });
  f.failBrowserSave();
  const failedRevoke = await f.call(f.controllerToken, "POST", "/v1/browser/revoke", {
    body: { id: session.client.id },
  });
  assert.equal(failedRevoke.status, 503);
  assert.deepEqual(failedRevoke.body, { error: "Browser management is unavailable." });
  assert.equal(f.persistedBrowserState().sessions.length, 1);
  assert.deepEqual((await f.call(f.controllerToken, "GET", "/v1/browser")).body, {
    status: "unavailable",
    reason: "auth_unavailable",
  });

  f.setCurrent({ status: "unavailable", reason: "assets_unavailable" });
  const unavailable = await f.call(f.controllerToken, "GET", "/v1/browser/clients");
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { error: "Browser management is unavailable." });
});
