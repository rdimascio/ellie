import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const deadline = 1_500;

export function launch(file, environment, workingDirectory, args = []) {
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
  if (status.status !== 0) throw new Error("Cannot inspect the owned process group.");
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

async function eventually(check, message) {
  const end = performance.now() + deadline;
  while (performance.now() < end) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  throw new Error(message);
}

async function exitedWithin(owned, milliseconds) {
  let timer;
  const result = await Promise.race([
    owned.exited.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), milliseconds);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

async function reaped(owned) {
  let timer;
  const outcome = await Promise.race([
    owned.exited,
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ timeout: true }), 3_500);
    }),
  ]);
  clearTimeout(timer);
  if (outcome.error || outcome.timeout) throw new Error("Owned process leader was not reaped.");
}

export async function stop(owned, signal = "SIGTERM") {
  if (!owned) return;
  if (owned.child.exitCode === null && owned.child.signalCode === null) {
    if (!owned.child.kill(signal) && !(await exitedWithin(owned, 100)))
      throw new Error("Owned process leader could not be signaled.");
  }
  if (!(await exitedWithin(owned, signal === "SIGKILL" ? 100 : deadline))) {
    if (!owned.child.kill("SIGKILL") && !(await exitedWithin(owned, 100)))
      throw new Error("Owned process leader could not be killed.");
  }
  await reaped(owned);
  await eventually(
    async () => groupMembers(owned.pgid).length === 0,
    "Owned process group remained after cleanup.",
  );
}
