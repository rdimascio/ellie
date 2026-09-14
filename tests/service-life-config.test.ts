import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import test from "node:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAmbientServiceLifeConfig,
  configureServiceLife,
  selectedServiceLifeConfig,
} from "../apps/cli/src/service-life-config.ts";

const execute = promisify(execFile);

test("service run strips only ambient Life selection", () => {
  const environment = { ELLIE_LIFE_CONFIG: "/private/ambient.json", KEEP: "yes" };
  clearAmbientServiceLifeConfig(environment);
  assert.deepEqual(environment, { KEEP: "yes" });
});

test("service Life selection persists, reloads, disables and serializes updates", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    config = join(root, "life.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600 });
  assert.equal(await selectedServiceLifeConfig(state), undefined);
  let validated = "";
  assert.equal(
    await configureServiceLife(state, config, (path) => {
      validated = path;
    }),
    "enabled",
  );
  assert.equal(validated, config);
  assert.equal(await selectedServiceLifeConfig(state), config);
  assert.deepEqual(JSON.parse(await readFile(join(state, "service-life-config.json"), "utf8")), {
    version: 1,
    lifeConfig: config,
  });

  await writeFile(join(state, "service-life-config.lock"), "held\n", { mode: 0o600 });
  await assert.rejects(
    configureServiceLife(state, undefined, () => {}),
    /active/,
  );
  assert.equal(await selectedServiceLifeConfig(state), config);
  await rm(join(state, "service-life-config.lock"));
  await rm(config);
  assert.equal(await configureServiceLife(state, undefined, () => {}), "disabled");
  assert.equal(await selectedServiceLifeConfig(state), undefined);
});

test("service Life selection preserves unsafe and malformed evidence", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-unsafe-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    config = join(root, "life.json"),
    pointer = join(state, "service-life-config.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600 });
  for (const bytes of [
    "{}\n",
    '{"version":2,"lifeConfig":"/x"}\n',
    '{"version":1,"lifeConfig":"relative"}\n',
    `{"version":1,"version":1,"lifeConfig":${JSON.stringify(config)}}\n`,
  ]) {
    await writeFile(pointer, bytes, { mode: 0o600 });
    await assert.rejects(selectedServiceLifeConfig(state));
    assert.equal(await readFile(pointer, "utf8"), bytes);
    await rm(pointer);
  }
  await writeFile(pointer, "{}\n", { mode: 0o644 });
  await assert.rejects(configureServiceLife(state, undefined, () => {}));
  assert.equal((await lstat(pointer)).mode & 0o777, 0o644);
  await rm(pointer);
  execFileSync("/usr/bin/mkfifo", [pointer]);
  await assert.rejects(selectedServiceLifeConfig(state));
  await rm(pointer);
  await symlink(config, pointer);
  await assert.rejects(selectedServiceLifeConfig(state));
  assert.equal((await lstat(pointer)).isSymbolicLink(), true);
  await rm(pointer);
  await chmod(state, 0o755);
  await assert.rejects(
    configureServiceLife(state, config, () => {}),
    /unsafe/,
  );
});

test("service Life selection rejects noncanonical paths and validation failures without publication", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-path-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    config = join(root, "life.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600 });
  await assert.rejects(
    configureServiceLife(state, `${root}/./life.json`, () => {}),
    /canonical/,
  );
  await assert.rejects(configureServiceLife(state, `/${"a".repeat(5000)}`, () => {}));
  await assert.rejects(
    configureServiceLife(state, config, () => {
      throw new Error("bad config");
    }),
    /bad config/,
  );
  assert.equal(await selectedServiceLifeConfig(state), undefined);
});

test("configuration refuses parent and lock substitution without deleting foreign evidence", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-race-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    displaced = join(root, "displaced"),
    config = join(root, "life.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600 });
  await assert.rejects(
    configureServiceLife(state, config, () => {
      renameSync(state, displaced);
      mkdirSync(state, { mode: 0o700 });
    }),
    /changed/,
  );
  assert.equal(await selectedServiceLifeConfig(state), undefined);
  assert.equal((await lstat(join(displaced, "service-life-config.lock"))).isFile(), true);

  await rm(state, { recursive: true });
  await mkdir(state, { mode: 0o700 });
  await assert.rejects(
    configureServiceLife(state, config, () => {
      unlinkSync(join(state, "service-life-config.lock"));
      writeFileSync(join(state, "service-life-config.lock"), "foreign\n", { mode: 0o600 });
    }),
    /lock changed/,
  );
  assert.equal((await lstat(join(state, "service-life-config.lock"))).isFile(), true);
});

test("configuration preserves pointer creation, replacement, and in-place mutation races", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-pointer-race-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    first = join(root, "first.json"),
    second = join(root, "second.json"),
    pointer = join(state, "service-life-config.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(first, "{}\n", { mode: 0o600 });
  await writeFile(second, "{}\n", { mode: 0o600 });
  const foreign = Buffer.from("foreign-pointer-evidence\n");
  await assert.rejects(
    configureServiceLife(state, first, () =>
      writeFileSync(pointer, foreign.subarray(0, -1), { mode: 0o600 }),
    ),
  );
  assert.deepEqual(await readFile(pointer), foreign.subarray(0, -1));
  await rm(pointer);

  await configureServiceLife(state, first, () => {});
  const replacement = Buffer.from("foreign-replacement\n");
  await assert.rejects(
    configureServiceLife(state, second, () => {
      unlinkSync(pointer);
      writeFileSync(pointer, replacement, { mode: 0o600 });
    }),
  );
  assert.deepEqual(await readFile(pointer), replacement);
  await rm(pointer);

  await configureServiceLife(state, first, () => {});
  const mutated = Buffer.from("changed-in-place-evidence\n");
  await assert.rejects(
    configureServiceLife(state, second, () => {
      writeFileSync(pointer, mutated);
      chmodSync(pointer, 0o600);
    }),
  );
  assert.deepEqual(await readFile(pointer), mutated);
});

test("restrictive umask still publishes exact private readable metadata", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-umask-")));
  t.after(() => rm(root, { recursive: true }));
  const state = join(root, "state"),
    config = join(root, "life.json");
  await mkdir(state, { mode: 0o700 });
  await writeFile(config, "{}\n", { mode: 0o600 });
  const script = `import {stat} from 'node:fs/promises';import {statSync} from 'node:fs';import {configureServiceLife} from ${JSON.stringify(new URL("../apps/cli/src/service-life-config.ts", import.meta.url).href)};process.umask(0o277);let lockMode;await configureServiceLife(process.argv[1],process.argv[2],()=>{lockMode=statSync(process.argv[1]+'/service-life-config.lock').mode&0o777});console.log(lockMode,(await stat(process.argv[1]+'/service-life-config.json')).mode&0o777);`;
  const result = await execute(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script, state, config],
    { timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  assert.equal(result.stdout.trim(), "384 384");
});

test("real CLI configures and disables Life without credentials or service mutation", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ellie-service-life-cli-")));
  t.after(() => rm(root, { recursive: true }));
  const lifeState = join(root, "life-state"),
    config = join(root, "life.json"),
    serviceState = join(root, ".ellie"),
    identity = join(serviceState, "server.json"),
    identityBytes = Buffer.from("synthetic-existing-identity-evidence\n");
  await mkdir(lifeState, { mode: 0o700 });
  await mkdir(serviceState, { mode: 0o700 });
  await writeFile(identity, identityBytes, { mode: 0o600 });
  await writeFile(
    config,
    `${JSON.stringify({ version: 1, stateDir: lifeState, actorId: "alice" })}\n`,
    { mode: 0o600 },
  );
  const cli = new URL("../apps/cli/src/main.ts", import.meta.url).pathname;
  const environment = { HOME: root, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root };
  const invoke = (args: string[]) =>
    execute(process.execPath, ["--experimental-strip-types", cli, ...args], {
      env: environment,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  const enabled = await invoke(["service", "configure", "coordinator", "--life-config", config]);
  assert.match(enabled.stdout, /enabled; changes apply on the next explicit restart/);
  assert.equal(await selectedServiceLifeConfig(join(root, ".ellie")), config);
  const disabled = await invoke(["service", "configure", "coordinator", "--disable-life"]);
  assert.match(disabled.stdout, /disabled; changes apply on the next explicit restart/);
  assert.equal(await selectedServiceLifeConfig(join(root, ".ellie")), undefined);
  await assert.rejects(invoke(["service", "configure", "node", "--life-config", config]));
  await chmod(config, 0o644);
  await assert.rejects(
    invoke(["service", "configure", "coordinator", "--life-config", config]),
    (error: unknown) => {
      assert.match(
        String((error as { stderr?: string }).stderr),
        /Review the private Life config.*--disable-life/,
      );
      assert.doesNotMatch(String((error as { stderr?: string }).stderr), new RegExp(root));
      return true;
    },
  );
  assert.equal(await selectedServiceLifeConfig(join(root, ".ellie")), undefined);
  await assert.rejects(invoke(["service", "configure", "coordinator", "--unknown"]));
  await assert.rejects(
    invoke(["service", "configure", "coordinator", "--life-config", join(root, "missing.json")]),
    (error: unknown) => {
      const message = String((error as { stderr?: string }).stderr);
      assert.match(
        message,
        /Life config file is unavailable.*Review the selected private Life config/,
      );
      assert.doesNotMatch(message, /server init|node pair/);
      assert.doesNotMatch(message, new RegExp(root));
      return true;
    },
  );
  await chmod(config, 0o600);
  await writeFile(
    config,
    `${JSON.stringify({ version: 1, stateDir: lifeState, actorId: "alice", googleOAuthClientFile: join(root, "missing-oauth.json") })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    invoke(["service", "configure", "coordinator", "--life-config", config]),
    (error: unknown) => {
      assert.match(
        String((error as { stderr?: string }).stderr),
        /Review the private Life config.*--disable-life/,
      );
      return true;
    },
  );
  assert.deepEqual(await readFile(identity), identityBytes);
});
