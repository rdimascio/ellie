#!/usr/bin/env node
// Deliberately opt-in: this creates and deletes only the two Simulator IDs it receives from
// simctl create. Run on an explicitly leased Xcode host; never against an existing device.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createOwnedProcessRunner, ownedCleanupTargets } from "./watch-paired-owned-process.mjs";

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
const commands = createOwnedProcessRunner({
  cwd: root, output, deadline: totalDeadline,
  env: { ...process.env, DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" },
});
let phoneID;
let watchID;
let creationUncertain = false;
for (const name of ["scripts/test-watch-paired.mjs", "scripts/watch-paired-owned-process.mjs",
  "scripts/test-watch-paired-process.test.mjs", "apps/ios/Sources/EllieIOSApp.swift",
  "apps/ios/Sources/WatchMediaPhoneBridge.swift", "apps/ios/Sources/WatchMediaPhoneController.swift",
  "apps/ios/Sources/WatchPairedUITestFixture.swift", "apps/watch/Sources/WatchMediaView.swift",
  "apps/watch/Sources/WatchMediaWatchStore.swift", "apps/watch/UITests/WatchPairedUITests.swift",
  "apps/ios/WatchShared/WatchMediaWire.swift",
  "apps/ios/EllieIOS.xcodeproj/project.pbxproj", "apps/ios/EllieIOS.xcodeproj/xcshareddata/xcschemes/EllieWatch.xcscheme"]) {
  receipt.source[name] = createHash("sha256").update(readFileSync(join(root, name))).digest("hex");
}
function persist() { writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); }
persist();

const run = commands.run;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, commands.requestStop);
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
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function createdID(value, kind) {
  if (!uuid.test(value)) {
    creationUncertain = true;
    throw new Error(`${kind} creation did not return one exact Simulator UUID; no further Simulator operation is safe.`);
  }
  return value;
}
function ownedIDsPresent(inventory, ids) {
  if (!inventory.devices || typeof inventory.devices !== "object" || Array.isArray(inventory.devices) ||
      !Object.values(inventory.devices).every(Array.isArray)) {
    throw new Error("Final Simulator inventory is malformed.");
  }
  const owned = new Set(ids.map((id) => id.toLowerCase()));
  return Object.values(inventory.devices).flat().some((device) =>
    typeof device.udid === "string" && owned.has(device.udid.toLowerCase()));
}
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
  receipt.toolchain = {
    developerDir: "/Applications/Xcode.app/Contents/Developer",
    xcode: await stage("xcode-version", "xcodebuild", ["-version"]),
    iosSDK: await stage("ios-sdk-version", "xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"]),
    watchSDK: await stage("watch-sdk-version", "xcrun", ["--sdk", "watchsimulator", "--show-sdk-version"]),
  };
  persist();
  const inventory = JSON.parse(await simctl("simulator-inventory", ["list", "-j"], { timeout: 30_000 }));
  for (const [kind, runtime, type] of [
    ["iOS", options["--ios-runtime"], options["--ios-type"]],
    ["watchOS", options["--watch-runtime"], options["--watch-type"]],
  ]) {
    const installedRuntime = inventory.runtimes?.find((item) => item.identifier === runtime && item.isAvailable === true);
    if (!runtime.includes(`SimRuntime.${kind}-`) || !installedRuntime) throw new Error(`${kind} runtime unavailable.`);
    if (!inventory.devicetypes?.some((item) => item.identifier === type)) throw new Error(`${kind} device type unavailable.`);
    receipt.toolchain[`${kind}Runtime`] = { identifier: runtime, version: installedRuntime.version, buildversion: installedRuntime.buildversion };
  }
  persist();
  phoneID = createdID(await simctl("create-phone", ["create", `Ellie paired ${runID} phone`, options["--ios-type"], options["--ios-runtime"]]), "Phone");
  receipt.simulator.phone = phoneID; persist();
  watchID = createdID(await simctl("create-watch", ["create", `Ellie paired ${runID} watch`, options["--watch-type"], options["--watch-runtime"]]), "Watch");
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
  let cleanupCertain = !creationUncertain && commands.certain && !commands.active;
  for (const [kind, id] of ownedCleanupTargets(watchID, phoneID)) {
    if (!cleanupCertain) break;
    for (const action of ["shutdown", "delete"]) {
      if (!commands.certain || commands.active) { cleanupCertain = false; break; }
      try {
        await run("xcrun", ["simctl", action, id], {
          label: `${action}-${kind}`, timeout: 30_000, allowAfterSignal: true,
          allowAfterDeadline: true,
        });
        receipt.cleanup.push(`${action}-${kind}-complete`);
      } catch {
        receipt.cleanup.push(`${action}-${kind}-uncertain`);
        cleanupCertain = false;
        primary ??= new Error("Owned Simulator cleanup is uncertain.");
        break;
      }
    }
  }
  if (cleanupCertain && (phoneID || watchID)) {
    try {
      const finalInventory = JSON.parse(await run("xcrun", ["simctl", "list", "-j"], {
        label: "verify-owned-deletion", timeout: 30_000, allowAfterSignal: true, allowAfterDeadline: true,
      }));
      if (ownedIDsPresent(finalInventory, [phoneID, watchID].filter(Boolean))) throw new Error("Owned Simulator still appears after deletion.");
      receipt.cleanup.push("owned-ids-absent-from-final-inventory");
    } catch {
      cleanupCertain = false;
      primary ??= new Error("Owned Simulator deletion could not be verified.");
    }
  }
  if (!cleanupCertain) {
    receipt.cleanup.push("owned-ids-retained-for-inspection-after-cleanup-uncertainty");
    primary ??= new Error("A direct child could not be reaped or Simulator cleanup was uncertain.");
  }
  if (primary) receipt.status = "failed";
  persist();
}
if (primary) { console.error(primary.message); process.exitCode = 1; }
else console.log(`Paired Watch UI acceptance passed; receipt ${join(output, "receipt.json")}`);
