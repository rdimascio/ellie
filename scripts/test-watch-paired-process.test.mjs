import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { createOwnedProcessRunner } from "./watch-paired-owned-process.mjs";

function runner(overrides = {}) {
  return createOwnedProcessRunner({ cwd: process.cwd(), env: process.env,
    deadline: performance.now() + 5_000, termGraceMs: 40, reapGraceMs: 40, ...overrides });
}

test("missing executable closes its owned child and leaves command lane usable", async () => {
  const commands = runner();
  await assert.rejects(commands.run("/definitely/missing/watch-paired-child", [], { label: "missing" }),
    /could not start/);
  assert.equal(commands.certain, true);
  assert.equal(commands.active, false);
  assert.equal(await commands.run(process.execPath, ["-e", "process.stdout.write('ok')"], { label: "next" }), "ok");
});

test("timeout escalates to the retained direct child and waits for its close", async () => {
  const commands = runner();
  await assert.rejects(commands.run(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { label: "hung", timeout: 100 }), /exceeded 100 ms/);
  assert.equal(commands.certain, true);
  assert.equal(commands.active, false);
  assert.equal(await commands.run(process.execPath, ["-e", "process.stdout.write('reaped')"], { label: "next" }), "reaped");
});

test("signal requests the same finite stop path", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  child.kill = (signal) => { signals.push(signal); return true; };
  child.unref = () => {};
  const commands = runner({ spawnCommand: () => child, termGraceMs: 10, reapGraceMs: 10 });
  const start = performance.now();
  const pending = commands.run("synthetic", [], { label: "signalled", timeout: 1_000 });
  commands.requestStop();
  await assert.rejects(pending, /not reaped/);
  assert.ok(performance.now() - start < 500, "signal must not wait for the original command timeout");
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(commands.certain, false);
});

test("unreaped direct child permanently blocks cleanup commands", async () => {
  const signals = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = null;
  child.stderr = null;
  child.kill = (signal) => { signals.push(signal); return true; };
  child.unref = () => {};
  const commands = runner({ spawnCommand: () => child, termGraceMs: 10, reapGraceMs: 10 });
  const pending = commands.run("synthetic", [], { label: "unreaped", timeout: 10 });
  await assert.rejects(commands.run("must-not-spawn", [], { label: "overlap" }), /active or was not reaped/);
  await assert.rejects(pending, /not reaped/);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(commands.certain, false);
  await assert.rejects(commands.run("must-not-spawn", [], { label: "cleanup", allowAfterSignal: true,
    allowAfterDeadline: true }), /active or was not reaped/);
});
