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
// One turn owns its AbortController: barge-in must cancel STT/model/TTS and queued audio.
// Push-to-talk precedes wake-word. Microphone capture and audio retention are off in V1.
