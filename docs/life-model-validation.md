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

Earlier attempts exposed three real compatibility problems: numeric time alone led to an incorrect year, the model flattened a nested action, and one output appended text after the JSON object. The context now supplies formatted current local time and exact nested examples; one bounded JSON/schema repair runs before any host action. Fourteen focused adapter tests cover this contract, input limits, cancellation, admission and shared repair deadlines. Passing these four examples is a useful acceptance sample, not a general benchmark or guarantee of model correctness.

The eighth slice reran the same pinned runner with partial scoped world records and added two advice/privacy cases. The first run caught an invalid top-level `clarify` action even after repair and an unsupported assertion that all suggested gifts would fit a stored budget. The host now handles ordinary polite missing-time reminders deterministically before inference, and the model contract includes an exact draft envelope plus explicit budget/price distinctions. The final six-case script passed:

| Case                          | Result                                                              | Inference requests | Time  |
| ----------------------------- | ------------------------------------------------------------------- | ------------------ | ----- |
| Reminder                      | Correct reminder/task for September 15 at 10 am Los Angeles         | 1                  | 8.1 s |
| Event                         | Correct start and thirty-minute duration                            | 1                  | 4.7 s |
| Shopping need                 | Correct item, budget and currency                                   | 1                  | 3.1 s |
| Missing-time reminder         | Host-created typed draft; no reminder/task write                    | 0                  | 1 ms  |
| Gift advice for Maya          | Used gardening/hiking interests and existing-gloves note; no writes | 1                  | 6.0 s |
| Same person in an empty group | Did not expose the personal interests or create records             | 1                  | 3.2 s |

The final gift response suggested relevant categories without claiming verified prices or an actual purchase. Its phrasing about checking affordability could still be clearer, and its list was longer than ideal. These are recorded observations, not a general quality score. The script asserts the selected facts, lack of side effects and absence of private fixture facts from the group answer; a human reviewed the full text. It now reports inference counts so host parsing cannot be mistaken for a successful model call. The captured synthetic final output is `/tmp/ellie-life-model-acceptance/world-final-cases.log`.

An early generated water-counter app used `localStorage`, which is unavailable in the opaque plugin sandbox. After the SDK was introduced, a fresh generation and two plain-language revisions produced the unchanged fixture in `apps/life-ui/tests/fixtures/sdk-water-counter-v3.json`, using the trusted `window.ellie.storage` SDK. The real browser acceptance adds two glasses, verifies host storage, restores the value after closing and after a full page reload, persists Reset, retains the old count after an injected write failure, and keeps controls disabled until retry after an injected read failure. The generated app still parses stored values permissively and makes its retry message clickable rather than using a semantic button; this acceptance records tested behavior rather than a general quality guarantee.

## Delivery lifecycle acceptance

The tenth slice extended the synthetic script with timer pause, a modeled delivery-status question and cancellation. The first run exposed an agenda operation that ignored the paused runtime state and called the timer active. Both modeled and deterministic agenda reads now resolve authoritative delivery state. The final nine-case run passed: the pause and cancellation commands used zero model calls; the status question used one and returned “check the bread (paused)” without record or task mutations. The six earlier cases also passed their stored-effect and privacy checks. Full output: `/tmp/ellie-life-model-acceptance/delivery-final-cases.log`.

The gift answer in this rerun again claimed that all suggested options fit the stored budget without current prices. The script does not verify recommendation prices or general factual quality. This remains a demonstrated limitation of the tested 4B model despite the budget/price distinction in its instructions; passing the functional cases must not be represented as resolving it. The status reply also returned a broader agenda than the question needed, while accurately labeling paused delivery.

## Feedback-to-guidance acceptance

The ninth slice used the same pinned local model through the actual private improvement engine. Reproduce with an already running local endpoint:

```sh
node scripts/verify-life-improvement.mjs http://127.0.0.1:39473/v1 ellie-life-qwen4b
```

The synthetic correction requested two brief vegetarian dinner ideas with about twenty minutes of preparation. A direct protocol probe produced a candidate and offline reply in 5.7 and 1.8 seconds. The first complete engine run then exposed a preview returned as a JSON string rather than the required object; validation rejected it before saving a proposal or adopting guidance. One bounded schema repair now shares the original model deadline.

The final complete engine run passed in 14.1 seconds. It verified no active guidance before adoption, no preview-created tasks or apps, atomic adoption using the same record, an actual modeled chat reply receiving that guidance, and pause removing it from active guidance. The resulting reply offered vegetable tacos or chickpea stir-fry. The full synthetic result is `/tmp/ellie-life-model-acceptance/improvement-final-engine.log`.

The candidate unnecessarily conditioned its rule on a future request repeating the dietary/time constraints, and it embedded an illustrative preferred answer. Both the preview and later reply reused that wording. This establishes the functional loop and its effect on model input; it does not establish a general quality improvement or a held-out evaluation. Those limitations are why the product shows the actual candidate and keeps adoption explicit.

## Pinned inputs

- Base model: [Qwen/Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507).
- Quantization: [lmstudio-community/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/lmstudio-community/Qwen3-4B-Instruct-2507-GGUF), repository commit `4edb920b6f14e3b9284d4502a6485103d72cde05`, file `Qwen3-4B-Instruct-2507-Q4_K_M.gguf`, 2,497,280,448 bytes, SHA-256 `8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc`.
- Runner: [llama.cpp b10926](https://github.com/ggml-org/llama.cpp/releases/tag/b10926), `llama-b10926-bin-macos-arm64.tar.gz`, 11,154,497 bytes, SHA-256 `1f0b05fe9b1fd01bb0ce1feb7bb1414a89b273a75b6ac58eeff9e2888924d5ac`.

Downloads were hash-verified before execution. The temporary runner used a 32,768-token context, one parallel slot, four CPU threads and Metal offload, bound only to 127.0.0.1 with a matching restricted CORS origin and web UI/agent features disabled. Temporary logs and provenance are in `/tmp/ellie-life-model-acceptance`; these files are not a durable release artifact.
