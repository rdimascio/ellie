import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifeApplication } from "../apps/life/src/main.ts";
import { HostCredentialVault } from "../packages/life-connectors/src/vault.ts";

test("application enforces connector session/origin and resets an unfinished OAuth connection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-connected-app-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createLifeApplication({
    stateDir: directory,
    port: 0,
    userId: "fixture",
    googleOAuth: { clientId: "synthetic-desktop-client" },
    openAuthorizationUrl: async () => false,
  });
  let state = "";
  try {
    const ready = await app.listen();
    assert.equal((await fetch(`${ready.url}/api/connections`)).status, 401);
    const login = await fetch(`${ready.url}/api/life/session`, {
      method: "POST",
      headers: { origin: ready.url, "content-type": "application/json" },
      body: JSON.stringify({ token: decodeURIComponent(ready.launchUrl.split("#token=")[1]!) }),
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!,
      headers = { cookie, origin: ready.url, "content-type": "application/json" };
    const catalog = (await (await fetch(`${ready.url}/api/connections`, { headers })).json()) as {
      providers: { id: string; configured: boolean }[];
    };
    assert.equal(catalog.providers.find((p) => p.id === "google-calendar")?.configured, true);
    assert.equal(catalog.providers.find((p) => p.id === "plaid")?.configured, false);
    assert.equal(
      (
        await fetch(`${ready.url}/api/connections/start`, {
          method: "POST",
          headers: { ...headers, origin: "https://example.com" },
          body: JSON.stringify({ provider: "gmail", mode: "prepare" }),
        })
      ).status,
      403,
    );
    const started = await fetch(`${ready.url}/api/connections/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "google-calendar", mode: "prepare" }),
    });
    assert.equal(started.status, 200);
    const authorization = new URL(
      ((await started.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    assert.equal(authorization.origin, "https://accounts.google.com");
    assert.equal(
      authorization.searchParams.get("redirect_uri"),
      `${ready.url}/api/connections/callback`,
    );
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    state = authorization.searchParams.get("state")!;
    const review = (await (
      await fetch(`${ready.url}/api/life/personal-data/review`, { headers })
    ).json()) as {
      reviewToken: string;
      counts: { connections: number };
      generations: { connectors: number };
    };
    assert.equal(review.counts.connections, 1);
    const exported = await fetch(
      `${ready.url}/api/life/personal-data/export?store=connectors&reviewToken=${review.reviewToken}&limit=1`,
      { headers },
    );
    assert.equal(exported.status, 200);
    const contents = await exported.text();
    assert.ok(!contents.includes(state));
    assert.ok(!contents.includes("verifier"));
    assert.ok(!contents.includes("accessToken"));
    const reset = await fetch(`${ready.url}/api/life/personal-data/reset`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    assert.equal(reset.status, 200, await reset.clone().text());
    assert.equal(((await reset.json()) as { state: string }).state, "completed");
    const after = (await (await fetch(`${ready.url}/api/connections`, { headers })).json()) as {
      connections: unknown[];
    };
    assert.deepEqual(after.connections, []);
    // Reset state fails before token exchange, even without the Strict session cookie.
    assert.equal(
      (
        await fetch(
          `${ready.url}/api/connections/callback?state=${state}&code=synthetic-never-exchanged`,
          { redirect: "manual" },
        )
      ).status,
      400,
    );
    const deniedStart = await fetch(`${ready.url}/api/connections/start`, {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "gmail", mode: "observe" }),
    });
    const deniedUrl = new URL(
      ((await deniedStart.json()) as { authorizationUrl: string }).authorizationUrl,
    );
    const denied = await fetch(
      `${ready.url}/api/connections/callback?state=${deniedUrl.searchParams.get("state")}&error=access_denied`,
      { redirect: "manual" },
    );
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.get("location"), "/connections/cancelled");
    const returned = await fetch(`${ready.url}/connections/cancelled`);
    assert.equal(returned.status, 200);
    assert.match(await returned.text(), /Connection canceled/);
    const failed = (await (await fetch(`${ready.url}/api/connections`, { headers })).json()) as {
      connections: { state: string }[];
    };
    assert.deepEqual(
      failed.connections.map((c) => c.state),
      ["revoked"],
    );
  } finally {
    await app.close();
  }
  try {
    const vault = new HostCredentialVault(join(directory, "credentials"));
    const key = createHash("sha256").update(state).digest("hex");
    assert.equal(vault.get(`link-${key}`), undefined);
    assert.equal(vault.get(`oauth-state:${key}`), undefined);
    vault.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("embedded application opens host account settings only with configured Google OAuth", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-owner-settings-"));
  let captured = "";
  const configured = await createLifeApplication({
    stateDir: join(root, "configured"),
    userId: "fixture",
    googleOAuth: { clientId: "synthetic-desktop-client" },
    openOwnerSettingsUrl: async (url) => {
      captured = url;
      return true;
    },
  });
  const unconfigured = await createLifeApplication({
    stateDir: join(root, "unconfigured"),
    userId: "fixture",
    openOwnerSettingsUrl: async () => {
      throw new Error("Unconfigured Life must not invoke the browser opener.");
    },
  });
  try {
    await configured.prepareEmbedded();
    await unconfigured.prepareEmbedded();
    assert.equal(await unconfigured.openOwnerSettings(), "unconfigured");
    assert.equal(await configured.openOwnerSettings(), "opened");
    const target = new URL(captured);
    assert.equal(target.hostname, "127.0.0.1");
    assert.equal(target.search, "?view=settings&section=connections");
    assert.match(target.hash, /^#token=[A-Za-z0-9_-]{43}$/);
  } finally {
    await Promise.all([configured.close(), unconfigured.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("application shutdown makes an in-flight owner opener report unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-owner-settings-close-"));
  let release!: (opened: boolean) => void, signalStarted!: () => void;
  const openerStarted = new Promise<void>((resolve) => (signalStarted = resolve)),
    application = await createLifeApplication({
      stateDir: root,
      userId: "fixture",
      googleOAuth: { clientId: "synthetic-desktop-client" },
      openOwnerSettingsUrl: async () => {
        signalStarted();
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
  try {
    await application.prepareEmbedded();
    const opening = application.openOwnerSettings();
    await openerStarted;
    let closingSettled = false;
    const closing = application.close().then(() => {
      closingSettled = true;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(closingSettled, false);
    release(true);
    await closing;
    assert.equal(await opening, "unavailable");
    assert.equal(await application.openOwnerSettings(), "unavailable");
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("application opener failure revokes a session exchanged before it settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-owner-settings-failure-"));
  let release!: (opened: boolean) => void,
    openedUrl = "",
    signalStarted!: () => void;
  const openerStarted = new Promise<void>((resolve) => (signalStarted = resolve)),
    application = await createLifeApplication({
      stateDir: root,
      userId: "fixture",
      googleOAuth: { clientId: "synthetic-desktop-client" },
      openOwnerSettingsUrl: async (url) => {
        openedUrl = url;
        signalStarted();
        return new Promise<boolean>((resolve) => (release = resolve));
      },
    });
  try {
    await application.prepareEmbedded();
    const opening = application.openOwnerSettings();
    await openerStarted;
    const target = new URL(openedUrl),
      token = new URLSearchParams(target.hash.slice(1)).get("token")!,
      response = await fetch(`${target.origin}/api/life/session`, {
        method: "POST",
        headers: { origin: target.origin, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
    assert.equal(response.status, 204);
    assert.equal(
      (await fetch(`${target.origin}/api/life/bootstrap`, { headers: { cookie } })).status,
      200,
    );
    release(false);
    assert.equal(await opening, "unavailable");
    assert.equal(
      (await fetch(`${target.origin}/api/life/bootstrap`, { headers: { cookie } })).status,
      401,
    );
  } finally {
    await application.close();
    await rm(root, { recursive: true, force: true });
  }
});
