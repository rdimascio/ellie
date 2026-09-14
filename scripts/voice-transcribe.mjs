#!/usr/bin/env node
import { createReadStream } from "node:fs";
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2)
  values.set(process.argv[index], process.argv[index + 1]);
const audio = values.get("--audio"),
  model = values.get("--model"),
  executable = values.get("--executable");
if (![audio, model, executable].every((value) => value?.startsWith("/"))) process.exit(2);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
try {
  let speech;
  try {
    speech = await import("./speech-index.ts");
  } catch {
    speech = await import("../packages/speech/src/index.ts");
  }
  const { WhisperCliSpeechInput } = speech;
  const input = new WhisperCliSpeechInput({
    executable,
    model,
    maxAudioBytes: 1_100_000,
    maxAudioDurationMs: 30_000,
    maxTranscriptBytes: 8_000,
    timeoutMs: 30_000,
  });
  let transcript = "";
  for await (const result of input.transcribe(createReadStream(audio), controller.signal))
    transcript = result.text;
  process.stdout.write(JSON.stringify({ text: transcript }));
} catch {
  process.stderr.write("Local transcription failed.\n");
  process.exitCode = 1;
}
