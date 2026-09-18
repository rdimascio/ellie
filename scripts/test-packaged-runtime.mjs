import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { inflateRawSync } from "node:zlib";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Auth, newToken } from "../apps/server/src/auth.ts";
import { generateCertificate } from "../apps/cli/src/certificate.ts";
import { Client } from "@ellie/transport";
import { defaults } from "@ellie/config";
import { MAXIMUM_PAYLOAD_FILES } from "./build-service-payload.mjs";

const source = resolve(fileURLToPath(new URL("..", import.meta.url)));
const helperSource = join(source, "tests/fixtures/PackagedRuntimeHelper.swift");
const deadlineMs = 12_000;
const maximumArchiveEntries = 4096;
const maximumArchiveDepth = 16;
const maximumArchiveFileBytes = 128 * 1024 * 1024;
const maximumExpandedBytes = 512 * 1024 * 1024;

const sha256 = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const lowercaseHex = (value, length) =>
  typeof value === "string" &&
  Buffer.byteLength(value) === length &&
  [...Buffer.from(value)].every(
    (byte) => (byte >= 48 && byte <= 57) || (byte >= 97 && byte <= 102),
  );

function archivePath(value, releaseName) {
  if (
    !value ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) > 126)
  )
    throw new Error("Archive contains an unsafe path.");
  const directory = value.endsWith("/");
  const rawComponents = value.split("/");
  if (directory) rawComponents.pop();
  if (rawComponents.some((component) => component.length === 0))
    throw new Error("Archive contains an unsafe path.");
  const components = rawComponents;
  if (
    components.length === 0 ||
    components.length > maximumArchiveDepth + 2 ||
    components.some(
      (component) => component === "." || component === ".." || component.length > 100,
    )
  )
    throw new Error("Archive contains an unsafe path.");
  let metadata = false;
  if (components[0] === "__MACOSX") {
    metadata = true;
    components.shift();
    if (components.length === 0 && directory) return { directory, metadata, components };
  }
  if (components[0] !== releaseName || components.length - 1 > maximumArchiveDepth)
    throw new Error("Archive contains an unexpected top-level root.");
  return { directory, metadata, components };
}

export function zipEntries(data, releaseName) {
  if (!Buffer.isBuffer(data) || data.length < 22 || data.length > 512 * 1024 * 1024)
    throw new Error("Archive is outside the accepted size bound.");
  const minimum = Math.max(0, data.length - 65_557);
  let end = -1;
  for (let offset = data.length - 22; offset >= minimum; offset--)
    if (data.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  if (end < 0 || end + 22 + data.readUInt16LE(end + 20) !== data.length)
    throw new Error("Archive directory is invalid.");
  const count = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  let offset = data.readUInt32LE(end + 16);
  if (
    data.readUInt16LE(end + 4) !== 0 ||
    data.readUInt16LE(end + 6) !== 0 ||
    count !== data.readUInt16LE(end + 8) ||
    count === 0 ||
    count > maximumArchiveEntries ||
    offset + directorySize !== end
  )
    throw new Error("Archive directory is invalid.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = new Set();
  const entries = [];
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("Archive entry is invalid.");
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const mode = data.readUInt32LE(offset + 38) >>> 16;
    const localOffset = data.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & 1) !== 0 || ![0, 8].includes(method))
      throw new Error("Archive entry is invalid.");
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameLength);
    if ([...nameBytes].some((byte) => byte > 127)) throw new Error("Archive path is not ASCII.");
    const name = decoder.decode(nameBytes);
    if (seen.has(name)) throw new Error("Archive contains a duplicate path.");
    seen.add(name);
    const path = archivePath(name, releaseName);
    const kind = mode & 0o170000;
    if (kind !== (path.directory ? 0o040000 : 0o100000))
      throw new Error("Archive contains a linked or special entry.");
    if (!path.directory && size > maximumArchiveFileBytes)
      throw new Error("Archive file exceeds the expanded bound.");
    expanded += size;
    if (expanded > maximumExpandedBytes) throw new Error("Archive exceeds the expanded bound.");
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50)
      throw new Error("Archive local entry is invalid.");
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataEnd > data.length ||
      data.readUInt16LE(localOffset + 6) !== flags ||
      data.readUInt16LE(localOffset + 8) !== method ||
      !data.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)
    )
      throw new Error("Archive local entry is invalid.");
    entries.push({
      name,
      nameBytes,
      path,
      flags,
      method,
      checksum,
      compressedSize,
      size,
      mode,
      dataStart,
      dataEnd,
    });
    offset = next;
  }
  if (offset !== end || !seen.has(`${releaseName}/`))
    throw new Error("Archive root is incomplete.");
  return entries;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

async function extractZip(data, destination, releaseName) {
  const entries = zipEntries(data, releaseName);
  for (const entry of entries) {
    if (entry.path.metadata) continue;
    const output =
      entry.method === 0
        ? data.subarray(entry.dataStart, entry.dataEnd)
        : inflateRawSync(data.subarray(entry.dataStart, entry.dataEnd), {
            maxOutputLength: entry.size,
          });
    if (output.length !== entry.size || crc32(output) !== entry.checksum)
      throw new Error("Archive entry checksum is invalid.");
    const path = join(destination, ...entry.path.components);
    if (entry.path.directory) await mkdir(path, { mode: entry.mode & 0o777 });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, output, { flag: "wx", mode: entry.mode & 0o777 });
    }
  }
}

async function eventually(check, message, timeout = deadlineMs) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port available.");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: deadlineMs, ...options });
  if (result.status !== 0 || result.signal)
    throw new Error(`Bounded acceptance command failed: ${file.split("/").at(-1)}.`);
  return result.stdout.trim();
}

export function launch(file, environment, workingDirectory, args = ["--launch-agent"]) {
  const child = spawn(file, args, {
    detached: true,
    cwd: workingDirectory,
    env: environment,
    stdio: "ignore",
  });
  const exited = new Promise((resolveExit) => {
    child.once("error", () => resolveExit({ error: true }));
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error("Invalid owned process ID.");
  return { child, pgid: child.pid, exited };
}

function groupMembers(pgid) {
  const status = spawnSync("/bin/ps", ["-o", "pid=,uid=", "-g", String(pgid)], {
    encoding: "utf8",
    timeout: 200,
    maxBuffer: 64 * 1024,
  });
  if (status.status === 1) return [];
  if (status.status === 0) {
    const lines = status.stdout.trim().split("\n").filter(Boolean);
    if (lines.length > 64) throw new Error("Owned process group exceeded its member bound.");
    return lines.map((line) => {
      const values = line.trim().split(/\s+/).map(Number);
      if (
        values.length !== 2 ||
        !Number.isInteger(values[0]) ||
        values[0] <= 1 ||
        values[1] !== process.getuid?.()
      )
        throw new Error("Owned process group identity changed.");
      return values[0];
    });
  }
  throw new Error("Cannot inspect the owned process group.");
}

export async function stop(owned, signal = "SIGTERM") {
  if (!owned) return;
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    if (!owned.child.kill(signal) && !(await exitedWithin(owned, 100)))
      throw new Error("Owned process leader could not be signaled.");
  }
  if (!(await exitedWithin(owned, signal === "SIGKILL" ? 100 : 1500))) {
    if (!owned.child.kill("SIGKILL") && !(await exitedWithin(owned, 100)))
      throw new Error("Owned process leader could not be killed.");
  }
  await reaped(owned);
  await eventually(
    async () => groupMembers(owned.pgid).length === 0,
    "Owned process group remained after cleanup.",
    1500,
  );
}

async function exitedWithin(owned, milliseconds) {
  let timeout;
  const outcome = await Promise.race([
    owned.exited.then(() => true),
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), milliseconds);
    }),
  ]);
  clearTimeout(timeout);
  return outcome;
}

async function readPrivate(path, maximum) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const information = await handle.stat();
    if (
      !information.isFile() ||
      information.nlink !== 1 ||
      information.uid !== process.getuid?.() ||
      (information.mode & 0o7777) !== 0o600 ||
      information.size < 0 ||
      information.size > maximum
    )
      throw new Error("Owned helper protocol file is unsafe.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function publishRelease(path, token) {
  try {
    await writeFile(path, token, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if ((await readPrivate(path, 64)).toString("utf8") !== token)
    throw new Error("Owned helper release file changed.");
}

export async function releaseHelper(release, acknowledgement, token, pid, timeout = deadlineMs) {
  await publishRelease(release, token);
  await eventually(
    async () => {
      if (!pidExists(pid)) return true;
      return (await readPrivate(acknowledgement, 64)).toString("utf8") === token;
    },
    "Synthetic helper did not observe its release request.",
    timeout,
  );
  await eventually(
    async () => !pidExists(pid),
    "Synthetic helper remained after release.",
    timeout,
  );
}

function pidExists(pid) {
  const status = spawnSync("/bin/ps", ["-o", "pid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 200,
    maxBuffer: 4096,
  });
  if (status.status === 1) return false;
  if (status.status === 0) return Number(status.stdout.trim()) === pid;
  throw new Error("Cannot inspect the synthetic helper process.");
}

async function helperPIDs(path) {
  const text = (await readPrivate(path, 4096)).toString("utf8");
  const values = text.split("\n").filter(Boolean).map(Number);
  if (
    values.length > 4 ||
    values.some((value) => !Number.isInteger(value) || value <= 1) ||
    new Set(values).size !== values.length
  )
    throw new Error("Synthetic helper process record is invalid.");
  return values;
}

async function reaped(owned) {
  let timeout;
  const outcome = await Promise.race([
    owned.exited,
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ timeout: true }), 3500);
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.error || outcome.timeout) throw new Error("Owned process leader was not reaped.");
}

async function installedModes(root, manifest) {
  for (const item of manifest.files)
    await chmod(join(root, "payload", item.path), item.mode === 0o755 ? 0o555 : 0o444);
  const directories = new Set([root, join(root, "payload")]);
  for (const item of manifest.files) {
    let path = dirname(join(root, "payload", item.path));
    while (path.startsWith(join(root, "payload"))) {
      directories.add(path);
      if (path === join(root, "payload")) break;
      path = dirname(path);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length))
    await chmod(directory, 0o555);
  await chmod(join(root, "manifest.json"), 0o444);
}

async function main() {
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    process.versions.node.split(".")[0] !== "24"
  )
    throw new Error("Packaged runtime acceptance requires arm64 macOS and Node.js 24.");
  if (process.argv.length !== 5)
    throw new Error("Use: node scripts/test-packaged-runtime.mjs ORIGINAL_ZIP SHA256 REVISION");
  const archive = await realpath(resolve(process.argv[2]));
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 512 * 1024 * 1024)
    throw new Error("Original archive must be a bounded regular file.");
  const archiveSha256 = process.argv[3];
  const archiveData = await readFile(archive);
  if (
    !lowercaseHex(archiveSha256, 64) ||
    createHash("sha256").update(archiveData).digest("hex") !== archiveSha256
  )
    throw new Error("Original archive checksum does not match.");
  const expectedRevision = process.argv[4];
  if (!lowercaseHex(expectedRevision, 40)) throw new Error("Expected revision is invalid.");
  const releaseName = basename(archive, ".zip");
  zipEntries(archiveData, releaseName);

  const owned = await realpath(await mkdtemp(join(tmpdir(), "ellie-packaged-runtime-acceptance-")));
  await chmod(owned, 0o700);
  const derivative = join(owned, "release");
  const home = join(owned, "home");
  const state = join(home, ".ellie");
  const effects = join(owned, "effects.txt");
  const helperPID = join(owned, "helper.pid");
  const helperRelease = join(owned, "helper.release");
  const helperAck = join(owned, "helper.released");
  const helperToken = randomBytes(32).toString("hex");
  const secretsPath = join(owned, "secrets.json");
  let coordinator;
  let node;
  let controller;
  let cleanupCertain = true;
  let operationError;
  let report;
  try {
    const expanded = join(owned, "original");
    await mkdir(expanded, { mode: 0o700 });
    await extractZip(archiveData, expanded, releaseName);
    const original = join(expanded, releaseName);
    const originalInfo = await lstat(original);
    if (!originalInfo.isDirectory() || originalInfo.isSymbolicLink())
      throw new Error("Verified archive has no exact release root.");
    const manifest = JSON.parse(await readFile(join(original, "manifest.json"), "utf8"));
    assert.equal(manifest.sourceRevision, expectedRevision);
    assert.equal(manifest.sourceModified, false);
    assert.ok(manifest.files.length > 0 && manifest.files.length <= MAXIMUM_PAYLOAD_FILES);
    const inspected = command(join(original, "payload/bin/ellie-service-installer"), [
      "inspect",
      original,
    ]);
    assert.match(inspected, new RegExp(expectedRevision));
    await cp(original, derivative, { recursive: true, preserveTimestamps: false });
    const helper = join(derivative, "payload/helpers/ellie-macos");
    const oldHelperHash = await sha256(helper);
    command("/usr/bin/xcrun", [
      "swiftc",
      "-parse-as-library",
      "-target",
      "arm64-apple-macos14.0",
      helperSource,
      "-o",
      helper,
    ]);
    command("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--identifier",
      "org.ellie.helper",
      helper,
    ]);
    const helperRecord = manifest.files.find((item) => item.path === "helpers/ellie-macos");
    assert.ok(helperRecord);
    const helperInfo = await stat(helper);
    helperRecord.size = helperInfo.size;
    helperRecord.sha256 = await sha256(helper);
    await writeFile(join(derivative, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o644,
    });

    await mkdir(join(state, "bin"), { recursive: true, mode: 0o700 });
    await cp(helper, join(state, "bin/ellie-macos"));
    await chmod(join(state, "bin/ellie-macos"), 0o700);
    await writeFile(effects, "", { mode: 0o600 });
    await writeFile(helperPID, "", { mode: 0o600, flag: "wx" });
    const identity = await generateCertificate();
    const controllerToken = newToken();
    await Auth.initialize(controllerToken, state);
    const auth = await Auth.open(state);
    const invitation = await auth.invite();
    const nodeID = "packaged-runtime-node";
    const nodeToken = await auth.pair(invitation.code, nodeID);
    const port = await freePort();
    await writeFile(join(state, "server-key.pem"), identity.key, { mode: 0o600 });
    await writeFile(join(state, "server-cert.pem"), identity.cert, { mode: 0o600 });
    await writeFile(join(state, "node-server-cert.pem"), identity.cert, { mode: 0o600 });
    await writeFile(
      join(state, "server.json"),
      JSON.stringify({ version: 1, host: "127.0.0.1", port, preferences: defaults }),
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
    await writeFile(
      secretsPath,
      JSON.stringify({
        "server.key": identity.key,
        "server.controller": controllerToken,
        [`node.${nodeID}`]: nodeToken,
      }),
      { mode: 0o600 },
    );
    await installedModes(derivative, manifest);

    const environment = {
      HOME: home,
      TMPDIR: owned,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ELLIE_PACKAGED_RUNTIME_EFFECTS: effects,
      ELLIE_PACKAGED_RUNTIME_HELPER_PID: helperPID,
      ELLIE_PACKAGED_RUNTIME_HELPER_RELEASE: helperRelease,
      ELLIE_PACKAGED_RUNTIME_HELPER_ACK: helperAck,
      ELLIE_PACKAGED_RUNTIME_TOKEN: helperToken,
      ELLIE_PACKAGED_RUNTIME_SECRETS: secretsPath,
    };
    const coordinatorLauncher = join(
      derivative,
      "payload/launchers/Ellie Coordinator.app/Contents/MacOS/EllieService",
    );
    const nodeLauncher = join(
      derivative,
      "payload/launchers/Ellie Node.app/Contents/MacOS/EllieService",
    );
    coordinator = launch(coordinatorLauncher, environment, derivative);
    controller = new Client(`https://127.0.0.1:${port}`, identity.cert, controllerToken);
    await eventually(
      async () => Array.isArray(await controller.call("GET", "/v1/nodes")),
      "Coordinator did not become ready.",
    );
    node = launch(nodeLauncher, environment, derivative);
    await eventually(
      async () => (await controller.call("GET", "/v1/nodes")).some((item) => item.id === nodeID),
      "Node did not become ready.",
    );

    const interrupted = controller.call("POST", "/v1/commands", {
      nodeId: nodeID,
      text: "open Arc",
    });
    void interrupted.catch(() => {});
    await eventually(
      async () => (await readFile(effects, "utf8")).trim().split("\n").filter(Boolean).length === 1,
      "First effect was not delivered.",
    );
    const deliveredPIDs = await helperPIDs(helperPID);
    assert.equal(deliveredPIDs.length, 1);
    const deliveredHelperPID = deliveredPIDs[0];
    await stop(coordinator, "SIGKILL");
    coordinator = undefined;
    await assert.rejects(interrupted);
    await releaseHelper(helperRelease, helperAck, helperToken, deliveredHelperPID);
    await stop(node);
    node = undefined;

    coordinator = launch(coordinatorLauncher, environment, derivative);
    controller.close();
    controller = new Client(`https://127.0.0.1:${port}`, identity.cert, controllerToken);
    await eventually(async () => {
      const jobs = await controller.call("GET", "/v1/jobs");
      return jobs[0]?.state === "unknown" && jobs[0]?.outcomeCode === "unknown_after_restart";
    }, "Interrupted delivery was not recovered as unknown.");
    node = launch(nodeLauncher, environment, derivative);
    await eventually(
      async () => (await controller.call("GET", "/v1/nodes")).some((item) => item.id === nodeID),
      "Node did not reconnect.",
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert.equal((await readFile(effects, "utf8")).trim().split("\n").filter(Boolean).length, 1);
    const fresh = await controller.call("POST", "/v1/commands", {
      nodeId: nodeID,
      text: "open Safari",
    });
    assert.equal(fresh.ok, true);
    assert.deepEqual((await readFile(effects, "utf8")).trim().split("\n"), [
      "company.thebrowser.Browser",
      "com.apple.Safari",
    ]);
    const finalHelperPIDs = await helperPIDs(helperPID);
    assert.equal(finalHelperPIDs.length, 2);
    await eventually(
      async () => finalHelperPIDs.every((pid) => !pidExists(pid)),
      "A synthetic helper remained after its finite invocation.",
    );

    await stop(node);
    node = undefined;
    await stop(coordinator);
    coordinator = undefined;
    cleanupCertain = true;
    report = {
      sourceRevision: manifest.sourceRevision,
      originalArchiveSha256: archiveSha256,
      verifiedManifestFiles: manifest.files.length,
      originalVerified: true,
      derivative: {
        substituted: "payload/helpers/ellie-macos",
        originalSha256: oldHelperHash,
        sha256: helperRecord.sha256,
        compatibilityCopy: ".ellie/bin/ellie-macos",
      },
      roles: ["coordinator", "node"],
      lifecycle: ["start", "ready", "stop", "restart"],
      effects: 2,
      interruptedOutcome: "unknown_after_restart",
      replayed: false,
    };
  } catch (error) {
    operationError = error;
  } finally {
    controller?.close();
    try {
      await publishRelease(helperRelease, helperToken);
    } catch {
      cleanupCertain = false;
    }
    const stopped = await Promise.allSettled([stop(node), stop(coordinator)]);
    if (stopped.some((result) => result.status === "rejected")) cleanupCertain = false;
    if (cleanupCertain) {
      command("/bin/chmod", ["-R", "u+w", owned]);
      await rm(owned, { recursive: true });
    } else {
      console.error(`Owned acceptance state was retained because cleanup is uncertain: ${owned}`);
    }
  }
  if (!cleanupCertain) throw new Error("Owned acceptance cleanup was incomplete.");
  if (operationError) throw operationError;
  console.log(JSON.stringify({ ...report, cleanupCertain: true }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
