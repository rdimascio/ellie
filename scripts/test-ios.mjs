#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const environment = {
  ...process.env,
  DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer",
};
const derivedData = mkdtempSync(`${tmpdir()}/ellie-ios-derived-`);
const resultBundle = resolve(root, "test-results/native-ios.xcresult");
let simulatorID,
  activeChild,
  requestedSignal,
  cleaning = false,
  succeeded = false;

function terminate(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function execute(
  file,
  args,
  { capture = false, timeout = 30_000, ignoreFailure = false, allowAfterSignal = false } = {},
) {
  if (requestedSignal && !allowAfterSignal)
    return Promise.reject(new Error("iOS test interrupted."));
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChild = child;
    if (capture)
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
    let killTimer;
    const timer = setTimeout(() => {
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), 5_000);
    }, timeout);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (activeChild === child) activeChild = undefined;
      if (code === 0 || ignoreFailure) resolvePromise(stdout);
      else reject(new Error(`${file} exited with ${signal ?? code}.`));
    });
  });
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (simulatorID) {
    try {
      await execute("xcrun", ["simctl", "shutdown", simulatorID], {
        timeout: 15_000,
        allowAfterSignal: true,
      });
    } catch {
      console.warn("The temporary iOS simulator did not shut down cleanly.");
    }
    try {
      await execute("xcrun", ["simctl", "delete", simulatorID], {
        timeout: 15_000,
        allowAfterSignal: true,
      });
    } catch {
      console.warn(
        "The temporary iOS simulator could not be deleted; remove the uniquely named Ellie iOS Tests simulator manually.",
      );
    }
  }
  rmSync(derivedData, { recursive: true, force: true });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    if (activeChild) {
      const child = activeChild;
      terminate(child, "SIGTERM");
      setTimeout(() => {
        if (activeChild === child) terminate(child, "SIGKILL");
      }, 5_000);
    }
  });
}

try {
  rmSync(resultBundle, { recursive: true, force: true });
  mkdirSync(dirname(resultBundle), { recursive: true });
  const runtimes = JSON.parse(
    await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
      capture: true,
      timeout: 15_000,
    }),
  )
    .runtimes.filter(
      (item) =>
        item.isAvailable &&
        item.identifier?.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-") &&
        Number(item.version?.split(".")[0]) >= 17,
    )
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (!runtimes.length)
    throw new Error("No available iOS 17 or newer Simulator runtime was found.");
  const compatible =
    runtimes[0].supportedDeviceTypes?.filter((item) => item.productFamily === "iPhone") ?? [];
  const device = compatible.find((item) => item.name === "iPhone 16") ?? compatible[0];
  if (!device) throw new Error(`No iPhone device type supports iOS ${runtimes[0].version}.`);
  simulatorID = (
    await execute(
      "xcrun",
      [
        "simctl",
        "create",
        `Ellie iOS Tests ${randomUUID().slice(0, 8)}`,
        device.identifier,
        runtimes[0].identifier,
      ],
      { capture: true, timeout: 30_000 },
    )
  ).trim();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorID)) {
    simulatorID = undefined;
    throw new Error("Simulator creation returned an invalid identifier.");
  }
  await execute("xcrun", ["simctl", "boot", simulatorID], { timeout: 30_000 });
  await execute("xcrun", ["simctl", "bootstatus", simulatorID, "-b"], { timeout: 120_000 });
  await execute(
    "xcodebuild",
    [
      "-project",
      "apps/ios/EllieIOS.xcodeproj",
      "-scheme",
      "EllieIOS",
      "-destination",
      `platform=iOS Simulator,id=${simulatorID}`,
      "-derivedDataPath",
      derivedData,
      "-resultBundlePath",
      resultBundle,
      "CODE_SIGNING_ALLOWED=YES",
      "test",
    ],
    { timeout: 600_000 },
  );
  succeeded = true;
} finally {
  await cleanup();
  if (succeeded) rmSync(resultBundle, { recursive: true, force: true });
}

if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
