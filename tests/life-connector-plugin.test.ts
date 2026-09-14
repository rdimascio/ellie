import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorPluginRegistry,
  validateConnectorPluginManifest,
  type ConnectorPluginManifest,
} from "../packages/life-plugins/src/connectors.ts";
import type {
  LifeProviderAdapter,
  ProviderPullResult,
} from "../packages/life-connectors/src/provider-types.ts";

function manifest(): ConnectorPluginManifest {
  return {
    id: "google-calendar",
    label: "Google Calendar",
    version: 1,
    kind: "connector",
    observationKinds: ["event"],
    auth: "google-oauth",
    scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    origins: ["https://www.googleapis.com"],
  };
}

function adapter(): LifeProviderAdapter {
  return {
    id: "google-calendar",
    async identity() {
      return { accountId: "account-a" };
    },
    async pull() {
      return { accountId: "account-a", items: [], cursor: "cursor", complete: true };
    },
  };
}

test("host connector registration preserves metadata and returns independent public snapshots", async () => {
  const registry = new ConnectorPluginRegistry(),
    source = manifest(),
    implementation = adapter();
  registry.register(source, implementation);
  source.origins.push("https://example.com");
  source.label = "Changed outside registry";
  const listed = registry.list();
  listed[0]!.scopes.length = 0;
  listed[0]!.observationKinds.push("transaction");
  listed.length = 0;
  assert.deepEqual(registry.list(), [manifest()]);
  const returned = registry.adapters();
  returned.length = 0;
  assert.equal(registry.adapters().length, 1);
  implementation.identity = async () => ({ accountId: "mutated" });
  assert.deepEqual(
    await registry
      .adapters()[0]!
      .identity({ accessToken: "synthetic-secret" }, new AbortController().signal),
    { accountId: "account-a" },
  );
  assert.throws(() => {
    (registry.adapters()[0] as { id: string }).id = "changed";
  }, TypeError);
  assert.doesNotMatch(
    JSON.stringify(registry.list()),
    /synthetic-secret|accessToken|identity|pull/,
  );
});

test("duplicate, mismatched and declarative-only adapters cannot register", () => {
  const registry = new ConnectorPluginRegistry();
  registry.register(manifest(), adapter());
  assert.throws(() => registry.register(manifest(), adapter()), /already registered/);
  assert.throws(
    () => new ConnectorPluginRegistry().register(manifest(), { ...adapter(), id: "gmail" }),
    /does not match/,
  );
  assert.throws(
    () =>
      new ConnectorPluginRegistry().register(manifest(), {
        id: "google-calendar",
        module: "https://example.com/plugin.js",
      } as never),
    /does not match/,
  );
  assert.throws(
    () => new ConnectorPluginRegistry().register(manifest(), undefined as never),
    /does not match/,
  );
});

test("widget capabilities, credentials, executable fields and oversized declarations are rejected", () => {
  for (const field of [
    "capabilities",
    "allowedCapabilities",
    "tools",
    "html",
    "code",
    "module",
    "credentials",
    "accessToken",
    "clientSecret",
    "iframe",
  ]) {
    assert.throws(
      () => validateConnectorPluginManifest({ ...manifest(), [field]: "synthetic-secret" }),
      (error) => error instanceof TypeError && !error.message.includes("synthetic-secret"),
    );
  }
  for (const patch of [
    { id: "../hidden" },
    { id: "a".repeat(81) },
    { id: "Name With Spaces" },
    { version: 2 },
    { kind: "custom" },
    { auth: "arbitrary-oauth-url" },
    { observationKinds: ["execute"] },
    { observationKinds: ["event", "event"] },
    { scopes: ["Bearer synthetic-secret"] },
    { scopes: Array.from({ length: 17 }, (_, i) => `scope-${i}`) },
    { origins: [] },
  ])
    assert.throws(
      () => validateConnectorPluginManifest({ ...manifest(), ...patch }),
      /manifest is invalid/,
    );
  const getter = { ...manifest() };
  Object.defineProperty(getter, "label", {
    get() {
      throw new Error("Must not execute getter");
    },
    enumerable: true,
  });
  assert.throws(() => validateConnectorPluginManifest(getter), /manifest is invalid/);
});

test("origins cannot target private hosts or carry paths, credentials and non-HTTPS authority", () => {
  for (const origin of [
    "http://www.googleapis.com",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[2001:4860:4860::8888]",
    "https://localhost",
    "https://api.localhost",
    "https://api.local",
    "https://api.internal",
    "https://api.test",
    "https://internal",
    "https://www.googleapis.com/",
    "https://www.googleapis.com/calendar",
    "https://user:password@www.googleapis.com",
    "https://www.googleapis.com?token=secret",
    "https://www.googleapis.com#secret",
    "https://www.googleapis.com:8443",
  ])
    assert.throws(
      () => validateConnectorPluginManifest({ ...manifest(), origins: [origin] }),
      /manifest is invalid/,
    );
  assert.deepEqual(
    validateConnectorPluginManifest({
      ...manifest(),
      origins: ["https://sandbox.plaid.com", "https://production.plaid.com"],
    }).origins,
    ["https://sandbox.plaid.com", "https://production.plaid.com"],
  );
});

test("the registered adapter cannot return observations outside its declared kinds", async () => {
  const registry = new ConnectorPluginRegistry(),
    implementation = adapter();
  const result: ProviderPullResult = {
    accountId: "account-a",
    complete: true,
    cursor: "cursor",
    items: [
      {
        kind: "deleted",
        sourceKey: "message-a",
        sourceRevision: "revision",
        observedAt: 1,
        title: "Deleted message",
        data: { previousKind: "message" },
      },
    ],
  };
  implementation.pull = async () => result;
  registry.register(manifest(), implementation);
  const input = {
    credential: { accessToken: "synthetic-secret" },
    window: { from: 1, to: 2 },
    limit: 1,
    signal: new AbortController().signal,
  };
  await assert.rejects(() => registry.adapters()[0]!.pull(input), /undeclared observation kinds/);
  result.items = [
    {
      kind: "deleted",
      sourceKey: "event-a",
      sourceRevision: "revision",
      observedAt: 1,
      title: "Deleted event",
      data: { previousKind: "event" },
    },
  ];
  assert.equal((await registry.adapters()[0]!.pull(input)).items.length, 1);
});
