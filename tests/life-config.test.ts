import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createLifeActivationGate,
  lifeConfigPath,
  loadLifeHostConfig,
} from "../apps/cli/src/life-config.ts";

test("Life config opt-in is unambiguous", () => {
  assert.equal(lifeConfigPath([], {}), undefined);
  assert.equal(
    lifeConfigPath(["--life-config", "/private/config.json"], {}),
    "/private/config.json",
  );
  assert.equal(lifeConfigPath([], { ELLIE_LIFE_CONFIG: "/private/env.json" }), "/private/env.json");
  assert.throws(
    () => lifeConfigPath(["--life-config", "/a"], { ELLIE_LIFE_CONFIG: "/b" }),
    /either/,
  );
  assert.throws(() => lifeConfigPath(["--unknown", "/a"], {}), /Use:/);
  assert.throws(() => lifeConfigPath(["positional"], {}), /Use:/);
  assert.throws(() => lifeConfigPath([], { ELLIE_LIFE_CONFIG: "" }), /absolute/);
  assert.throws(() => lifeConfigPath(["--life-config", "/a", "--life-config", "/b"], {}), /Use:/);
});

test("private closed Life config validates local model and optional Google client", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-life-config-"));
  const config = join(root, "life.json"),
    google = join(root, "google.json");
  try {
    await writeFile(google, JSON.stringify({ clientId: "fixture.apps.googleusercontent.com" }), {
      mode: 0o600,
    });
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        stateDir: join(root, "state"),
        actorId: "owner",
        modelUrl: "http://127.0.0.1:8000/v1",
        model: "fixture",
        googleOAuthClientFile: google,
      }),
      { mode: 0o600 },
    );
    const loaded = loadLifeHostConfig(config);
    assert.equal(loaded.actorId, "owner");
    assert.equal(loaded.stateDir, join(root, "state"));
    assert.equal(loaded.googleOAuth?.clientId, "fixture.apps.googleusercontent.com");
    await chmod(config, 0o644);
    assert.throws(() => loadLifeHostConfig(config), /0600/);
    await chmod(config, 0o600);
    const link = join(root, "link.json");
    await symlink(config, link);
    assert.throws(() => loadLifeHostConfig(link), /0600/);
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        stateDir: join(root, "state"),
        actorId: "owner",
        assetsDir: "bad",
      }),
      { mode: 0o600 },
    );
    assert.throws(() => loadLifeHostConfig(config), /invalid/);
    await writeFile(
      config,
      JSON.stringify({ version: 1, stateDir: join(homedir(), ".ellie", "life"), actorId: "owner" }),
      { mode: 0o600 },
    );
    assert.throws(() => loadLifeHostConfig(config), /~\/.ellie/);
    await writeFile(config, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    assert.throws(() => loadLifeHostConfig(config), /0600|64 KiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Life activation gate is unavailable until authority-ready startup activates it", async () => {
  const gate = createLifeActivationGate();
  assert.equal(await gate.application.openOwnerSettings(), "unavailable");
  let status = 0,
    body = "";
  const response = {
    writeHead(value: number) {
      status = value;
      return this;
    },
    end(value: string) {
      body = value;
      return this;
    },
  };
  assert.equal(await gate.application.handle({} as never, response as never, {} as never), true);
  assert.equal(status, 503);
  assert.match(body, /starting/);
  let delegated = false;
  let ownerOpened = false;
  gate.activate({
    async handle() {
      delegated = true;
      return true;
    },
    async openOwnerSettings() {
      ownerOpened = true;
      return "opened";
    },
  });
  assert.equal(await gate.application.handle({} as never, response as never, {} as never), true);
  assert.equal(delegated, true);
  assert.equal(await gate.application.openOwnerSettings(), "opened");
  assert.equal(ownerOpened, true);
  assert.throws(
    () =>
      gate.activate({
        async handle() {
          return true;
        },
        async openOwnerSettings() {
          return "opened";
        },
      }),
    /already active/,
  );
});
