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
import {
  BROWSER_SESSION_COOKIE,
  BROWSER_SESSION_TTL_MS,
  BrowserAuth,
  browserSessionToken,
} from "../apps/server/src/browser-auth.ts";
import type { BrowserAuthState, BrowserInvitationSpec } from "../apps/server/src/browser-auth.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import { NativeAuth } from "../apps/server/src/native-auth.ts";
import { HouseholdState } from "../apps/server/src/household-state.ts";
import { NativeSpeech } from "../apps/server/src/native-speech.ts";
import { WhisperCliSpeechInput } from "@ellie/speech";
import type { SpeechInput } from "@ellie/speech";
import type { BrowserAssets, BrowserRemote } from "../apps/server/src/browser-server.ts";

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

async function fixture(
  assets?: BrowserAssets,
  remote?: BrowserRemote,
  suppliedSpeech?: SpeechInput,
) {
  const tls = await certificate;
  const port = await availablePort();
  const origin = `https://localhost:${port}`;
  let state = BrowserAuth.empty();
  let failSave = false;
  let now = 1_000;
  let saveGate:
    | {
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
        fail: boolean;
      }
    | undefined;
  const auth = new BrowserAuth(
    state,
    async (next) => {
      const gate = saveGate;
      if (gate) {
        saveGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
        if (gate.fail) throw new Error("private path and credential must stay redacted");
      }
      if (failSave) throw new Error("private path and credential must stay redacted");
      state = structuredClone(next);
    },
    { now: () => now },
  );
  let nativeState = NativeAuth.empty();
  let nativeNow: number | undefined;
  let nativeSaveGate:
    | {
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
        fail: boolean;
      }
    | undefined;
  const nativeAuth = new NativeAuth(
    nativeState,
    async (next) => {
      const gate = nativeSaveGate;
      if (gate) {
        nativeSaveGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
        if (gate.fail) throw new Error("private native state must stay redacted");
      }
      nativeState = structuredClone(next);
    },
    { now: () => nativeNow ?? Date.now() },
  );
  const household = HouseholdState.memory();
  const speechInput: SpeechInput = {
    async *transcribe(audio) {
      let bytes = 0;
      for await (const chunk of audio) bytes += chunk.length;
      if (!bytes) throw new Error();
      yield { text: "Synthetic transcript", final: true };
    },
  };
  const speech = NativeSpeech.memory(nativeAuth, suppliedSpeech ?? speechInput);
  const app = createBrowserServer({
    ...tls,
    origin,
    auth,
    nativeAuth,
    household,
    speech,
    assets,
    remote,
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(port, "127.0.0.1", resolve);
  });

  async function request(
    method: string,
    path: string,
    options: {
      body?: unknown;
      rawBody?: string | Buffer;
      headers?: Record<string, string>;
      signal?: AbortSignal;
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
          signal: options.signal,
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
              body:
                text && response.headers["content-type"]?.startsWith("application/json")
                  ? (JSON.parse(text) as unknown)
                  : undefined,
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
    nativeAuth,
    household,
    speech,
    origin,
    port,
    request,
    failSave(value: boolean) {
      failSave = value;
    },
    blockNextNativeSave(fail = false) {
      assert.equal(nativeSaveGate, undefined);
      const gate = { entered: deferred<void>(), release: deferred<void>(), fail };
      nativeSaveGate = gate;
      return gate;
    },
    nativeNow(value: number) {
      nativeNow = value;
    },
    blockNextSave(fail = false) {
      assert.equal(saveGate, undefined);
      const gate = { entered: deferred<void>(), release: deferred<void>(), fail };
      saveGate = gate;
      return gate;
    },
    now(value: number) {
      now = value;
    },
    persisted: () => structuredClone(state) as BrowserAuthState,
    close() {
      app.shutdown();
    },
  };
}

test("native bearer channel pairs once, recovers by GET, logs out, and rejects browser authority", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const invitation = await f.nativeAuth.invite({
    label: "Test iPhone",
    grants: [{ target: "living-room-mini", capabilities: ["app.open"] }],
  });
  const token = "9".repeat(64);
  const nativeHeaders = { "x-ellie-version": "1" };
  assert.equal(
    (await f.request("POST", "/native/v1/pair", { body: { invitation: invitation.code, token } }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.request("POST", "/native/v1/pair", {
        body: { invitation: invitation.code, token },
        headers: { "x-ellie-version": "2" },
      })
    ).status,
    403,
  );
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: nativeHeaders,
  });
  assert.equal(paired.status, 200);
  assert.doesNotMatch(paired.text, new RegExp(`${invitation.code}|${token}|tokenHash`));
  assert.equal(
    (
      await f.request("POST", "/native/v1/pair", {
        body: { invitation: invitation.code, token: "8".repeat(64) },
        headers: nativeHeaders,
      })
    ).status,
    400,
  );
  const session = await f.request("GET", "/native/v1/session", {
    headers: { ...nativeHeaders, authorization: `Bearer ${token}` },
  });
  assert.equal(session.status, 200);
  assert.deepEqual(
    (session.body as { client: { grants: unknown } }).client.grants,
    invitation.grants,
  );

  for (const headers of [
    { cookie: `__Host-ellie-session=${"a".repeat(64)}` },
    { origin: f.origin },
    { "sec-fetch-site": "same-origin" },
  ] as Record<string, string>[])
    assert.equal(
      (
        await f.request("GET", "/native/v1/session", {
          headers: { ...nativeHeaders, authorization: `Bearer ${token}`, ...headers },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await f.request("GET", "/browser/v1/session", {
        headers: { ...nativeHeaders, authorization: `Bearer ${token}` },
      })
    ).status,
    403,
  );

  assert.equal(
    (
      await f.request("POST", "/native/v1/logout", {
        body: {},
        headers: { ...nativeHeaders, authorization: `Bearer ${token}` },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("GET", "/native/v1/session", {
        headers: { ...nativeHeaders, authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
});

test("native speech HTTPS requires a separate grant and strict bounded audio headers", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const invitation = await f.nativeAuth.invite({
    label: "Speech iPhone",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const token = "6".repeat(64);
  const bearer = { "x-ellie-version": "1", authorization: `Bearer ${token}` };
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: { "x-ellie-version": "1" },
  });
  const client = (paired.body as { client: { id: string } }).client;
  assert.equal(
    (await f.request("GET", "/native/v1/speech/availability", { headers: bearer })).status,
    403,
  );
  await f.speech.grant({ clientId: client.id, capability: "speech.transcribe" });
  assert.deepEqual(
    (await f.request("GET", "/native/v1/speech/availability", { headers: bearer })).body,
    { available: true },
  );
  const audio = Buffer.from("synthetic wav bytes");
  const turnId = "11111111-1111-4111-8111-111111111111";
  const response = await f.request("POST", "/native/v1/speech/transcriptions", {
    rawBody: audio,
    headers: {
      ...bearer,
      "content-type": "audio/wav",
      "content-length": String(audio.length),
      "x-ellie-turn-id": turnId,
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { turnId, text: "Synthetic transcript" });
  assert.deepEqual(
    (
      await f.request("POST", `/native/v1/speech/transcriptions/${turnId}/cancel`, {
        body: {},
        headers: bearer,
      })
    ).body,
    { ok: true, cancelled: false },
  );
  assert.equal(
    (
      await f.request("POST", "/native/v1/speech/transcriptions", {
        rawBody: audio,
        headers: {
          ...bearer,
          "content-type": "application/json",
          "content-length": String(audio.length),
          "x-ellie-turn-id": turnId,
        },
      })
    ).status,
    415,
  );
});

test("native speech HTTPS rejects invalid WAV before starting Whisper", async (t) => {
  const f = await fixture(
    undefined,
    undefined,
    new WhisperCliSpeechInput({
      executable: "/usr/bin/false",
      model: "/dev/null",
      timeoutMs: 1_000,
    }),
  );
  t.after(() => f.close());
  const invitation = await f.nativeAuth.invite({
    label: "Speech iPhone",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const token = "5".repeat(64),
    headers = { "x-ellie-version": "1", authorization: `Bearer ${token}` };
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: { "x-ellie-version": "1" },
  });
  await f.speech.grant({
    clientId: (paired.body as { client: { id: string } }).client.id,
    capability: "speech.transcribe",
  });
  const body = Buffer.from("not a wave");
  assert.equal(
    (
      await f.request("POST", "/native/v1/speech/transcriptions", {
        rawBody: body,
        headers: {
          ...headers,
          "content-type": "audio/wav",
          "content-length": String(body.length),
          "x-ellie-turn-id": "22222222-2222-4222-8222-222222222222",
        },
      })
    ).status,
    400,
  );
});

function validSpeechWave(): Buffer {
  const body = Buffer.alloc(46);
  body.write("RIFF", 0);
  body.writeUInt32LE(38, 4);
  body.write("WAVEfmt ", 8);
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(16_000, 24);
  body.writeUInt32LE(32_000, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write("data", 36);
  body.writeUInt32LE(2, 40);
  return body;
}

async function speechBearer(f: Awaited<ReturnType<typeof fixture>>, token: string) {
  const invitation = await f.nativeAuth.invite({
    label: "Slow speech iPhone",
    grants: [{ target: "mac", capabilities: ["app.open"] }],
  });
  const headers = { "x-ellie-version": "1", authorization: `Bearer ${token}` };
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: { "x-ellie-version": "1" },
  });
  const clientId = (paired.body as { client: { id: string } }).client.id;
  await f.speech.grant({ clientId, capability: "speech.transcribe" });
  return headers;
}

test("completed speech upload keeps its bounded response window beyond ten seconds", async (t) => {
  let calls = 0;
  const input: SpeechInput = {
    async *transcribe(audio) {
      calls += 1;
      for await (const _ of audio) void _;
      await new Promise((resolve) => setTimeout(resolve, 10_500));
      yield { text: "Slow synthetic transcript", final: true };
    },
  };
  const f = await fixture(undefined, undefined, input);
  t.after(() => f.close());
  const headers = await speechBearer(f, "7".repeat(64));
  const wave = validSpeechWave();
  const response = await f.request("POST", "/native/v1/speech/transcriptions", {
    rawBody: wave,
    headers: {
      ...headers,
      "content-type": "audio/wav",
      "content-length": String(wave.length),
      "x-ellie-turn-id": "77777777-7777-4777-8777-777777777777",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    turnId: "77777777-7777-4777-8777-777777777777",
    text: "Slow synthetic transcript",
  });
  assert.equal(calls, 1);
});

test("incomplete speech upload retains the ten second socket deadline", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const headers = await speechBearer(f, "9".repeat(64));
  const tls = await certificate;
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest({
      host: "127.0.0.1",
      port: f.port,
      servername: "localhost",
      path: "/native/v1/speech/transcriptions",
      method: "POST",
      ca: tls.ca,
      rejectUnauthorized: true,
      headers: {
        host: `localhost:${f.port}`,
        ...headers,
        "content-type": "audio/wav",
        "content-length": String(validSpeechWave().length),
        "x-ellie-turn-id": "99999999-9999-4999-8999-999999999999",
      },
    });
    const timer = setTimeout(
      () => reject(new Error("Stalled upload exceeded its deadline.")),
      12_000,
    );
    request.once("error", () => {
      clearTimeout(timer);
      resolve();
    });
    request.write(validSpeechWave().subarray(0, 12));
  });
  assert.ok(Date.now() - started >= 9_000);
  assert.ok(Date.now() - started < 12_000);
});

test("native household routes require separate grants and enforce conditional revisions", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const invitation = await f.nativeAuth.invite({
    label: "Household iPhone",
    grants: [{ target: "living-room-mini", capabilities: ["app.open"] }],
  });
  const token = "8".repeat(64);
  const headers = { "x-ellie-version": "1", authorization: `Bearer ${token}` };
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: { "x-ellie-version": "1" },
  });
  assert.equal(paired.status, 200);
  const client = (paired.body as { client: { id: string } }).client;
  assert.equal(
    (await f.request("GET", "/native/v1/household/shared/dashboards", { headers })).status,
    403,
  );
  assert.equal(
    await f.household.grant(f.nativeAuth, {
      clientId: client.id,
      profile: "shared",
      kind: "dashboards",
      access: "write",
    }),
    true,
  );
  const empty = await f.request("GET", "/native/v1/household/shared/dashboards", { headers });
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.etag, '"ellie-revision-0"');
  assert.deepEqual(empty.body, {
    profile: "shared",
    kind: "dashboards",
    revision: 0,
    value: { version: 1, dashboards: [] },
  });
  const value = { version: 1, dashboards: [{ id: "home", name: "Home", widgets: [] }] };
  const saved = await f.request("PUT", "/native/v1/household/shared/dashboards", {
    body: { value },
    headers: { ...headers, "if-match": '"ellie-revision-0"' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.etag, '"ellie-revision-1"');
  const conflict = await f.request("PUT", "/native/v1/household/shared/dashboards", {
    body: { value: { version: 1, dashboards: [] } },
    headers: { ...headers, "if-match": '"ellie-revision-0"' },
  });
  assert.deepEqual(conflict.body, { profile: "shared", kind: "dashboards", revision: 1 });
  assert.equal(conflict.status, 412);
  assert.equal((await f.request("GET", "/native/v1/nodes", { headers })).status, 503);
  await f.household.revoke({ clientId: client.id, profile: "shared", kind: "dashboards" });
  assert.equal(
    (await f.request("GET", "/native/v1/household/shared/dashboards", { headers })).status,
    403,
  );
});

function cookieFrom(response: Response): string {
  const setCookie = response.headers["set-cookie"]?.[0];
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0]!;
}

test("static pairing assets retain origin, host and agent-credential isolation", async () => {
  const f = await fixture(
    new Map([
      ["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("<html>Connect</html>") }],
      [
        "/assets/pairing.js",
        { contentType: "text/javascript; charset=utf-8", body: Buffer.from("pairing") },
      ],
      [
        "/browser/v1/session",
        { contentType: "text/html", body: Buffer.from("must not shadow API") },
      ],
    ]),
  );
  try {
    const page = await f.request("GET", "/");
    assert.equal(page.status, 200);
    assert.equal(page.text, "<html>Connect</html>");
    assert.equal(page.headers["cache-control"], "no-store");
    assert.match(String(page.headers["content-security-policy"]), /frame-ancestors 'none'/);
    const head = await f.request("HEAD", "/assets/pairing.js");
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal(head.headers["content-length"], "7");
    assert.equal((await f.request("GET", "/browser/v1/session")).status, 401);
    for (const path of [
      "/index.html",
      "/pair/index.html",
      "/assets/missing.js",
      "/.vite/manifest.json",
      "/browser-auth.json",
      "/v1/nodes",
    ]) {
      assert.equal((await f.request("GET", path)).status, 404);
    }
    assert.equal((await f.request("GET", "/?code=private")).status, 400);
    assert.equal((await f.request("GET", "/", { headers: { host: "evil.local" } })).status, 403);
    assert.equal(
      (await f.request("GET", "/", { headers: { origin: "https://evil.local" } })).status,
      403,
    );
    assert.equal(
      (await f.request("GET", "/", { headers: { authorization: "Bearer synthetic-agent" } }))
        .status,
      403,
    );
  } finally {
    f.close();
  }
});

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
  assert.equal(app.server.requestTimeout, 65_000);
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
  assert.equal(
    response.headers["permissions-policy"],
    "camera=(self), microphone=(), geolocation=()",
  );
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.doesNotMatch(response.text, /household|node|target|label/i);

  const missing = await f.request("GET", "/browser/v1/missing");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["permissions-policy"], response.headers["permissions-policy"]);
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
    assert.match(
      response,
      /permissions-policy: camera=\(self\), microphone=\(\), geolocation=\(\)/i,
    );
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

async function pairBrowserClient(
  f: Awaited<ReturnType<typeof fixture>>,
  invitation: BrowserInvitationSpec,
): Promise<{ cookie: string; clientId: string }> {
  const invited = await f.auth.invite(invitation);
  const paired = await f.request("POST", "/browser/v1/pair", {
    body: { code: invited.code },
    headers: { origin: f.origin },
  });
  assert.equal(paired.status, 200);
  return {
    cookie: cookieFrom(paired),
    clientId: (paired.body as { client: { id: string } }).client.id,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("browser nodes require an authenticated phone, a configured remote, and app.open grants", async (t) => {
  const calls: string[] = [];
  const remote: BrowserRemote = {
    async nodes() {
      return [
        {
          id: "living-room-mini",
          label: "Living room",
          online: true,
          capabilities: ["app.open"],
          privateTelemetry: "remote-secret-must-not-cross-browser-boundary",
        },
        { id: "bedroom-mini", label: "Bedroom", online: true, capabilities: ["app.open"] },
      ];
    },
    async openApp(nodeId, app) {
      calls.push(`${nodeId}:${app}`);
      return { ok: true, message: "opened" };
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  assert.equal((await f.request("GET", "/browser/v1/nodes")).status, 401);

  const tvSession = await pairBrowserClient(f, tv);
  assert.equal(
    (await f.request("GET", "/browser/v1/nodes", { headers: { cookie: tvSession.cookie } })).status,
    403,
  );

  const phoneSession = await pairBrowserClient(f, phone);
  const listed = await f.request("GET", "/browser/v1/nodes", {
    headers: { cookie: phoneSession.cookie },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body, {
    nodes: [
      { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
    ],
  });
  assert.doesNotMatch(listed.text, /privateTelemetry|remote-secret/);
  assert.deepEqual(calls, []);

  const withoutRemote = await fixture();
  t.after(() => withoutRemote.close());
  const noRemoteSession = await pairBrowserClient(withoutRemote, phone);
  assert.equal(
    (
      await withoutRemote.request("GET", "/browser/v1/nodes", {
        headers: { cookie: noRemoteSession.cookie },
      })
    ).status,
    503,
  );
});

test("browser commands reject unauthorized, malformed, unsupported, and cross-origin requests before dispatch", async (t) => {
  const dispatched: string[] = [];
  const remote: BrowserRemote = {
    async nodes() {
      return [
        { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
        { id: "bedroom-mini", label: "Bedroom", online: true, capabilities: ["app.open"] },
      ];
    },
    async openApp(nodeId, app) {
      dispatched.push(`${nodeId}:${app}`);
      return { ok: true, message: "opened" };
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const tvSession = await pairBrowserClient(f, tv);
  const phoneSession = await pairBrowserClient(f, phone);
  const endpoint = "/browser/v1/commands";
  const validBody = { nodeId: "living-room-mini", text: "open Arc" };
  const responses = [
    await f.request("POST", endpoint, { body: validBody, headers: { origin: f.origin } }),
    await f.request("POST", endpoint, {
      body: validBody,
      headers: { origin: f.origin, cookie: tvSession.cookie },
    }),
    await f.request("POST", endpoint, {
      body: { nodeId: "bedroom-mini", text: "open Arc" },
      headers: { origin: f.origin, cookie: phoneSession.cookie },
    }),
    await f.request("POST", endpoint, {
      body: { ...validBody, extra: true },
      headers: { origin: f.origin, cookie: phoneSession.cookie },
    }),
    await f.request("POST", endpoint, {
      body: { nodeId: "living-room-mini", text: "delete every message" },
      headers: { origin: f.origin, cookie: phoneSession.cookie },
    }),
    await f.request("POST", endpoint, {
      body: { nodeId: "living-room-mini", text: `open Arc${" ".repeat(501)}` },
      headers: { origin: f.origin, cookie: phoneSession.cookie },
    }),
    await f.request("POST", endpoint, {
      body: validBody,
      headers: { cookie: phoneSession.cookie },
    }),
  ];
  assert.deepEqual(
    responses.map(({ status }) => status),
    [401, 403, 403, 400, 400, 400, 403],
  );
  assert.deepEqual(dispatched, []);
});

test("browser commands reauthenticate after node discovery and never dispatch a revoked session", async (t) => {
  const nodeLookup = deferred<Awaited<ReturnType<BrowserRemote["nodes"]>>>();
  let dispatches = 0;
  const remote: BrowserRemote = {
    nodes: () => nodeLookup.promise,
    async openApp() {
      dispatches += 1;
      return { ok: true, message: "opened" };
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const session = await pairBrowserClient(f, phone);
  const request = f.request("POST", "/browser/v1/commands", {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers: { origin: f.origin, cookie: session.cookie },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await f.auth.revoke(session.clientId), true);
  nodeLookup.resolve([
    { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
  ]);
  assert.equal((await request).status, 401);
  assert.equal(dispatches, 0);
});

test("queued revoke, logout, expiry, and save failure settle before command admission", async (t) => {
  for (const operation of ["revoke", "logout", "expiry", "failed-revoke"] as const) {
    const nodeLookup = deferred<Awaited<ReturnType<BrowserRemote["nodes"]>>>();
    const nodeLookupEntered = deferred<void>();
    let dispatches = 0;
    const remote: BrowserRemote = {
      nodes: () => {
        nodeLookupEntered.resolve();
        return nodeLookup.promise;
      },
      async openApp() {
        dispatches += 1;
        return { ok: true, message: "opened" };
      },
    };
    const f = await fixture(undefined, remote);
    t.after(() => f.close());
    const session = await pairBrowserClient(f, phone);
    const token = browserSessionToken(session.cookie);
    assert.ok(token);
    const command = f.request("POST", "/browser/v1/commands", {
      body: { nodeId: "living-room-mini", text: "open Arc" },
      headers: { origin: f.origin, cookie: session.cookie },
    });
    await nodeLookupEntered.promise;

    let mutation: Promise<unknown> | undefined;
    let gate: ReturnType<typeof f.blockNextSave> | undefined;
    if (operation === "expiry") {
      gate = f.blockNextSave();
      mutation = f.auth.invite(tv);
      await gate.entered.promise;
      f.now(1_000 + BROWSER_SESSION_TTL_MS);
    } else {
      gate = f.blockNextSave(operation === "failed-revoke");
      mutation = operation === "logout" ? f.auth.logout(token) : f.auth.revoke(session.clientId);
      await gate.entered.promise;
    }
    nodeLookup.resolve([
      { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 0);
    gate?.release.resolve();

    if (operation === "failed-revoke") {
      assert.ok(mutation);
      await assert.rejects(mutation);
    } else if (mutation) {
      const mutationResult = await mutation;
      if (operation !== "expiry") assert.equal(mutationResult, true);
    }
    const response = await command;
    assert.equal(response.status, operation === "failed-revoke" ? 503 : 401, operation);
    assert.equal(dispatches, 0);
  }
});

test("command admission that wins the authorization order dispatches once without replay", async (t) => {
  const result = deferred<{ ok: boolean; message: string }>();
  const dispatchEntered = deferred<void>();
  let dispatches = 0;
  const remote: BrowserRemote = {
    async nodes() {
      return [
        { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
      ];
    },
    openApp() {
      dispatches += 1;
      dispatchEntered.resolve();
      return result.promise;
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const session = await pairBrowserClient(f, phone);
  const command = f.request("POST", "/browser/v1/commands", {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers: { origin: f.origin, cookie: session.cookie },
  });
  await dispatchEntered.promise;
  assert.equal(await f.auth.revoke(session.clientId), true);
  result.reject(new Error("outcome lost after admission"));
  const response = await command;
  assert.equal(response.status, 502);
  assert.equal(dispatches, 1);
});

test("browser commands require an online capable target and normalize only the finite app grammar", async (t) => {
  const dispatched: Array<[string, string]> = [];
  const remote: BrowserRemote = {
    async nodes() {
      return [
        { id: "living-room-mini", label: "Living room", online: false, capabilities: ["app.open"] },
      ];
    },
    async openApp(nodeId, app) {
      dispatched.push([nodeId, app]);
      return { ok: true, message: "opened" };
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const session = await pairBrowserClient(f, phone);
  const headers = { origin: f.origin, cookie: session.cookie };
  const offline = await f.request("POST", "/browser/v1/commands", {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers,
  });
  assert.equal(offline.status, 409);
  assert.deepEqual(dispatched, []);

  remote.nodes = async () => [
    { id: "living-room-mini", label: "Living room", online: true, capabilities: [] },
  ];
  const incapable = await f.request("POST", "/browser/v1/commands", {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers,
  });
  assert.equal(incapable.status, 409);
  assert.deepEqual(dispatched, []);

  remote.nodes = async () => [
    { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
  ];
  for (const [text, app] of [
    ["Ellie, OPEN ARC!!!", "arc"],
    ["launch Safari.", "safari"],
    ["Start Messages", "messages"],
  ] as const) {
    const response = await f.request("POST", "/browser/v1/commands", {
      body: { nodeId: "living-room-mini", text },
      headers,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(dispatched.at(-1), ["living-room-mini", app]);
  }
  assert.equal(dispatched.length, 3);
});

test("browser commands enforce one in-flight dispatch per node", async (t) => {
  const firstDispatch = deferred<{ ok: boolean; message: string }>();
  let dispatches = 0;
  const remote: BrowserRemote = {
    async nodes() {
      return [
        { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
      ];
    },
    openApp() {
      dispatches += 1;
      return firstDispatch.promise;
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const session = await pairBrowserClient(f, phone);
  const options = {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers: { origin: f.origin, cookie: session.cookie },
  };
  const first = f.request("POST", "/browser/v1/commands", options);
  await new Promise((resolve) => setImmediate(resolve));
  const busy = await f.request("POST", "/browser/v1/commands", options);
  assert.equal(busy.status, 409);
  assert.equal(dispatches, 1);
  firstDispatch.resolve({ ok: true, message: "opened" });
  assert.equal((await first).status, 200);
  assert.equal(dispatches, 1);
});

test("browser commands report an unknown outcome without retrying an upstream failure", async (t) => {
  let dispatches = 0;
  const remote: BrowserRemote = {
    async nodes() {
      return [
        { id: "living-room-mini", label: "Living room", online: true, capabilities: ["app.open"] },
      ];
    },
    async openApp() {
      dispatches += 1;
      throw new Error("private upstream route and credential");
    },
  };
  const f = await fixture(undefined, remote);
  t.after(() => f.close());
  const session = await pairBrowserClient(f, phone);
  const response = await f.request("POST", "/browser/v1/commands", {
    body: { nodeId: "living-room-mini", text: "open Arc" },
    headers: { origin: f.origin, cookie: session.cookie },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, {
    error: "Command outcome is unknown. Check the Mac before sending again.",
  });
  assert.equal(dispatches, 1);
  assert.doesNotMatch(response.text, /private upstream|credential/);
});

const nativeTarget = {
  id: "living-room-mini",
  label: "Living room",
  online: true,
  capabilities: ["app.open"] as "app.open"[],
};
const nativeCommand = { nodeId: nativeTarget.id, action: { tool: "app.open", app: "arc" } };
async function nativeControlSession(f: Awaited<ReturnType<typeof fixture>>) {
  const invitation = await f.nativeAuth.invite({
    label: "Test iPhone",
    grants: [{ target: nativeTarget.id, capabilities: ["app.open"] }],
  });
  const token = "c".repeat(64);
  const paired = await f.request("POST", "/native/v1/pair", {
    body: { invitation: invitation.code, token },
    headers: { "x-ellie-version": "1" },
  });
  assert.equal(paired.status, 200);
  return {
    headers: { "x-ellie-version": "1", authorization: `Bearer ${token}` },
    client: (paired.body as { client: { id: string; expiresAt: number } }).client,
  };
}

test("native controls expose only granted inventory and finite redacted outcomes over real TLS", async (t) => {
  const calls: unknown[] = [];
  const f = await fixture(undefined, {
    nodes: async () => [
      { ...nativeTarget, privateTelemetry: "private detail" } as typeof nativeTarget,
      { ...nativeTarget, id: "private-mini" },
    ],
    openApp: async (id, app, options) => {
      calls.push([id, app]);
      assert.ok(options?.signal);
      return { ok: app !== "messages", message: "private secret" };
    },
  });
  t.after(() => f.close());
  const { headers } = await nativeControlSession(f);
  const inventory = await f.request("GET", "/native/v1/nodes", { headers });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.headers["cache-control"], "no-store");
  assert.deepEqual(inventory.body, { nodes: [nativeTarget] });
  for (const app of ["arc", "safari", "messages"]) {
    const result = await f.request("POST", "/native/v1/commands", {
      headers,
      body: { ...nativeCommand, action: { tool: "app.open", app } },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { outcome: app === "messages" ? "failed" : "completed" });
  }
  assert.deepEqual(
    calls,
    ["arc", "safari", "messages"].map((app) => [nativeTarget.id, app]),
  );
});

test("native browser commands require the exact read or control grant and preserve unknown", async (t) => {
  const calls: unknown[] = [];
  const f = await fixture(undefined, {
    nodes: async () => [
      {
        ...nativeTarget,
        capabilities: ["app.open", "browser.read", "browser.control"],
      },
    ],
    openApp: async () => ({ ok: true, message: "opened" }),
    execute: async (_id, action) => {
      calls.push(action);
      return {
        ok: false,
        message: "Browser action did not confirm completion.",
        browser: {
          source: "webmcp",
          operation: "command",
          status: "unknown",
          revision: "a".repeat(64),
        },
      };
    },
  });
  t.after(() => f.close());
  const invitation = await f.nativeAuth.invite({
    label: "Browser iPhone",
    grants: [{ target: nativeTarget.id, capabilities: ["browser.control"] }],
  });
  const token = "e".repeat(64);
  assert.equal(
    (
      await f.request("POST", "/native/v1/pair", {
        body: { invitation: invitation.code, token },
        headers: { "x-ellie-version": "1" },
      })
    ).status,
    200,
  );
  const headers = { "x-ellie-version": "1", authorization: `Bearer ${token}` };
  assert.deepEqual((await f.request("GET", "/native/v1/nodes", { headers })).body, {
    nodes: [
      {
        id: nativeTarget.id,
        label: nativeTarget.label,
        online: true,
        capabilities: ["browser.control"],
      },
    ],
  });
  const status = await f.request("POST", "/native/v1/commands", {
    headers,
    body: {
      nodeId: nativeTarget.id,
      action: { tool: "browser.scroll", direction: "right", revision: "a".repeat(64) },
    },
  });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, {
    outcome: "unknown",
    result: {
      ok: false,
      message: "Browser action did not confirm completion.",
      browser: {
        source: "webmcp",
        operation: "command",
        status: "unknown",
        revision: "a".repeat(64),
      },
    },
  });
  const denied = await f.request("POST", "/native/v1/commands", {
    headers,
    body: {
      nodeId: nativeTarget.id,
      action: { tool: "browser.status" },
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(calls.length, 1);
});

test("native controls reject browser authority, ungranted targets and noncanonical actions before dispatch", async (t) => {
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => [nativeTarget],
    openApp: async () => {
      calls++;
      return { ok: true, message: "" };
    },
  });
  t.after(() => f.close());
  const { headers } = await nativeControlSession(f);
  for (const rejectedHeaders of [
    {},
    { ...headers, authorization: `Bearer ${"d".repeat(64)}` },
    { ...headers, origin: f.origin },
    { ...headers, cookie: "ellie=browser" },
    { ...headers, "sec-fetch-site": "same-origin" },
    { ...headers, "x-ellie-version": "2" },
  ]) {
    const result = await f.request("POST", "/native/v1/commands", {
      headers: rejectedHeaders,
      body: nativeCommand,
    });
    assert.ok([401, 403].includes(result.status));
  }
  for (const body of [
    { ...nativeCommand, nodeId: "private-mini" },
    { ...nativeCommand, text: "open Arc" },
    { ...nativeCommand, action: { tool: "app.open", app: "terminal" } },
    { ...nativeCommand, action: { tool: "app.open", app: "arc", extra: true } },
    { nodeId: nativeTarget.id, text: "open Arc" },
  ]) {
    const result = await f.request("POST", "/native/v1/commands", { headers, body });
    assert.ok([400, 403].includes(result.status));
  }
  assert.equal(calls, 0);
});

test("native inventory and dispatch recheck revocation after asynchronous discovery", async (t) => {
  for (const method of ["GET", "POST"]) {
    const started = deferred<void>();
    const discovery = deferred<(typeof nativeTarget)[]>();
    let calls = 0;
    const f = await fixture(undefined, {
      nodes: () => {
        started.resolve();
        return discovery.promise;
      },
      openApp: async () => {
        calls++;
        return { ok: true, message: "" };
      },
    });
    t.after(() => f.close());
    const { headers, client } = await nativeControlSession(f);
    const pending = f.request(
      method,
      method === "GET" ? "/native/v1/nodes" : "/native/v1/commands",
      { headers, ...(method === "POST" ? { body: nativeCommand } : {}) },
    );
    await started.promise;
    await f.nativeAuth.revoke(client.id);
    discovery.resolve([nativeTarget]);
    assert.equal((await pending).status, 401);
    assert.equal(calls, 0);
  }
});

test("native command admission waits for queued revoke, logout, expiry, and failed save", async (t) => {
  for (const operation of ["revoke", "logout", "expiry", "failed-revoke"] as const) {
    const discoveryStarted = deferred<void>();
    const discovery = deferred<(typeof nativeTarget)[]>();
    let dispatches = 0;
    const f = await fixture(undefined, {
      nodes: () => {
        discoveryStarted.resolve();
        return discovery.promise;
      },
      async openApp() {
        dispatches += 1;
        return { ok: true, message: "opened" };
      },
    });
    t.after(() => f.close());
    const { headers, client } = await nativeControlSession(f);
    const pending = f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
    await discoveryStarted.promise;

    const gate = f.blockNextNativeSave(operation === "failed-revoke");
    const mutation =
      operation === "logout"
        ? f.nativeAuth.logout(headers.authorization)
        : operation === "expiry"
          ? f.nativeAuth.invite({
              label: "Another test phone",
              grants: [{ target: nativeTarget.id, capabilities: ["app.open"] }],
            })
          : f.nativeAuth.revoke(client.id);
    await gate.entered.promise;
    if (operation === "expiry") f.nativeNow(client.expiresAt);
    discovery.resolve([nativeTarget]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 0, operation);
    gate.release.resolve();

    if (operation === "failed-revoke") await assert.rejects(mutation);
    else await mutation;
    assert.equal((await pending).status, operation === "failed-revoke" ? 503 : 401, operation);
    assert.equal(dispatches, 0, operation);
  }
});

test("native command admitted before revocation dispatches once without replay", async (t) => {
  const dispatched = deferred<void>();
  const result = deferred<{ ok: boolean; message: string }>();
  let dispatches = 0;
  const f = await fixture(undefined, {
    async nodes() {
      return [nativeTarget];
    },
    openApp() {
      dispatches += 1;
      dispatched.resolve();
      return result.promise;
    },
  });
  t.after(() => f.close());
  const { headers, client } = await nativeControlSession(f);
  const pending = f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
  await dispatched.promise;
  assert.equal(await f.nativeAuth.revoke(client.id), true);
  result.reject(new Error("outcome lost after admission"));
  assert.equal((await pending).status, 502);
  assert.equal(dispatches, 1);
});

test("native dispatch refuses missing, offline and incapable targets and redacts discovery failures", async (t) => {
  let nodes: (typeof nativeTarget)[] = [];
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => nodes,
    openApp: async () => {
      calls++;
      return { ok: true, message: "" };
    },
  });
  t.after(() => f.close());
  const { headers } = await nativeControlSession(f);
  for (const [inventory, status] of [
    [[], 404],
    [[{ ...nativeTarget, online: false }], 409],
    [[{ ...nativeTarget, capabilities: [] }], 409],
    [[{ ...nativeTarget, label: "secret\ninvalid" }], 503],
    [Array(17).fill(nativeTarget), 503],
  ] as [typeof nodes, number][]) {
    nodes = inventory;
    const result = await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
    assert.equal(result.status, status);
    assert.doesNotMatch(result.text, /secret|invalid/);
  }
  assert.equal(calls, 0);
});

test("native and browser command channels share the per-device reservation", async (t) => {
  const started = deferred<void>();
  const operation = deferred<{ ok: boolean; message: string }>();
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => [nativeTarget],
    openApp: () => {
      calls++;
      started.resolve();
      return operation.promise;
    },
  });
  t.after(() => {
    operation.resolve({ ok: true, message: "" });
    f.close();
  });
  const { headers } = await nativeControlSession(f);
  const browserSession = await pairBrowserClient(f, phone);
  const pending = f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
  await started.promise;
  assert.equal(
    (await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand })).status,
    409,
  );
  assert.equal(
    (
      await f.request("POST", "/browser/v1/commands", {
        headers: { origin: f.origin, cookie: browserSession.cookie },
        body: { nodeId: nativeTarget.id, text: "open Arc" },
      })
    ).status,
    409,
  );
  operation.resolve({ ok: true, message: "" });
  assert.equal((await pending).status, 200);
  assert.equal(calls, 1);
});

test("native client disconnect cancels discovery without dispatch or replay", async (t) => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const discovery = deferred<(typeof nativeTarget)[]>();
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: ({ signal } = {}) => {
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      return discovery.promise;
    },
    openApp: async () => {
      calls++;
      return { ok: true, message: "" };
    },
  });
  t.after(() => {
    discovery.resolve([nativeTarget]);
    f.close();
  });
  const { headers } = await nativeControlSession(f);
  const controller = new AbortController();
  const pending = f.request("POST", "/native/v1/commands", {
    headers,
    body: nativeCommand,
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await started.promise;
  controller.abort();
  await rejection;
  await aborted.promise;
  discovery.resolve([nativeTarget]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

test("native command deadline signals cancellation and retains reservation until ignored upstream settles", async (t) => {
  const started = deferred<void>();
  const operation = deferred<{ ok: boolean; message: string }>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => [nativeTarget],
    openApp: (_id, _app, options) => {
      calls++;
      signal = options?.signal;
      started.resolve();
      return operation.promise;
    },
  });
  t.after(() => {
    operation.resolve({ ok: true, message: "" });
    f.close();
  });
  const { headers } = await nativeControlSession(f);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
  await started.promise;
  t.mock.timers.tick(35_001);
  const result = await pending;
  t.mock.timers.reset();
  assert.equal(signal?.aborted, true);
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, { outcome: "unknown" });
  assert.equal(
    (await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand })).status,
    409,
  );
  assert.equal(calls, 1);
  operation.resolve({ ok: true, message: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand })).status,
    200,
  );
  assert.equal(calls, 2, "Only the new explicit command dispatches after upstream settles");
});

test("native command exceptions and malformed outcomes are unknown and never leak upstream detail", async (t) => {
  let mode = 0;
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => [nativeTarget],
    openApp: async () => {
      calls++;
      if (mode === 0) throw new Error("private token secret");
      return { ok: "yes", message: "private token secret" } as never;
    },
  });
  t.after(() => f.close());
  const { headers } = await nativeControlSession(f);
  for (mode = 0; mode < 2; mode++) {
    const result = await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
    assert.equal(result.status, 502);
    assert.deepEqual(result.body, { outcome: "unknown" });
  }
  assert.equal(calls, 2);
});

test("native command disconnect after dispatch cancels upstream without replay or releasing its unsettled reservation", async (t) => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const operation = deferred<{ ok: boolean; message: string }>();
  let calls = 0;
  const f = await fixture(undefined, {
    nodes: async () => [nativeTarget],
    openApp: (_id, _app, { signal } = {}) => {
      calls++;
      signal!.addEventListener("abort", () => aborted.resolve(), { once: true });
      started.resolve();
      return operation.promise;
    },
  });
  t.after(() => {
    operation.resolve({ ok: true, message: "" });
    f.close();
  });
  const { headers } = await nativeControlSession(f);
  const controller = new AbortController();
  const pending = f.request("POST", "/native/v1/commands", {
    headers,
    body: nativeCommand,
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  await started.promise;
  controller.abort();
  await rejection;
  await aborted.promise;
  assert.equal(
    (await f.request("POST", "/native/v1/commands", { headers, body: nativeCommand })).status,
    409,
  );
  operation.resolve({ ok: true, message: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});

test("native discovery deadline never dispatches after a late inventory response", async (t) => {
  const started = deferred<void>();
  const discovery = deferred<(typeof nativeTarget)[]>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const f = await fixture(undefined, {
    nodes: (options) => {
      signal = options?.signal;
      started.resolve();
      return discovery.promise;
    },
    openApp: async () => {
      calls++;
      return { ok: true, message: "" };
    },
  });
  t.after(() => {
    discovery.resolve([nativeTarget]);
    f.close();
  });
  const { headers } = await nativeControlSession(f);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = f.request("POST", "/native/v1/commands", { headers, body: nativeCommand });
  await started.promise;
  t.mock.timers.tick(5_001);
  assert.equal((await pending).status, 503);
  t.mock.timers.reset();
  assert.equal(signal?.aborted, true);
  discovery.resolve([nativeTarget]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});
