import assert from "node:assert/strict";
import test from "node:test";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import { BrowserAuth } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { NativeLifeAuthority } from "../apps/server/src/native-life.ts";

const hostname = "ellie-life-gateway.local";
const token = (value: string) => value.repeat(64);

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
  options: { cookie?: string; origin?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname,
        servername: hostname,
        port,
        path,
        method: "GET",
        ca,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
        headers: {
          host: `${hostname}:${port}`,
          ...(options.cookie ? { cookie: `__Host-ellie_life=${options.cookie}` } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("error", reject);
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    request.setTimeout(15_000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test(
  "native Life gateway retains long authorized work, reports pressure, and keeps legacy body deadlines",
  { timeout: 35_000 },
  async () => {
    const tls = await generateBrowserTlsIdentity(hostname);
    const port = await freePort();
    const origin = `https://${hostname}:${port}`;
    const ids = ["native-invitation", "native-client"];
    const auth = new NativeAuth(NativeAuth.empty(), async () => {}, {
      id: () => ids.shift()!,
      token: () => token("a"),
    });
    const invitation = await auth.invite({
      label: "Fixture phone",
      grants: [{ target: "mac", capabilities: ["app.open"] }],
    });
    const client = await auth.pair(invitation.code, token("b"));
    const life = NativeLifeAuthority.memory(auth, ["owner"], { token: () => token("c") });
    await life.grant({ clientId: client.id, actorId: "owner", capability: "life.account" });
    const session = await life.session(`Bearer ${token("b")}`);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let pending = Promise.resolve<PromiseSettledResult<{ status: number; body: string }>[]>([]);
    const app = createBrowserServer({
      key: tls.leafKey,
      cert: tls.leafCert,
      origin,
      auth: new BrowserAuth(BrowserAuth.empty(), async () => {}),
      nativeAuth: auth,
      nativeLife: life,
      lifeApplication: {
        async handle(request, response) {
          if (request.url === "/api/life/slow")
            await new Promise((resolve) => setTimeout(resolve, 10_200));
          else if (request.url === "/api/life/held") await held;
          (response as ServerResponse).writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
          return true;
        },
      },
    });
    await new Promise<void>((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(port, "127.0.0.1", resolve);
    });
    try {
      assert.equal((await call(port, tls.rootCert, "/api/life/slow")).status, 403);
      assert.equal(
        (
          await call(port, tls.rootCert, "/api/life/slow", {
            cookie: session.sessionToken,
            origin: "https://foreign.invalid",
          })
        ).status,
        403,
      );
      assert.equal(
        (await call(port, tls.rootCert, "/api/life/slow", { cookie: session.sessionToken })).status,
        200,
      );

      const active = Array.from({ length: 4 }, () =>
        call(port, tls.rootCert, "/api/life/held", { cookie: session.sessionToken }),
      );
      pending = Promise.allSettled(active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(
        (await call(port, tls.rootCert, "/api/life/held", { cookie: session.sessionToken })).status,
        429,
      );
      release?.();
      assert.ok((await Promise.all(active)).every((response) => response.status === 200));
      assert.equal(
        (await call(port, tls.rootCert, "/api/life/ready", { cookie: session.sessionToken }))
          .status,
        200,
      );

      const closedAt = await new Promise<number>((resolve, reject) => {
        const started = Date.now();
        const socket = tlsConnect({
          host: "127.0.0.1",
          port,
          servername: hostname,
          ca: tls.rootCert,
        });
        const interval = setInterval(() => socket.write("x"), 1_000);
        const deadline = setTimeout(() => {
          clearInterval(interval);
          socket.destroy();
          reject(new Error("legacy request body deadline did not close the socket"));
        }, 12_000);
        socket.once("secureConnect", () => {
          socket.write(
            `POST /native/v1/logout HTTP/1.1\r\nHost: ${hostname}:${port}\r\nAuthorization: Bearer ${token("b")}\r\nX-Ellie-Version: 1\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`,
          );
        });
        socket.once("error", () => {});
        socket.once("close", () => {
          clearInterval(interval);
          clearTimeout(deadline);
          resolve(Date.now() - started);
        });
      });
      assert.ok(closedAt >= 9_500 && closedAt < 11_500, `closed after ${closedAt}ms`);
    } finally {
      release?.();
      await pending;
      app.shutdown();
      await life.close();
      await auth.close();
    }
  },
);
