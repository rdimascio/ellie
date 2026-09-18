import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { createIOSGoogleLifeFixture } from "../scripts/ios-google-life-fixture.mjs";

const host = "ellie-ios-quiet-fixture.local";
const token = "9a".repeat(32);

async function freePort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}

function call(
  port: number,
  ca: string,
  path: string,
  bearer?: string,
  cookie?: string,
  body?: unknown,
) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const request = httpsRequest(
      {
        hostname: host,
        servername: host,
        port,
        path,
        method: bearer || encoded ? "POST" : "GET",
        ca,
        lookup: (_name, options, callback) =>
          options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
        headers: {
          host: `${host}:${port}`,
          ...(bearer
            ? {
                authorization: `Bearer ${bearer}`,
                "x-ellie-version": "1",
                "content-type": "application/json",
                "content-length": "2",
              }
            : {}),
          ...(cookie ? { cookie: `__Host-ellie_life=${cookie}` } : {}),
          ...(encoded
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(encoded)),
                origin: `https://${host}:${port}`,
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
    request.setTimeout(6_000, () => request.destroy(new Error("Quiet fixture request timed out")));
    request.once("error", reject);
    request.end(bearer ? "{}" : encoded);
  });
}

test(
  "pinned native Quiet fixture serves same-actor durable activity and verified finding",
  {
    timeout: 20_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ellie-ios-quiet-life-"));
    const identities = ["quiet-invite", "quiet-client"];
    const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
      id: () => identities.shift()!,
      token: () => "a".repeat(64),
    });
    let fixture: Awaited<ReturnType<typeof createIOSGoogleLifeFixture>> | undefined;
    let browser: ReturnType<typeof createBrowserServer> | undefined;
    try {
      const invitation = await auth.invite({
        label: "Quiet allowed",
        grants: [{ target: "quiet-fixture-no-node", capabilities: ["app.open"] }],
      });
      const client = await auth.pair(invitation.code, token);
      fixture = await createIOSGoogleLifeFixture({
        directory,
        nativeAuth: auth,
        grantedClientIds: [client.id],
        quiet: true,
      });
      const quiet = fixture.quiet;
      assert.ok(quiet);
      const tls = await generateBrowserTlsIdentity(host);
      const port = await freePort();
      browser = createBrowserServer({
        key: tls.leafKey,
        cert: tls.leafCert,
        origin: `https://${host}:${port}`,
        auth: new BrowserAuth(BrowserAuth.empty(), async () => {}),
        nativeAuth: auth,
        nativeLife: fixture.nativeLife,
        lifeApplication: fixture.lifeApplication,
      });
      await new Promise<void>((resolve, reject) => {
        browser!.server.once("error", reject);
        browser!.server.listen(port, "127.0.0.1", resolve);
      });
      const admitted = await call(port, tls.rootCert, "/native/v1/life/session", token);
      assert.equal(admitted.status, 200);
      const cookie = admitted.json.sessionToken as string;
      assert.match(cookie, /^[0-9a-f]{64}$/);
      const page = await call(
        port,
        tls.rootCert,
        "/api/life/native/sessions?limit=3",
        undefined,
        cookie,
      );
      assert.equal(page.status, 200);
      assert.ok(
        page.json.sessions.some((session: { id: string }) => session.id === quiet.sessionID),
      );
      const detail = await call(
        port,
        tls.rootCert,
        `/api/life/native/sessions/${quiet.sessionID}`,
        undefined,
        cookie,
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.json.originalRequest, "Review the family albums 👩‍👩‍👧‍👧");
      assert.equal(detail.json.activity[0].id, quiet.taskID);
      assert.equal(detail.json.activity[0].state, "succeeded");
      assert.equal(detail.json.activity[0].finding.summary, "Three albums verified.");
      assert.deepEqual(
        detail.json.activity[0].finding.citations.map((entry: { title: string }) => entry.title),
        ["Family album register 👩‍👩‍👧‍👧"],
      );
      assert.equal(quiet.control.nativeChatPosts(), 0);
      const state = await call(
        port,
        tls.rootCert,
        "/api/life/native/chat/state",
        undefined,
        cookie,
      );
      assert.equal(state.status, 200);
      assert.equal(state.json.available, true);
      quiet.control.armChatResponse();
      const requestId = "native_5ee29e71-b495-4fc8-8eb0-a38ad6fbe264";
      const sent = call(port, tls.rootCert, "/api/life/native/chat", undefined, cookie, {
        message: "What is the family plan?",
        requestId,
        chatEpoch: state.json.chatEpoch,
      });
      const deadline = Date.now() + 5_000;
      while (quiet.control.chatResponseHeld() !== 1 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(
        quiet.control.chatResponseHeld(),
        1,
        "The server committed a durable turn before the synthetic reply hold",
      );
      const reconciled = await call(
        port,
        tls.rootCert,
        `/api/life/native/chat/requests/${requestId}`,
        undefined,
        cookie,
      );
      assert.equal(reconciled.status, 200);
      assert.equal(reconciled.json.status, "completed");
      quiet.control.releaseChatResponse();
      assert.deepEqual((await sent).json, reconciled.json);
      assert.equal(quiet.control.nativeChatPosts(), 1);
    } finally {
      browser?.shutdown();
      await fixture?.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
