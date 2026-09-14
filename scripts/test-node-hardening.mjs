#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const maximumOutput = 1024 * 1024;
const commandTimeout = 30_000;
const archiveMaximum = 100 * 1024 * 1024;
const nodeMaximum = 256 * 1024 * 1024;

export const nodeHardeningEntitlements = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
  "com.apple.security.cs.allow-unsigned-executable-memory": true,
});

export function parseNodeHardeningOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !value ||
      !["--node-archive", "--node-sha256", "--developer-id-sha1", "--team-id"].includes(key) ||
      key in values
    )
      throw new Error(
        "Use: test-node-hardening.mjs --node-archive ABSOLUTE_TAR_XZ --node-sha256 LOWERCASE_SHA256 [--developer-id-sha1 CERTIFICATE_SHA1 --team-id TEAM_ID]",
      );
    values[key] = value;
  }
  if (
    ![4, 8].includes(args.length) ||
    !values["--node-archive"]?.startsWith("/") ||
    !/^([a-f0-9]{64})$/.test(values["--node-sha256"] ?? "")
  )
    throw new Error("Node hardening inputs are invalid.");
  const archive = resolve(values["--node-archive"]);
  if (!/^node-v24\.[0-9]+\.[0-9]+-darwin-arm64\.tar\.xz$/.test(basename(archive)))
    throw new Error("Node hardening archive name is invalid.");
  const identitySha1 = values["--developer-id-sha1"];
  const teamId = values["--team-id"];
  validateDeveloperIdOptions({ identitySha1, teamId });
  if (identitySha1 !== undefined) {
    return { archive, sha256: values["--node-sha256"], identitySha1, teamId };
  }
  return { archive, sha256: values["--node-sha256"] };
}

const validationIdentifier = "org.ellie.validation.node";

export function validateDeveloperIdOptions(options) {
  const identitySha1 = options?.identitySha1;
  const teamId = options?.teamId;
  if ((identitySha1 === undefined) !== (teamId === undefined))
    throw new Error("Developer ID validation inputs are incomplete.");
  if (
    identitySha1 !== undefined &&
    (typeof identitySha1 !== "string" ||
      identitySha1.length !== 40 ||
      !/^[A-F0-9]{40}$/.test(identitySha1) ||
      typeof teamId !== "string" ||
      teamId.length !== 10 ||
      !/^[A-Z0-9]{10}$/.test(teamId))
  )
    throw new Error("Developer ID validation inputs are invalid.");
}

export function developerIdSigningEnvironment(options, isolatedEnvironment, callerHome) {
  if (!options.identitySha1) return { ...isolatedEnvironment };
  if (
    typeof callerHome !== "string" ||
    !callerHome.startsWith("/") ||
    callerHome.length > 1_024 ||
    callerHome.includes("\0") ||
    resolve(callerHome) !== callerHome
  )
    throw new Error("Developer ID signing HOME is invalid.");
  return { ...isolatedEnvironment, HOME: callerHome };
}

export function classifyDeveloperIdSigningFailure(stderr) {
  if (typeof stderr !== "string") return "exit-status";
  if (
    /identity .{0,80}not found|no identity found|specified item could not be found in the keychain/i.test(
      stderr,
    )
  )
    return "signing-identity-unavailable";
  if (/user interaction is not allowed|interaction not allowed/i.test(stderr))
    return "signing-interaction-not-allowed";
  if (/timestamp.{0,100}(?:unavailable|failed|could not|unable|timed out)/i.test(stderr))
    return "signing-timestamp-unavailable";
  if (/timed out/i.test(stderr)) return "signing-timeout";
  return "exit-status";
}

export function nodeHardeningSigningArguments(options, node, entitlements) {
  const identity = options.identitySha1 ?? "-";
  return [
    "--force",
    "--sign",
    identity,
    "--identifier",
    validationIdentifier,
    "--options",
    "runtime",
    ...(options.identitySha1 ? ["--timestamp"] : []),
    "--entitlements",
    entitlements,
    node,
  ];
}

export function nodeHardeningVerificationArguments(options, node) {
  const result = ["--verify", "--strict", "--all-architectures"];
  if (options.identitySha1) {
    result.push(
      `-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${options.teamId}" and identifier "${validationIdentifier}"`,
    );
  }
  result.push(node);
  return result;
}

export function validateNodeSignatureMetadata(details, teamId) {
  if (typeof details !== "string" || Buffer.byteLength(details) > maximumOutput)
    throw new Error("Hardened Node signature metadata is invalid.");
  const flags = /flags=0x([0-9a-f]+)\([^)]*runtime[^)]*\)/i.exec(details);
  if (
    !flags ||
    (Number.parseInt(flags[1], 16) & 0x10000) === 0 ||
    !new RegExp(`^Identifier=${validationIdentifier.replaceAll(".", "\\.")}$`, "m").test(details)
  )
    throw new Error("Hardened Node signature metadata is invalid.");
  if (teamId === undefined) {
    if (!/^Signature=adhoc$/m.test(details) || /^Timestamp=/m.test(details))
      throw new Error("Hardened Node signature metadata is invalid.");
    return;
  }
  const authorities = [...details.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
  if (
    typeof teamId !== "string" ||
    teamId.length !== 10 ||
    !/^[A-Z0-9]{10}$/.test(teamId) ||
    !new RegExp(`^TeamIdentifier=${teamId}$`, "m").test(details) ||
    !/^Timestamp=.+$/m.test(details) ||
    /^Signature=adhoc$/m.test(details) ||
    authorities.length !== 3 ||
    !authorities[0].startsWith("Developer ID Application:") ||
    authorities[1] !== "Developer ID Certification Authority" ||
    authorities[2] !== "Apple Root CA"
  )
    throw new Error("Hardened Node Developer ID metadata is invalid.");
}

function groupAbsent(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup <= 1) return true;
  try {
    process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

function signalDirectChild(child, signal) {
  if (
    !child ||
    !Number.isInteger(child.pid) ||
    child.pid <= 1 ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return false;
  return child.kill(signal);
}

function removeOwnedRoot(state) {
  if (state.children.size) state.cleanupCertain = false;
  if (!state.cleanupCertain) return false;
  rmSync(state.root, { recursive: true });
  return true;
}

function command(file, args, options, state) {
  const {
    capture = false,
    timeout = commandTimeout,
    env = state.environment,
    outputFile,
    maximumFile = 0,
    failureClassifier,
    killAfter = 5_000,
    reapAfter = 7_000,
  } = options ?? {};
  if (state.signal) return Promise.reject(new Error("Node hardening validation interrupted."));
  state.commandOutcome = undefined;
  return new Promise((resolvePromise, reject) => {
    let stdout = "",
      stderr = "",
      outputBytes = 0,
      outputDescriptor,
      failure,
      killTimer,
      reapTimer,
      settled = false;
    if (outputFile)
      outputDescriptor = openSync(
        outputFile,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o700,
      );
    let child;
    try {
      child = spawn(file, args, {
        cwd: state.root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      if (outputDescriptor !== undefined) {
        try {
          closeSync(outputDescriptor);
        } catch {
          state.cleanupCertain = false;
        }
      }
      state.commandOutcome = "spawn-error";
      reject(new Error("Validation child could not start."));
      return;
    }
    state.children.add(child);
    state.active = child;
    const stop = (error, outcome = "interrupted") => {
      if (settled) return;
      state.commandOutcome ??= outcome;
      failure ??= error;
      signalDirectChild(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), killAfter);
      reapTimer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearTimeout(killTimer);
        state.cleanupCertain = false;
        state.children.delete(child);
        if (state.active === child) {
          state.active = undefined;
          state.stop = undefined;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        if (outputDescriptor !== undefined) {
          try {
            closeSync(outputDescriptor);
          } catch {}
          outputDescriptor = undefined;
        }
        child.unref();
        reject(new Error("A validation child could not be reaped; owned evidence was retained."));
      }, reapAfter);
    };
    state.stop = () => stop(new Error("Node hardening validation interrupted."));
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) + Buffer.byteLength(chunk) > maximumOutput) {
        stop(new Error("Validation child output exceeded its bound."), "output-limit");
        return current;
      }
      return current + chunk;
    };
    if (outputFile)
      child.stdout.on("data", (chunk) => {
        if (failure || settled) return;
        if (outputBytes + chunk.length > maximumFile) {
          stop(new Error("Extracted Node executable exceeded its bound."), "output-limit");
          return;
        }
        try {
          let written = 0;
          while (written < chunk.length) {
            const count = writeSync(outputDescriptor, chunk, written, chunk.length - written);
            if (count < 1) throw new Error("short write");
            written += count;
          }
          outputBytes += chunk.length;
        } catch {
          stop(new Error("Extracted Node executable could not be written."), "write-failure");
        }
      });
    else
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (failure || settled) return;
        stdout = append(stdout, chunk);
      });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      if (failure || settled) return;
      stderr = append(stderr, chunk);
    });
    const deadline = setTimeout(
      () => stop(new Error("Validation child exceeded its deadline."), "deadline"),
      timeout,
    );
    child.once("error", () => {
      state.commandOutcome = "spawn-error";
      failure ??= new Error("Validation child could not start.");
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      if (outputDescriptor !== undefined) {
        try {
          closeSync(outputDescriptor);
        } catch {
          state.cleanupCertain = false;
          failure ??= new Error("Extracted Node executable could not be closed.");
        }
        outputDescriptor = undefined;
      }
      state.children.delete(child);
      if (state.active === child) {
        state.active = undefined;
        state.stop = undefined;
      }
      if (settled) return;
      settled = true;
      try {
        if (!groupAbsent(child.pid)) {
          state.cleanupCertain = false;
          failure ??= new Error("A validation child left process-group members.");
        }
      } catch {
        state.cleanupCertain = false;
        failure ??= new Error("Validation child cleanup could not be verified.");
      }
      if (failure) reject(failure);
      else if (code !== 0) {
        state.commandOutcome = signal ? "signal" : (failureClassifier?.(stderr) ?? "exit-status");
        reject(new Error(`Validation child exited with ${signal ? "a signal" : "an error"}.`));
      } else resolvePromise(capture ? { stdout, stderr } : undefined);
    });
  });
}

export async function runNodeHardeningCommandFixture(file, args, options) {
  const state = {
    root: options.root,
    children: new Set(),
    cleanupCertain: true,
    environment: {
      HOME: options.root,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: options.root,
      LANG: "C",
      LC_ALL: "C",
    },
  };
  let interruptTimer;
  if (options.interruptAfter !== undefined)
    interruptTimer = setTimeout(() => {
      state.signal = "SIGTERM";
      state.stop?.();
    }, options.interruptAfter);
  let outcome = "completed";
  try {
    await command(
      file,
      args,
      {
        capture: true,
        outputFile: options.outputFile,
        maximumFile: options.maximumFile,
        timeout: options.timeout,
        killAfter: options.killAfter,
        reapAfter: options.reapAfter,
      },
      state,
    );
  } catch (error) {
    outcome = error instanceof Error ? error.message : "failed";
  } finally {
    clearTimeout(interruptTimer);
  }
  let laterBlocked = false;
  if (options.interruptAfter !== undefined) {
    try {
      await command(file, args, { capture: true, timeout: 100 }, state);
    } catch (error) {
      laterBlocked = error instanceof Error && error.message.includes("interrupted");
    }
  }
  if (options.cleanupOnSettlement) removeOwnedRoot(state);
  return { outcome, cleanupCertain: state.cleanupCertain, laterBlocked };
}

async function captureArchive(source, destination, expected, state) {
  const hash = createHash("sha256");
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output;
  let operationError;
  let closeFailed = false;
  try {
    const info = await input.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      info.nlink !== 1 ||
      (info.mode & 0o022) !== 0 ||
      info.size < 1 ||
      info.size > archiveMaximum
    )
      throw new Error("Node archive is not one bounded private regular file.");
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    const buffer = Buffer.allocUnsafe(256 * 1024);
    while (offset < info.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, info.size - offset),
        offset,
      );
      if (bytesRead < 1) throw new Error("Node archive changed while it was captured.");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, offset + written);
        if (result.bytesWritten < 1) throw new Error("Node archive could not be captured.");
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    if ((await input.read(buffer, 0, 1, offset)).bytesRead !== 0)
      throw new Error("Node archive changed while it was captured.");
    const finalInfo = await input.stat();
    if (
      finalInfo.dev !== info.dev ||
      finalInfo.ino !== info.ino ||
      finalInfo.uid !== info.uid ||
      finalInfo.nlink !== info.nlink ||
      finalInfo.mode !== info.mode ||
      finalInfo.size !== info.size
    )
      throw new Error("Node archive changed while it was captured.");
    if (hash.digest("hex") !== expected) throw new Error("Node archive checksum does not match.");
    await output.sync();
  } catch (error) {
    operationError = error;
  } finally {
    if (output)
      try {
        await output.close();
      } catch {
        state.cleanupCertain = false;
        closeFailed = true;
      }
    try {
      await input.close();
    } catch {
      state.cleanupCertain = false;
      closeFailed = true;
    }
  }
  if (closeFailed) throw new Error("Captured Node archive could not be closed safely.");
  if (operationError) throw operationError;
}

function entitlementPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
`;
}

export function validateNodeEntitlements(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Hardened Node entitlement set is invalid.");
  const keys = Object.keys(value);
  const expected = Object.keys(nodeHardeningEntitlements).sort();
  if (JSON.stringify(keys.sort()) !== JSON.stringify(expected))
    throw new Error("Hardened Node entitlement set is invalid.");
  for (const key of expected)
    if (value[key] !== true) throw new Error("Hardened Node entitlement set is invalid.");
}

function workloadSource() {
  return `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:tls";
import { connect } from "node:tls";
import { Worker } from "node:worker_threads";

for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "DYLD_INSERT_LIBRARIES", "ELLIE_MACOS_HELPER"]) {
  assert.equal(name in process.env, false);
}

const hot = (value) => (value * 33 + 17) >>> 0;
let value = 1;
for (let index = 0; index < 2_000_000; index += 1) value = hot(value);
assert.equal(value, 3447428225);
assert.equal(createHash("sha256").update("ellie").digest("hex"), "027434cce1114811be52fa56af57a6550bda1c7777be20f4e51f4a6952574c72");
assert.equal((await import("node:path")).basename("/a/b"), "b");
await new Promise((resolveWorker, reject) => {
  const worker = new Worker("const {parentPort}=require('node:worker_threads'); parentPort.postMessage(6*7)", { eval: true });
  worker.once("message", (result) => result === 42 ? resolveWorker() : reject(new Error("worker")));
  worker.once("error", reject);
});
const [key, cert] = await Promise.all([readFile(process.env.TEST_KEY), readFile(process.env.TEST_CERT)]);
const server = createServer({ key, cert }, (socket) => socket.end("ok"));
await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
const address = server.address();
await new Promise((resolveTLS, reject) => {
  const socket = connect({ host: "127.0.0.1", port: address.port, ca: cert, servername: "localhost" });
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => text += chunk);
  socket.once("end", () => text === "ok" ? resolveTLS() : reject(new Error("tls")));
  socket.once("error", reject);
});
await new Promise((resolveClose) => server.close(resolveClose));
console.log(JSON.stringify({ warmup: true, worker: true, crypto: true, dynamicImport: true, tls: true }));
`;
}

export async function runNodeHardeningValidation(options) {
  validateDeveloperIdOptions(options);
  const signingHome = developerIdSigningEnvironment(options, {}, process.env.HOME).HOME;
  const archiveName = /^node-(v24\.[0-9]+\.[0-9]+)-darwin-arm64\.tar\.xz$/.exec(
    basename(options.archive),
  );
  if (!archiveName) throw new Error("Node hardening archive name is invalid.");
  const maximumNodeBytes = options.testMaximumNodeBytes ?? nodeMaximum;
  if (
    !Number.isSafeInteger(maximumNodeBytes) ||
    maximumNodeBytes < 1 ||
    maximumNodeBytes > nodeMaximum
  )
    throw new Error("Node hardening test bound is invalid.");
  const root = mkdtempSync(join(tmpdir(), "ellie-node-hardening-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const state = {
    root,
    children: new Set(),
    cleanupCertain: true,
    stage: "archive-capture",
    environment: {
      HOME: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TMPDIR: root,
      LANG: "C",
      LC_ALL: "C",
    },
  };
  const interrupt = (signal) => {
    state.signal = signal;
    state.stop?.();
  };
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => interrupt(signal)]),
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  let succeeded = false;
  let runFailure;
  try {
    const capturedArchive = join(root, "node-input.tar.xz");
    await captureArchive(options.archive, capturedArchive, options.sha256, state);
    state.stage = "archive-inspect";
    const listing = await command(
      "/usr/bin/tar",
      ["-tJf", capturedArchive],
      { capture: true },
      state,
    );
    const nodeEntries = listing.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.endsWith("/bin/node"));
    if (
      nodeEntries.length !== 1 ||
      nodeEntries[0] !== `node-${archiveName[1]}-darwin-arm64/bin/node`
    )
      throw new Error("Node archive layout is invalid.");
    const member = await command(
      "/usr/bin/tar",
      ["-tvJf", capturedArchive, nodeEntries[0]],
      { capture: true },
      state,
    );
    const escapedMember = nodeEntries[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const memberMatch = new RegExp(
      `^-rwxr-xr-x\\s+0\\s+[^\\s]+\\s+[^\\s]+\\s+([0-9]+)\\s+[A-Z][a-z]{2}\\s+[0-9]{1,2}\\s+(?:[0-9]{2}:[0-9]{2}|[0-9]{4})\\s+${escapedMember}$`,
    ).exec(member.stdout.trim());
    const memberSize = Number(memberMatch?.[1]);
    if (
      !memberMatch ||
      !Number.isSafeInteger(memberSize) ||
      memberSize < 1 ||
      memberSize > maximumNodeBytes
    )
      throw new Error("Node archive member is not one canonical executable file.");
    const node = join(root, "node");
    state.stage = "archive-extract";
    await command(
      "/usr/bin/tar",
      ["-xOJf", capturedArchive, nodeEntries[0]],
      { outputFile: node, maximumFile: Math.min(memberSize, maximumNodeBytes) },
      state,
    );
    const nodeHandle = await open(
      node,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let nodeInfo;
    let inspectionCloseFailed = false;
    try {
      nodeInfo = await nodeHandle.stat();
    } finally {
      try {
        await nodeHandle.close();
      } catch {
        state.cleanupCertain = false;
        inspectionCloseFailed = true;
      }
    }
    if (inspectionCloseFailed)
      throw new Error("Extracted Node inspection descriptor could not be closed.");
    if (
      !nodeInfo.isFile() ||
      nodeInfo.uid !== process.getuid() ||
      nodeInfo.nlink !== 1 ||
      nodeInfo.size !== memberSize ||
      (nodeInfo.mode & 0o022) !== 0
    )
      throw new Error("Extracted Node executable is invalid.");
    chmodSync(node, 0o700);
    state.stage = "signature-create";
    const entitlements = join(root, "node.entitlements");
    writeFileSync(entitlements, entitlementPlist(), { mode: 0o600 });
    await command(
      "/usr/bin/codesign",
      nodeHardeningSigningArguments(options, node, entitlements),
      {
        env: developerIdSigningEnvironment(options, state.environment, signingHome),
        failureClassifier: options.identitySha1 ? classifyDeveloperIdSigningFailure : undefined,
      },
      state,
    );
    state.stage = "signature-verify";
    await command(
      "/usr/bin/codesign",
      nodeHardeningVerificationArguments(options, node),
      {},
      state,
    );
    state.stage = "signature-inspect";
    const details = await command("/usr/bin/codesign", ["-dvv", node], { capture: true }, state);
    validateNodeSignatureMetadata(details.stderr, options.teamId);
    const actual = await command(
      "/usr/bin/codesign",
      ["-d", "--entitlements", ":-", node],
      { capture: true },
      state,
    );
    const actualEntitlements = join(root, "actual-entitlements.plist");
    writeFileSync(actualEntitlements, actual.stdout, { mode: 0o600 });
    const semanticEntitlements = await command(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", actualEntitlements],
      { capture: true },
      state,
    );
    let entitlementValue;
    try {
      entitlementValue = JSON.parse(semanticEntitlements.stdout);
    } catch {
      throw new Error("Hardened Node entitlement set is invalid.");
    }
    validateNodeEntitlements(entitlementValue);

    state.stage = "runtime-identity";
    const identity = await command(
      node,
      [
        "-p",
        "JSON.stringify({version:process.version,arch:process.arch,platform:process.platform})",
      ],
      { capture: true },
      state,
    );
    let runtimeIdentity;
    try {
      runtimeIdentity = JSON.parse(identity.stdout);
    } catch {
      throw new Error("Copied Node runtime identity is invalid.");
    }
    if (
      JSON.stringify(runtimeIdentity) !==
      JSON.stringify({
        version: archiveName[1],
        arch: "arm64",
        platform: "darwin",
      })
    )
      throw new Error("Copied Node runtime identity does not match its archive.");

    state.stage = "certificate";
    const openssl = "/usr/bin/openssl";
    const config = join(root, "openssl.cnf");
    const key = join(root, "key.pem");
    const cert = join(root, "cert.pem");
    writeFileSync(
      config,
      "[req]\ndistinguished_name=dn\nx509_extensions=server\nprompt=no\n[dn]\nCN=localhost\n[server]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
      { mode: 0o600 },
    );
    await command(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-config",
        config,
      ],
      {},
      state,
    );
    const workload = join(root, `workload-${randomUUID()}.mjs`);
    writeFileSync(workload, workloadSource(), { mode: 0o600 });
    const environment = {
      ...state.environment,
      TEST_KEY: key,
      TEST_CERT: cert,
    };
    state.stage = "workload";
    const result = await command(node, [workload], { capture: true, env: environment }, state);
    const expected = {
      warmup: true,
      worker: true,
      crypto: true,
      dynamicImport: true,
      tls: true,
    };
    if (JSON.stringify(JSON.parse(result.stdout)) !== JSON.stringify(expected))
      throw new Error("Hardened Node workload result is invalid.");
    succeeded = true;
    console.log(
      `PASS Hardened ${options.identitySha1 ? "Developer ID" : "ad-hoc"} Node completed the isolated runtime workload.`,
    );
  } catch {
    runFailure = new Error(
      `FAIL Node hardening validation stage=${state.stage} outcome=${state.signal ? "interrupted" : (state.commandOutcome ?? "failed")}.`,
    );
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (!removeOwnedRoot(state)) console.error(`Owned Node hardening evidence retained: ${root}`);
  }
  if (runFailure) throw runFailure;
  if (!succeeded) throw new Error("FAIL Node hardening validation did not complete.");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    const options = parseNodeHardeningOptions(process.argv.slice(2));
    await runNodeHardeningValidation(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "FAIL Node hardening validation.");
    process.exitCode = 1;
  }
}
