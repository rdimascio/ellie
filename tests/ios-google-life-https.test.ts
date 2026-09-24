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
  options: { token?: string; cookie?: string; body?: unknown } = {},
) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = httpsRequest(
      {
        hostname,
        servername: hostname,
        port,
        path,
        method: options.token || body ? "POST" : "GET",
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
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
                origin: `https://${hostname}:${port}`,
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
    request.end(options.token ? "{}" : body);
  });
}

test(
  "production pinned-Life gateway serves selected Google reads and one durable native review",
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
      assert.equal(fixture.control.chatEvidence().plans, 0);
      assert.equal(fixture.control.chatEvidence().conversations, 0);
      assert.equal(fixture.control.chatEvidence().records, 0);
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
      const chatState = await call(port, tls.rootCert, "/api/life/native/chat/state", { cookie });
      assert.equal(chatState.status, 200);
      assert.equal(chatState.json.available, true);
      const requestId = "native_ae2bbc9c-57c0-4a8a-97fc-e6ba10179bc2";
      const sent = await call(port, tls.rootCert, "/api/life/native/chat", {
        cookie,
        body: {
          message: "What is the family plan?",
          requestId,
          chatEpoch: chatState.json.chatEpoch,
        },
      });
      assert.equal(sent.status, 200);
      assert.equal(sent.json.reply, "Family 👩‍👩‍👧‍👧\r\n日本語 read-only answer.");
      const status = await call(port, tls.rootCert, `/api/life/native/chat/requests/${requestId}`, {
        cookie,
      });
      assert.deepEqual(status.json, sent.json);
      assert.equal(fixture.control.chatEvidence().plans, 1);
      assert.equal(fixture.control.chatEvidence().conversations, 1);
      assert.equal(fixture.control.chatEvidence().records, 0);
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
      fixture.control.armCalendarChangeAfterNextList();
      const staleListing = await call(port, tls.rootCert, "/api/connections", { cookie });
      assert.equal(
        staleListing.json.connections.find(
          (connection: { id: string }) => connection.id === fixture!.connectionIds.calendar,
        ).selectedCalendarId,
        "selected@example.test",
      );
      const changedAgenda = await call(
        port,
        tls.rootCert,
        `/api/connections/${fixture.connectionIds.calendar}/agenda?timeZone=America%2FLos_Angeles`,
        { cookie },
      );
      assert.equal(changedAgenda.status, 200);
      assert.equal(changedAgenda.json.selectedCalendarId, "primary");
      assert.equal(
        changedAgenda.json.events.some(
          (event: { title: string }) => event.title === "Selected family visit 👩‍👩‍👧‍👦",
        ),
        false,
        "the changed-calendar response must not retain the prior calendar's event",
      );
      assert.equal(fixture.control.calendarChanges(), 1);
      const restoredListing = await call(port, tls.rootCert, "/api/connections", { cookie });
      assert.equal(
        restoredListing.json.connections.find(
          (connection: { id: string }) => connection.id === fixture!.connectionIds.calendar,
        ).selectedCalendarId,
        "selected@example.test",
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
      const messagePath = `/api/connections/${fixture.connectionIds.gmail}/messages/unicode_message`;
      const unauthenticatedDraft = await call(port, tls.rootCert, `${messagePath}/draft`, {
        body: { to: ["recipient@example.test"], text: "Synthetic draft" },
      });
      assert.equal(unauthenticatedDraft.status, 403);
      const rejectedDraft = await call(port, tls.rootCert, `${messagePath}/draft`, {
        cookie,
        body: { to: ["recipient@example.test"], text: "Synthetic draft" },
      });
      assert.equal(rejectedDraft.status, 404);
      const rejectedSend = await call(port, tls.rootCert, `${messagePath}/send`, {
        cookie,
        body: { confirmed: true },
      });
      assert.equal(rejectedSend.status, 404);
      assert.deepEqual(
        fixture.control.bodyReads(),
        {},
        "unsupported draft/send requests must not fetch or act on a message",
      );
      const detail = await call(port, tls.rootCert, messagePath, { cookie });
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
