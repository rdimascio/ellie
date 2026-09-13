import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SpeechInputError,
  WhisperCliSpeechInput,
  whisperCliAvailability,
} from "../packages/speech/src/index.ts";

const wave = Buffer.from("RIFF\x04\x00\x00\x00WAVEtest");

async function fixture(mode = "success") {
  const directory = await mkdtemp(join(tmpdir(), "ellie-speech-test-"));
  const executable = join(directory, "whisper-cli");
  const model = join(directory, `model-${mode}.bin`);
  const audit = join(directory, "audit.json");
  await writeFile(model, JSON.stringify({ mode, audit }));
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const config = JSON.parse(fs.readFileSync(value("-m"), "utf8"));
fs.writeFileSync(config.audit, JSON.stringify({ args, audio: value("-f") }));
if (config.mode === "fail") process.exit(7);
if (config.mode === "hang") setInterval(() => {}, 1000);
else fs.writeFileSync(value("-of") + ".txt", config.mode === "large" ? "x".repeat(100) : "  safe local words  \\n");
`,
  );
  await chmod(executable, 0o700);
  return { directory, executable, model, audit };
}

async function* bytes(value = wave): AsyncIterable<Uint8Array> {
  yield value.subarray(0, 7);
  yield value.subarray(7);
}

async function collect(input: WhisperCliSpeechInput, signal = new AbortController().signal) {
  const results = [];
  for await (const result of input.transcribe(bytes(), signal)) results.push(result);
  return results;
}

test("whisper.cpp adapter passes fixed argv, returns one final result, and removes turn files", async () => {
  const f = await fixture();
  const unusualModel = join(f.directory, "model $() with spaces.bin");
  await writeFile(unusualModel, await readFile(f.model));
  const input = new WhisperCliSpeechInput({ executable: f.executable, model: unusualModel });
  assert.deepEqual(await collect(input), [{ text: "safe local words", final: true }]);
  const audit = JSON.parse(await readFile(f.audit, "utf8")) as { args: string[]; audio: string };
  assert.equal(audit.args[audit.args.indexOf("-m") + 1], unusualModel);
  assert.deepEqual(audit.args.slice(-3), ["-of", audit.args.at(-2), "-np"]);
  await assert.rejects(readFile(audit.audio), { code: "ENOENT" });
});

test("availability only checks explicit local executable and model paths", async () => {
  const f = await fixture();
  assert.deepEqual(await whisperCliAvailability(f), {
    available: true,
    executable: true,
    model: true,
  });
  assert.deepEqual(await whisperCliAvailability({ ...f, model: join(f.directory, "missing") }), {
    available: false,
    executable: true,
    model: false,
  });
});

test("adapter rejects invalid and oversized audio before starting a process", async () => {
  const f = await fixture();
  const invalid = new WhisperCliSpeechInput({ executable: f.executable, model: f.model });
  await assert.rejects(
    async () => {
      for await (const _ of invalid.transcribe(
        bytes(Buffer.from("not wave")),
        new AbortController().signal,
      ));
    },
    (error) => error instanceof SpeechInputError && error.code === "INVALID_AUDIO",
  );
  const limited = new WhisperCliSpeechInput({
    executable: f.executable,
    model: f.model,
    maxAudioBytes: 8,
  });
  await assert.rejects(
    async () => {
      for await (const _ of limited.transcribe(bytes(), new AbortController().signal));
    },
    (error) => error instanceof SpeechInputError && error.code === "LIMIT_EXCEEDED",
  );
  await assert.rejects(readFile(f.audit), { code: "ENOENT" });
});

test("adapter bounds transcript output and hides process stderr", async () => {
  const large = await fixture("large");
  await assert.rejects(
    collect(
      new WhisperCliSpeechInput({
        executable: large.executable,
        model: large.model,
        maxTranscriptBytes: 20,
      }),
    ),
    (error) => error instanceof SpeechInputError && error.code === "LIMIT_EXCEEDED",
  );
  const failed = await fixture("fail");
  await assert.rejects(
    collect(new WhisperCliSpeechInput({ executable: failed.executable, model: failed.model })),
    (error) =>
      error instanceof SpeechInputError &&
      error.code === "PROCESS_FAILED" &&
      !error.message.includes("secret"),
  );
});

test("caller cancellation and deadlines stop a turn, and concurrent replay is rejected", async () => {
  const f = await fixture("hang");
  const input = new WhisperCliSpeechInput({
    executable: f.executable,
    model: f.model,
    timeoutMs: 2_000,
  });
  const cancel = new AbortController();
  const first = input.transcribe(bytes(), cancel.signal)[Symbol.asyncIterator]().next();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    collect(input),
    (error) => error instanceof SpeechInputError && error.code === "BUSY",
  );
  cancel.abort();
  await assert.rejects(
    first,
    (error) => error instanceof SpeechInputError && error.code === "ABORTED",
  );

  const deadline = new WhisperCliSpeechInput({
    executable: f.executable,
    model: f.model,
    timeoutMs: 20,
  });
  await assert.rejects(
    collect(deadline),
    (error) => error instanceof SpeechInputError && error.code === "TIMED_OUT",
  );

  const stalledAudio: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  };
  const stalled = new WhisperCliSpeechInput({
    executable: f.executable,
    model: f.model,
    timeoutMs: 20,
  });
  await assert.rejects(
    async () => {
      for await (const _ of stalled.transcribe(stalledAudio, new AbortController().signal));
    },
    (error) => error instanceof SpeechInputError && error.code === "TIMED_OUT",
  );
});
