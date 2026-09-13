import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SpeechInput {
  transcribe(
    audio: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<{ text: string; final: boolean }>;
}
export interface SpeechOutput {
  synthesize(
    text: AsyncIterable<string>,
    voiceId: string,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array>;
}

export interface WhisperCliOptions {
  executable: string;
  model: string;
  maxAudioBytes?: number;
  maxTranscriptBytes?: number;
  timeoutMs?: number;
}
export interface WhisperCliAvailability {
  available: boolean;
  executable: boolean;
  model: boolean;
}
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class SpeechInputError extends Error {
  readonly code:
    | "ABORTED"
    | "BUSY"
    | "INVALID_AUDIO"
    | "LIMIT_EXCEEDED"
    | "PROCESS_FAILED"
    | "TIMED_OUT";
  constructor(
    code: "ABORTED" | "BUSY" | "INVALID_AUDIO" | "LIMIT_EXCEEDED" | "PROCESS_FAILED" | "TIMED_OUT",
    message: string,
  ) {
    super(message);
    this.name = "SpeechInputError";
    this.code = code;
  }
}
function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0)
    throw new TypeError(`${name} must be positive.`);
  return selected;
}
function validatePath(value: string, name: string): string {
  if (!isAbsolute(value) || value.includes("\0"))
    throw new TypeError(`${name} must be an absolute path.`);
  return value;
}
async function present(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Checks only configured local paths. It never searches, downloads, or starts a model. */
export async function whisperCliAvailability(
  options: Pick<WhisperCliOptions, "executable" | "model">,
): Promise<WhisperCliAvailability> {
  const executablePath = validatePath(options.executable, "executable");
  const modelPath = validatePath(options.model, "model");
  const [executable, model] = await Promise.all([present(executablePath), present(modelPath)]);
  return { available: executable && model, executable, model };
}
function isWave(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}
async function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  aborted: () => Error,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) throw aborted();
  return await new Promise((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(aborted());
    };
    signal.addEventListener("abort", cancel, { once: true });
    void iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", cancel);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

/** A one-turn local whisper.cpp adapter whose private temporary files are always removed. */
export class WhisperCliSpeechInput implements SpeechInput {
  readonly #executable: string;
  readonly #model: string;
  readonly #maxAudioBytes: number;
  readonly #maxTranscriptBytes: number;
  readonly #timeoutMs: number;
  #active = false;
  constructor(options: WhisperCliOptions) {
    this.#executable = validatePath(options.executable, "executable");
    this.#model = validatePath(options.model, "model");
    this.#maxAudioBytes = positiveInteger(
      options.maxAudioBytes,
      DEFAULT_MAX_AUDIO_BYTES,
      "maxAudioBytes",
    );
    this.#maxTranscriptBytes = positiveInteger(
      options.maxTranscriptBytes,
      DEFAULT_MAX_TRANSCRIPT_BYTES,
      "maxTranscriptBytes",
    );
    this.#timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
  }
  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): AsyncIterable<{ text: string; final: boolean }> {
    if (this.#active) throw new SpeechInputError("BUSY", "A transcription turn is already active.");
    this.#active = true;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.#timeoutMs);
    const combined = AbortSignal.any([signal, deadline.signal]);
    let directory: string | undefined;
    const iterator = audio[Symbol.asyncIterator]();
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const item = await nextChunk(iterator, combined, () => this.#abortError(timedOut));
        if (item.done) break;
        const chunk = item.value;
        if (!(chunk instanceof Uint8Array))
          throw new SpeechInputError("INVALID_AUDIO", "Audio chunks must be bytes.");
        size += chunk.byteLength;
        if (size > this.#maxAudioBytes)
          throw new SpeechInputError("LIMIT_EXCEEDED", "Audio exceeds the configured turn limit.");
        chunks.push(Buffer.from(chunk));
      }
      if (combined.aborted) throw this.#abortError(timedOut);
      const wav = Buffer.concat(chunks, size);
      if (!isWave(wav))
        throw new SpeechInputError("INVALID_AUDIO", "Audio must be a RIFF/WAVE file.");
      directory = await mkdtemp(join(tmpdir(), "ellie-speech-"));
      const audioPath = join(directory, "turn.wav");
      const outputPath = join(directory, "transcript");
      await writeFile(audioPath, wav, { mode: 0o600 });
      await this.#run(audioPath, outputPath, combined, () => timedOut);
      const transcriptPath = `${outputPath}.txt`;
      if ((await stat(transcriptPath)).size > this.#maxTranscriptBytes)
        throw new SpeechInputError(
          "LIMIT_EXCEEDED",
          "Transcript exceeds the configured turn limit.",
        );
      yield { text: (await readFile(transcriptPath, "utf8")).trim(), final: true };
    } finally {
      clearTimeout(timer);
      void iterator.return?.().catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
      this.#active = false;
    }
  }
  #abortError(timedOut: boolean): SpeechInputError {
    return timedOut
      ? new SpeechInputError("TIMED_OUT", "Local transcription timed out.")
      : new SpeechInputError("ABORTED", "Local transcription was cancelled.");
  }
  async #run(
    audioPath: string,
    outputPath: string,
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.#executable,
        ["-m", this.#model, "-f", audioPath, "-otxt", "-of", outputPath, "-np"],
        { shell: false, stdio: ["ignore", "ignore", "ignore"] },
      );
      let settled = false;
      let forceKill: NodeJS.Timeout | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (forceKill) clearTimeout(forceKill);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 250);
        forceKill.unref();
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.once("error", () => {
        if (signal.aborted) return finish(this.#abortError(timedOut()));
        finish(
          new SpeechInputError(
            "PROCESS_FAILED",
            "The configured local transcription process could not start.",
          ),
        );
      });
      child.once("exit", (code, terminationSignal) => {
        if (signal.aborted) return finish(this.#abortError(timedOut()));
        if (code !== 0)
          return finish(
            new SpeechInputError(
              "PROCESS_FAILED",
              `Local transcription failed (${terminationSignal ? "terminated" : `exit ${code ?? "unknown"}`}).`,
            ),
          );
        finish();
      });
    });
  }
}
// One turn owns its AbortController: barge-in must cancel STT/model/TTS and queued audio.
// Push-to-talk precedes wake-word. Microphone capture and audio retention are off in V1.
