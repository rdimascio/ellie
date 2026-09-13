import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SpeechInputError,
  WhisperCliSpeechInput,
  whisperCliAvailability,
} from "../packages/speech/src/index.ts";

function pcmWave(dataBytes = 320): Buffer {
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(16_000, 24);
  result.writeUInt32LE(32_000, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataBytes, 40);
  return result;
}
const wave = pcmWave();

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
else if (config.mode === "missing") process.exit(0);
else if (config.mode === "invalid-text") fs.writeFileSync(value("-of") + ".txt", Buffer.from([0xff]));
else if (config.mode === "cleanup-fail") {
  fs.writeFileSync(value("-of") + ".txt", "safe local words");
  fs.chmodSync(require("node:path").dirname(value("-f")), 0o500);
}
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
  assert.deepEqual(await whisperCliAvailability({ executable: f.directory, model: f.directory }), {
    available: false,
    executable: false,
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

test("adapter validates the complete PCM WAV boundary and duration before starting a process", async () => {
  const f = await fixture();
  const input = new WhisperCliSpeechInput({ executable: f.executable, model: f.model });
  const malformed = [
    wave.subarray(0, 30),
    Buffer.from(wave).fill(0xff, 4, 8),
    Buffer.from(wave).fill(0xff, 40, 44),
    (() => {
      const stereo = Buffer.from(wave);
      stereo.writeUInt16LE(2, 22);
      return stereo;
    })(),
    pcmWave(319),
    (() => {
      const missingData = Buffer.from(wave);
      missingData.write("junk", 36);
      return missingData;
    })(),
  ];
  for (const value of malformed)
    await assert.rejects(
      async () => {
        for await (const _ of input.transcribe(bytes(value), new AbortController().signal));
      },
      (error) => error instanceof SpeechInputError && error.code === "INVALID_AUDIO",
    );
  const duration = new WhisperCliSpeechInput({
    executable: f.executable,
    model: f.model,
    maxAudioDurationMs: 5,
  });
  await assert.rejects(
    async () => {
      for await (const _ of duration.transcribe(bytes(), new AbortController().signal));
    },
    (error) => error instanceof SpeechInputError && error.code === "LIMIT_EXCEEDED",
  );
  await assert.rejects(readFile(f.audit), { code: "ENOENT" });
});

test("cleanup failure is redacted and never leaves the adapter busy", async () => {
  const f = await fixture("cleanup-fail");
  const input = new WhisperCliSpeechInput({ executable: f.executable, model: f.model });
  await assert.rejects(
    collect(input),
    (error) =>
      error instanceof SpeechInputError &&
      error.code === "PROCESS_FAILED" &&
      error.message === "Temporary speech data could not be removed.",
  );
  const audit = JSON.parse(await readFile(f.audit, "utf8")) as { audio: string };
  const leakedDirectory = join(audit.audio, "..");
  await chmod(leakedDirectory, 0o700);
  await rm(leakedDirectory, { recursive: true });
  await writeFile(f.model, JSON.stringify({ mode: "success", audit: f.audit }));
  assert.deepEqual(await collect(input), [{ text: "safe local words", final: true }]);
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
  for (const mode of ["missing", "invalid-text"] as const) {
    const invalid = await fixture(mode);
    const input = new WhisperCliSpeechInput({
      executable: invalid.executable,
      model: invalid.model,
    });
    await assert.rejects(
      collect(input),
      (error) => error instanceof SpeechInputError && error.code === "PROCESS_FAILED",
    );
    await assert.rejects(
      collect(input),
      (error) => error instanceof SpeechInputError && error.code === "PROCESS_FAILED",
    );
  }
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
