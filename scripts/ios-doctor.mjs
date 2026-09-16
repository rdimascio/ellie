#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const OUTPUT_LIMIT = 16_384;
const JSON_LIMIT = 262_144;
const COMMAND_TIMEOUT = 8_000;

export async function runBounded(file, args, { timeoutMs = COMMAND_TIMEOUT } = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let overflow = false;
    let stderrBytes = 0;
    let stdoutBytes = 0;
    let timedOut = false;
    let reaped = false;
    let exited = false;
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const deadline = setTimeout(() => {
      timedOut = true;
      if (!exited) child.kill("SIGTERM");
    }, timeoutMs);
    const killTimer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, timeoutMs + 1_000);
    const reapTimer = setTimeout(() => {
      if (reaped) return;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(Object.assign(new Error("owned-child-not-reaped"), { code: "OWNERSHIP_UNCERTAIN" }));
    }, timeoutMs + 3_000);
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > OUTPUT_LIMIT) {
        overflow = true;
        if (!exited) child.kill("SIGTERM");
      } else stdout += chunk.toString("utf8");
    });
    // Drain but never retain stderr, which can contain local paths or account details.
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > OUTPUT_LIMIT) {
        overflow = true;
        if (!exited) child.kill("SIGTERM");
      }
    });
    child.once("error", () => {});
    child.once("exit", () => {
      exited = true;
    });
    child.once("close", (code, signal) => {
      reaped = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      resolve({
        code,
        signal,
        stdout: overflow || timedOut ? "" : stdout,
        limited: overflow || timedOut,
      });
    });
  });
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The v2 envelope and connection fields are grounded in retained devicectl output
// and flutter/flutter@154e6f34f6cade05ab61890164f0d734aa05e70c.
// Physical reality must also be explicit; an absent field remains unknown.
export function summarizeDevices(json) {
  if (
    !plainObject(json) ||
    !plainObject(json.info) ||
    json.info.outcome !== "success" ||
    json.info.commandType !== "devicectl.list.devices" ||
    json.info.jsonVersion !== 2 ||
    !plainObject(json.result) ||
    !Array.isArray(json.result.devices)
  )
    return { status: "unknown", count: 0, paired: 0, developerMode: 0 };
  if (json.result.devices.length > 100)
    return { status: "unknown", count: 0, paired: 0, developerMode: 0 };
  const phones = json.result.devices.filter(
    (device) =>
      plainObject(device) &&
      plainObject(device.hardwareProperties) &&
      device.hardwareProperties.deviceType === "iPhone" &&
      device.hardwareProperties.platform === "iOS" &&
      device.hardwareProperties.reality === "physical",
  );
  if (!phones.length)
    return {
      status: json.result.devices.length ? "unknown" : "blocked",
      count: 0,
      paired: 0,
      developerMode: 0,
    };
  const paired = phones.filter(
    (device) => device.connectionProperties?.pairingState === "paired",
  ).length;
  const developerMode = phones.filter(
    (device) => device.deviceProperties?.developerModeStatus === "enabled",
  ).length;

  const explicitBlocked = phones.some(
    (device) => device.deviceProperties?.developerModeStatus === "disabled",
  );
  return {
    status: phones.some(
      (device) =>
        device.connectionProperties?.pairingState === "paired" &&
        device.deviceProperties?.developerModeStatus === "enabled" &&
        ["wired", "localNetwork"].includes(device.connectionProperties?.transportType) &&
        device.connectionProperties?.tunnelState === "connected",
    )
      ? "observed"
      : explicitBlocked
        ? "blocked"
        : "unknown",
    count: phones.length,
    paired,
    developerMode,
  };
}

export function summarizeIdentities(output) {
  if (typeof output !== "string" || output.length > OUTPUT_LIMIT)
    return { status: "unknown", count: 0 };
  const lines = output.split(/\r?\n/);
  const count = lines.filter((line) =>
    /^\s*\d+\)\s+[A-Fa-f0-9]{40}\s+"Apple Development: [^"\r\n]{1,256}"\s*$/.test(line),
  ).length;
  const summary = output.match(/(?:^|\n)\s*(\d+) valid identities found\s*$/);
  if (!summary || Number(summary[1]) < count) return { status: "unknown", count: 0 };
  return { status: count ? "observed" : "blocked", count };
}

async function readBoundedJSON(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > JSON_LIMIT) throw new Error("json-file-invalid");
    const bytes = Buffer.alloc(JSON_LIMIT + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > JSON_LIMIT) throw new Error("json-limit");
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await handle.close();
  }
}

export async function checkIOS({
  run = runBounded,
  readJSON = readBoundedJSON,
  platform = process.platform,
} = {}) {
  const result = {
    host: platform === "darwin" ? "supported" : "unsupported",
    subprocessOwnership: "verified",
    xcode: { status: "unknown" },
    identity: { status: "unknown", count: 0 },
    devices: { status: "unknown", count: 0, paired: 0, developerMode: 0 },
    provisioning: "unverified",
    buildInstall: "unverified",
  };
  if (platform !== "darwin") return result;
  try {
    const version = await run("xcodebuild", ["-version"]);
    const sdk = await run("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
    result.xcode.status =
      version.code === 0 &&
      /^Xcode \d+(?:\.\d+)*\s*\nBuild version \S+/m.test(version.stdout) &&
      sdk.code === 0 &&
      /^\d+(?:\.\d+)+\s*$/.test(sdk.stdout)
        ? "observed"
        : version.limited || sdk.limited
          ? "unknown"
          : "blocked";
  } catch (error) {
    if (error?.code === "OWNERSHIP_UNCERTAIN") {
      result.subprocessOwnership = "uncertain";
      return result;
    }
  }
  try {
    const identity = await run("security", ["find-identity", "-v", "-p", "codesigning"]);
    result.identity =
      identity.code === 0 && !identity.limited
        ? summarizeIdentities(identity.stdout)
        : { status: "unknown", count: 0 };
  } catch (error) {
    if (error?.code === "OWNERSHIP_UNCERTAIN") {
      result.subprocessOwnership = "uncertain";
      return result;
    }
  }
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), "ellie-ios-doctor-"));
    await chmod(directory, 0o700);
    const outputPath = join(directory, "devices.json");
    const listing = await run("xcrun", [
      "devicectl",
      "list",
      "devices",
      "--timeout",
      "5",
      "--json-output",
      outputPath,
    ]);
    if (listing.code === 0 && !listing.limited)
      result.devices = summarizeDevices(await readJSON(outputPath));
  } catch (error) {
    if (error?.code === "OWNERSHIP_UNCERTAIN") result.subprocessOwnership = "uncertain";
  } finally {
    if (directory && result.subprocessOwnership !== "uncertain") {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        result.devices = { status: "unknown", count: 0, paired: 0, developerMode: 0 };
      }
    }
  }
  return result;
}

export function formatHuman(result) {
  return [
    `macOS host: ${result.host}`,
    `Preflight subprocess ownership: ${result.subprocessOwnership}`,
    `Full Xcode + iPhoneOS SDK: ${result.xcode.status}`,
    `Visible Apple Development identities: ${result.identity.status} (${result.identity.count})`,
    `Physical iPhones: ${result.devices.status} (${result.devices.count} seen; ${result.devices.paired} paired; ${result.devices.developerMode} Developer Mode enabled)`,
    "App provisioning profile, signed build, and physical install: unverified",
    result.host === "unsupported"
      ? "Run this preflight on the Mac that will connect to the iPhone."
      : result.xcode.status !== "observed"
        ? "Select full Xcode with its iPhoneOS SDK; sign in to Xcode for attended setup."
        : result.identity.status !== "observed"
          ? "Check Xcode account/team and Apple Development signing setup; identity visibility alone cannot verify the app profile."
          : result.devices.status !== "observed"
            ? "Connect and unlock the iPhone, accept Trust, pair it in Xcode, and enable Developer Mode."
            : "Next: choose the app team/profile in Xcode, then verify a signed build and physical install.",
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: bun run ios:doctor [--json]\nRead-only local iPhone development preflight. Does not build, sign, or install.\nExit 0: observations available, not install-ready; 1: blocked/unknown; 2: usage.",
    );
    return;
  }
  if (args.length && !(args.length === 1 && args[0] === "--json")) {
    console.error("Usage: bun run ios:doctor [--json]");
    process.exitCode = 2;
    return;
  }
  const result = await checkIOS();
  console.log(args[0] === "--json" ? JSON.stringify(result) : formatHuman(result));
  if (
    result.host !== "supported" ||
    result.subprocessOwnership !== "verified" ||
    [result.xcode, result.identity, result.devices].some((check) => check.status !== "observed")
  )
    process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
