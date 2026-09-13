import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, open, rmdir, stat, unlink, writeFile } from "node:fs/promises";
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
  maxAudioDurationMs?: number;
  maxTranscriptBytes?: number;
  timeoutMs?: number;
}
export interface WhisperCliAvailability {
  available: boolean;
  executable: boolean;
  model: boolean;
}
const DEFAULT_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_DURATION_MS = 120_000;
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
async function usableFile(path: string, mode: number): Promise<boolean> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return false;
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}
/** Checks only configured local paths. It never searches, downloads, or starts a model. */
export async function whisperCliAvailability(
  options: Pick<WhisperCliOptions, "executable" | "model">,
): Promise<WhisperCliAvailability> {
  const executablePath = validatePath(options.executable, "executable");
  const modelPath = validatePath(options.model, "model");
  const [executable, model] = await Promise.all([
    usableFile(executablePath, constants.X_OK),
    usableFile(modelPath, constants.R_OK),
  ]);
  return { available: executable && model, executable, model };
}
function validateWave(bytes: Buffer, maxDurationMs: number): void {
  const invalid = () =>
    new SpeechInputError("INVALID_AUDIO", "Audio must be 16 kHz mono PCM16 WAV.");
  if (
    bytes.length < 12 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  )
    throw invalid();
  let offset = 12;
  let chunks = 0;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset < bytes.length) {
    if (++chunks > 128 || bytes.length - offset < 8) throw invalid();
    const id = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const next = end + (size & 1);
    if (end < start || next > bytes.length) throw invalid();
    if (id === "fmt ") {
      if (byteRate !== undefined || size < 16) throw invalid();
      const format = bytes.readUInt16LE(start);
      const channels = bytes.readUInt16LE(start + 2);
      const sampleRate = bytes.readUInt32LE(start + 4);
      byteRate = bytes.readUInt32LE(start + 8);
      const blockAlign = bytes.readUInt16LE(start + 12);
      const bitsPerSample = bytes.readUInt16LE(start + 14);
      if (
        format !== 1 ||
        channels !== 1 ||
        sampleRate !== 16_000 ||
        byteRate !== 32_000 ||
        blockAlign !== 2 ||
        bitsPerSample !== 16
      )
        throw invalid();
    } else if (id === "data") {
      if (dataBytes !== undefined || size === 0) throw invalid();
      dataBytes = size;
    }
    offset = next;
  }
  if (offset !== bytes.length || byteRate === undefined || dataBytes === undefined) throw invalid();
  if (dataBytes % 2 !== 0) throw invalid();
  if (dataBytes * 1_000 > byteRate * maxDurationMs)
    throw new SpeechInputError("LIMIT_EXCEEDED", "Audio exceeds the configured duration limit.");
}
async function readBoundedTranscript(path: string, maxBytes: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes)
      throw new SpeechInputError("LIMIT_EXCEEDED", "Transcript exceeds the configured turn limit.");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)).trim();
  } catch (error) {
    if (error instanceof SpeechInputError) throw error;
    throw new SpeechInputError(
      "PROCESS_FAILED",
      "Local transcription produced no valid transcript.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
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
  readonly #maxAudioDurationMs: number;
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
    this.#maxAudioDurationMs = positiveInteger(
      options.maxAudioDurationMs,
      DEFAULT_MAX_AUDIO_DURATION_MS,
      "maxAudioDurationMs",
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
    let audioPath: string | undefined;
    let transcriptPath: string | undefined;
    let primaryError: unknown;
    let cleanupFailed = false;
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      iterator = audio[Symbol.asyncIterator]();
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
      validateWave(wav, this.#maxAudioDurationMs);
      directory = await mkdtemp(join(tmpdir(), "ellie-speech-"));
      audioPath = join(directory, "turn.wav");
      const outputPath = join(directory, "transcript");
      transcriptPath = `${outputPath}.txt`;
      await writeFile(audioPath, wav, { mode: 0o600 });
      await this.#run(audioPath, outputPath, combined, () => timedOut);
      yield {
        text: await readBoundedTranscript(transcriptPath, this.#maxTranscriptBytes),
        final: true,
      };
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      clearTimeout(timer);
      void iterator?.return?.().catch(() => undefined);
      const removeFile = async (path: string | undefined) => {
        if (!path) return;
        try {
          await unlink(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true;
        }
      };
      await removeFile(audioPath);
      await removeFile(transcriptPath);
      if (directory) {
        try {
          await rmdir(directory);
        } catch {
          cleanupFailed = true;
        }
      }
      this.#active = false;
    }
    if (cleanupFailed && primaryError === undefined)
      throw new SpeechInputError("PROCESS_FAILED", "Temporary speech data could not be removed.");
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
