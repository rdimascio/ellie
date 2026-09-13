import type { IncomingMessage, ServerResponse } from "node:http";
import { record } from "@ellie/protocol";
import { readJson } from "@ellie/transport";
import { MAX_SPEECH_AUDIO_BYTES, NativeSpeech, NativeSpeechError } from "./native-speech.ts";

type Reply = (status: number, body: unknown) => void;
const values = (request: IncomingMessage, name: string): string[] => {
  const found: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2)
    if (request.rawHeaders[index]!.toLowerCase() === name)
      found.push(request.rawHeaders[index + 1] ?? "");
  return found;
};
const empty = (value: unknown): boolean => {
  const body = record(value);
  return Object.keys(body).length === 0;
};
const NORMAL_SOCKET_TIMEOUT_MS = 10_000;
const SPEECH_RESPONSE_TIMEOUT_MS = 36_000;
async function* exactAudio(
  request: IncomingMessage,
  expected: number,
  completed: () => void,
): AsyncIterable<Uint8Array> {
  let received = 0;
  for await (const value of request) {
    const bytes = value instanceof Uint8Array ? value : Buffer.from(value);
    received += bytes.byteLength;
    if (received > expected) throw new NativeSpeechError("invalid");
    yield bytes;
  }
  if (received !== expected || !request.complete) throw new NativeSpeechError("invalid");
  completed();
}
export async function handleNativeSpeech(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  speech: NativeSpeech | undefined,
  bearer: string,
  reply: Reply,
): Promise<boolean> {
  const availability = path === "/native/v1/speech/availability" && request.method === "GET";
  const upload = path === "/native/v1/speech/transcriptions" && request.method === "POST";
  const cancel = /^\/native\/v1\/speech\/transcriptions\/([0-9a-f-]+)\/cancel$/.exec(path);
  if (!availability && !upload && !(cancel && request.method === "POST")) return false;
  if (!speech) {
    reply(503, { error: "Native speech unavailable." });
    return true;
  }
  try {
    if (availability) {
      if (!(await speech.available(bearer))) throw new NativeSpeechError("forbidden");
      reply(200, { available: true });
      return true;
    }
    if (cancel) {
      const types = values(request, "content-type");
      if (
        types.length !== 1 ||
        !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(types[0]!) ||
        !empty(await readJson(request, 2))
      )
        throw new NativeSpeechError("invalid");
      const cancelled = await speech.cancel(bearer, cancel[1]!);
      if (cancelled === undefined) throw new NativeSpeechError("forbidden");
      reply(200, { ok: true, cancelled });
      return true;
    }
    const turnIds = values(request, "x-ellie-turn-id");
    const types = values(request, "content-type");
    const lengths = values(request, "content-length");
    if (types.length !== 1 || types[0]!.toLowerCase() !== "audio/wav") {
      reply(415, { error: "WAV audio required." });
      return true;
    }
    if (turnIds.length !== 1 || lengths.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(lengths[0]!))
      throw new NativeSpeechError("invalid");
    const length = Number(lengths[0]);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SPEECH_AUDIO_BYTES)
      throw new NativeSpeechError("invalid");
    const disconnected = new AbortController();
    const stop = () => disconnected.abort();
    request.once("aborted", stop);
    response.once("close", stop);
    let complete = false;
    try {
      const audio = exactAudio(request, length, () => {
        complete = true;
        request.socket.setTimeout(SPEECH_RESPONSE_TIMEOUT_MS);
      });
      const text = await speech.transcribe(bearer, turnIds[0]!, audio, disconnected.signal);
      if (!complete) throw new NativeSpeechError("invalid");
      const body = { turnId: turnIds[0], text };
      if (Buffer.byteLength(JSON.stringify(body)) > 16_384) throw new NativeSpeechError("invalid");
      reply(200, body);
    } finally {
      request.socket.setTimeout(NORMAL_SOCKET_TIMEOUT_MS);
      request.removeListener("aborted", stop);
      response.removeListener("close", stop);
    }
  } catch (error) {
    const kind = error instanceof NativeSpeechError ? error.kind : "unavailable";
    if (kind === "forbidden") reply(403, { error: "Native speech is not allowed." });
    else if (kind === "busy") reply(409, { error: "Native speech is busy." });
    else if (kind === "invalid") reply(400, { error: "Native speech request rejected." });
    else if (kind === "cancelled") reply(499, { error: "Native speech stopped." });
    else reply(503, { error: "Native speech unavailable." });
  }
  return true;
}
