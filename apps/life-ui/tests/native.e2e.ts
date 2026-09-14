import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect, type BrowserContext } from "@playwright/test";
import { generateBrowserTlsIdentity } from "../../cli/src/certificate.ts";
import { createEmbeddedLifeApplication } from "../../life/src/embedded.ts";
import { createBrowserServer } from "../../server/src/browser-server.ts";
import { NativeAuth } from "../../server/src/native-auth.ts";
import { NATIVE_LIFE_CAPABILITY, NativeLifeAuthority } from "../../server/src/native-life.ts";

const hostname = "ellie-native-fixture.local";
const actorId = "native-e2e-user";
const token = (value: string) => value.repeat(64);
const artifactDir =
  process.env.ELLIE_E2E_ARTIFACT_DIR ?? join(tmpdir(), "ellie-native-e2e-artifacts");
await mkdir(artifactDir, { recursive: true });

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function request(
  port: number,
  ca: string,
  path: string,
  options: { authorization?: string; body?: unknown } = {},
) {
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return new Promise<{ status: number; body: Record<string, unknown> }>(
    (resolveRequest, reject) => {
      const outgoing = httpsRequest(
        {
          hostname,
          servername: hostname,
          port,
          path,
          method: options.body === undefined ? "GET" : "POST",
          ca,
          lookup: (_name, lookupOptions, callback) =>
            lookupOptions.all
              ? callback(null, [{ address: "127.0.0.1", family: 4 }])
              : callback(null, "127.0.0.1", 4),
          headers: {
            host: `${hostname}:${port}`,
            "x-ellie-version": "1",
            ...(body ? { "content-type": "application/json", "content-length": body.length } : {}),
            ...(options.authorization ? { authorization: options.authorization } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("error", reject);
          response.once("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolveRequest({
              status: response.statusCode ?? 0,
              body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
            });
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    },
  );
}

async function pair(
  auth: NativeAuth,
  port: number,
  ca: string,
  label: string,
  sessionToken: string,
) {
  const invitation = await auth.invite({
    label,
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const paired = await request(port, ca, "/native/v1/pair", {
    body: { invitation: invitation.code, token: sessionToken },
  });
  assert.equal(paired.status, 200);
  return (paired.body.client as { id: string }).id;
}

async function installLifeCookie(
  context: BrowserContext,
  port: number,
  ca: string,
  bearer: string,
) {
  const response = await request(port, ca, "/native/v1/life/session", {
    authorization: `Bearer ${bearer}`,
    body: {},
  });
  assert.equal(response.status, 200);
  const sessionToken = String(response.body.sessionToken);
  assert.match(sessionToken, /^[a-f0-9]{64}$/);
  await context.addCookies([
    {
      name: "__Host-ellie_life",
      value: sessionToken,
      domain: hostname,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      expires: Number(response.body.expiresAt) / 1000,
    },
  ]);
  return sessionToken;
}

const root = await mkdtemp(join(tmpdir(), "ellie-native-life-e2e-"));
await chmod(root, 0o700);
const lifeState = join(root, "life");
await mkdir(lifeState, { mode: 0o700 });
const port = await freePort();
const origin = `https://${hostname}:${port}`;
const tls = await generateBrowserTlsIdentity(hostname);
const nativeAuth = new NativeAuth(NativeAuth.empty(), async () => {});
const nativeLife = NativeLifeAuthority.memory(nativeAuth, [actorId]);
let embedded = await createEmbeddedLifeApplication({
  stateDir: lifeState,
  assetsDir: resolve("apps/life-ui/dist"),
  userId: actorId,
});
let gateway = createBrowserServer({
  key: tls.leafKey,
  cert: tls.leafCert,
  origin,
  auth: undefined as never,
  nativeAuth,
  nativeLife,
  lifeApplication: embedded,
});
await new Promise<void>((resolveListen, reject) => {
  gateway.server.once("error", reject);
  gateway.server.listen(port, "127.0.0.1", resolveListen);
});
const browser = await chromium.launch({
  headless: true,
  args: [`--host-resolver-rules=MAP ${hostname} 127.0.0.1`],
});

try {
  const macToken = token("b"),
    phoneToken = token("c"),
    deniedToken = token("d");
  const macId = await pair(nativeAuth, port, tls.rootCert, "MacBook", macToken);
  const phoneId = await pair(nativeAuth, port, tls.rootCert, "Phone", phoneToken);
  await pair(nativeAuth, port, tls.rootCert, "UngRanted", deniedToken);
  await nativeLife.grant({ clientId: macId, actorId, capability: NATIVE_LIFE_CAPABILITY });
  await nativeLife.grant({ clientId: phoneId, actorId, capability: NATIVE_LIFE_CAPABILITY });
  assert.equal(
    (
      await request(port, tls.rootCert, "/native/v1/life/session", {
        authorization: `Bearer ${deniedToken}`,
        body: {},
      })
    ).status,
    403,
  );

  const mac = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    timezoneId: "America/Los_Angeles",
    ignoreHTTPSErrors: true,
  });
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
    ignoreHTTPSErrors: true,
  });
  const macSecret = await installLifeCookie(mac, port, tls.rootCert, macToken);
  await installLifeCookie(phone, port, tls.rootCert, phoneToken);
  assert.deepEqual(
    await request(port, tls.rootCert, "/native/v1/life/session", {
      authorization: `Bearer ${macToken}`,
    }),
    { status: 200, body: { allowed: true } },
  );
  const macPage = await mac.newPage();
  await macPage.goto(`${origin}/life/?conversation=native-fixture`);
  await expect(macPage.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(macPage.getByRole("button", { name: "Talk to Ellie", exact: true })).toBeVisible();
  assert.equal(await macPage.evaluate(() => document.cookie.includes("ellie_life")), false);
  assert.equal((await macPage.content()).includes(macSecret), false);
  await macPage.getByRole("button", { name: "Talk to Ellie", exact: true }).click();
  await macPage
    .getByLabel("Message Ellie")
    .fill("Create a plan called Native trip: Pack charger; Download tickets; Check the weather");
  await macPage.getByLabel("Send message").click();
  await expect(macPage.getByText(/Created plan .Native trip. with 3 steps/i)).toBeVisible();
  await macPage.getByRole("button", { name: "Close conversation", exact: true }).click();
  await macPage.screenshot({
    animations: "disabled",
    path: join(artifactDir, "native-life-desktop.png"),
    fullPage: false,
  });
  await macPage.getByRole("button", { name: /Add or make an app/ }).click();
  await macPage
    .getByPlaceholder(/family board/)
    .fill("Build an arcade game with a persistent high score");
  await macPage.getByRole("button", { name: "Build it" }).click();
  await expect(macPage.getByText("Star arcade", { exact: true })).toBeVisible();
  await macPage
    .locator("article")
    .filter({ hasText: "Star arcade" })
    .getByRole("button", { name: "Open" })
    .click();
  const arcade = macPage
    .frameLocator('iframe[title="Star arcade"]')
    .frameLocator('iframe[title="Plugin"]');
  await arcade.getByRole("button", { name: "Let's play" }).click();
  await arcade.locator("canvas").press("Space");
  await arcade.locator("#score").evaluate(
    (score) =>
      new Promise<void>((resolveScore, rejectScore) => {
        const deadline = performance.now() + 2_000;
        const check = () => {
          if (Number(score.textContent) > 0) resolveScore();
          else if (performance.now() > deadline) rejectScore(new Error("Arcade did not score"));
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
  await arcade.locator("body").evaluate(async () => {
    await (
      globalThis as unknown as {
        call(method: string, key: string, value: unknown): Promise<unknown>;
      }
    ).call("storage.set", "highScore", 37);
  });
  await macPage.screenshot({
    animations: "disabled",
    path: join(artifactDir, "native-life-arcade.png"),
    fullPage: false,
  });
  await macPage.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    macPage.locator("article").filter({ hasText: "Star arcade" }).getByText("37", { exact: true }),
  ).toBeVisible();

  const phonePage = await phone.newPage();
  await phonePage.goto(`${origin}/life/`);
  await phonePage.getByRole("button", { name: "Talk to Ellie", exact: true }).click();
  await phonePage.getByLabel("Message Ellie").fill("Show plan Native trip");
  await phonePage.getByLabel("Send message").click();
  await expect(phonePage.getByText(/Pack charger/i)).toBeVisible();
  await phonePage.getByLabel("Message Ellie").fill("Complete step 1 of plan Native trip");
  await phonePage.getByLabel("Send message").click();
  await expect(phonePage.getByText(/Completed step 1/i)).toBeVisible();
  await phonePage.getByRole("button", { name: "Close conversation", exact: true }).click();
  await phonePage.getByRole("button", { name: "Settings", exact: true }).first().click();
  await expect(
    phonePage.getByRole("heading", { name: "Connected accounts", exact: true }),
  ).toBeVisible();
  await expect(phonePage.getByRole("button", { name: "Setup required" }).first()).toBeDisabled();
  await expect(
    phonePage.getByText(/Connect accounts directly on the Mac hosting Ellie/i).first(),
  ).toBeVisible();
  await phonePage.screenshot({
    animations: "disabled",
    path: join(artifactDir, "native-life-mobile.png"),
    fullPage: false,
  });

  await nativeLife.revoke(macId);
  assert.equal(
    (
      await request(port, tls.rootCert, "/native/v1/life/session", {
        authorization: `Bearer ${macToken}`,
      })
    ).status,
    403,
  );
  assert.equal(
    await macPage.evaluate(() => fetch("/api/life/bootstrap").then((r) => r.status)),
    401,
  );
  assert.equal(
    await phonePage.evaluate(() => fetch("/api/life/bootstrap").then((r) => r.status)),
    200,
  );

  await mac.close();
  await phone.close();
  gateway.shutdown();
  await embedded.close();
  embedded = await createEmbeddedLifeApplication({
    stateDir: lifeState,
    assetsDir: resolve("apps/life-ui/dist"),
    userId: actorId,
  });
  gateway = createBrowserServer({
    key: tls.leafKey,
    cert: tls.leafCert,
    origin,
    auth: undefined as never,
    nativeAuth,
    nativeLife,
    lifeApplication: embedded,
  });
  await new Promise<void>((resolveListen, reject) => {
    gateway.server.once("error", reject);
    gateway.server.listen(port, "127.0.0.1", resolveListen);
  });
  const restored = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
    ignoreHTTPSErrors: true,
  });
  await installLifeCookie(restored, port, tls.rootCert, phoneToken);
  const restoredPage = await restored.newPage();
  await restoredPage.goto(`${origin}/life/`);
  await restoredPage.getByRole("button", { name: "Talk to Ellie", exact: true }).click();
  await restoredPage.getByLabel("Message Ellie").fill("Show plan Native trip");
  await restoredPage.getByLabel("Send message").click();
  await expect(restoredPage.getByText(/Pack charger/i)).toBeVisible();
  await expect(restoredPage.getByText(/Plan .Native trip. \(1\/3 complete\)/i)).toBeVisible();
  await restored.close();
  process.stdout.write(`Native Life E2E artifacts: ${artifactDir}\n`);
} finally {
  await browser.close();
  gateway.shutdown();
  await nativeLife.close();
  await nativeAuth.close();
  await embedded.close();
  await rm(root, { recursive: true, force: true });
}
