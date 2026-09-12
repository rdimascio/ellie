import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableSecretStore } from "@ellie/config";
import { defaults } from "@ellie/config";
import { Client } from "@ellie/transport";
import { generateBrowserTlsIdentity, generateCertificate } from "../apps/cli/src/certificate.ts";
import {
  BROWSER_CA_CERT,
  BROWSER_SERVER_CERT,
  initializeBrowser,
} from "../apps/cli/src/browser-setup.ts";
import { createBrowserRuntime } from "../apps/cli/src/browser-runtime.ts";
import type { BrowserRuntime } from "../apps/cli/src/browser-runtime.ts";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { BROWSER_AUTH_FILE, BrowserAuth } from "../apps/server/src/browser-auth.ts";
import type { BrowserControl } from "../apps/server/src/browser-management.ts";
import { createBrowserServer } from "../apps/server/src/browser-server.ts";
import type {
  BrowserAssets,
  BrowserServer,
  BrowserServerOptions,
} from "../apps/server/src/browser-server.ts";
import { createEllieServer } from "../apps/server/src/index.ts";
import { JobStore } from "../apps/server/src/jobs.ts";

const hostname = "living-room.local";
const browserOrigin = `https://${hostname}:8444`;

class MemorySecrets implements MutableSecretStore {
  readonly values = new Map<string, string>();

  async get(account: string): Promise<string> {
    const value = this.values.get(account);
    if (!value) throw new Error("missing synthetic secret");
    return value;
  }

  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }

  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }

  async add(account: string, value: string): Promise<void> {
    if (this.values.has(account)) throw new Error("duplicate synthetic secret");
    this.values.set(account, value);
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

interface BrowserResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: unknown;
}

async function browserRequest(
  port: number,
  ca: string,
  method: "GET" | "POST",
  path: string,
  options: { body?: unknown; cookie?: string } = {},
): Promise<BrowserResponse> {
  const data = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      {
        hostname,
        port,
        servername: hostname,
        lookup: (_name, lookupOptions, callback) =>
          lookupOptions.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
        method,
        path,
        ca,
        rejectUnauthorized: true,
        headers: {
          host: `${hostname}:8444`,
          ...(method === "POST" ? { origin: browserOrigin } : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...(data === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }),
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
            body: response.headers["content-type"]?.startsWith("application/json")
              ? (JSON.parse(text) as unknown)
              : text,
          });
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("browser request timed out")));
    request.once("error", reject);
    request.end(data);
  });
}

test("coordinator and browser runtime preserve their lock and complete a durable pairing lifecycle", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "ellie-browser-integration-"));
  const secrets = new MemorySecrets();
  const setup = {
    stateDir,
    secrets,
    localHostname: async () => hostname,
    generate: generateBrowserTlsIdentity,
    now: Date.now,
  };
  const assets = new Map([
    ["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("pairing page") }],
  ]) as BrowserAssets;
  const jobPath = join(stateDir, "jobs.sqlite");
  let failedRuntime: BrowserRuntime | undefined;
  let readyRuntime: BrowserRuntime | undefined;
  let currentRuntime: BrowserRuntime | undefined;
  let browserServer: BrowserServer | undefined;
  let jobStore: JobStore | undefined;
  let app: ReturnType<typeof createEllieServer> | undefined;
  let controller: Client | undefined;
  let appStopped = false;

  try {
    await initializeBrowser(setup);
    const [{ key: agentKey, cert: agentCert }, browserCert, browserCa] = await Promise.all([
      generateCertificate(),
      readFile(join(stateDir, BROWSER_SERVER_CERT), "utf8"),
      readFile(join(stateDir, BROWSER_CA_CERT), "utf8"),
    ]);
    assert.notEqual(
      new X509Certificate(agentCert).fingerprint256,
      new X509Certificate(browserCert).fingerprint256,
    );

    const controllerToken = newToken();
    await Auth.initialize(controllerToken, stateDir);
    jobStore = new JobStore(jobPath);

    failedRuntime = createBrowserRuntime({
      setup,
      bindHost: "127.0.0.1",
      loadAssets: async () => {
        throw new Error("synthetic asset failure");
      },
    });
    currentRuntime = failedRuntime;
    const browser: BrowserControl = { current: () => currentRuntime!.current() };
    app = createEllieServer({
      key: agentKey,
      cert: agentCert,
      auth: await Auth.open(stateDir),
      preferences: defaults,
      jobStore,
      browser,
    });
    await new Promise<void>((resolve, reject) => {
      app!.server.once("error", reject);
      app!.server.listen(0, "127.0.0.1", resolve);
    });
    const agentPort = (app.server.address() as AddressInfo).port;
    controller = new Client(`https://127.0.0.1:${agentPort}`, agentCert, controllerToken);

    assert.throws(() => new JobStore(jobPath), /already in use by another coordinator/);
    await failedRuntime.start();
    assert.deepEqual(failedRuntime.current(), {
      status: "unavailable",
      reason: "assets_unavailable",
    });
    assert.deepEqual(await controller.call("GET", "/v1/nodes"), []);
    assert.deepEqual(await controller.call("GET", "/v1/browser"), {
      status: "unavailable",
      reason: "assets_unavailable",
    });
    await failedRuntime.shutdown();

    const ephemeralBrowserServer = (options: BrowserServerOptions): BrowserServer => {
      const created = createBrowserServer(options);
      const listen = created.server.listen.bind(created.server);
      created.server.listen = ((_port: number, _host: string) =>
        listen(0, "127.0.0.1")) as typeof created.server.listen;
      browserServer = created;
      return created;
    };
    readyRuntime = createBrowserRuntime({
      setup,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
      createServer: ephemeralBrowserServer,
    });
    currentRuntime = readyRuntime;
    await readyRuntime.start();
    const ready = readyRuntime.current();
    assert.equal(ready.status, "ready");
    assert.equal(ready.status === "ready" ? ready.origin : undefined, browserOrigin);
    assert.ok(JSON.parse(await readFile(join(stateDir, BROWSER_AUTH_FILE), "utf8")));
    const browserPort = (browserServer!.server.address() as AddressInfo).port;
    assert.equal((await browserRequest(browserPort, browserCa, "GET", "/")).body, "pairing page");

    const invitation = (await controller.call("POST", "/v1/browser/invitations", {
      role: "tv_viewer",
      label: "Synthetic phone",
      grants: [],
    })) as { code: string };
    assert.match(invitation.code, /^[a-f0-9]{64}$/);
    const paired = await browserRequest(browserPort, browserCa, "POST", "/browser/v1/pair", {
      body: { code: invitation.code },
    });
    assert.equal(paired.status, 200);
    const cookie = paired.headers["set-cookie"]?.[0]?.split(";", 1)[0];
    assert.ok(cookie);
    const session = await browserRequest(browserPort, browserCa, "GET", "/browser/v1/session", {
      cookie,
    });
    assert.equal(session.status, 200);
    const client = (session.body as { client: { id: string } }).client;

    assert.deepEqual(await controller.call("POST", "/v1/browser/revoke", { id: client.id }), {
      ok: true,
      revoked: true,
    });
    assert.equal(
      (
        await browserRequest(browserPort, browserCa, "GET", "/browser/v1/session", {
          cookie,
        })
      ).status,
      401,
    );

    await readyRuntime.shutdown();
    assert.deepEqual(readyRuntime.current(), { status: "disabled" });
    app.shutdown();
    appStopped = true;
    const reopenedAuth = await BrowserAuth.open(stateDir);
    assert.deepEqual(reopenedAuth.listClients(), []);
    const reopenedJobs = new JobStore(jobPath);
    reopenedJobs.close();
  } finally {
    controller?.close();
    await readyRuntime?.shutdown();
    await failedRuntime?.shutdown();
    if (app && !appStopped) app.shutdown();
    else if (!app) jobStore?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
