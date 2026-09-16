import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrowserAccessibilityRuntime,
  type BrowserNativeHostContext,
} from "../apps/node/src/browser-accessibility-runtime.ts";

const context = {
  browserProcessPid: 42,
  browserStartSeconds: 10,
  browserStartMicroseconds: 20,
  browserCodeHash: "a".repeat(40),
  connectionId: "12345678-1234-4123-8123-123456789abc",
  authenticated: true,
} as const;
const binding = {
  availability: "accessibility" as const,
  documentId: "document-1",
  url: "https://example.test/watch",
  revision: "revision-1",
};
const statusAction = { tool: "browser.status" as const };
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + 3_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error("accessibility lifecycle timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
async function settledWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fixture(
  mode:
    | "close-after-bind"
    | "malformed-first"
    | "semantic-bind"
    | "semantic-read"
    | "semantic-perform"
    | "ignore"
    | "gated-ignore"
    | "ignore-perform"
    | "respond",
) {
  const root = await mkdtemp(join(tmpdir(), "ellie-ax-lifecycle-"));
  const executable = join(root, "helper");
  const countPath = join(root, "count");
  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      String.raw`const fs=require("node:fs"),path=require("node:path"),root=path.dirname(process.argv[1]),countPath=path.join(root,"count"),mode=fs.readFileSync(path.join(root,"mode"),"utf8");
const count=Number(fs.existsSync(countPath)?fs.readFileSync(countPath,"utf8"):0)+1;fs.writeFileSync(countPath,String(count));if(mode==="gated-ignore"){fs.writeFileSync(path.join(root,"startup-paused"),"yes");while(!fs.existsSync(path.join(root,"continue-startup")))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}fs.writeFileSync(path.join(root,"pid-"+count),String(process.pid));
let input="",session,documentRevision;process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk;const newline=input.indexOf("\n");if(newline<0)return;const raw=input.slice(0,newline);input=input.slice(newline+1);const value=JSON.parse(raw);fs.appendFileSync(path.join(root,"requests-"+count),value.id+"\\n");if(count===1&&mode==="malformed-first"){process.stdout.write("{}\n");return;}if(mode==="ignore"||mode==="gated-ignore"||(mode==="ignore-perform"&&value.type==="perform"))return;let reply;if(value.type==="bind"){session="session-"+count;documentRevision=value.documentRevision;reply={id:value.id,status:count===1&&mode==="semantic-bind"?"garbage":"bound",sessionID:session,documentRevision};}else if(value.type==="read")reply={id:value.id,status:count===1&&mode==="semantic-read"?"garbage":"completed",sessionID:session,generation:"generation-"+count,documentRevision,items:[],operation:"read"};else reply={id:value.id,status:"dispatchedUnverified",sessionID:session,documentRevision,operation:count===1&&mode==="semantic-perform"?"search":value.operation};process.stdout.write(JSON.stringify(reply)+"\n",()=>{if(count===1&&mode==="close-after-bind"){fs.closeSync(0);fs.writeFileSync(path.join(root,"stdin-closed"),"yes");}});});
setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  await writeFile(join(root, "mode"), mode, { mode: 0o600 });
  const count = () => readFile(countPath, "utf8").then(Number, () => 0);
  return { root, executable, count };
}

async function executeStatus(
  runtime: BrowserAccessibilityRuntime,
  signal = new AbortController().signal,
) {
  return runtime.execute(statusAction, binding, signal);
}
async function executeRead(runtime: BrowserAccessibilityRuntime) {
  return runtime.execute(
    { tool: "browser.read", view: "summary", revision: binding.revision },
    binding,
    new AbortController().signal,
  );
}

async function recoverStatus(runtime: BrowserAccessibilityRuntime) {
  const deadline = performance.now() + 3_000;
  while (true) {
    try {
      return await executeStatus(runtime);
    } catch (error) {
      if (performance.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("stdin EPIPE is contained and a certain retirement permits a fresh helper", async () => {
  const item = await fixture("close-after-bind");
  let complete = false;
  try {
    const runtime = new BrowserAccessibilityRuntime(item.executable, () => context);
    await executeStatus(runtime);
    await waitFor(() =>
      access(join(item.root, "stdin-closed")).then(
        () => true,
        () => false,
      ),
    );
    await assert.rejects(
      runtime.execute(
        { tool: "browser.read", view: "summary", revision: binding.revision },
        binding,
        new AbortController().signal,
      ),
      /read failed/,
    );
    await writeFile(join(item.root, "mode"), "respond", { mode: 0o600 });
    const result = await recoverStatus(runtime);
    assert.equal(result.browser.source, "accessibility");
    assert.equal(await item.count(), 2);
    assert.match(await readFile(join(item.root, "requests-2"), "utf8"), /^[^\\]+\\n$/);
    await runtime.close();
    await assert.rejects(executeStatus(runtime), /helper is unavailable/);
    assert.equal(await item.count(), 2);
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
  }
});

test("explicit fresh status replaces a stale AX session without replaying old work", async () => {
  const item = await fixture("respond");
  let complete = false;
  try {
    let current: BrowserNativeHostContext = { ...context };
    const runtime = new BrowserAccessibilityRuntime(item.executable, () => current);
    await executeStatus(runtime);
    const oldRead = await runtime.execute(
      { tool: "browser.read", view: "summary", revision: binding.revision },
      binding,
      new AbortController().signal,
    );
    assert.equal(oldRead.browser.status, "completed");
    current = { ...context, connectionId: "22345678-1234-4123-8123-123456789abc" };
    const freshBinding = {
      ...binding,
      documentId: "document-2",
      url: "https://example.test/next",
      revision: "revision-2",
    };
    await assert.rejects(
      runtime.execute(
        { tool: "browser.read", view: "summary", revision: binding.revision },
        binding,
        new AbortController().signal,
      ),
      /page changed/,
    );
    const freshStatus = await runtime.execute(
      statusAction,
      freshBinding,
      new AbortController().signal,
    );
    assert.equal(freshStatus.browser.status, "connected");
    const freshRead = await runtime.execute(
      { tool: "browser.read", view: "summary", revision: freshBinding.revision },
      freshBinding,
      new AbortController().signal,
    );
    assert.equal(freshRead.browser.status, "completed");
    assert.equal(await item.count(), 2);
    await runtime.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
  }
});

test("malformed reply settles its request and stale generation events cannot kill recovery", async () => {
  const item = await fixture("malformed-first");
  let complete = false;
  try {
    const runtime = new BrowserAccessibilityRuntime(item.executable, () => context);
    await assert.rejects(executeStatus(runtime), /helper is unavailable/);
    const result = await recoverStatus(runtime);
    assert.equal(result.browser.status, "connected");
    assert.equal(await item.count(), 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await executeStatus(runtime)).browser.status, "connected");
    assert.equal(await item.count(), 2);
    await runtime.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
  }
});

test("semantic bind, read, and perform corruption retires the helper before recovery", async () => {
  for (const mode of ["semantic-bind", "semantic-read", "semantic-perform"] as const) {
    const item = await fixture(mode);
    let complete = false;
    try {
      const runtime = new BrowserAccessibilityRuntime(item.executable, () => context);
      if (mode === "semantic-bind") {
        await assert.rejects(executeStatus(runtime), /helper is unavailable/);
      } else {
        await executeStatus(runtime);
        if (mode === "semantic-read") {
          await assert.rejects(executeRead(runtime), /read failed/);
        } else {
          await executeRead(runtime);
          const result = await runtime.execute(
            { tool: "browser.scroll", direction: "down", revision: binding.revision },
            binding,
            new AbortController().signal,
          );
          assert.equal(result.browser.status, "unknown");
        }
      }
      await writeFile(join(item.root, "mode"), "respond", { mode: 0o600 });
      await recoverStatus(runtime);
      assert.equal((await executeRead(runtime)).browser.status, "completed");
      assert.equal(await item.count(), 2);
      const replacementRequests = await readFile(join(item.root, "requests-2"), "utf8");
      assert.equal(replacementRequests.split("\\n").filter(Boolean).length, 2);
      await runtime.close();
      complete = true;
    } finally {
      if (complete) await rm(item.root, { recursive: true });
      else console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
    }
  }
});

test("cancelled dispatched action is unknown and is never replayed after certain cleanup", async () => {
  const item = await fixture("ignore-perform");
  let complete = false;
  try {
    const runtime = new BrowserAccessibilityRuntime(item.executable, () => context);
    const aborter = new AbortController();
    await executeStatus(runtime);
    await executeRead(runtime);
    const pending = runtime.execute(
      { tool: "browser.scroll", direction: "down", revision: binding.revision },
      binding,
      aborter.signal,
    );
    await waitFor(async () => {
      const requests = await readFile(join(item.root, "requests-1"), "utf8");
      return requests.split("\\n").filter(Boolean).length === 3;
    });
    aborter.abort();
    assert.equal((await pending).browser.status, "unknown");
    await writeFile(join(item.root, "mode"), "respond", { mode: 0o600 });
    await recoverStatus(runtime);
    assert.match(await readFile(join(item.root, "requests-2"), "utf8"), /^[^\\]+\\n$/);
    await runtime.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
  }
});

test("cleanup uncertainty retains ownership, blocks replacement, and remains observable", async () => {
  const item = await fixture("gated-ignore");
  const originalKill = ChildProcess.prototype.kill;
  const aborter = new AbortController();
  let runtime: BrowserAccessibilityRuntime | undefined;
  let pending: Promise<unknown> | undefined;
  let ownedChild: ChildProcess | undefined;
  let ownedClose: Promise<void> | undefined;
  let startupReleased = false;
  let primaryError: unknown;
  let cleanupError: Error | undefined;
  const rememberOwnedChild = (child: ChildProcess) => {
    if (!ownedChild) {
      ownedChild = child;
      ownedClose = new Promise((resolve) => child.once("close", () => resolve()));
    }
  };
  try {
    runtime = new BrowserAccessibilityRuntime(item.executable, () => context);
    pending = executeStatus(runtime, aborter.signal);
    void pending.catch(() => {});
    await waitFor(
      async () =>
        (await item.count()) === 1 &&
        (await access(join(item.root, "startup-paused")).then(
          () => true,
          () => false,
        )),
    );
    // Count is deliberately published first; it is not helper readiness.
    await assert.rejects(access(join(item.root, "pid-1")), { code: "ENOENT" });
    await writeFile(join(item.root, "continue-startup"), "go", { mode: 0o600 });
    startupReleased = true;
    await waitFor(
      async () =>
        await access(join(item.root, "requests-1")).then(
          () => true,
          () => false,
        ),
    );
    ChildProcess.prototype.kill = function (signal) {
      if (this.spawnfile !== item.executable || (ownedChild && this !== ownedChild))
        return originalKill.call(this, signal);
      rememberOwnedChild(this);
      return true;
    };
    aborter.abort();
    await assert.rejects(pending, /cleanup is uncertain/);
    assert.ok(ownedChild, "only the task-owned helper kill was intercepted");
    await assert.rejects(executeStatus(runtime), /helper is unavailable|cleanup is uncertain/);
    assert.equal(await item.count(), 1);
    await assert.rejects(runtime.close(), /cleanup is uncertain/);
    await assert.rejects(runtime.close(), /cleanup is uncertain/);
  } catch (error) {
    primaryError = error;
  } finally {
    ChildProcess.prototype.kill = originalKill;
    let cleanupCertain = true;
    if (!startupReleased) {
      try {
        await writeFile(join(item.root, "continue-startup"), "go", { mode: 0o600 });
      } catch {
        cleanupCertain = false;
      }
    }
    aborter.abort();
    if (ownedChild && ownedClose) {
      try {
        if (ownedChild.exitCode === null && ownedChild.signalCode === null)
          originalKill.call(ownedChild, "SIGKILL");
        if (!(await settledWithin(ownedClose, 3_000))) cleanupCertain = false;
      } catch {
        cleanupCertain = false;
      }
    } else if (runtime) {
      try {
        await runtime.close();
      } catch {
        cleanupCertain = false;
      }
    }
    if (pending && !(await settledWithin(pending, 5_000))) cleanupCertain = false;
    if (cleanupCertain) {
      try {
        await rm(item.root, { recursive: true });
      } catch {
        cleanupCertain = false;
      }
    }
    if (!cleanupCertain) console.error(`Retained accessibility lifecycle fixture: ${item.root}`);
    if (!cleanupCertain)
      cleanupError = new Error("Task-owned accessibility fixture cleanup is uncertain.");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError) throw cleanupError;
});
