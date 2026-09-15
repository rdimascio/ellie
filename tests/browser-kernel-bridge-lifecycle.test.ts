import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startBrowserKernelBridge } from "../apps/node/src/browser-kernel-bridge.ts";

const node = process.execPath;
const request = (id: string) => ({
  protocol: "ellie.browser-webmcp.v1" as const,
  id,
  type: "binding.status" as const,
});
const waitFor = async (check: () => boolean | Promise<boolean>) => {
  const deadline = performance.now() + 3_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error("bridge lifecycle timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function fixture(
  mode: "ignore-first" | "crash-first" | "always-crash" | "idle-reconnect" | "epipe",
) {
  const root = await mkdtemp(join(tmpdir(), "ellie-kernel-lifecycle-"));
  const home = join(root, "home");
  await mkdir(join(home, "Library/Application Support/Ellie"), { recursive: true, mode: 0o700 });
  const executable = join(root, "broker");
  await writeFile(
    executable,
    `#!${node}\n` +
      String.raw`const fs=require("node:fs"),path=require("node:path");
const home=process.env.HOME,countPath=path.join(home,"count"),mode=fs.readFileSync(path.join(home,"mode"),"utf8");
const count=Number(fs.existsSync(countPath)?fs.readFileSync(countPath,"utf8"):0)+1;fs.writeFileSync(countPath,String(count));
fs.writeFileSync(path.join(home,"pid-"+count),String(process.pid));
if(mode==="always-crash")process.exit(7);
const send=v=>{const p=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32LE(p.length);process.stdout.write(Buffer.concat([h,p]));};
const connection=n=>"12345678-1234-4123-8123-"+String(n).padStart(12,"0"),context=n=>send({type:"broker.context",version:1,authenticated:true,browserPid:42,nativeHostPid:43,pidVersion:1,browserStartSeconds:10,browserStartMicroseconds:20,browserCodeHash:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",connectionId:connection(n)});
context(count);if(mode==="epipe")setTimeout(()=>fs.closeSync(0),10);if(mode==="idle-reconnect"){let cycle=1;const timer=setInterval(()=>{send({type:"broker.disconnected",version:1,connectionId:connection(cycle)});cycle+=1;context(cycle);if(cycle===5)clearInterval(timer);},30);}
let input=Buffer.alloc(0);process.stdin.on("data",chunk=>{input=Buffer.concat([input,chunk]);if(input.length<4)return;const size=input.readUInt32LE();if(input.length<size+4)return;const value=JSON.parse(input.subarray(4,size+4));fs.appendFileSync(path.join(home,"requests-"+count),value.id+"\\n");if(count===1&&mode==="crash-first")process.exit(8);if(count===1&&mode==="ignore-first")return;send({protocol:"ellie.browser-webmcp.v1",id:value.id,type:"result",status:"ok",value:{}});});
setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  await writeFile(join(home, "mode"), mode, { mode: 0o600 });
  return { root, home, executable };
}

const count = async (home: string) =>
  Number(await readFile(join(home, "count"), "utf8").catch(() => "0"));

test("dispatched abort retires its generation and admits only a fresh authenticated context", async () => {
  const item = await fixture("ignore-first");
  let complete = false;
  try {
    const bridge = await startBrowserKernelBridge(item);
    await waitFor(() => bridge.connected());
    const oldConnection = bridge.connectionContext()?.connectionId;
    const aborter = new AbortController();
    const pending = bridge.request(request("abandoned"), aborter.signal);
    aborter.abort();
    assert.equal((await pending).status, "unknown");
    assert.equal(
      (await bridge.request(request("during-retirement"), new AbortController().signal)).status,
      "unavailable",
    );
    await waitFor(
      () => bridge.connected() && bridge.connectionContext()?.connectionId !== oldConnection,
    );
    assert.equal(
      (await bridge.request(request("fresh"), new AbortController().signal)).status,
      "ok",
    );
    assert.equal(await readFile(join(item.home, "requests-1"), "utf8"), "abandoned\\n");
    assert.equal(await readFile(join(item.home, "requests-2"), "utf8"), "fresh\\n");
    await bridge.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained kernel lifecycle fixture: ${item.root}`);
  }
});

test("broker crash makes dispatched work unknown and never replays it into the replacement", async () => {
  const item = await fixture("crash-first");
  let complete = false;
  try {
    const bridge = await startBrowserKernelBridge(item);
    await waitFor(() => bridge.connected());
    assert.equal(
      (await bridge.request(request("crashed"), new AbortController().signal)).status,
      "unknown",
    );
    await waitFor(() => bridge.connected() && count(item.home).then((value) => value === 2));
    assert.equal(
      (await bridge.request(request("replacement"), new AbortController().signal)).status,
      "ok",
    );
    assert.equal(await readFile(join(item.home, "requests-2"), "utf8"), "replacement\\n");
    await bridge.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained kernel lifecycle fixture: ${item.root}`);
  }
});

test("idle browser reconnects preserve the healthy broker beyond the retry budget", async () => {
  const item = await fixture("idle-reconnect");
  let complete = false;
  try {
    const bridge = await startBrowserKernelBridge(item);
    await waitFor(() => bridge.connectionContext()?.connectionId.endsWith("000000000005") === true);
    assert.equal(await count(item.home), 1);
    assert.equal(
      (await bridge.request(request("after-four-reconnects"), new AbortController().signal)).status,
      "ok",
    );
    assert.equal(await count(item.home), 1);
    await bridge.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained kernel lifecycle fixture: ${item.root}`);
  }
});

test("child stdin errors retire the generation without crashing the parent", async () => {
  const item = await fixture("epipe");
  let complete = false;
  try {
    const bridge = await startBrowserKernelBridge(item);
    await waitFor(() => bridge.connected());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await bridge.request(request("epipe"), new AbortController().signal);
    assert.equal(result.status, "unknown");
    await bridge.close();
    complete = true;
  } finally {
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained kernel lifecycle fixture: ${item.root}`);
  }
});

test("cleanup uncertainty remains observable after its retirement promise settles", async () => {
  const item = await fixture("ignore-first");
  let complete = false;
  const originalKill = ChildProcess.prototype.kill;
  try {
    const bridge = await startBrowserKernelBridge(item);
    await waitFor(() => bridge.connected());
    const pid = Number(await readFile(join(item.home, "pid-1"), "utf8"));
    ChildProcess.prototype.kill = () => true;
    await assert.rejects(bridge.close(), /cleanup is uncertain/);
    await assert.rejects(bridge.close(), /cleanup is uncertain/);
    ChildProcess.prototype.kill = originalKill;
    process.kill(pid, "SIGKILL");
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    complete = true;
  } finally {
    ChildProcess.prototype.kill = originalKill;
    if (complete) await rm(item.root, { recursive: true });
    else console.error(`Retained kernel lifecycle fixture: ${item.root}`);
  }
});

test("restart attempts are bounded and close cancels a pending retry", async () => {
  const exhausted = await fixture("always-crash");
  const closing = await fixture("always-crash");
  let complete = false;
  try {
    const failed = await startBrowserKernelBridge(exhausted);
    await waitFor(() => count(exhausted.home).then((value) => value === 4));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await count(exhausted.home), 4);
    assert.equal(
      (await failed.request(request("bounded"), new AbortController().signal)).status,
      "unavailable",
    );
    await failed.close();

    const stopped = await startBrowserKernelBridge(closing);
    await waitFor(() => count(closing.home).then((value) => value === 1));
    await stopped.close();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(await count(closing.home), 1);
    complete = true;
  } finally {
    if (complete) {
      await rm(exhausted.root, { recursive: true });
      await rm(closing.root, { recursive: true });
    } else {
      console.error(`Retained kernel lifecycle fixtures: ${exhausted.root} ${closing.root}`);
    }
  }
});
