# Local speech input

`WhisperCliSpeechInput` transcribes one bounded RIFF/WAVE turn with an explicitly configured
local [whisper.cpp CLI](https://github.com/ggml-org/whisper.cpp/tree/master/examples/cli). It
passes the model, input, and output paths as process arguments with shell execution disabled.
There is no automatic model download or cloud fallback. The temporary audio and transcript are
mode-private and removed on every outcome; Ellie does not log either payload.

With an existing `whisper-cli` binary and GGML model:

```sh
bun run ellie transcribe \
  --audio /absolute/path/turn.wav \
  --model /absolute/path/ggml-base.en.bin \
  --executable /absolute/path/whisper-cli
```

The input must be a structurally valid, uncompressed 16 kHz mono PCM16 WAV of at most two minutes
(and 10 MiB). whisper.cpp documents 16-bit WAV input and shows this 16 kHz mono conversion before
transcription. The next browser milestone is explicit press-and-hold
microphone capture, local conversion to that format, and posting the bounded turn to an endpoint
authorized by the paired phone's existing grants. A transcript is content to parse through those
grants; it is not authentication and must never expand them.
