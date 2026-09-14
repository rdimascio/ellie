import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SpeechStartDiagnostics } from "../scripts/speech-start-diagnostics.mjs";

const execute = promisify(execFile);

test("speech control timeout reports fixed actual lifecycle states without identifiers", () => {
  const diagnostics = new SpeechStartDiagnostics();
  assert.deepEqual(diagnostics.observe("owner", "started", "4", [], []), {
    ready: false,
    reason: "no-upload",
    state: "none",
  });
  diagnostics.noteUpload("owner");
  diagnostics.delivered("private-turn-id", "owner");
  assert.deepEqual(diagnostics.observe("owner", "started", "4", [], []), {
    ready: false,
    reason: "no-worker-marker",
    state: "pending",
  });
  diagnostics.settled("private-turn-id");
  const terminal = diagnostics.observe("owner", "started", "4", [], []);
  assert.deepEqual(terminal, { ready: false, reason: "no-active-turn", state: "terminal" });
  assert.throws(() => {
    (terminal as { reason: string }).reason = "private";
  }, TypeError);
  diagnostics.timeout(terminal);
  const summary = diagnostics.summary([], []);
  assert.equal(
    summary,
    "uploads:1,starts:0,exits:0,active:0,settled:1,control:no-active-turn,controlState:terminal",
  );
  assert.doesNotMatch(summary, /private-turn-id|owner/);
  diagnostics.timeout({ ready: false, reason: "private", state: "private" } as never);
  assert.equal(diagnostics.summary([], []), summary);
});

test("marker evidence is unavailable until captured and remains after files disappear", () => {
  const diagnostics = new SpeechStartDiagnostics();
  assert.match(diagnostics.summary(), /starts:unavailable,exits:unavailable/);
  assert.match(diagnostics.summary(["1", "2", "3"], ["1", "2"]), /starts:3,exits:2/);
  assert.match(diagnostics.summary(), /starts:3,exits:2/);
});

test("an observed upload without delivery remains explicitly ambiguous", () => {
  const diagnostics = new SpeechStartDiagnostics();
  diagnostics.noteUpload("synthetic-owner");
  const observation = diagnostics.observe("synthetic-owner", "started", "4", [], []);
  assert.deepEqual(observation, {
    ready: false,
    reason: "no-delivered-turn",
    state: "none",
  });
  diagnostics.timeout(observation);
  assert.match(diagnostics.summary([], []), /control:no-delivered-turn,controlState:none$/);
});

test("a marker observed only after the deadline stays classified as timed out", () => {
  const diagnostics = new SpeechStartDiagnostics();
  diagnostics.noteUpload("owner");
  diagnostics.delivered("turn", "owner");
  const late = diagnostics.observe("owner", "started", "4", ["4"], []);
  assert.equal(late.ready, true);
  diagnostics.timeout(late);
  assert.match(
    diagnostics.summary(["4"], []),
    /control:ready-after-deadline,controlState:pending$/,
  );
});

test("settlement diagnostics distinguish pending and multiple delivered turns", () => {
  const diagnostics = new SpeechStartDiagnostics();
  diagnostics.noteUpload("owner");
  diagnostics.delivered("turn-one", "owner");
  const pending = diagnostics.observe("owner", "settled", "4", [], ["4"]);
  assert.deepEqual(pending, { ready: false, reason: "turn-not-settled", state: "pending" });
  diagnostics.delivered("turn-two", "owner");
  const multiple = diagnostics.observe("owner", "settled", "4", [], ["4"]);
  assert.deepEqual(multiple, {
    ready: false,
    reason: "unexpected-turn-count",
    state: "pending",
  });
});

test("diagnostic counters are capped and never render identifiers", () => {
  const diagnostics = new SpeechStartDiagnostics();
  for (let index = 0; index < 110; index += 1) {
    diagnostics.noteUpload("private-owner");
    const turn = `private-turn-${index}`;
    diagnostics.delivered(turn, "private-owner");
    diagnostics.settled(turn);
  }
  const summary = diagnostics.summary(Array(110).fill("private"), Array(110).fill("private"));
  assert.equal(
    summary,
    "uploads:99,starts:99,exits:99,active:0,settled:99,control:none,controlState:none",
  );
  assert.doesNotMatch(summary, /private|owner|turn/);
});

test("finite worker markers prove pending then terminal settlement before owned cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-speech-diagnostic-test-"));
  const worker = join(root, "worker");
  const starts = join(root, "starts");
  const exits = join(root, "exits");
  let cleanupSafe = false;
  let child: ReturnType<typeof execute> | undefined;
  let childSettled = false;
  try {
    await writeFile(
      worker,
      `#!/bin/sh
set -eu
printf '4\n' > "$1"
/bin/sleep 0.1
printf '4\n' > "$2"
`,
      { mode: 0o700 },
    );
    await chmod(worker, 0o700);
    const diagnostics = new SpeechStartDiagnostics();
    diagnostics.noteUpload("synthetic-owner");
    diagnostics.delivered("synthetic-turn", "synthetic-owner");
    child = execute(worker, [starts, exits], { timeout: 2_000, maxBuffer: 4_096 });
    const deadline = performance.now() + 1_000;
    let observedStarts: string[] = [];
    while (performance.now() < deadline) {
      try {
        observedStarts = (await readFile(starts, "utf8")).trim().split("\n");
        if (observedStarts.includes("4")) break;
      } catch {}
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    assert.deepEqual(diagnostics.observe("synthetic-owner", "started", "4", observedStarts, []), {
      ready: true,
      reason: "none",
      state: "pending",
    });
    await child;
    childSettled = true;
    diagnostics.settled("synthetic-turn");
    const observedExits = (await readFile(exits, "utf8")).trim().split("\n");
    assert.deepEqual(observedExits, ["4"]);
    assert.deepEqual(
      diagnostics.observe("synthetic-owner", "settled", "4", observedStarts, observedExits),
      {
        ready: true,
        reason: "none",
        state: "terminal",
      },
    );
    cleanupSafe = true;
  } finally {
    if (child && !childSettled) {
      try {
        await child;
        childSettled = true;
      } catch {
        // Preserve the owned root when direct-child settlement is uncertain or failed.
      }
    }
    if (cleanupSafe) await rm(root, { recursive: true });
  }
});
