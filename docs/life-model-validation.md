# Real local model acceptance

On September 14, 2026, the life harness was exercised with Qwen3-4B-Instruct-2507 Q4_K_M through a temporary llama.cpp runner on this Mac. Only synthetic requests and temporary records were used. The test did not change Ellie’s saved model configuration, household databases, services or Keychain.

## Reproduce

With an OpenAI-compatible local runner already listening, run from the checkout using Node 24:

```sh
node scripts/verify-life-model.mjs http://127.0.0.1:39473/v1 ellie-life-qwen4b
```

Replace the endpoint and exact model ID with the runner’s configuration. The adapter permits only unauthenticated literal-IP HTTP loopback endpoints. The script creates private temporary stores, uses a fixed September 14, 2026 clock and America/Los_Angeles time zone, checks actual stored effects, and cleans up its own fixture. Any failed case produces a nonzero exit status. Model weights and the runner are not bundled or downloaded by the script.

## Observed results

| Request                                                     | Verified host result                                     | Time  |
| ----------------------------------------------------------- | -------------------------------------------------------- | ----- |
| Add a reminder to water the basil tomorrow at 10 am         | One reminder and task, September 15 at 10 am Los Angeles | 8.4 s |
| Add tomorrow’s 2 pm dentist appointment, lasting 30 minutes | One event, correct start and duration                    | 4.2 s |
| Add oat milk to shopping needs with an 8 USD budget         | One need with the requested budget and currency          | 2.8 s |
| Remind me to phone Maya, without a time                     | Typed missing-time draft; no additional reminder         | 2.7 s |

Earlier attempts exposed three real compatibility problems: numeric time alone led to an incorrect year, the model flattened a nested action, and one output appended text after the JSON object. The context now supplies formatted current local time and exact nested examples; one bounded JSON/schema repair runs before any host action. Eleven focused adapter tests cover this contract, input limits, cancellation, admission and shared repair deadlines. Passing these four examples is a useful acceptance sample, not a general benchmark or guarantee of model correctness.

A separate generated water-counter app returned syntactically valid HTML but used `localStorage`, which is unavailable in the opaque plugin sandbox. It has not passed functional persistence acceptance. The next implementation slice supplies a trusted storage SDK and tests a freshly generated app through that interface.

## Pinned inputs

- Base model: [Qwen/Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507).
- Quantization: [lmstudio-community/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF), repository commit `4edb920b6f14e3b9284d4502a6485103d72cde05`, file `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, 2,497,280,448 bytes, SHA-256 `8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc`.
- Runner: [llama.cpp b10926](https://github.com/ggml-org/llama.cpp/releases/tag/b10926), `llama-b10926-bin-macos-arm64.tar.gz`, 11,154,497 bytes, SHA-256 `1f0b05fe9b1fd01bb0ce1feb7bb1414a89b273a75b6ac58eeff9e2888924d5ac`.

Downloads were hash-verified before execution. The temporary runner used a 32,768-token context, one parallel slot, four CPU threads and Metal offload, bound only to 127.0.0.1 with a matching restricted CORS origin and web UI/agent features disabled. Temporary logs and provenance are in `/tmp/ellie-life-model-acceptance`; these files are not a durable release artifact.
