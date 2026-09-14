import assert from "node:assert/strict";
import { X509Certificate, createHash, createPrivateKey, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const OLD_REVISION = "004d8ef8baa3e586e5a40ee13781ca663e88683e";
export const NEW_REVISION = "0cb2a4ad6f51ce9195bcc4f79b830f000ed97809";
const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lifecycleSHA256 = "10dec010be9668c60b2bf9313c62ee420fa09c410655014ceb5a03830bf4e40c";
const bootstrapSHA256 = "9fb75874a466953b3602b03492a84bb225633ed0d91ebec4764c3e14faa624c1";
const helperSHA256 = "8d60f91f93aae0acbbe06d5b8311396bf61e1ecfa7eb0c0ee5ec7e1d8f4c539e";
const stageDeadline = 20_000;
const setupDeadline = 120_000;
const maximumSnapshotBytes = 64 * 1024 * 1024;
const additiveFiles = [
  "browser-auth.json",
  "native-auth.json",
  "data-authority.json",
  "household-documents.json",
];
const coreFiles = [
  "server.json",
  "node.json",
  "auth.json",
  "server-cert.pem",
  "node-server-cert.pem",
];
class ProcessCleanupUncertain extends Error {}

const hex = (value, length) =>
  typeof value === "string" &&
  Buffer.byteLength(value) === length &&
  [...Buffer.from(value)].every(
    (byte) => (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102),
  );
export function exactRevision(value) {
  if (!hex(value, 40)) throw new Error("Runtime source revision is invalid.");
  return value;
}
const sha256Data = (data) => createHash("sha256").update(data).digest("hex");
const sha256 = async (path) => sha256Data(await readFile(path));
export async function requireExactSHA256(path, expected) {
  if (!hex(expected, 64) || (await sha256(path)) !== expected)
    throw new Error("Selected rollback fixture input has changed.");
}
const token = () => randomBytes(32).toString("hex");

export async function ownedCommand(lifecycle, file, args, options = {}) {
  const child = lifecycle.launch(file, options.env, options.cwd, args);
  let timer;
  const outcome = await Promise.race([
    child.exited,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timeout: true }), options.timeout ?? stageDeadline);
    }),
  ]);
  clearTimeout(timer);
  try {
    await lifecycle.stop(child);
  } catch {
    throw new ProcessCleanupUncertain(
      `Rollback fixture command cleanup is uncertain: ${file.split("/").at(-1)}.`,
    );
  }
  if (outcome.timeout)
    throw new Error(`Rollback fixture command timed out: ${file.split("/").at(-1)}.`);
  if (outcome.error || outcome.signal || outcome.code !== 0)
    throw new Error(`Rollback fixture command failed: ${file.split("/").at(-1)}.`);
}

async function eventually(check, message, timeout = stageDeadline) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
}

async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

export async function syntheticIdentity(lifecycle, owned) {
  const directory = join(owned, "identity");
  await mkdir(directory, { mode: 0o700 });
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  await ownedCommand(
    lifecycle,
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "2",
      "-subj",
      "/CN=ellie.local",
    ],
    {
      cwd: directory,
      env: { HOME: owned, TMPDIR: owned, PATH: "/usr/bin:/bin" },
      timeout: setupDeadline,
    },
  );
  await Promise.all([chmod(keyPath, 0o600), chmod(certPath, 0o600)]);
  const [key, cert] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
  const certificate = new X509Certificate(cert);
  if (!certificate.checkPrivateKey(createPrivateKey(key)))
    throw new Error("Synthetic TLS identity does not match.");
  return { key, cert };
}

async function snapshot(lifecycle, revision, destination, bun, bunCache, owned) {
  exactRevision(revision);
  const toolEnvironment = {
    HOME: owned,
    TMPDIR: owned,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  await ownedCommand(lifecycle, "/usr/bin/git", ["cat-file", "-e", `${revision}^{commit}`], {
    cwd: source,
    env: toolEnvironment,
  });
  await mkdir(destination, { mode: 0o700 });
  const archive = join(owned, `${revision}.tar`);
  await ownedCommand(
    lifecycle,
    "/usr/bin/git",
    ["archive", "--format=tar", "--output", archive, revision],
    { cwd: source, env: toolEnvironment },
  );
  const archiveInfo = await lstat(archive);
  if (
    !archiveInfo.isFile() ||
    archiveInfo.isSymbolicLink() ||
    archiveInfo.size > maximumSnapshotBytes
  )
    throw new Error("Runtime source snapshot is outside its bound.");
  await ownedCommand(lifecycle, "/usr/bin/tar", ["-xf", archive, "-C", destination], {
    timeout: setupDeadline,
    env: toolEnvironment,
  });
  await rm(archive);
  const installHome = join(owned, `install-${revision}`);
  await mkdir(installHome, { mode: 0o700 });
  const environment = {
    HOME: installHome,
    TMPDIR: installHome,
    BUN_INSTALL_CACHE_DIR: bunCache,
    PATH: `${dirname(process.execPath)}:${dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  await ownedCommand(
    lifecycle,
    bun,
    ["install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
    {
      cwd: destination,
      env: environment,
      timeout: setupDeadline,
      stdio: "ignore",
    },
  );
  return environment;
}

async function initializeAdditiveStores(newSource, state) {
  const [{ BrowserAuth }, { NativeAuth }, { HouseholdState }] = await Promise.all([
    import(pathToFileURL(join(newSource, "apps/server/src/browser-auth.ts"))),
    import(pathToFileURL(join(newSource, "apps/server/src/native-auth.ts"))),
    import(pathToFileURL(join(newSource, "apps/server/src/household-state.ts"))),
  ]);
  const stores = [];
  let failed;
  let cleanupFailed = false;
  try {
    stores.push(await BrowserAuth.openOrInitialize(state));
    stores.push(await NativeAuth.openOrInitialize(state));
    stores.push(await HouseholdState.openOrInitialize(state));
  } catch (error) {
    failed = error;
  } finally {
    const closed = await Promise.allSettled(stores.reverse().map((store) => store.close()));
    cleanupFailed = closed.some((result) => result.status === "rejected");
  }
  if (cleanupFailed)
    throw new ProcessCleanupUncertain("Additive authority store cleanup is uncertain.");
  if (failed) throw failed;
}

async function hashes(directory, names) {
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await sha256(join(directory, name))])),
  );
}
export function assertPreserved(before, after, label = "state") {
  assert.deepEqual(after, before, `${label} changed across the runtime transition`);
}

async function readEffects(path) {
  return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
}

function runtime(lifecycle, node, tree, environment, role) {
  return lifecycle.launch(node, environment, tree, [
    join(tree, "apps/cli/src/main.ts"),
    role,
    "start",
  ]);
}

async function main() {
  if (process.argv.length !== 4)
    throw new Error("Use: node scripts/test-runtime-rollback.mjs BUN BUN_CACHE");
  const bun = resolve(process.argv[2]);
  const bunCache = resolve(process.argv[3]);
  const owned = await realpath(await mkdtemp(join(tmpdir(), "ellie-runtime-rollback-")));
  await chmod(owned, 0o700);
  let oldCoordinator;
  let oldNode;
  let newCoordinator;
  let newNode;
  let finalCoordinator;
  let finalNode;
  let controller;
  let cleanupCertain = true;
  let operationError;
  let report;
  let activeLifecycle;
  const stateHome = join(owned, "home");
  const state = join(stateHome, ".ellie");
  const effects = join(owned, "effects.txt");
  const helperPID = join(owned, "helper.pid");
  const helperRelease = join(owned, "helper.release");
  const helperAck = join(owned, "helper.released");
  const helperToken = token();
  const secretsPath = join(owned, "secrets.json");
  try {
    const oldSource = join(owned, "old");
    const newSource = join(owned, "new");
    const bootstrapPath = join(source, "scripts/runtime-rollback-owned-process.mjs");
    await requireExactSHA256(bootstrapPath, bootstrapSHA256);
    const bootstrapLifecycle = await import(pathToFileURL(bootstrapPath));
    activeLifecycle = bootstrapLifecycle;
    await snapshot(bootstrapLifecycle, NEW_REVISION, newSource, bun, bunCache, owned);
    const lifecyclePath = join(newSource, "scripts/test-packaged-runtime.mjs");
    await requireExactSHA256(lifecyclePath, lifecycleSHA256);
    const lifecycle = await import(pathToFileURL(lifecyclePath));
    activeLifecycle = lifecycle;
    await snapshot(lifecycle, OLD_REVISION, oldSource, bun, bunCache, owned);
    const helperSource = join(newSource, "tests/fixtures/PackagedRuntimeHelper.swift");
    await requireExactSHA256(helperSource, helperSHA256);
    const [{ Auth, newToken }, { Client }, { defaults }] = await Promise.all([
      import(pathToFileURL(join(newSource, "apps/server/src/auth.ts"))),
      import(pathToFileURL(join(newSource, "packages/transport/src/index.ts"))),
      import(pathToFileURL(join(newSource, "packages/config/src/defaults.ts"))),
    ]);

    await mkdir(join(state, "bin"), { recursive: true, mode: 0o700 });
    const helper = join(state, "bin/ellie-macos");
    await ownedCommand(
      lifecycle,
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-target",
        "arm64-apple-macos14.0",
        helperSource,
        "-o",
        helper,
      ],
      {
        timeout: setupDeadline,
        env: {
          HOME: owned,
          TMPDIR: owned,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
      },
    );
    await chmod(helper, 0o700);
    await writeFile(effects, "", { mode: 0o600 });
    await writeFile(helperPID, "", { mode: 0o600, flag: "wx" });
    const identity = await syntheticIdentity(lifecycle, owned);
    const controllerToken = newToken();
    await Auth.initialize(controllerToken, state);
    const auth = await Auth.open(state);
    const invitation = await auth.invite();
    const nodeID = "rollback-fixture-node";
    const nodeToken = await auth.pair(invitation.code, nodeID);
    const port = await freePort();
    await writeFile(join(state, "server-cert.pem"), identity.cert, {
      mode: 0o600,
    });
    await writeFile(join(state, "node-server-cert.pem"), identity.cert, {
      mode: 0o600,
    });
    await writeFile(
      join(state, "server.json"),
      JSON.stringify({
        version: 1,
        host: "127.0.0.1",
        port,
        preferences: defaults,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(state, "node.json"),
      JSON.stringify({
        version: 1,
        id: nodeID,
        serverUrl: `https://127.0.0.1:${port}`,
        preferences: defaults,
        executionEnabled: true,
      }),
      { mode: 0o600 },
    );
    const secrets = {
      "server.key": identity.key,
      "server.controller": controllerToken,
      [`node.${nodeID}`]: nodeToken,
    };
    await writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    const coreBefore = await hashes(state, coreFiles);
    const environment = {
      HOME: stateHome,
      TMPDIR: owned,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      ELLIE_PACKAGED_RUNTIME_EFFECTS: effects,
      ELLIE_PACKAGED_RUNTIME_HELPER_PID: helperPID,
      ELLIE_PACKAGED_RUNTIME_HELPER_RELEASE: helperRelease,
      ELLIE_PACKAGED_RUNTIME_HELPER_ACK: helperAck,
      ELLIE_PACKAGED_RUNTIME_TOKEN: helperToken,
      ELLIE_PACKAGED_RUNTIME_SECRETS: secretsPath,
      ELLIE_MACOS_HELPER: helper,
    };

    oldCoordinator = runtime(lifecycle, process.execPath, oldSource, environment, "server");
    controller = new Client(`https://127.0.0.1:${port}`, identity.cert, controllerToken);
    await eventually(
      async () => Array.isArray(await controller.call("GET", "/v1/nodes")),
      "Old coordinator did not start.",
    );
    oldNode = runtime(lifecycle, process.execPath, oldSource, environment, "node");
    await eventually(
      async () => (await controller.call("GET", "/v1/nodes")).some((item) => item.id === nodeID),
      "Old node did not register.",
    );
    const interrupted = controller.call("POST", "/v1/commands", {
      nodeId: nodeID,
      text: "open Arc",
    });
    void interrupted.catch(() => {});
    await eventually(
      async () => (await readEffects(effects)).length === 1,
      "Old running effect was not observed.",
    );
    const runningJobs = await controller.call("GET", "/v1/jobs");
    assert.equal(runningJobs.length, 1);
    assert.equal(runningJobs[0].state, "running");
    const interruptedJobID = runningJobs[0].id;
    assert.equal(typeof interruptedJobID, "string");
    const firstPID = Number((await readFile(helperPID, "utf8")).trim());
    assert.ok(Number.isInteger(firstPID) && firstPID > 1);
    await lifecycle.stop(oldCoordinator, "SIGKILL");
    oldCoordinator = undefined;
    await assert.rejects(interrupted);
    await lifecycle.releaseHelper(helperRelease, helperAck, helperToken, firstPID);
    await lifecycle.stop(oldNode);
    oldNode = undefined;

    newCoordinator = runtime(lifecycle, process.execPath, newSource, environment, "server");
    controller.close();
    controller = new Client(`https://127.0.0.1:${port}`, identity.cert, controllerToken);
    await eventually(async () => {
      const jobs = await controller.call("GET", "/v1/jobs");
      return (
        jobs.length === 1 &&
        jobs[0]?.id === interruptedJobID &&
        jobs[0]?.state === "unknown" &&
        jobs[0]?.outcomeCode === "unknown_after_restart"
      );
    }, "New coordinator did not recover running work as unknown_after_restart.");
    assertPreserved(coreBefore, await hashes(state, coreFiles), "core identity/configuration");
    newNode = runtime(lifecycle, process.execPath, newSource, environment, "node");
    await eventually(
      async () => (await controller.call("GET", "/v1/nodes")).some((item) => item.id === nodeID),
      "New node did not register.",
    );
    const beforeNewFresh = await controller.call("GET", "/v1/jobs");
    assert.equal(beforeNewFresh.length, 1);
    const fresh = await controller.call("POST", "/v1/commands", {
      nodeId: nodeID,
      text: "open Safari",
    });
    assert.equal(fresh.ok, true);
    const afterNewFresh = await controller.call("GET", "/v1/jobs");
    assert.equal(afterNewFresh.length, 2);
    const newFreshJob = afterNewFresh.find((job) => job.id !== interruptedJobID);
    assert.equal(newFreshJob?.state, "completed");
    assert.equal(newFreshJob?.outcomeCode, "succeeded");
    const newFreshJobID = newFreshJob.id;
    assert.equal(typeof newFreshJobID, "string");
    const recoveredAfterFresh = afterNewFresh.find((job) => job.id === interruptedJobID);
    assert.equal(recoveredAfterFresh?.state, "unknown");
    assert.equal(recoveredAfterFresh?.outcomeCode, "unknown_after_restart");
    assert.deepEqual(await readEffects(effects), [
      "company.thebrowser.Browser",
      "com.apple.Safari",
    ]);
    await lifecycle.stop(newNode);
    newNode = undefined;
    await lifecycle.stop(newCoordinator);
    newCoordinator = undefined;

    await initializeAdditiveStores(newSource, state);
    const additiveBeforeOld = await hashes(state, additiveFiles);

    finalCoordinator = runtime(lifecycle, process.execPath, oldSource, environment, "server");
    controller.close();
    controller = new Client(`https://127.0.0.1:${port}`, identity.cert, controllerToken);
    await eventually(async () => {
      const jobs = await controller.call("GET", "/v1/jobs");
      return (
        jobs.length === 2 &&
        jobs.some(
          (job) =>
            job.id === interruptedJobID &&
            job.state === "unknown" &&
            job.outcomeCode === "unknown_after_restart",
        ) &&
        jobs.some((job) => job.id === newFreshJobID && job.state === "completed")
      );
    }, "Old rollback runtime could not read the recovered job.");
    finalNode = runtime(lifecycle, process.execPath, oldSource, environment, "node");
    await eventually(
      async () => (await controller.call("GET", "/v1/nodes")).some((item) => item.id === nodeID),
      "Rollback node did not re-register.",
    );
    const beforeRollbackFresh = await controller.call("GET", "/v1/jobs");
    assert.deepEqual(
      new Set(beforeRollbackFresh.map((job) => job.id)),
      new Set([interruptedJobID, newFreshJobID]),
    );
    const rollbackFresh = await controller.call("POST", "/v1/commands", {
      nodeId: nodeID,
      text: "open Arc",
    });
    assert.equal(rollbackFresh.ok, true);
    const finalJobs = await controller.call("GET", "/v1/jobs");
    assert.equal(finalJobs.length, 3);
    const interruptedFinal = finalJobs.find((job) => job.id === interruptedJobID);
    assert.equal(interruptedFinal?.state, "unknown");
    assert.equal(interruptedFinal?.outcomeCode, "unknown_after_restart");
    const newFreshFinal = finalJobs.find((job) => job.id === newFreshJobID);
    assert.equal(newFreshFinal?.state, "completed");
    assert.equal(newFreshFinal?.outcomeCode, "succeeded");
    const rollbackFreshJobs = finalJobs.filter(
      (job) => job.id !== interruptedJobID && job.id !== newFreshJobID,
    );
    assert.equal(rollbackFreshJobs.length, 1);
    assert.equal(rollbackFreshJobs[0].state, "completed");
    assert.equal(rollbackFreshJobs[0].outcomeCode, "succeeded");
    assert.equal(typeof rollbackFreshJobs[0].id, "string");
    assert.deepEqual(await readEffects(effects), [
      "company.thebrowser.Browser",
      "com.apple.Safari",
      "company.thebrowser.Browser",
    ]);
    assertPreserved(coreBefore, await hashes(state, coreFiles), "core identity/configuration");
    assertPreserved(
      additiveBeforeOld,
      await hashes(state, additiveFiles),
      "additive authority state",
    );
    await lifecycle.stop(finalNode);
    finalNode = undefined;
    await lifecycle.stop(finalCoordinator);
    finalCoordinator = undefined;
    report = {
      oldRevision: OLD_REVISION,
      newRevision: NEW_REVISION,
      terminalOutcome: "unknown_after_restart",
      effects: 3,
      jobs: {
        total: 3,
        interrupted: "unknown_after_restart",
        freshCompleted: 2,
      },
      replayed: false,
      coreFilesPreserved: coreFiles.length,
      additiveFilesPreserved: additiveFiles.length,
      oldNodeReregistered: true,
    };
  } catch (error) {
    if (error instanceof ProcessCleanupUncertain) cleanupCertain = false;
    operationError = error;
  } finally {
    controller?.close();
    const stopped = await Promise.allSettled([
      activeLifecycle?.stop(finalNode),
      activeLifecycle?.stop(finalCoordinator),
      activeLifecycle?.stop(newNode),
      activeLifecycle?.stop(newCoordinator),
      activeLifecycle?.stop(oldNode),
      activeLifecycle?.stop(oldCoordinator),
    ]);
    if (stopped.some((result) => result.status === "rejected")) cleanupCertain = false;
    if (cleanupCertain) await rm(owned, { recursive: true });
    else console.error(`Owned rollback state retained because cleanup is uncertain: ${owned}`);
  }
  if (!cleanupCertain) throw new Error("Owned rollback cleanup was incomplete.");
  if (operationError) throw operationError;
  console.log(JSON.stringify({ ...report, cleanupCertain: true }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
