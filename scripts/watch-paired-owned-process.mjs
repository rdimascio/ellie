import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { performance } from "node:perf_hooks";

export function ownedCleanupTargets(watchID, phoneID) {
  return [["watch", watchID], ["phone", phoneID]].filter(([, id]) => id !== undefined);
}

// One retained direct child at a time. An unreaped child closes the command lane permanently.
export function createOwnedProcessRunner({ cwd, env, deadline, output, spawnCommand = spawn,
  clock = () => performance.now(), termGraceMs = 5_000, reapGraceMs = 8_000 }) {
  let activeChild;
  let activeStop;
  let certain = true;
  let interrupted = false;

  function requestStop() {
    interrupted = true;
    activeStop?.(new Error("Paired run interrupted."));
  }

  function run(file, args, { label, timeout = 30_000, log, allowAfterSignal = false,
    allowAfterDeadline = false } = {}) {
    if (!certain || activeChild) return Promise.reject(new Error("A direct child is active or was not reaped; owned simulators retained."));
    if (interrupted && !allowAfterSignal) return Promise.reject(new Error("Paired run interrupted."));
    const remaining = deadline - clock();
    if (remaining <= 0 && !allowAfterDeadline) return Promise.reject(new Error("Paired run exceeded its whole-run deadline."));
    const bounded = allowAfterDeadline ? timeout : Math.min(timeout, remaining);
    return new Promise((resolveResult, rejectResult) => {
      let outputText = "";
      let failure;
      let settled = false;
      let killTimer;
      let reapTimer;
      let child;
      let fd;
      try {
        fd = log ? openSync(`${output}/${log}`, "wx", 0o600) : undefined;
        child = spawnCommand(file, args, {
          cwd, env, stdio: fd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", fd, fd],
        });
        activeChild = child;
      } catch {
        if (fd !== undefined) closeSync(fd);
        rejectResult(new Error(`${label} could not start.`));
        return;
      }
      if (fd !== undefined) closeSync(fd);
      function stop(reason) {
        failure ??= reason;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, termGraceMs);
        reapTimer ??= setTimeout(() => {
          if (settled) return;
          settled = true;
          certain = false;
          clearTimeout(timer);
          child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
          rejectResult(new Error(`${label} direct child was not reaped; owned simulators retained.`));
        }, termGraceMs + reapGraceMs);
      }
      activeStop = stop;
      const timer = setTimeout(() => stop(new Error(`${label} exceeded ${bounded} ms.`)), bounded);
      if (fd === undefined) for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding("utf8").on("data", (chunk) => {
          if (outputText.length + chunk.length > 1_048_576) {
            outputText += chunk.slice(0, Math.max(0, 1_048_576 - outputText.length));
            stop(new Error(`${label} output exceeded 1 MiB.`));
          } else outputText += chunk;
        });
      }
      child.once("error", () => { failure ??= new Error(`${label} could not start.`); });
      child.once("close", (code, signal) => {
        clearTimeout(timer); clearTimeout(reapTimer); clearTimeout(killTimer);
        if (activeChild === child) { activeChild = undefined; activeStop = undefined; }
        if (settled) return;
        settled = true;
        if (failure) rejectResult(failure);
        else if (code === 0) resolveResult(outputText.trim());
        else rejectResult(new Error(`${label} exited ${signal ?? code}; see ${log ?? "captured output"}. ${outputText.slice(-300)}`));
      });
    });
  }

  return { run, requestStop, get certain() { return certain; }, get active() { return !!activeChild; } };
}
