#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
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
const diagnosticFile = resolve(root, "test-results/native-ios-runner-diagnostic.txt");
let simulatorID,
  activeChild,
  requestedSignal,
  cleaning = false,
  succeeded = false;
const runnerStarted = performance.now();
let stage = "runner-setup",
  stageStarted = runnerStarted,
  xcodeStarted = false,
  failureOutcome = "failed",
  failureStageMilliseconds;
const cleanupOutcomes = [];

function enterStage(value) {
  stage = value;
  stageStarted = performance.now();
}

function millisecondsSince(value) {
  return Math.min(Math.max(Math.round(performance.now() - value), 0), 999_999);
}

function diagnostic(outcome, result, stageMilliseconds = millisecondsSince(stageStarted)) {
  const line = [
    "iOS runner diagnostic:",
    `stage=${stage}`,
    `outcome=${outcome}`,
    `stageMs=${stageMilliseconds}`,
    `totalMs=${millisecondsSince(runnerStarted)}`,
    `xcode=${xcodeStarted ? "started" : "not-started"}`,
    `result=${result}`,
    `cleanup=${cleanupOutcomes.length ? cleanupOutcomes.join(",") : "not-started"}`,
  ].join(" ");
  console.error(line);
  try {
    writeFileSync(diagnosticFile, `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    console.warn("The bounded iOS runner diagnostic could not be preserved.");
  }
}

function executionError(message, outcome) {
  return Object.assign(new Error(message), { outcome });
}

function terminate(child, signal) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function execute(
  file,
  args,
  {
    capture = false,
    timeout = 30_000,
    ignoreFailure = false,
    allowAfterSignal = false,
    label = "subprocess",
  } = {},
) {
  if (requestedSignal && !allowAfterSignal)
    return Promise.reject(executionError("iOS test interrupted.", "interrupted"));
  return new Promise((resolvePromise, reject) => {
    let stdout = "",
      failure,
      killTimer;
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    activeChild = child;
    const stop = (error) => {
      failure ??= error;
      terminate(child, "SIGTERM");
      killTimer ??= setTimeout(() => terminate(child, "SIGKILL"), 5_000);
    };
    if (capture)
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        if (stdout.length + chunk.length > 1_048_576) {
          stop(executionError(`${label} output exceeded its bound.`, "output-limit"));
        } else stdout += chunk;
      });
    const timer = setTimeout(() => {
      stop(executionError(`${label} exceeded its ${timeout} ms deadline.`, "timeout"));
    }, timeout);
    child.once("error", () => {
      failure ??= executionError(`${label} could not start.`, "spawn-failed");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      // The direct child closing does not prove that every member of its detached
      // process group exited. Repeat the owned-group kill before dropping its PID.
      if (failure) terminate(child, "SIGKILL");
      clearTimeout(killTimer);
      if (activeChild === child) activeChild = undefined;
      if (failure) reject(failure);
      else if (code === 0 || ignoreFailure) resolvePromise(stdout);
      else
        reject(
          executionError(
            `${label} exited with ${signal ? "signal" : `status-${code}`}.`,
            signal ? "signal" : "exit-status",
          ),
        );
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
        label: "simulator shutdown",
      });
      cleanupOutcomes.push("shutdown-complete");
    } catch {
      cleanupOutcomes.push("shutdown-failed");
      console.warn("The temporary iOS simulator did not shut down cleanly.");
    }
    try {
      await execute("xcrun", ["simctl", "delete", simulatorID], {
        timeout: 15_000,
        allowAfterSignal: true,
        label: "simulator deletion",
      });
      cleanupOutcomes.push("delete-complete");
    } catch {
      cleanupOutcomes.push("delete-failed");
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
  enterStage("simulator-discovery");
  rmSync(resultBundle, { recursive: true, force: true });
  rmSync(diagnosticFile, { force: true });
  mkdirSync(dirname(resultBundle), { recursive: true });
  const runtimes = JSON.parse(
    await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
      capture: true,
      timeout: 15_000,
      label: "simulator runtime discovery",
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
  enterStage("simulator-create");
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
      { capture: true, timeout: 30_000, label: "simulator creation" },
    )
  ).trim();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i.test(simulatorID)) {
    simulatorID = undefined;
    throw new Error("Simulator creation returned an invalid identifier.");
  }
  enterStage("simulator-boot-request");
  await execute("xcrun", ["simctl", "boot", simulatorID], {
    timeout: 30_000,
    label: "simulator boot request",
  });
  enterStage("simulator-boot-ready");
  await execute("xcrun", ["simctl", "bootstatus", simulatorID, "-b"], {
    capture: true,
    timeout: 120_000,
    label: "simulator boot readiness",
  });
  enterStage("xcode-test");
  xcodeStarted = true;
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
    { timeout: 600_000, label: "Xcode test" },
  );
  succeeded = true;
  enterStage("complete");
} catch (error) {
  failureStageMilliseconds = millisecondsSince(stageStarted);
  failureOutcome = requestedSignal ? "interrupted" : (error?.outcome ?? "failed");
  console.error(error instanceof Error ? error.message : "iOS test failed.");
} finally {
  await cleanup();
  if (succeeded) {
    rmSync(resultBundle, { recursive: true, force: true });
    diagnostic("passed", "removed-after-success");
  } else {
    let result = "not-created";
    try {
      const info = lstatSync(resultBundle);
      result = info.isDirectory() ? "retained" : "invalid";
    } catch (error) {
      if (error?.code !== "ENOENT") result = "unreadable";
    }
    diagnostic(failureOutcome, result, failureStageMilliseconds);
    process.exitCode = 1;
  }
}

if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
