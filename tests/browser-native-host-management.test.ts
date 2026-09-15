import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  browserNativeHostPreflight,
  installBrowserNativeHost,
  uninstallBrowserNativeHost,
} from "../apps/cli/src/browser-native-host-management.ts";
import { browserWebMCPHostInstallationPlan } from "../scripts/browser-webmcp-host-setup.ts";
import { stageApplication } from "../scripts/build-service-payload.mjs";

async function materializeProductionDependencies(
  repository: string,
  source: string,
): Promise<void> {
  const workspaces = new Map<string, string>();
  for (const area of ["apps", "packages"]) {
    for (const name of await readdir(join(source, area))) {
      const directory = join(source, area, name);
      try {
        const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (typeof value.name === "string") workspaces.set(value.name, directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  const queue = ["@ellie/cli", "@ellie/node", "@ellie/server"];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const directory = workspaces.get(name) ?? join(repository, "node_modules", name);
    const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    for (const dependency of Object.keys(value.dependencies ?? {})) queue.push(dependency);
    if (!workspaces.has(name)) {
      await cp(await realpath(directory), join(source, "node_modules", name), { recursive: true });
    }
  }
}

async function fixture(t: test.TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "ellie-browser-host-")));
  let complete = false;
  t.after(async () => {
    if (complete) {
      await chmod(join(home, "captured-release"), 0o700).catch(() => {});
      await rm(home, { recursive: true, maxRetries: 3, retryDelay: 10 });
    } else process.stderr.write(`retained browser host fixture: ${home}\n`);
  });
  const release = join(home, "captured-release");
  await mkdir(join(release, "payload/bin"), { recursive: true, mode: 0o700 });
  const launcher = Buffer.from("#!/bin/sh\nexit 1\n");
  await writeFile(join(release, "payload/bin/ellie-browser-webmcp-host"), launcher, {
    mode: 0o555,
  });
  await writeFile(
    join(release, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      productVersion: "0.1.0",
      sourceRevision: "a".repeat(40),
      sourceModified: false,
      platform: "darwin",
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      minimumOS: "14.0",
      lockSha256: "b".repeat(64),
      runtime: {
        version: "v24.21.0",
        architecture: process.arch === "arm64" ? "arm64" : "x64",
        sha256: "c".repeat(64),
      },
      helper: { identifier: "org.ellie.helper", signature: "development-ad-hoc" },
      launchers: [
        {
          role: "coordinator",
          name: "Ellie Coordinator",
          identifier: "org.ellie.assistant.coordinator.app",
          signature: "development-ad-hoc",
          architecture: process.arch === "arm64" ? "arm64" : "x64",
          minimumOS: "14.0",
        },
        {
          role: "node",
          name: "Ellie Node",
          identifier: "org.ellie.assistant.node.app",
          signature: "development-ad-hoc",
          architecture: process.arch === "arm64" ? "arm64" : "x64",
          minimumOS: "14.0",
        },
      ],
      components: [],
      files: [
        {
          path: "bin/ellie-browser-webmcp-host",
          mode: 0o755,
          size: launcher.length,
          sha256: createHash("sha256").update(launcher).digest("hex"),
        },
      ],
    })}\n`,
    { mode: 0o444 },
  );
  await writeFile(
    join(release, "SOURCE.txt"),
    `Ellie service payload\nSource revision: ${"a".repeat(40)}\nNode.js: v24.21.0\nNode archive SHA-256: ${"c".repeat(64)}\nMinimum macOS: 14.0\nHelper: org.ellie.helper (development-ad-hoc)\n`,
    { mode: 0o444 },
  );
  await chmod(release, 0o555);
  await mkdir(join(home, "Library/Application Support/Arc/User Data"), {
    recursive: true,
    mode: 0o700,
  });
  return { home, release, done: () => (complete = true) };
}

test("Arc native host install is explicit, exact, idempotent, and reversibly owned", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await browserNativeHostPreflight(f.home, f.release), {
    version: 1,
    browser: "arc",
    status: "absent",
    ready: true,
  });
  await installBrowserNativeHost(f.home, f.release);
  const plan = browserWebMCPHostInstallationPlan(f.release);
  const manifestPath = join(
    f.home,
    "Library/Application Support/Arc/User Data/NativeMessagingHosts",
    plan.manifestName,
  );
  assert.equal(await readFile(manifestPath, "utf8"), plan.manifest);
  assert.equal((await lstat(manifestPath)).mode & 0o777, 0o600);
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "installed");
  await installBrowserNativeHost(f.home, f.release);
  await uninstallBrowserNativeHost(f.home, f.release);
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "absent");
  await uninstallBrowserNativeHost(f.home, f.release);
  f.done();
});

test("install preserves an existing unowned or different manifest", async (t) => {
  const f = await fixture(t);
  const plan = browserWebMCPHostInstallationPlan(f.release);
  const directory = join(f.home, "Library/Application Support/Arc/User Data/NativeMessagingHosts");
  await mkdir(directory, { mode: 0o700 });
  const manifest = join(directory, plan.manifestName);
  await writeFile(manifest, "foreign\n", { mode: 0o600 });
  await assert.rejects(installBrowserNativeHost(f.home, f.release), /unowned/);
  assert.equal(await readFile(manifest, "utf8"), "foreign\n");
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "conflict");
  f.done();
});

test("unsafe manifest and ownership paths are rejected without replacement", async (t) => {
  const f = await fixture(t);
  const plan = browserWebMCPHostInstallationPlan(f.release);
  const directory = join(f.home, "Library/Application Support/Arc/User Data/NativeMessagingHosts");
  await mkdir(directory, { mode: 0o700 });
  const target = join(f.home, "foreign");
  await writeFile(target, "foreign\n", { mode: 0o600 });
  await symlink(target, join(directory, plan.manifestName));
  await assert.rejects(installBrowserNativeHost(f.home, f.release), /unsafe/);
  assert.equal(await readFile(target, "utf8"), "foreign\n");
  f.done();
});

test("uninstall preserves changed owned evidence and launcher mismatch", async (t) => {
  const f = await fixture(t);
  await installBrowserNativeHost(f.home, f.release);
  const plan = browserWebMCPHostInstallationPlan(f.release);
  const manifest = join(
    f.home,
    "Library/Application Support/Arc/User Data/NativeMessagingHosts",
    plan.manifestName,
  );
  await writeFile(manifest, "changed\n", { mode: 0o600 });
  await assert.rejects(uninstallBrowserNativeHost(f.home, f.release), /changed/);
  assert.equal(await readFile(manifest, "utf8"), "changed\n");
  const launcher = join(f.release, "payload/bin/ellie-browser-webmcp-host");
  await chmod(launcher, 0o600);
  await writeFile(launcher, "changed launcher\n");
  await chmod(launcher, 0o555);
  await assert.rejects(uninstallBrowserNativeHost(f.home, f.release), /release metadata/);
  assert.equal(await readFile(manifest, "utf8"), "changed\n");
  f.done();
});

test("known interrupted phase resumes while a retained lock blocks every mutation", async (t) => {
  const f = await fixture(t);
  await installBrowserNativeHost(f.home, f.release);
  const state = join(f.home, ".ellie/browser-native-hosts");
  const recordPath = join(state, "arc-native-host.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, `${JSON.stringify({ ...record, phase: "installing" })}\n`, {
    mode: 0o600,
  });
  const plan = browserWebMCPHostInstallationPlan(f.release);
  const manifest = join(
    f.home,
    "Library/Application Support/Arc/User Data/NativeMessagingHosts",
    plan.manifestName,
  );
  await rm(manifest);
  await installBrowserNativeHost(f.home, f.release);
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "installed");
  const lock = join(state, "arc-native-host.lock");
  await writeFile(lock, "retained uncertain owner\n", { mode: 0o600 });
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "recovery_required");
  await assert.rejects(installBrowserNativeHost(f.home, f.release), /retained lock evidence/);
  assert.equal(await readFile(lock, "utf8"), "retained uncertain owner\n");
  f.done();
});

test("a lock-free uninstalling phase completes without touching unrelated state", async (t) => {
  const f = await fixture(t);
  await installBrowserNativeHost(f.home, f.release);
  const state = join(f.home, ".ellie/browser-native-hosts");
  const recordPath = join(state, "arc-native-host.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  await writeFile(recordPath, `${JSON.stringify({ ...record, phase: "uninstalling" })}\n`, {
    mode: 0o600,
  });
  const unrelated = join(f.home, ".ellie/identity-evidence");
  await writeFile(unrelated, "preserve exactly\n", { mode: 0o600 });
  await uninstallBrowserNativeHost(f.home, f.release);
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "absent");
  assert.equal(await readFile(unrelated, "utf8"), "preserve exactly\n");
  f.done();
});

test("a retained ownership stage blocks install and uninstall and is preserved exactly", async (t) => {
  const f = await fixture(t);
  await installBrowserNativeHost(f.home, f.release);
  const stage = join(f.home, ".ellie/browser-native-hosts/.arc-native-host.json.stage");
  const evidence = "retained partial publication\n";
  await writeFile(stage, evidence, { mode: 0o600 });
  assert.equal((await browserNativeHostPreflight(f.home, f.release)).status, "recovery_required");
  await assert.rejects(installBrowserNativeHost(f.home, f.release), /retained stage evidence/);
  await assert.rejects(uninstallBrowserNativeHost(f.home, f.release), /retained stage evidence/);
  assert.equal(await readFile(stage, "utf8"), evidence);
  f.done();
});

test("the actual staged application imports and invokes native-host preflight", async (t) => {
  const f = await fixture(t);
  const repository = await realpath(new URL("..", import.meta.url).pathname);
  const source = join(f.home, "source");
  await mkdir(source, { mode: 0o700 });
  for (const name of ["apps", "packages", "package.json", "bun.lock", "LICENSE"])
    await cp(join(repository, name), join(source, name), { recursive: true });
  await materializeProductionDependencies(repository, source);
  await mkdir(join(source, "apps/command-center/dist"), { recursive: true });
  await writeFile(join(source, "apps/command-center/dist/index.html"), "fixture\n");
  await mkdir(join(source, "apps/life-ui/dist/assets"), { recursive: true });
  await writeFile(join(source, "apps/life-ui/dist/index.html"), "fixture\n");
  await writeFile(join(source, "apps/life-ui/dist/assets/main.js"), "export {};\n");
  const payload = join(f.home, "staged-payload");
  await mkdir(join(payload, "LICENSES"), { recursive: true, mode: 0o700 });
  await stageApplication(source, payload);
  const result = spawnSync(
    process.execPath,
    [
      join(payload, "lib/ellie/apps/cli/src/main.ts"),
      "browser-webmcp",
      "host",
      "preflight",
      "--browser",
      "arc",
      "--release",
      f.release,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: { HOME: f.home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    browser: "arc",
    status: "absent",
    ready: true,
  });
  f.done();
});
