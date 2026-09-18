import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const mac = process.platform === "darwin";
const production = new URL("../packages/macos/native/BrowserAccessibility.swift", import.meta.url)
  .pathname;
const fixture = new URL("fixtures/browser-accessibility.swift", import.meta.url).pathname;

async function removeOwned(root: string) {
  const writable = async (path: string) => {
    const info = await lstat(path);
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path)) await writable(join(path, name));
    } else if (!info.isSymbolicLink()) await chmod(path, 0o600);
  };
  await writable(root);
  await rm(root, { recursive: true });
}

async function runOwned(file: string, args: string[], timeoutMs: number) {
  const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  let stopping = false;
  let uncertain = false;
  let escalation: NodeJS.Timeout | undefined;
  let reap: NodeJS.Timeout | undefined;
  let rejectSettlement: ((error: Error) => void) | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill("SIGTERM");
    escalation = setTimeout(() => {
      child.kill("SIGKILL");
      reap = setTimeout(() => {
        uncertain = true;
        rejectSettlement?.(new Error("owned child did not settle after escalation"));
      }, 7_000);
    }, 2_000);
  };
  const collect = (target: Buffer[]) => (value: Buffer) => {
    bytes += value.length;
    if (bytes > 64 * 1024) stop();
    else target.push(value);
  };
  child.stdout.on("data", collect(stdout));
  child.stderr.on("data", collect(stderr));
  const deadline = setTimeout(stop, timeoutMs);
  let result: { code: number | null; signal: NodeJS.Signals | null };
  try {
    result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        rejectSettlement = reject;
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
  } finally {
    clearTimeout(deadline);
    if (escalation) clearTimeout(escalation);
    if (reap) clearTimeout(reap);
  }
  assert.equal(uncertain, false, "owned child did not settle after escalation");
  assert.equal(stopping, false, "owned child exceeded its deadline");
  assert.ok(bytes <= 64 * 1024, "owned child exceeded output bound");
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString(),
    stderr: Buffer.concat(stderr).toString(),
  };
}

test(
  "browser accessibility primitive revalidates observed pages before bounded mock actions",
  // One compiler and six children each retain their own TERM, KILL and reap bounds.
  { skip: !mac, timeout: 125_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ellie-browser-accessibility-"));
    await chmod(root, 0o700);
    let completed = false;
    t.after(async () => {
      if (completed) await removeOwned(root);
      else t.diagnostic(`Retained browser accessibility fixture: ${root}`);
    });
    const executable = join(root, "browser-accessibility-fixture");
    const compiled = await runOwned(
      "/usr/bin/xcrun",
      ["swiftc", production, fixture, "-o", executable],
      20_000,
    );
    assert.equal(compiled.code, 0, compiled.stderr);
    assert.equal(compiled.signal, null);
    assert.equal(compiled.stdout, "");
    assert.equal(compiled.stderr, "");
    for (const scenario of [
      "read-select-stale",
      "page-rebind",
      "identity-and-generation",
      "cancel-and-bounds",
      "search-partial",
      "ambiguous-and-playback",
    ]) {
      const result = await runOwned(executable, [scenario], 5_000);
      assert.equal(result.signal, null, scenario);
      assert.equal(result.code, 0, `${scenario}: ${result.stderr}`);
      assert.equal(result.stdout, "passed\n", scenario);
      assert.equal(result.stderr, "", scenario);
    }
    completed = true;
  },
);
