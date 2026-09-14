# Native voice hardware validation — 2026-09-13

## Physical Mac, synthetic audio

These checks ran on an Apple silicon Mac mini with macOS 26.6.2 and Node.js 24.21.0. Homebrew's whisper-cpp 1.9.2 performed real local model inference. The public tiny.en GGML model was downloaded from the upstream ggerganov/whisper.cpp distribution; its 77,704,715 bytes matched the published SHA-256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`.

- macOS `say -o` generated the synthetic phrase “Open Safari.” into a file. `afconvert` produced mono 16 kHz, signed 16-bit PCM WAV. No sound was played through speakers and no microphone was opened.
- The existing local speech adapter returned the exact phrase using the real model. The first cold run took 16.104 seconds.
- The final source bridge returned the expected JSON through the repeatable native voice runner in 213 milliseconds with the model warm.
- The bridge and adjacent speech adapter copied from the built MacBook application's Resources directory also passed real transcription in 220 milliseconds. This verifies the packaged bridge's successful import and model path, rather than only its failure behavior.
- A separate real-model adapter check aborted after its owned executable wrapper launched. It returned `ABORTED`, the launched process no longer existed, and its isolated adapter directory was empty. The check took 241 milliseconds.

Each run used a private directory created specifically for that check. `scripts/test-native-voice.mjs` generates its own synthetic input, checks the transcript, enforces subprocess/output bounds and removes that directory. Run it with explicit absolute paths to an installed executable and model; `--bridge` can select the bridge inside a built application. It does not download a model, change voice preferences, or dispatch a command.

The final SwiftUI Devices view and local transcriber were also exercised in a signed, isolated QA application on the mini. Only the recorder and coordinator were injected: the recorder supplied the synthetic WAV above, and the coordinator used a synthetic node with command dispatch disabled. The production Swift transcriber launched the bundled bridge and real model and displayed “Open Safari.” in the editable review. Editing to “Open Calculator” removed the preparation button; restoring the permitted command and accepting review updated only the application picker. Discard cleared the transcript, and cancelling a second recording returned to idle. The final build repeated transcription, discard and cancellation after the process-lifetime fixes. No microphone, saved credentials or household endpoint was accessed.

```sh
node scripts/test-native-voice.mjs \
  --executable /absolute/path/to/whisper-cli \
  --model /absolute/path/to/ggml-tiny.en.bin \
  --bridge /absolute/path/to/Ellie.app/Contents/Resources/voice-transcribe.mjs
```

## Draft test cleanup incident

Coordinating review found that the original, unpublished voice draft derived a recursive cleanup directory from a recorder-returned audio path. Its test recorder returned an audio URL directly under the user temporary directory. Two earlier focused test runs on the MacBook therefore attempted recursive removal of that temporary root.

That test path was stopped. A read-only inspection confirmed the temporary root still existed, with private permissions and hundreds of entries. There was no before-and-after inventory, so the impact on individual temporary entries is unknown; this is not evidence that every entry remained unchanged. Household configuration and Keychain paths were outside the deletion target.

The correction assigns ownership to the recorder: it returns an artifact identifier, remembers the exact files it created, and disposes only those files. Empty owned directories are removed with `rmdir`, never by taking an arbitrary supplied path's parent. Test recorders create their own unique directories. The separate Swift validation record covers the corrected cancellation and process tests; successful earlier tests do not excuse the unsafe draft.

## Remaining acceptance

This evidence is real model execution on physical hardware with synthetic speech. It does not validate microphone consent/capture, a person's speech or background noise, live SwiftUI microphone-to-command behavior, iPhone recording, end-to-end LAN voice commands, wake words, speech output, or a signed distribution. Native command dispatch remains an explicit separate action after transcript review. No household command was sent by these checks.
