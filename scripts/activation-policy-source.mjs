import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const sourceNames = [
  "ServicePayloadAuthorization.swift",
  "ServicePayloadAuthenticatedInspection.swift",
  "AuthenticatedActivationPolicy.swift",
  "AuthenticatedCandidateVerifier.swift",
  "ServicePayloadCapture.swift",
  "ServicePayloadSelection.swift",
  "ServicePayloadLifecycle.swift",
  "ServicePayloadMigration.swift",
  "ServicePayloadInstaller.swift",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const validTeamID = (value) =>
  typeof value === "string" && Buffer.byteLength(value) === 10 && /^[A-Z0-9]{10}$/.test(value);

function groupAbsent(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

export function runActivationPolicyBuildCommand(file, args, options) {
  const { cwd, timeoutMs = 120_000, maximumOutputBytes = 64 * 1024 } = options;
  if (
    !isAbsolute(file) ||
    !isAbsolute(cwd) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120_000 ||
    !Number.isInteger(maximumOutputBytes) ||
    maximumOutputBytes < 1 ||
    maximumOutputBytes > 64 * 1024
  )
    throw new Error("Invalid activation policy command bounds.");
  return new Promise((resolveCommand, reject) => {
    const environment = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      LC_ALL: "C",
      TMPDIR: cwd,
    };
    if (process.env.DEVELOPER_DIR && isAbsolute(process.env.DEVELOPER_DIR))
      environment.DEVELOPER_DIR = process.env.DEVELOPER_DIR;
    const child = spawn(file, args, {
      cwd,
      env: environment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0),
      stderrBytes = 0,
      failure,
      killTimer,
      reapTimer,
      deadline,
      settled = false;
    const clearTimers = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
    };
    const signalDirectChild = (signal) => {
      if (
        !settled &&
        Number.isInteger(child.pid) &&
        child.pid > 1 &&
        child.exitCode === null &&
        child.signalCode === null
      ) {
        try {
          child.kill(signal);
        } catch {
          failure ??= new Error("Activation policy child could not be signaled.");
        }
      }
    };
    const stop = (message) => {
      if (settled) return;
      failure ??= new Error(message);
      clearTimeout(deadline);
      signalDirectChild("SIGTERM");
      killTimer ??= setTimeout(() => signalDirectChild("SIGKILL"), 2_000);
      reapTimer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(
          new Error("Activation policy child could not be reaped; owned evidence was retained."),
        );
      }, 7_000);
    };
    child.stdout.on("data", (chunk) => {
      if (settled || failure) return;
      if (stdout.length + chunk.length > maximumOutputBytes)
        stop("Activation policy child output exceeded its bound.");
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk) => {
      if (settled || failure) return;
      stderrBytes += chunk.length;
      stop(
        stderrBytes > maximumOutputBytes
          ? "Activation policy child output exceeded its bound."
          : "Activation policy child wrote unexpected diagnostics.",
      );
    });
    child.once("error", () => stop("Activation policy child could not start."));
    deadline = setTimeout(() => stop("Activation policy child exceeded its deadline."), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimers();
      if (settled) return;
      settled = true;
      try {
        if (Number.isInteger(child.pid) && !groupAbsent(child.pid))
          failure ??= new Error("Activation policy child left process-group members.");
      } catch {
        failure ??= new Error("Activation policy child cleanup could not be verified.");
      }
      if (failure) reject(failure);
      else if (code !== 0 || signal)
        reject(new Error("Activation policy child exited with an error."));
      else resolveCommand(stdout);
    });
  });
}

function blobSource(data) {
  const bytes = [...data].map((value) => `0x${value.toString(16).padStart(2, "0")}`).join(",");
  return `#include "EllieActivationPolicyBlob.h"
__attribute__((used, section("__TEXT,__ellie_policy"), aligned(1)))
static const uint8_t ellie_policy[] = {${bytes}};
const uint8_t *ellie_activation_policy_bytes(void) { return ellie_policy; }
size_t ellie_activation_policy_size(void) { return sizeof(ellie_policy); }
`;
}

export function unavailableActivationPolicySource() {
  return blobSource(Buffer.from("ELLIE-ACTIVATION-POLICY-UNAVAILABLE-V1\n"));
}

function paddedName(data, offset) {
  const value = data.subarray(offset, offset + 16);
  const zero = value.indexOf(0);
  const end = zero < 0 ? 16 : zero;
  if (value.subarray(0, end).some((byte) => byte < 0x20 || byte > 0x7e))
    throw new Error("Activation policy Mach-O name is malformed.");
  if (zero >= 0 && value.subarray(zero).some((byte) => byte !== 0))
    throw new Error("Activation policy Mach-O name is malformed.");
  return value.subarray(0, end).toString("ascii");
}

export async function inspectActivationPolicyBlob(path, architecture, authority) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !["arm64", "x64"].includes(architecture) ||
    !Buffer.isBuffer(authority) ||
    authority.length < 1 ||
    authority.length > 16 * 1024
  )
    throw new Error("Invalid activation policy audit input.");
  authority = Buffer.from(authority);
  const { data } = await readRegular(path, 64 * 1024 * 1024);
  if (data.length < 32 || data.readUInt32LE(0) !== 0xfeedfacf)
    throw new Error("Activation policy binary is not a supported thin Mach-O.");
  const expectedCPU = architecture === "arm64" ? [0x0100000c, 0] : [0x01000007, 3];
  if (
    data.readUInt32LE(4) !== expectedCPU[0] ||
    data.readUInt32LE(8) !== expectedCPU[1] ||
    data.readUInt32LE(12) !== 2 ||
    data.readUInt32LE(28) !== 0
  )
    throw new Error("Activation policy binary architecture is invalid.");
  const commands = data.readUInt32LE(16),
    commandBytes = data.readUInt32LE(20);
  if (
    commands < 1 ||
    commands > 128 ||
    commandBytes > 1024 * 1024 ||
    32 + commandBytes > data.length
  )
    throw new Error("Activation policy Mach-O commands are invalid.");
  let cursor = 32;
  const matches = [];
  const mappings = [];
  let textSegments = 0;
  for (let index = 0; index < commands; index += 1) {
    if (cursor + 8 > 32 + commandBytes) throw new Error("Activation policy Mach-O is truncated.");
    const command = data.readUInt32LE(cursor),
      size = data.readUInt32LE(cursor + 4);
    if (size < 8 || size % 8 !== 0 || cursor + size > 32 + commandBytes)
      throw new Error("Activation policy Mach-O command is invalid.");
    if (command === 1) throw new Error("Activation policy Mach-O contains a 32-bit segment.");
    if (command === 0x19) {
      if (size < 72) throw new Error("Activation policy Mach-O segment is invalid.");
      const segment = paddedName(data, cursor + 8);
      const vmAddress = data.readBigUInt64LE(cursor + 24),
        vmSize = data.readBigUInt64LE(cursor + 32);
      const fileOffset = data.readBigUInt64LE(cursor + 40),
        fileSize = data.readBigUInt64LE(cursor + 48);
      const maxProtection = data.readUInt32LE(cursor + 56),
        initialProtection = data.readUInt32LE(cursor + 60);
      const sections = data.readUInt32LE(cursor + 64);
      const segmentFlags = data.readUInt32LE(cursor + 68);
      if (
        sections > 256 ||
        size !== 72 + sections * 80 ||
        fileOffset + fileSize > BigInt(data.length) ||
        fileOffset + fileSize > 0xffff_ffff_ffff_ffffn ||
        vmAddress + vmSize > 0xffff_ffff_ffff_ffffn ||
        vmSize < fileSize
      )
        throw new Error("Activation policy Mach-O segment is invalid.");
      if (segment === "__TEXT") {
        textSegments += 1;
        if (segmentFlags !== 0 || maxProtection !== 5 || initialProtection !== 5)
          throw new Error("Activation policy text segment is invalid.");
      }
      for (const prior of mappings) {
        const fileOverlap =
          fileSize > 0n &&
          prior.fileSize > 0n &&
          fileOffset < prior.fileOffset + prior.fileSize &&
          prior.fileOffset < fileOffset + fileSize;
        const virtualOverlap =
          vmSize > 0n &&
          prior.vmSize > 0n &&
          vmAddress < prior.vmAddress + prior.vmSize &&
          prior.vmAddress < vmAddress + vmSize;
        if (fileOverlap || virtualOverlap)
          throw new Error("Activation policy Mach-O segments overlap.");
      }
      mappings.push({ fileOffset, fileSize, vmAddress, vmSize });
      for (let sectionIndex = 0; sectionIndex < sections; sectionIndex += 1) {
        const section = cursor + 72 + sectionIndex * 80;
        const name = paddedName(data, section),
          sectionSegment = paddedName(data, section + 16);
        if (name !== "__ellie_policy") continue;
        const address = data.readBigUInt64LE(section + 32),
          length = data.readBigUInt64LE(section + 40);
        const offset = data.readUInt32LE(section + 48),
          alignment = data.readUInt32LE(section + 52);
        const relocationOffset = data.readUInt32LE(section + 56),
          relocations = data.readUInt32LE(section + 60);
        const flags = data.readUInt32LE(section + 64),
          reserved1 = data.readUInt32LE(section + 68),
          reserved2 = data.readUInt32LE(section + 72),
          reserved3 = data.readUInt32LE(section + 76);
        const relative = BigInt(offset) - fileOffset;
        if (
          segment !== "__TEXT" ||
          sectionSegment !== "__TEXT" ||
          maxProtection !== 5 ||
          initialProtection !== 5 ||
          length < 1n ||
          length > 16n * 1024n ||
          offset < 32 + commandBytes ||
          relative < 0n ||
          relative + length > fileSize ||
          address !== vmAddress + relative ||
          BigInt(offset) + length > BigInt(data.length) ||
          alignment !== 0 ||
          relocationOffset !== 0 ||
          relocations !== 0 ||
          flags !== 0 ||
          reserved1 !== 0 ||
          reserved2 !== 0 ||
          reserved3 !== 0
        )
          throw new Error("Activation policy Mach-O section is invalid.");
        matches.push(Buffer.from(data.subarray(offset, offset + Number(length))));
      }
    }
    cursor += size;
  }
  if (cursor !== 32 + commandBytes || textSegments !== 1 || matches.length !== 1)
    throw new Error("Activation policy Mach-O section is missing or duplicated.");
  if (!matches[0].equals(authority))
    throw new Error("Activation policy Mach-O bytes do not match build authority.");
  return matches[0];
}

const sameIdentity = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const sameFile = (a, b) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs;
const validHex = (value) =>
  typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);

async function directoryChain(path) {
  const canonical = await realpath(path);
  const chain = [];
  let current = canonical;
  while (true) {
    const info = await lstat(current, { bigint: true });
    const rootSticky = info.uid === 0n && (info.mode & 0o1000n) !== 0n;
    if (
      !info.isDirectory() ||
      ![0n, BigInt(process.getuid())].includes(info.uid) ||
      ((info.mode & 0o022n) !== 0n && !rootSticky)
    )
      throw new Error("Activation policy directory is unsafe.");
    chain.push({ path: current, info });
    if (current === "/") break;
    current = dirname(current);
  }
  if (chain[0].info.uid !== BigInt(process.getuid()))
    throw new Error("Activation policy directory is not owned by this user.");
  return { original: resolve(path), canonical, chain };
}

async function rebindDirectory(directory) {
  if ((await realpath(directory.original)) !== directory.canonical)
    throw new Error("Activation policy directory changed.");
  for (const item of directory.chain) {
    const info = await lstat(item.path, { bigint: true });
    if (!info.isDirectory() || !sameIdentity(info, item.info))
      throw new Error("Activation policy directory changed.");
  }
}

async function readRegular(path, maximum, expectedMode) {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.uid !== BigInt(process.getuid()) ||
      (before.mode & 0o022n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(maximum) ||
      (expectedMode !== undefined && (before.mode & 0o7777n) !== BigInt(expectedMode))
    )
      throw new Error("Activation policy file is unsafe or exceeds its bound.");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await input.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await input.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      length > maximum ||
      BigInt(length) !== before.size ||
      !sameFile(before, after) ||
      !sameFile(after, named)
    )
      throw new Error("Activation policy file changed while being read.");
    return { data: Buffer.from(buffer.subarray(0, length)), info: after };
  } finally {
    await input.close();
  }
}

export async function readActivationPolicyBuildFile(path, maximum, expectedMode) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 64 * 1024 * 1024 ||
    (expectedMode !== undefined &&
      ![0o400, 0o444, 0o600, 0o644, 0o700, 0o755].includes(expectedMode))
  )
    throw new Error("Invalid activation policy file input.");
  const directory = await directoryChain(dirname(path));
  const result = await readRegular(path, maximum, expectedMode);
  await rebindDirectory(directory);
  return {
    data: result.data,
    identity: {
      dev: result.info.dev,
      ino: result.info.ino,
      uid: result.info.uid,
      mode: result.info.mode,
      nlink: result.info.nlink,
      size: result.info.size,
      mtimeNs: result.info.mtimeNs,
      ctimeNs: result.info.ctimeNs,
    },
  };
}

export async function captureActivationPolicyBuildDirectory(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0"))
    throw new Error("Invalid activation policy directory input.");
  return directoryChain(path);
}

export async function verifyActivationPolicyBuildDirectory(directory) {
  if (
    !directory ||
    typeof directory !== "object" ||
    typeof directory.original !== "string" ||
    typeof directory.canonical !== "string" ||
    !Array.isArray(directory.chain)
  )
    throw new Error("Invalid activation policy directory evidence.");
  await rebindDirectory(directory);
}

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJSON(value[key])]),
    );
  return value;
}

export function parseActivationPolicyProbe(stdout, publisherTeamID) {
  if (!Buffer.isBuffer(stdout) || stdout.length > 64 * 1024 || !validTeamID(publisherTeamID))
    throw new Error("Activation policy probe returned invalid output.");
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
  } catch {
    throw new Error("Activation policy probe returned invalid output.");
  }
  const lines = text.split("\n");
  if (lines.length !== 3 || lines[2] !== "" || !validHex(lines[1]))
    throw new Error("Activation policy probe returned invalid output.");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    throw new Error("Activation policy probe returned invalid output.");
  }
  const keys =
    "authorizationFormatVersion,candidateBindingScope,candidateBindingVersion,digestAlgorithm,envelopePolicyDigest,launcherVerification,payloadPolicyDigest,publisherTeamID,receiptVersion,roles,scope,selectionJournalVersion,version";
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== keys ||
    value.version !== 1 ||
    value.authorizationFormatVersion !== 1 ||
    value.candidateBindingScope !== "authenticated-candidate-capture" ||
    value.candidateBindingVersion !== 1 ||
    value.digestAlgorithm !== "sha256" ||
    value.launcherVerification !== "full-candidate-and-installed-role-v1" ||
    value.publisherTeamID !== publisherTeamID ||
    value.receiptVersion !== 2 ||
    value.scope !== "authenticated-service-activation" ||
    value.selectionJournalVersion !== 2 ||
    !validHex(value.envelopePolicyDigest) ||
    !validHex(value.payloadPolicyDigest) ||
    JSON.stringify(value.roles) !==
      JSON.stringify([
        { bundleIdentifier: "org.ellie.assistant.coordinator.app", name: "coordinator" },
        { bundleIdentifier: "org.ellie.assistant.node.app", name: "node" },
      ]) ||
    JSON.stringify(canonicalJSON(value)) !== lines[0]
  )
    throw new Error("Activation policy probe returned mismatched output.");
  const data = Buffer.from(lines[0] + "\n");
  const digest = sha256(data);
  if (digest !== lines[1]) throw new Error("Activation policy probe returned mismatched output.");
  return {
    data,
    digest,
    envelopePolicyDigest: value.envelopePolicyDigest,
    payloadPolicyDigest: value.payloadPolicyDigest,
  };
}

export function activationPolicyAuditMatches(output, expected, publisherTeamID, architecture) {
  try {
    if (!["arm64", "x64"].includes(architecture)) return false;
    const parsed = parseActivationPolicyProbe(
      Buffer.concat([expected.data, Buffer.from(expected.digest + "\n")]),
      publisherTeamID,
    );
    if (
      parsed.envelopePolicyDigest !== expected.envelopePolicyDigest ||
      parsed.payloadPolicyDigest !== expected.payloadPolicyDigest
    )
      return false;
    const header =
      [
        publisherTeamID,
        architecture,
        parsed.envelopePolicyDigest,
        parsed.payloadPolicyDigest,
        parsed.digest,
      ].join("|") + "\n";
    const wanted = Buffer.concat([
      Buffer.from(header),
      parsed.data,
      Buffer.from(parsed.digest + "\n"),
    ]);
    return (
      (Buffer.isBuffer(output) || typeof output === "string") && Buffer.from(output).equals(wanted)
    );
  } catch {
    return false;
  }
}

async function verifyScratch(scratch, captured, probeIdentity) {
  await rebindDirectory(scratch);
  if (
    (await readdir(scratch.canonical)).sort().join(",") !== "policy-probe,sources" ||
    (await readdir(join(scratch.canonical, "sources"))).sort().join(",") !==
      sourceNames.slice().sort().join(",")
  )
    throw new Error("Activation policy scratch inventory changed.");
  const sources = await lstat(join(scratch.canonical, "sources"), { bigint: true });
  if (
    !sources.isDirectory() ||
    sources.uid !== BigInt(process.getuid()) ||
    (sources.mode & 0o7777n) !== 0o700n
  )
    throw new Error("Activation policy snapshot directory changed.");
  for (const item of captured) {
    const snapshot = await readRegular(
      join(scratch.canonical, "sources", item.name),
      2 * 1024 * 1024,
      0o400,
    );
    if (sha256(snapshot.data) !== item.digest)
      throw new Error("Activation policy source snapshot changed.");
  }
  const probe = await readRegular(join(scratch.canonical, "policy-probe"), 64 * 1024 * 1024);
  if (
    (probe.info.mode & 0o111n) === 0n ||
    (probeIdentity &&
      (!sameFile(probe.info, probeIdentity.info) || sha256(probe.data) !== probeIdentity.digest))
  )
    throw new Error("Activation policy probe changed.");
  return { info: probe.info, digest: sha256(probe.data) };
}

export async function generateActivationPolicySource(options) {
  if (
    !options ||
    Object.keys(options).sort().join(",") !== "architecture,output,publisherTeamID,source"
  )
    throw new Error("Invalid activation policy generation input.");
  const { source, output, publisherTeamID, architecture } = options;
  if (
    typeof source !== "string" ||
    !isAbsolute(source) ||
    source.includes("\0") ||
    typeof output !== "string" ||
    !isAbsolute(output) ||
    output.includes("\0") ||
    !validTeamID(publisherTeamID) ||
    !["arm64", "x64"].includes(architecture) ||
    basename(output) === "." ||
    basename(output) === ".."
  )
    throw new Error("Invalid activation policy generation input.");
  const destination = await directoryChain(dirname(output));
  const target = join(destination.canonical, basename(output));
  try {
    await lstat(target);
    throw new Error("Activation policy output already exists.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const inputDirectory = await directoryChain(join(source, "packages/macos/native"));
  const captured = [];
  for (const name of sourceNames) {
    const path = join(inputDirectory.canonical, name);
    const value = await readRegular(path, 2 * 1024 * 1024);
    captured.push({ path, name, data: value.data, info: value.info, digest: sha256(value.data) });
  }
  await rebindDirectory(inputDirectory);
  await rebindDirectory(destination);
  const scratchPath = await mkdtemp(join(destination.canonical, ".ellie-policy-build-"));
  const scratch = await directoryChain(scratchPath);
  let completed = false;
  try {
    const snapshots = join(scratchPath, "sources");
    await mkdir(snapshots, { mode: 0o700 });
    for (const item of captured) {
      const handle = await open(
        join(snapshots, item.name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o400,
      );
      try {
        await handle.writeFile(item.data);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const probe = join(scratchPath, "policy-probe");
    await runActivationPolicyBuildCommand(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-parse-as-library",
        "-suppress-warnings",
        "-D",
        "ELLIE_ACTIVATION_POLICY_TESTING",
        ...sourceNames.map((name) => join(snapshots, name)),
        "-o",
        probe,
      ],
      { cwd: scratchPath },
    );
    const probeIdentity = await verifyScratch(scratch, captured);
    const stdout = await runActivationPolicyBuildCommand(
      probe,
      ["test-authenticated-activation-policy", publisherTeamID, architecture],
      { cwd: scratchPath },
    );
    const policy = parseActivationPolicyProbe(stdout, publisherTeamID);
    await verifyScratch(scratch, captured, probeIdentity);
    await rebindDirectory(inputDirectory);
    for (const item of captured) {
      const current = await readRegular(item.path, 2 * 1024 * 1024);
      if (!sameFile(current.info, item.info) || sha256(current.data) !== item.digest)
        throw new Error("Activation policy source changed during generation.");
    }
    const generated = blobSource(policy.data);
    await rebindDirectory(destination);
    const temporary = join(destination.canonical, ".ellie-policy-" + randomUUID());
    const handle = await open(
      temporary,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(generated);
      await handle.sync();
      const held = await handle.stat({ bigint: true });
      const staged = await readRegular(temporary, 64 * 1024, 0o600);
      if (!sameFile(staged.info, held) || !staged.data.equals(Buffer.from(generated)))
        throw new Error("Activation policy output changed before publication.");
      await rebindDirectory(destination);
      await link(temporary, target);
      const linked = await lstat(target, { bigint: true });
      const temporaryInfo = await lstat(temporary, { bigint: true });
      if (
        !sameIdentity(linked, held) ||
        !sameIdentity(temporaryInfo, held) ||
        linked.nlink !== 2n ||
        temporaryInfo.nlink !== 2n
      )
        throw new Error("Activation policy output publication is uncertain.");
      await rebindDirectory(destination);
      await unlink(temporary);
      const parent = await open(
        destination.canonical,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        if (!sameIdentity(await parent.stat({ bigint: true }), destination.chain[0].info))
          throw new Error("Activation policy output directory changed.");
        await parent.sync();
      } finally {
        await parent.close();
      }
      await rebindDirectory(destination);
      const published = await readRegular(target, 64 * 1024, 0o600);
      if (!sameIdentity(published.info, held) || !published.data.equals(Buffer.from(generated)))
        throw new Error("Activation policy output publication is uncertain.");
    } finally {
      await handle.close();
    }
    await verifyScratch(scratch, captured, probeIdentity);
    completed = true;
    return { ...policy, source: generated };
  } catch (error) {
    throw new Error(
      "Activation policy generation failed; owned evidence was retained at " + scratchPath + ".",
      { cause: error },
    );
  } finally {
    if (completed) {
      await rebindDirectory(scratch);
      await rm(scratchPath, { recursive: true });
    }
  }
}
