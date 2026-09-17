#!/usr/bin/env node
// Deliberately opt-in: this creates and deletes only the two Simulator IDs it receives from
// simctl create. Run on an explicitly leased Xcode host; never against an existing device.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "apps/ios/EllieIOS.xcodeproj");
const bundle = "org.ellie.dashboard.ios";
const runID = randomUUID();
const started = performance.now();
const totalDeadline = started + 25 * 60_000;
const options = Object.fromEntries(process.argv.slice(2).filter((_, i) => i % 2 === 0)
  .map((key, i) => [key, process.argv[3 + 2 * i]]));
const required = ["--execute", "--out", "--ios-runtime", "--watch-runtime", "--ios-type", "--watch-type"];
if (process.argv.length !== 14 || required.some((key) => !options[key]) || options["--execute"] !== "leased") {
  throw new Error("Provide --execute leased, an unused absolute --out directory, and exact iOS/Watch runtime and device-type IDs.");
}
const output = options["--out"];
if (!isAbsolute(output) || existsSync(output)) throw new Error("--out must be a new absolute directory.");
mkdirSync(output, { mode: 0o700 });
const derived = join(output, "DerivedData");
const receipt = { status: "incomplete", runID, source: {}, stages: [], simulator: {}, cleanup: [] };
let activeChild;
let childCertain = true;
let interrupted = false;
let phoneID;
let watchID;
for (const name of ["scripts/test-watch-paired.mjs", "apps/ios/Sources/EllieIOSApp.swift",
  "apps/ios/Sources/WatchMediaPhoneBridge.swift", "apps/ios/Sources/WatchMediaPhoneController.swift",
  "apps/ios/Sources/WatchPairedUITestFixture.swift", "apps/watch/Sources/WatchMediaView.swift",
  "apps/watch/Sources/WatchMediaWatchStore.swift", "apps/watch/UITests/WatchPairedUITests.swift",
  "apps/ios/WatchShared/WatchMediaWire.swift",
  "apps/ios/EllieIOS.xcodeproj/project.pbxproj", "apps/ios/EllieIOS.xcodeproj/xcshareddata/xcschemes/EllieWatch.xcscheme"]) {
  receipt.source[name] = createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
}
function persist() { writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); }
persist();

function run(file, args, { label, timeout = 30_000, log, allowAfterSignal = false,
                            allowAfterDeadline = false } = {}) {
  if (interrupted && !allowAfterSignal) return Promise.reject(new Error("Paired run interrupted."));
  const remaining = totalDeadline - performance.now();
  if (remaining <= 0 && !allowAfterDeadline) return Promise.reject(new Error("Paired run exceeded its whole-run deadline."));
  const bounded = allowAfterDeadline ? timeout : Math.min(timeout, remaining);
  return new Promise((resolveResult, rejectResult) => {
    let outputText = "";
    let failure;
    let settled = false;
    let killTimer;
    const fd = log ? openSync(join(output, log), "wx", 0o600) : undefined;
    const child = spawn(file, args, {
      cwd: root,
      env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer" },
      stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
    });
    activeChild = child;
    if (fd !== undefined) closeSync(fd);
    function stop(reason) {
      failure ??= reason;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5_000);
    }
    const timer = setTimeout(() => stop(new Error(`${label} exceeded ${bounded} ms.`)), bounded);
    const reapTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      childCertain = false;
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      rejectResult(new Error(`${label} direct child was not reaped; owned simulators retained.`));
    }, bounded + 8_000);
    if (fd === undefined) for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8").on("data", (chunk) => {
        outputText += chunk;
        if (outputText.length > 1_048_576) stop(new Error(`${label} output exceeded 1 MiB.`));
      });
    }
    child.once("error", () => { failure ??= new Error(`${label} could not start.`); });
    child.once("close", (code, signal) => {
      clearTimeout(timer); clearTimeout(reapTimer); clearTimeout(killTimer);
      if (activeChild === child) activeChild = undefined;
      if (settled) return;
      settled = true;
      if (failure) rejectResult(failure);
      else if (code === 0) resolveResult(outputText.trim());
      else rejectResult(new Error(`${label} exited ${signal ?? code}; see ${log ?? "captured output"}. ${outputText.slice(-300)}`));
    });
  });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => {
  interrupted = true;
  if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill("SIGTERM");
});
async function stage(name, file, args, settings = {}) {
  const begun = performance.now();
  try {
    const result = await run(file, args, { label: name, ...settings });
    receipt.stages.push({ name, ok: true, elapsedMs: Math.round(performance.now() - begun) }); persist();
    return result;
  } catch (error) {
    receipt.stages.push({ name, ok: false, elapsedMs: Math.round(performance.now() - begun), error: error.message }); persist();
    throw error;
  }
}
const simctl = (name, args, settings) => stage(name, "xcrun", ["simctl", ...args], settings);
function requireEvents(path, target, playCount) {
  const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const plays = rows.filter((row) => row.operation === "play" && row.target === target);
  if (plays.length !== playCount || rows.some((row) =>
    Object.keys(row).sort().join(",") !== "operation,target" ||
    !["refresh", "read", "play"].includes(row.operation) ||
    !["watch-fixture-mac-a", "watch-fixture-mac-b"].includes(row.target))) {
    throw new Error(`Fixture event count or operation was unexpected for ${target}.`);
  }
  return rows;
}
async function waitForEvent(path, operation, target, timeout = 5_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (existsSync(path)) {
      const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      if (rows.some((row) => row.operation === operation && row.target === target)) {
        return requireEvents(path, "watch-fixture-mac-a", 1);
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Expected ${operation} event on ${target} did not appear by deadline.`);
}
async function watchTest(method) {
  const resultPath = join(output, `${method}.xcresult`);
  await stage(`watch-ui-${method}`, "xcodebuild", [
    "-quiet", "-project", project, "-scheme", "EllieWatch", "-configuration", "Debug",
    "-destination", `platform=watchOS Simulator,id=${watchID}`,
    "-derivedDataPath", derived, "-resultBundlePath", resultPath,
    "-only-testing:EllieWatchUITests/WatchPairedUITests/" + method,
    "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "test",
  ], { timeout: 300_000, log: `${method}.log` });
  const summary = JSON.parse(await stage(`watch-summary-${method}`, "xcrun", [
    "xcresulttool", "get", "test-results", "summary", "--path", resultPath,
  ], { timeout: 30_000 }));
  const counts = {
    total: summary.totalTestCount, passed: summary.passedTests,
    failed: summary.failedTests, skipped: summary.skippedTests,
  };
  if (counts.total !== 1 || counts.passed !== 1 || counts.failed !== 0 || counts.skipped !== 0) {
    throw new Error(`${method} did not execute exactly one passing, non-skipped Watch UI test.`);
  }
  receipt.stages.push({ name: `assert-${method}`, ...counts, ok: true }); persist();
}
let primary;
try {
  if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) !== 24) {
    throw new Error("Requires macOS and Node 24 on the leased Xcode host.");
  }
  const inventory = JSON.parse(await simctl("simulator-inventory", ["list", "-j"], { timeout: 30_000 }));
  for (const [kind, runtime, type] of [
    ["iOS", options["--ios-runtime"], options["--ios-type"]],
    ["watchOS", options["--watch-runtime"], options["--watch-type"]],
  ]) {
    if (!runtime.includes(`SimRuntime.${kind}-`) || !inventory.runtimes?.some((item) =>
      item.identifier === runtime && item.isAvailable === true)) throw new Error(`${kind} runtime unavailable.`);
    if (!inventory.devicetypes?.some((item) => item.identifier === type)) throw new Error(`${kind} device type unavailable.`);
  }
  phoneID = await simctl("create-phone", ["create", `Ellie paired ${runID} phone`, options["--ios-type"], options["--ios-runtime"]]);
  receipt.simulator.phone = phoneID; persist();
  watchID = await simctl("create-watch", ["create", `Ellie paired ${runID} watch`, options["--watch-type"], options["--watch-runtime"]]);
  receipt.simulator.watch = watchID; persist();
  await simctl("pair", ["pair", watchID, phoneID]);
  await simctl("boot-phone", ["boot", phoneID], { timeout: 45_000 });
  await simctl("boot-watch", ["boot", watchID], { timeout: 45_000 });
  await simctl("ready-phone", ["bootstatus", phoneID, "-b"], { timeout: 120_000 });
  await simctl("ready-watch", ["bootstatus", watchID, "-b"], { timeout: 120_000 });
  await stage("build-ios-and-embedded-watch", "xcodebuild", [
    "-quiet", "-project", project, "-scheme", "EllieIOS", "-configuration", "Debug",
    "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derived,
    "CODE_SIGNING_ALLOWED=NO", "build",
  ], { timeout: 480_000, log: "build.log" });
  const phoneApp = join(derived, "Build/Products/Debug-iphonesimulator/Ellie.app");
  const watchApp = join(phoneApp, "Watch/Ellie Watch.app");
  if (!existsSync(watchApp)) throw new Error("Built iPhone app did not embed Ellie Watch.app.");
  await simctl("install-phone", ["install", phoneID, phoneApp], { timeout: 120_000 });
  await simctl("install-watch", ["install", watchID, watchApp], { timeout: 120_000 });
  const container = await simctl("phone-container", ["get_app_container", phoneID, bundle, "data"]);
  const eventPath = join(container, "Library/Application Support/Ellie/WatchPaired", `${runID}.jsonl`);
  await simctl("launch-A", ["launch", phoneID, bundle, "--ellie-ui-watch-paired-fixture", runID]);
  await watchTest("testTargetAReadThenOnePlayIsUnknownWithoutReplay");
  let events = await waitForEvent(eventPath, "play", "watch-fixture-mac-a");
  if (!events.some((row) => row.operation === "read" && row.target === "watch-fixture-mac-a")) {
    throw new Error("Watch UI did not cause a phone-side fresh read of A.");
  }
  await simctl("terminate-phone", ["terminate", phoneID, bundle]);
  await watchTest("testUnreachablePhoneHasNoAction");
  await simctl("relaunch-B", ["launch", phoneID, bundle, "--ellie-ui-watch-paired-fixture", runID, "--ellie-ui-watch-target-b"]);
  await watchTest("testTargetBNeedsFreshReadAndShowsSelectedMac");
  events = await waitForEvent(eventPath, "read", "watch-fixture-mac-b");
  if (!events.some((row) => row.operation === "read" && row.target === "watch-fixture-mac-b") ||
      events.some((row) => row.operation === "play" && row.target === "watch-fixture-mac-b")) {
    throw new Error("Reconnect did not show B's fresh read, or crossed action authority to B.");
  }
  receipt.events = events;
  receipt.status = "passed-synthetic-backend-real-paired-ui-wcsession";
} catch (error) {
  primary = error;
  receipt.error = error.message;
  receipt.status = "failed";
} finally {
  if (childCertain) for (const [kind, id] of [["watch", watchID], ["phone", phoneID]]) {
    if (!id) continue;
    for (const action of ["shutdown", "delete"]) {
      try {
        await run("xcrun", ["simctl", action, id], {
          label: `${action}-${kind}`, timeout: 30_000, allowAfterSignal: true,
          allowAfterDeadline: true,
        });
        receipt.cleanup.push(`${action}-${kind}-complete`);
      } catch {
        receipt.cleanup.push(`${action}-${kind}-uncertain`);
        primary ??= new Error("Owned Simulator cleanup is uncertain.");
      }
    }
  } else {
    receipt.cleanup.push("retained-both-simulators-after-child-uncertainty");
    primary ??= new Error("A direct child could not be reaped.");
  }
  if (primary) receipt.status = "failed";
  persist();
}
if (primary) { console.error(primary.message); process.exitCode = 1; }
else console.log(`Paired Watch UI acceptance passed; receipt ${join(output, "receipt.json")}`);
