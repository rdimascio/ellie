import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { BROWSER_SESSION_COOKIE, BrowserAuth } from "../apps/server/src/browser-auth.ts";
import type { BrowserAuthState, BrowserInvitationSpec } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";

const run = promisify(execFile);
const phone: BrowserInvitationSpec = {
  role: "phone_controller",
  label: "Kitchen phone",
  grants: [{ target: "living-room-mini", capabilities: ["app.open", "window.place"] }],
};
const tv: BrowserInvitationSpec = { role: "tv_viewer", label: "Living room TV", grants: [] };

async function syntheticCertificate(): Promise<{ key: string; cert: string; ca: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ellie-browser-tls-"));
  const openssl = process.platform === "darwin" ? "/usr/bin/openssl" : "openssl";
  try {
    const caConfig = join(dir, "ca.cnf");
    const leafConfig = join(dir, "leaf.cnf");
    const caKey = join(dir, "ca-key.pem");
    const caCert = join(dir, "ca.pem");
    const leafKey = join(dir, "leaf-key.pem");
    const leafRequest = join(dir, "leaf.csr");
    const leafCert = join(dir, "leaf.pem");
    await writeFile(
      caConfig,
      [
        "[req]",
        "distinguished_name=dn",
        "x509_extensions=v3_ca",
        "prompt=no",
        "[dn]",
        "CN=Ellie Browser Test Root",
        "[v3_ca]",
        "basicConstraints=critical,CA:true",
        "keyUsage=critical,keyCertSign,cRLSign",
        "subjectKeyIdentifier=hash",
        "",
      ].join("\n"),
    );
    await writeFile(
      leafConfig,
      [
        "[req]",
        "distinguished_name=dn",
        "prompt=no",
        "[dn]",
        "CN=localhost",
        "[v3_leaf]",
        "basicConstraints=critical,CA:false",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        "subjectAltName=DNS:localhost",
        "",
      ].join("\n"),
    );
    const quiet = { timeout: 30_000, maxBuffer: 64 * 1024 };
    await run(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        caKey,
        "-out",
        caCert,
        "-days",
        "2",
        "-sha256",
        "-config",
        caConfig,
      ],
      quiet,
    );
    await run(
      openssl,
      [
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        leafKey,
        "-out",
        leafRequest,
        "-sha256",
        "-config",
        leafConfig,
      ],
      quiet,
    );
    await run(
      openssl,
      [
        "x509",
        "-req",
        "-in",
        leafRequest,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-out",
        leafCert,
        "-days",
        "2",
        "-sha256",
        "-extfile",
        leafConfig,
        "-extensions",
        "v3_leaf",
      ],
      quiet,
    );
    const [key, cert, ca] = await Promise.all([
      readFile(leafKey, "utf8"),
      readFile(leafCert, "utf8"),
      readFile(caCert, "utf8"),
    ]);
    return { key, cert, ca };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const certificate = syntheticCertificate();

async function availablePort(): Promise<number> {
  const reservation = createNetServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

interface Response {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  text: string;
  body: unknown;
}

async function fixture() {
  const tls = await certificate;
  const port = await availablePort();
  const origin = `https://localhost:${port}`;
  let state = BrowserAuth.empty();
  let failSave = false;
  const auth = new BrowserAuth(state, async (next) => {
    if (failSave) throw new Error("private path and credential must stay redacted");
    state = structuredClone(next);
  });
  const app = createBrowserServer({ ...tls, origin, auth });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", resolve);
  });

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const data =
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          servername: "localhost",
          path,
          method,
          ca: tls.ca,
          rejectUnauthorized: true,
          headers: {
            host: `localhost:${port}`,
            ...(data === undefined
              ? {}
              : {
                  "content-type": "application/json",
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
              headers: response.headers,
              text,
              body: text ? (JSON.parse(text) as unknown) : undefined,
            });
          });
        },
      );
      request.once("error", reject);
      request.end(data);
    });
  }

  return {
    auth,
    origin,
    port,
    request,
    failSave(value: boolean) {
      failSave = value;
    },
    persisted: () => structuredClone(state) as BrowserAuthState,
    close() {
      app.shutdown();
    },
  };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers["set-cookie"]?.[0];
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0]!;
}

async function rawRequest(
  f: Awaited<ReturnType<typeof fixture>>,
  lines: string[],
): Promise<string> {
  const tls = await certificate;
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      host: "127.0.0.1",
      port: f.port,
      servername: "localhost",
      ca: tls.ca,
      rejectUnauthorized: true,
    });
    const chunks: Buffer[] = [];
    socket.setTimeout(5000, () => socket.destroy(new Error("test request timed out")));
    socket.once("error", reject);
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.once("secureConnect", () => socket.end([...lines, "", ""].join("\r\n")));
  });
}

test("browser listener stays closed until its caller listens and validates its fixed origin", async () => {
  const tls = await certificate;
  const auth = new BrowserAuth(BrowserAuth.empty(), async () => {});
  assert.throws(
    () => createBrowserServer({ ...tls, origin: "http://localhost:8443", auth }),
    /Invalid browser origin configuration/,
  );
  assert.throws(
    () => createBrowserServer({ ...tls, origin: "https://localhost:8443/path", auth }),
    /Invalid browser origin configuration/,
  );
  const app = createBrowserServer({ ...tls, origin: "https://localhost:8443", auth });
  assert.equal(app.server.listening, false);
  assert.equal(app.server.maxConnections, 32);
  assert.equal(app.server.requestTimeout, 10_000);
  assert.equal(app.server.headersTimeout, 5_000);
  app.shutdown();
  app.shutdown();
  assert.deepEqual(auth.listClients(), []);
});

test("browser health is minimal and every application response has restrictive headers", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const response = await f.request("GET", "/browser/v1/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(String(response.headers["content-security-policy"]), /frame-ancestors 'none'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.doesNotMatch(response.text, /household|node|target|label/i);

  const missing = await f.request("GET", "/browser/v1/missing");
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "Browser route not found." });
});

test("browser boundary rejects wrong origins, form bodies, and every Authorization header", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const secret = "agent-secret-must-not-escape";
  const cases = [
    await f.request("POST", "/browser/v1/pair", { body: {}, headers: {} }),
    await f.request("POST", "/browser/v1/pair", {
      body: {},
      headers: { origin: "https://wrong.example" },
    }),
    await f.request("POST", "/browser/v1/pair", {
      body: {},
      headers: { origin: "null" },
    }),
    await f.request("POST", "/browser/v1/pair", {
      rawBody: "code=x",
      headers: { origin: f.origin, "content-type": "application/x-www-form-urlencoded" },
    }),
    await f.request("GET", "/browser/v1/session", {
      headers: { authorization: `Bearer ${secret}` },
    }),
    await f.request("GET", "/browser/v1/health", {
      headers: { host: `127.0.0.1:${f.port}` },
    }),
  ];
  assert.deepEqual(
    cases.map((item) => item.status),
    [403, 403, 403, 415, 403, 403],
  );
  for (const response of cases) {
    assert.doesNotMatch(response.text, new RegExp(secret));
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
});

test("browser boundary rejects duplicate Host, Origin, and Authorization fields", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const requests = [
    [
      "GET /browser/v1/health HTTP/1.1",
      `Host: localhost:${f.port}`,
      `Host: localhost:${f.port}`,
      "Connection: close",
    ],
    [
      "GET /browser/v1/health HTTP/1.1",
      `Host: localhost:${f.port}`,
      `Origin: ${f.origin}`,
      `Origin: ${f.origin}`,
      "Connection: close",
    ],
    [
      "GET /browser/v1/health HTTP/1.1",
      `Host: localhost:${f.port}`,
      "Authorization: Bearer first-secret",
      "Authorization: Bearer second-secret",
      "Connection: close",
    ],
  ];
  for (const lines of requests) {
    const response = await rawRequest(f, lines);
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.doesNotMatch(response, /first-secret|second-secret/);
  }
});

test("pairing fixes role and grants, consumes once, and exposes only the own public session", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const invitation = await f.auth.invite(tv);
  const escalation = await f.request("POST", "/browser/v1/pair", {
    body: { code: invitation.code, role: "phone_controller", grants: phone.grants },
    headers: { origin: f.origin },
  });
  assert.equal(escalation.status, 400);
  assert.doesNotMatch(escalation.text, new RegExp(invitation.code));

  const paired = await f.request("POST", "/browser/v1/pair", {
    body: { code: invitation.code },
    headers: { origin: f.origin },
  });
  assert.equal(paired.status, 200);
  assert.deepEqual(
    (paired.body as { client: { role: string; grants: unknown[] } }).client.grants,
    [],
  );
  assert.equal((paired.body as { client: { role: string } }).client.role, "tv_viewer");
  assert.doesNotMatch(paired.text, /token|tokenHash|code/);
  const setCookie = paired.headers["set-cookie"]?.[0] ?? "";
  assert.match(
    setCookie,
    new RegExp(
      `^${BROWSER_SESSION_COOKIE}=[a-f0-9]{64}; Path=/; Max-Age=1209600; Secure; HttpOnly; SameSite=Strict$`,
    ),
  );

  const replay = await f.request("POST", "/browser/v1/pair", {
    body: { code: invitation.code },
    headers: { origin: f.origin },
  });
  assert.equal(replay.status, 400);
  const cookie = cookieFrom(paired);
  const session = await f.request("GET", "/browser/v1/session", {
    headers: { cookie },
  });
  assert.equal(session.status, 200);
  assert.deepEqual(
    (session.body as { client: { role: string; grants: unknown[] } }).client.grants,
    [],
  );
  assert.doesNotMatch(session.text, /token|tokenHash|code/);
  assert.equal(f.persisted().sessions.length, 1);
});

test("revocation and logout invalidate browser cookies", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const firstInvite = await f.auth.invite(phone);
  const firstPair = await f.request("POST", "/browser/v1/pair", {
    body: { code: firstInvite.code },
    headers: { origin: f.origin },
  });
  const firstClient = (firstPair.body as { client: { id: string } }).client;
  const firstCookie = cookieFrom(firstPair);
  assert.equal(await f.auth.revoke(firstClient.id), true);
  assert.equal(
    (await f.request("GET", "/browser/v1/session", { headers: { cookie: firstCookie } })).status,
    401,
  );

  const secondInvite = await f.auth.invite(phone);
  const secondPair = await f.request("POST", "/browser/v1/pair", {
    body: { code: secondInvite.code },
    headers: { origin: f.origin },
  });
  const secondCookie = cookieFrom(secondPair);
  const logout = await f.request("POST", "/browser/v1/logout", {
    body: {},
    headers: { origin: f.origin, cookie: secondCookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers["set-cookie"]?.[0] ?? "", /Max-Age=0/);
  assert.equal(
    (await f.request("GET", "/browser/v1/session", { headers: { cookie: secondCookie } })).status,
    401,
  );
});

test("malformed, oversized, and failed-state requests return static redacted errors", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const invitation = await f.auth.invite(phone);
  const malformed = await f.request("POST", "/browser/v1/pair", {
    rawBody: `{"code":"${invitation.code}",`,
    headers: { origin: f.origin },
  });
  const oversizedSecret = `private-${"x".repeat(5000)}`;
  const oversized = await f.request("POST", "/browser/v1/pair", {
    rawBody: JSON.stringify({ code: oversizedSecret }),
    headers: { origin: f.origin },
  });
  f.failSave(true);
  const unavailable = await f.request("POST", "/browser/v1/pair", {
    body: { code: invitation.code },
    headers: { origin: f.origin },
  });
  assert.deepEqual([malformed.status, oversized.status, unavailable.status], [400, 400, 503]);
  for (const response of [malformed, oversized, unavailable]) {
    assert.doesNotMatch(response.text, new RegExp(invitation.code));
    assert.doesNotMatch(response.text, /private path|credential|private-/);
  }
});
