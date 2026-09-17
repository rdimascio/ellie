import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { createIOSGoogleLifeFixture } from "../scripts/ios-google-life-fixture.mjs";

const hostname = "ellie-ios-google-fixture.local";
const bearer = (value: string) => value.repeat(64);

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function call(
  port: number,
  ca: string,
  path: string,
  options: { token?: string; cookie?: string } = {},
) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname,
        servername: hostname,
        port,
        path,
        method: options.token ? "POST" : "GET",
        ca,
        lookup: (_name, opts, callback) =>
          opts.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
        headers: {
          host: `${hostname}:${port}`,
          ...(options.cookie ? { cookie: `__Host-ellie_life=${options.cookie}` } : {}),
          ...(options.token
            ? {
                authorization: `Bearer ${options.token}`,
                "x-ellie-version": "1",
                "content-type": "application/json",
                "content-length": "2",
              }
            : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(8_000, () => request.destroy(new Error("fixture request timed out")));
    request.once("error", reject);
    request.end(options.token ? "{}" : undefined);
  });
}

test(
  "production pinned-Life gateway exposes selected calendar and only explicitly read Gmail body",
  { timeout: 25_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ellie-ios-google-life-"));
    const ids = ["invite-allowed", "google-allowed", "invite-denied", "google-denied"];
    const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
      id: () => ids.shift()!,
      token: () => bearer("a"),
    });
    let fixture: Awaited<ReturnType<typeof createIOSGoogleLifeFixture>> | undefined;
    let browser: ReturnType<typeof createBrowserServer> | undefined;
    try {
      const first = await auth.invite({
        label: "Google allowed",
        grants: [{ target: "fixture", capabilities: ["app.open"] }],
      });
      const allowed = await auth.pair(first.code, bearer("b"));
      const second = await auth.invite({
        label: "Google denied",
        grants: [{ target: "fixture", capabilities: ["app.open"] }],
      });
      await auth.pair(second.code, bearer("c"));
      fixture = await createIOSGoogleLifeFixture({
        directory,
        nativeAuth: auth,
        grantedClientIds: [allowed.id],
      });
      assert.deepEqual(fixture.control.bodyReads(), {});
      const tls = await generateBrowserTlsIdentity(hostname);
      const port = await freePort();
      browser = createBrowserServer({
        key: tls.leafKey,
        cert: tls.leafCert,
        origin: `https://${hostname}:${port}`,
        auth: new BrowserAuth(BrowserAuth.empty(), async () => {}),
        nativeAuth: auth,
        nativeLife: fixture.nativeLife,
        lifeApplication: fixture.lifeApplication,
      });
      await new Promise<void>((resolve, reject) => {
        browser!.server.once("error", reject);
        browser!.server.listen(port, "127.0.0.1", resolve);
      });
      const denied = await call(port, tls.rootCert, "/native/v1/life/session", {
        token: bearer("c"),
      });
      assert.equal(denied.status, 403);
      const opened = await call(port, tls.rootCert, "/native/v1/life/session", {
        token: bearer("b"),
      });
      assert.equal(opened.status, 200);
      const cookie = opened.json.sessionToken as string;
      assert.match(cookie, /^[a-f0-9]{64}$/);
      const listing = await call(port, tls.rootCert, "/api/connections", { cookie });
      assert.equal(listing.status, 200);
      assert.equal(listing.json.connections.length, 2);
      const agenda = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.calendar}/agenda?timeZone=America%2FLos_Angeles`,
        { cookie },
      );
      assert.equal(agenda.status, 200);
      assert.equal(agenda.json.selectedCalendarId, "selected@example.test");
      assert.deepEqual(
        agenda.json.events.map((event: { title: string }) => event.title),
        ["Selected family visit 👩‍👩‍👧‍👦"],
      );
      const preview = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.gmail}/preview`,
        { cookie },
      );
      assert.equal(preview.status, 200);
      assert.equal(preview.json.items.length, 4);
      assert.deepEqual(fixture.control.bodyReads(), {}, "list and preview must not fetch bodies");
      const detail = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.gmail}/messages/unicode_message`,
        { cookie },
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.json.text, "Line one\r\nLine two 👩‍👩‍👧‍👦\n");
      const partial = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.gmail}/messages/truncated_message`,
        { cookie },
      );
      assert.equal(partial.status, 200);
      assert.equal(partial.json.status, "truncated");
      assert.equal(partial.json.additionalPartsOmitted, true);
      const unavailable = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.gmail}/messages/unavailable_message`,
        { cookie },
      );
      assert.equal(unavailable.status, 200);
      assert.equal(unavailable.json.status, "unavailable");
      assert.equal(unavailable.json.text, undefined);
      assert.deepEqual(fixture.control.bodyReads(), {
        unicode_message: 1,
        truncated_message: 1,
        unavailable_message: 1,
      });
      const held = call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.gmail}/messages/held_message`,
        { cookie },
      );
      const startedDeadline = Date.now() + 5_000;
      while (fixture.control.heldReadStarted() < 1 && Date.now() < startedDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(fixture.control.heldReadStarted(), 1);
      assert.equal(fixture.control.heldHandled(), 0);
      fixture.control.releaseHeld();
      assert.equal((await held).status, 200);
      assert.equal(fixture.control.heldReadCompleted(), 1);
      assert.equal(fixture.control.heldHandled(), 1);
      fixture.control.failNextServerCloseForTest();
      await assert.rejects(fixture.close(), /cleanup is uncertain/);
      assert.equal(
        (await call(port, tls.rootCert, "/api/connections", { cookie })).status,
        200,
        "failed HTTPS close must retain dependent stores and authority",
      );
      await fixture.nativeLife.revoke(allowed.id);
      assert.equal((await call(port, tls.rootCert, "/api/connections", { cookie })).status, 401);
    } finally {
      browser?.shutdown();
      await fixture?.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
