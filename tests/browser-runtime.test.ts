import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutableSecretStore } from "@ellie/config";
import { generateBrowserTlsIdentity } from "../apps/cli/src/certificate.ts";
import {
  BROWSER_CONFIG,
  BROWSER_SERVER_KEY,
  initializeBrowser,
} from "../apps/cli/src/browser-setup.ts";
import { createBrowserRuntime } from "../apps/cli/src/browser-runtime.ts";
import { BROWSER_AUTH_FILE } from "../apps/server/src/browser-auth.ts";
import type { BrowserAssets, BrowserServer } from "../apps/server/src/browser-server.ts";

class MemorySecrets implements MutableSecretStore {
  readonly values = new Map<string, string>();
  gets = 0;
  async get(account: string): Promise<string> {
    this.gets += 1;
    const value = this.values.get(account);
    if (!value) throw new Error("missing");
    return value;
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async has(account: string): Promise<boolean> {
    return this.values.has(account);
  }
  async add(account: string, value: string): Promise<void> {
    if (this.values.has(account)) throw new Error("duplicate");
    this.values.set(account, value);
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

async function fixture(initialized = true) {
  const stateDir = await mkdtemp(join(tmpdir(), "ellie-browser-runtime-"));
  const secrets = new MemorySecrets();
  const environment = {
    stateDir,
    secrets,
    localHostname: async () => "living-room.local",
    generate: generateBrowserTlsIdentity,
    now: Date.now,
  };
  if (initialized) await initializeBrowser(environment);
  return { stateDir, secrets, environment };
}

class FakeHttpsServer extends EventEmitter {
  listening = false;
  shutdowns = 0;
  failListen = false;
  listen(_port: number, _host: string): this {
    queueMicrotask(() => {
      if (this.failListen) this.emit("error", new Error("private bind detail"));
      else {
        this.listening = true;
        this.emit("listening");
      }
    });
    return this;
  }
  close(): this {
    this.listening = false;
    return this;
  }
  closeAllConnections(): void {}
}

function fakeFactory(
  server: FakeHttpsServer,
  seen: unknown[],
): (options: unknown) => BrowserServer {
  return (options) => {
    seen.push(options);
    return {
      server: server as unknown as BrowserServer["server"],
      shutdown: () => {
        server.shutdowns += 1;
        server.close();
      },
    };
  };
}

const assets = new Map([
  ["/", { contentType: "text/html; charset=utf-8", body: Buffer.from("browser") }],
]) as BrowserAssets;

test("absent browser setup stays disabled with zero side effects", async () => {
  const setup = await fixture(false);
  let assetLoads = 0;
  let factories = 0;
  try {
    const runtime = createBrowserRuntime({
      setup: setup.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => {
        assetLoads += 1;
        return assets;
      },
      createServer: (options) => {
        factories += 1;
        return fakeFactory(new FakeHttpsServer(), [])(options);
      },
    });
    await runtime.start();
    assert.deepEqual(runtime.current(), { status: "disabled" });
    assert.equal(setup.secrets.gets, 0);
    assert.equal(assetLoads, 0);
    assert.equal(factories, 0);
    await assert.rejects(readFile(join(setup.stateDir, BROWSER_AUTH_FILE)), /ENOENT/);
    await runtime.shutdown();
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("runtime initializes auth once, listens explicitly, and closes its listener", async () => {
  const setup = await fixture();
  const server = new FakeHttpsServer();
  const seen: unknown[] = [];
  try {
    const runtime = createBrowserRuntime({
      setup: setup.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
      createServer: fakeFactory(server, seen),
    });
    await runtime.start();
    const current = runtime.current();
    assert.equal(current.status, "ready");
    if (current.status === "ready") assert.equal(current.origin, "https://living-room.local:8444");
    assert.equal(seen.length, 1);
    assert.equal(setup.secrets.gets, 1);
    assert.ok(JSON.parse(await readFile(join(setup.stateDir, BROWSER_AUTH_FILE), "utf8")));
    await runtime.start();
    assert.equal(seen.length, 1);
    await runtime.shutdown();
    assert.ok(server.shutdowns >= 1);
    assert.deepEqual(runtime.current(), { status: "disabled" });
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("a listener runtime error closes only that listener and marks it unavailable", async () => {
  const setup = await fixture();
  const server = new FakeHttpsServer();
  try {
    const runtime = createBrowserRuntime({
      setup: setup.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
      createServer: fakeFactory(server, []),
    });
    await runtime.start();
    assert.equal(runtime.current().status, "ready");
    server.emit("error", new Error("private runtime detail"));
    assert.deepEqual(runtime.current(), {
      status: "unavailable",
      reason: "listener_unavailable",
    });
    assert.ok(server.shutdowns >= 1);
    await runtime.shutdown();
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("startup failures are redacted and classified without rejecting", async () => {
  const identity = await fixture();
  const assetFailure = await fixture();
  const authFailure = await fixture();
  const listenerFailure = await fixture();
  try {
    await writeFile(join(identity.stateDir, BROWSER_CONFIG), "invalid", { mode: 0o600 });
    const identityRuntime = createBrowserRuntime({
      setup: identity.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
    });
    await identityRuntime.start();
    assert.deepEqual(identityRuntime.current(), {
      status: "unavailable",
      reason: "identity_unavailable",
    });

    const assetRuntime = createBrowserRuntime({
      setup: assetFailure.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => {
        throw new Error("private asset path");
      },
    });
    await assetRuntime.start();
    assert.deepEqual(assetRuntime.current(), {
      status: "unavailable",
      reason: "assets_unavailable",
    });

    await writeFile(join(authFailure.stateDir, BROWSER_AUTH_FILE), "corrupt", { mode: 0o600 });
    const authRuntime = createBrowserRuntime({
      setup: authFailure.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
    });
    await authRuntime.start();
    assert.deepEqual(authRuntime.current(), {
      status: "unavailable",
      reason: "auth_unavailable",
    });

    const failedServer = new FakeHttpsServer();
    failedServer.failListen = true;
    const listenerRuntime = createBrowserRuntime({
      setup: listenerFailure.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => assets,
      createServer: fakeFactory(failedServer, []),
    });
    await listenerRuntime.start();
    assert.deepEqual(listenerRuntime.current(), {
      status: "unavailable",
      reason: "listener_unavailable",
    });
  } finally {
    await Promise.all(
      [identity, assetFailure, authFailure, listenerFailure].map((item) =>
        rm(item.stateDir, { recursive: true, force: true }),
      ),
    );
  }
});

test("shutdown returns during asset loading and prevents late auth or listener startup", async () => {
  const setup = await fixture();
  let release!: (value: BrowserAssets) => void;
  let loadingStarted!: () => void;
  const beganLoading = new Promise<void>((resolve) => {
    loadingStarted = resolve;
  });
  const loading = new Promise<BrowserAssets>((resolve) => {
    release = resolve;
  });
  let factories = 0;
  try {
    const runtime = createBrowserRuntime({
      setup: setup.environment,
      bindHost: "127.0.0.1",
      loadAssets: () => {
        loadingStarted();
        return loading;
      },
      createServer: (options) => {
        factories += 1;
        return fakeFactory(new FakeHttpsServer(), [])(options);
      },
    });
    const starting = runtime.start();
    await beganLoading;
    const stopping = runtime.shutdown();
    assert.equal(
      await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]),
      true,
    );
    assert.deepEqual(runtime.current(), { status: "disabled" });
    release(assets);
    await Promise.all([starting, stopping]);
    assert.equal(factories, 0);
    assert.deepEqual(runtime.current(), { status: "disabled" });
    await assert.rejects(readFile(join(setup.stateDir, BROWSER_AUTH_FILE)), /ENOENT/);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("shutdown returns during a hung identity read and prevents late auth initialization", async () => {
  const setup = await fixture();
  const originalGet = setup.secrets.get.bind(setup.secrets);
  let readStarted!: () => void;
  let releaseRead!: (key: string) => void;
  const beganReading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const pendingKey = new Promise<string>((resolve) => {
    releaseRead = resolve;
  });
  setup.secrets.get = async (account) => {
    if (account !== BROWSER_SERVER_KEY) return originalGet(account);
    readStarted();
    return pendingKey;
  };
  let assetLoads = 0;
  let factories = 0;
  try {
    const runtime = createBrowserRuntime({
      setup: setup.environment,
      bindHost: "127.0.0.1",
      loadAssets: async () => {
        assetLoads += 1;
        return assets;
      },
      createServer: (options) => {
        factories += 1;
        return fakeFactory(new FakeHttpsServer(), [])(options);
      },
    });
    const starting = runtime.start();
    await beganReading;
    assert.equal(
      await Promise.race([
        runtime.shutdown().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]),
      true,
    );
    assert.deepEqual(runtime.current(), { status: "disabled" });
    releaseRead(setup.secrets.values.get(BROWSER_SERVER_KEY)!);
    await starting;
    assert.equal(assetLoads, 0);
    assert.equal(factories, 0);
    await assert.rejects(readFile(join(setup.stateDir, BROWSER_AUTH_FILE)), /ENOENT/);
  } finally {
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
