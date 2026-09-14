import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { test } from "node:test";
import {
  builtInManifest,
  groupStorageKey,
  groupStoragePrefix,
  MLBAdapter,
  PluginStore,
  validateManifest,
} from "../packages/life-plugins/src/index.ts";

test("plugins persist versioned capabilities and private score storage with guarded rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-plugins-test-"));
  let store = new PluginStore(join(directory, "plugins.sqlite"));
  try {
    const manifest = builtInManifest(
      "Build a first person arcade shooter with a high score widget",
    )!;
    const plugin = store.install("user:alice", manifest);
    assert.equal(plugin.kind, "arcade");
    assert.equal(store.storageSet("user:alice", plugin.id, "highScore", 300), 300);
    assert.equal(store.storageSet("user:alice", plugin.id, "highScore", 100), 300);
    assert.throws(() => store.get("user:bob", plugin.id));
    assert.throws(() => store.storageGet("user:bob", plugin.id, "highScore"));
    assert.throws(() => store.storageSet("user:alice", plugin.id, "highScore", -1));
    assert.throws(() =>
      store.update("user:alice", plugin.id, 1, {
        ...manifest,
        capabilities: ["storage", "mlb.read"],
      }),
    );
    const revision = store.update("user:alice", plugin.id, 1, { ...manifest, name: "Space break" });
    assert.equal(revision.version, 2);
    assert.throws(() => store.history("user:bob", plugin.id));
    assert.deepEqual(
      store.history("user:alice", plugin.id).map((item) => [item.version, item.name, item.active]),
      [
        [2, "Space break", true],
        [1, manifest.name, false],
      ],
    );
    assert.throws(() => store.update("user:alice", plugin.id, 1, manifest));
    assert.equal(store.rollback("user:alice", plugin.id, 2, 1).name, manifest.name);
    store.close();
    store = new PluginStore(join(directory, "plugins.sqlite"));
    assert.equal(store.get("user:alice", plugin.id).version, 3);
    assert.equal(store.history("user:alice", plugin.id)[0]?.name, manifest.name);
    assert.equal(store.storageGet("user:alice", plugin.id, "highScore"), 300);
    assert.equal(store.list("user:bob").length, 0);
    store.remove("user:alice", plugin.id);
    assert.throws(() => store.storageGet("user:alice", plugin.id, "highScore"));
    assert.throws(() => store.rollback("user:alice", plugin.id, 3, 1));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plugin manifests bound generated UI and storage, and shipped inline programs parse", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-plugins-validation-"));
  const store = new PluginStore(join(directory, "plugins.sqlite"));
  try {
    assert.equal(builtInManifest("Build me something unknown"), undefined);
    assert.throws(() =>
      validateManifest({
        name: "Bad",
        description: "Bad",
        kind: "custom",
        capabilities: ["shell"],
        html: "<h1>Hello</h1>",
      }),
    );
    assert.throws(() =>
      validateManifest({
        name: "Bad",
        description: "Bad",
        kind: "custom",
        capabilities: [],
        html: "x".repeat(160001),
      }),
    );
    for (const request of ["arcade shooter", "MLB standings"]) {
      const plugin = store.install("user:alice", builtInManifest(request)!);
      const html = store.view("user:alice", plugin.id);
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      assert.ok(scripts.length);
      for (const script of scripts) assert.doesNotThrow(() => new Script(script[1]!));
      if (plugin.kind === "mlb")
        assert.throws(() => store.storageGet("user:alice", plugin.id, "key"));
    }
    const custom = store.install("user:alice", {
      name: "Small app",
      description: "A local widget",
      kind: "custom",
      capabilities: ["storage"],
      html: "<h1>My app</h1>",
    });
    assert.throws(() => store.storageSet("user:alice", custom.id, "large", "x".repeat(20000)));
    assert.equal(store.storageSet("user:alice", custom.id, "counter", 7), 7);
    assert.throws(() =>
      store.update("user:alice", custom.id, 1, {
        name: "Broken candidate",
        description: "Should never activate",
        kind: "custom",
        capabilities: ["storage"],
        html: "<script>function (</script>",
      }),
    );
    assert.equal(store.get("user:alice", custom.id).version, 1);
    assert.equal("html" in store.history("user:alice", custom.id)[0]!, false);
    assert.equal(store.storageGet("user:alice", custom.id, "counter"), 7);
    const shared = store.install("group:home", builtInManifest("arcade shooter")!);
    store.storageSet("group:home", shared.id, "user:alice:highScore", 500);
    store.storageSet("group:home", shared.id, "user:bob:highScore", 200);
    assert.equal(store.storageSet("group:home", shared.id, "user:alice:highScore", 100), 500);
    assert.equal(store.storageGet("group:home", shared.id, "user:bob:highScore"), 200);
    const longKey = `user:${"a".repeat(180)}@home:highScore`;
    assert.equal(store.storageSet("group:home", shared.id, longKey, 25), 25);
    assert.equal(store.storageSet("group:home", shared.id, longKey, 3), 25);
    assert.throws(() => store.storageSet("group:home", shared.id, longKey, -1));
    const alice = groupStorageKey("alice", "bob:highScore"),
      bob = groupStorageKey("alice:bob", "highScore");
    assert.notEqual(alice, bob);
    assert.equal(bob.startsWith(groupStoragePrefix("alice")), false);
    assert.equal(groupStorageKey("a".repeat(200), "highScore").length < 512, true);
    store.storageSet("group:home", shared.id, alice, 5);
    store.storageSet("group:home", shared.id, bob, 50);
    assert.equal(store.storageSet("group:home", shared.id, bob, 2), 50);
    assert.equal(store.storageGet("group:home", shared.id, alice), 5);
    assert.throws(() => groupStoragePrefix("invalid user"));
    assert.throws(() => groupStorageKey("alice", "x".repeat(512)));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("revision history is bounded without losing current code or stored data", () => {
  const directory = mkdtempSync(join(tmpdir(), "ellie-plugin-history-"));
  const store = new PluginStore(join(directory, "plugins.sqlite"));
  try {
    const owner = `user:${"a".repeat(190)}@home`;
    let plugin = store.install(owner, builtInManifest("arcade")!);
    store.storageSet(owner, plugin.id, "highScore", 100);
    for (let revision = 0; revision < 102; revision++)
      plugin = store.update(owner, plugin.id, plugin.version, {
        ...builtInManifest("arcade")!,
        name: `Arcade ${revision}`,
      });
    assert.equal(store.history(owner, plugin.id).length, 100);
    assert.equal(store.history(owner, plugin.id).at(-1)?.version, 4);
    assert.throws(() => store.rollback(owner, plugin.id, plugin.version, 1));
    assert.equal(
      store.rollback(owner, plugin.id, plugin.version, plugin.version - 1).name,
      "Arcade 100",
    );
    assert.equal(store.storageGet(owner, plugin.id, "highScore"), 100);
    assert.throws(() => store.list("not-an-owner"));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("MLB limits simultaneous distinct refreshes while coalescing the same date", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter = new MLBAdapter(async (url) => {
    calls++;
    await gate;
    return Response.json(String(url).includes("standings") ? { records: [] } : { dates: [] });
  });
  const pending = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"].map((date) =>
    adapter.snapshot(date),
  );
  const duplicate = adapter.snapshot("2026-09-01");
  assert.equal(calls, 8);
  assert.match((await adapter.snapshot("2026-09-05")).error!, /busy/);
  assert.equal(calls, 8);
  release();
  const results = await Promise.all([...pending, duplicate]);
  assert.equal(
    results.every((result) => !result.stale),
    true,
  );
});

test("MLB adapter requests only fixed providers, caches simultaneous reads, and labels stale results", async () => {
  let now = 100000,
    calls = 0,
    fail = false;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    const url = String(input);
    assert.ok(url.startsWith("https://statsapi.mlb.com/api/v1/"));
    if (fail) throw new Error("network unavailable");
    return Response.json(
      url.includes("/standings")
        ? {
            records: [
              {
                division: { name: "AL West" },
                teamRecords: [
                  {
                    team: { id: 1, name: "Synthetic Stars" },
                    wins: 90,
                    losses: 50,
                    winningPercentage: ".643",
                    gamesBack: "-",
                  },
                ],
              },
            ],
          }
        : {
            dates: [
              {
                games: [
                  {
                    gamePk: 7,
                    gameDate: "2026-09-13T20:00:00Z",
                    status: { detailedState: "In Progress" },
                    teams: {
                      away: { team: { name: "Away" }, score: 2 },
                      home: { team: { name: "Home" }, score: 3 },
                    },
                    linescore: { currentInning: 7, inningHalf: "Top" },
                  },
                ],
              },
            ],
          },
    );
  };
  const adapter = new MLBAdapter(fetcher, () => now);
  const [one, two] = await Promise.all([
    adapter.snapshot("2026-09-13"),
    adapter.snapshot("2026-09-13"),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(one, two);
  assert.equal(one.games[0]?.homeScore, 3);
  assert.equal(one.standings[0]?.teams[0]?.name, "Synthetic Stars");
  one.games.length = 0;
  assert.equal((await adapter.snapshot("2026-09-13")).games.length, 1);
  assert.equal(calls, 2);
  now += 61000;
  fail = true;
  const stale = await adapter.snapshot("2026-09-13");
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
  assert.equal(stale.games.length, 1);
  assert.equal(stale.updatedAt, 100000);
  const unavailable = await adapter.snapshot("2026-09-14");
  assert.equal(unavailable.updatedAt, 0);
  assert.equal(unavailable.games.length, 0);
  assert.ok(unavailable.error);
  await assert.rejects(adapter.snapshot("2026-02-31"));
  await assert.rejects(adapter.snapshot("https://example.com"));
});
