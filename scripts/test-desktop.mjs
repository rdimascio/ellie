#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const scratch = mkdtempSync(`${tmpdir()}/ellie-desktop-tests-`);
const fixture = process.env.ELLIE_DESKTOP_TEST_FIXTURE;
const isFixture = fixture === "hang" || fixture === "parent-exits";
const configuredDeadline = Number(process.env.ELLIE_DESKTOP_TEST_DEADLINE_MS ?? 100);
const deadlineMilliseconds =
  isFixture && Number.isFinite(configuredDeadline) && configuredDeadline >= 1
    ? configuredDeadline
    : isFixture
      ? 100
      : 600_000;
let child;
let processGroup;
let interrupted;
let forcedKill;

function signalGroup(signal) {
  if (!processGroup) return false;
  try {
    process.kill(-processGroup, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    try {
      return child?.kill(signal) ?? false;
    } catch {
      return false;
    }
  }
}
function groupExists() {
  if (!processGroup) return false;
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}
async function stopGroup() {
  if (!processGroup) return;
  signalGroup("SIGKILL");
  const deadline = Date.now() + 2_000;
  while (groupExists() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (groupExists()) throw new Error("Desktop test process group did not stop.");
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    interrupted = signal;
    signalGroup("SIGTERM");
    forcedKill ??= setTimeout(() => signalGroup("SIGKILL"), 5_000);
  });
}
try {
  await new Promise((resolve, reject) => {
    if (interrupted) {
      reject(new Error("Desktop tests were interrupted before launch."));
      return;
    }
    const command = isFixture ? process.execPath : "xcrun";
    const parentIgnores = fixture === "hang";
    const commandArguments = isFixture
      ? [
          "-e",
          `const { spawn } = require("node:child_process");
          ${parentIgnores ? "process.on('SIGTERM', () => {});" : ""}
          const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
          console.log("desktop-test-fixture-descendant=" + descendant.pid);
          setInterval(() => {}, 1000);`,
        ]
      : ["swift", "test", "--package-path", "apps/desktop", "--scratch-path", scratch];
    child = spawn(command, commandArguments, { detached: true, stdio: "inherit" });
    processGroup = child.pid;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      forcedKill ??= setTimeout(() => signalGroup("SIGKILL"), 5_000);
    }, deadlineMilliseconds);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(deadline);
      if (timedOut)
        reject(
          new Error(`Desktop tests exceeded the ${deadlineMilliseconds}-millisecond deadline.`),
        );
      else if (code === 0) resolve();
      else reject(new Error(`Desktop tests exited with ${signal ?? code}.`));
    });
  });
} finally {
  if (forcedKill) clearTimeout(forcedKill);
  await stopGroup();
  child = undefined;
  processGroup = undefined;
  rmSync(scratch, { recursive: true, force: true });
}
if (interrupted)
  process.exitCode = 128 + (interrupted === "SIGINT" ? 2 : interrupted === "SIGTERM" ? 15 : 1);
