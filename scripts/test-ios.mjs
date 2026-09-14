#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { selectCompatibleIOSRuntime } from "./ios-runtime-selection.mjs";

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
  activeStop,
  requestedSignal,
  cleaning = false,
  succeeded = false,
  cleanupCertain = true;
const runnerStarted = performance.now();
let stage = "runner-setup",
  stageStarted = runnerStarted,
  xcodeStarted = false,
  failureOutcome = "failed",
  failureStageMilliseconds;
const cleanupOutcomes = [];
const platform = {
  xcode: "unknown",
  sdk: "unknown",
  runtime: "unknown",
  device: "unknown",
};

function diagnosticValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,160}$/.test(value) ? value : "invalid";
}
const unreapedChildren = new Set();

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
    `xcodeVersion=${diagnosticValue(platform.xcode)}`,
    `sdkVersion=${diagnosticValue(platform.sdk)}`,
    `runtime=${diagnosticValue(platform.runtime)}`,
    `device=${diagnosticValue(platform.device)}`,
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

function groupAbsent(processGroup) {
  if (!Number.isInteger(processGroup) || processGroup <= 1) return true;
  try {
    process.kill(-processGroup, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw executionError("Owned subprocess cleanup could not be verified.", "cleanup-uncertain");
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
      killTimer,
      reapTimer,
      settled = false;
    const child = spawn(file, args, {
      cwd: root,
      env: environment,
      detached: true,
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    });
    unreapedChildren.add(child);
    activeChild = child;
    const stop = (error) => {
      failure ??= error;
      signalDirectChild(child, "SIGTERM");
      killTimer ??= setTimeout(() => signalDirectChild(child, "SIGKILL"), 5_000);
      reapTimer ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        activeStop = undefined;
        cleanupCertain = false;
        child.stdout?.destroy();
        child.unref();
        reject(
          executionError(
            `${label} direct child was not reaped after termination.`,
            "cleanup-uncertain",
          ),
        );
      }, 7_000);
    };
    activeStop = () => stop(executionError("iOS test interrupted.", "interrupted"));
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
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      unreapedChildren.delete(child);
      if (activeChild === child) {
        activeChild = undefined;
        activeStop = undefined;
      }
      if (settled) return;
      settled = true;
      try {
        if (!groupAbsent(child.pid)) {
          cleanupCertain = false;
          failure ??= executionError(
            `${label} left process-group members whose ownership is uncertain.`,
            "cleanup-uncertain",
          );
        }
      } catch (error) {
        cleanupCertain = false;
        failure ??= error;
      }
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
  if (unreapedChildren.size) {
    for (const child of unreapedChildren) signalDirectChild(child, "SIGKILL");
    cleanupCertain = false;
    cleanupOutcomes.push("child-cleanup-uncertain");
  }
  if (simulatorID) {
    try {
      await execute("xcrun", ["simctl", "shutdown", simulatorID], {
        timeout: 15_000,
        allowAfterSignal: true,
        label: "simulator shutdown",
      });
      cleanupOutcomes.push("shutdown-complete");
    } catch {
      cleanupCertain = false;
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
      cleanupCertain = false;
      cleanupOutcomes.push("delete-failed");
      console.warn(
        "The temporary iOS simulator could not be deleted; remove the uniquely named Ellie iOS Tests simulator manually.",
      );
    }
  }
  if (unreapedChildren.size) cleanupCertain = false;
  if (cleanupCertain) {
    rmSync(derivedData, { recursive: true, force: true });
    cleanupOutcomes.push("derived-removed");
  } else {
    cleanupOutcomes.push("derived-retained");
    console.warn("Owned iOS test evidence was retained because subprocess cleanup is uncertain.");
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestedSignal = signal;
    activeStop?.();
  });
}

try {
  enterStage("simulator-discovery");
  try {
    lstatSync(resultBundle);
    throw executionError(
      "A previous iOS test result is retained; move or remove it before another run.",
      "retained-result",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  rmSync(diagnosticFile, { force: true });
  mkdirSync(dirname(resultBundle), { recursive: true });
  const xcodeVersion = await execute("xcodebuild", ["-version"], {
    capture: true,
    timeout: 15_000,
    label: "Xcode version discovery",
  });
  const xcodeMatch = /^Xcode ([0-9]+\.[0-9]+(?:\.[0-9]+)?)\nBuild version [A-Za-z0-9]+\n?$/.exec(
    xcodeVersion,
  );
  if (!xcodeMatch) throw new Error("Selected Xcode version output is invalid.");
  platform.xcode = xcodeMatch[1];
  platform.sdk = (
    await execute("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"], {
      capture: true,
      timeout: 15_000,
      label: "simulator SDK version discovery",
    })
  ).trim();
  const runtimes = JSON.parse(
    await execute("xcrun", ["simctl", "list", "runtimes", "--json"], {
      capture: true,
      timeout: 15_000,
      label: "simulator runtime discovery",
    }),
  ).runtimes;
  const selectedRuntime = selectCompatibleIOSRuntime(runtimes, platform.sdk);
  platform.runtime = selectedRuntime.version;
  const compatible =
    selectedRuntime.supportedDeviceTypes?.filter((item) => item.productFamily === "iPhone") ?? [];
  const device = compatible.find((item) => item.name === "iPhone 16") ?? compatible[0];
  if (!device) throw new Error(`No iPhone device type supports iOS ${selectedRuntime.version}.`);
  platform.device = device.identifier;
  enterStage("simulator-create");
  simulatorID = (
    await execute(
      "xcrun",
      [
        "simctl",
        "create",
        `Ellie iOS Tests ${randomUUID().slice(0, 8)}`,
        device.identifier,
        selectedRuntime.identifier,
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
  if (succeeded && cleanupCertain) {
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
    diagnostic(
      cleanupCertain ? failureOutcome : "cleanup-uncertain",
      result,
      failureStageMilliseconds,
    );
    process.exitCode = 1;
  }
}

if (requestedSignal)
  process.exitCode =
    128 + (requestedSignal === "SIGINT" ? 2 : requestedSignal === "SIGTERM" ? 15 : 1);
