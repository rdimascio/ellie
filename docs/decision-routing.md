# Optional decision routing

Ellie can interpret unmatched coordinator desktop commands through a replaceable decision provider. Known grammar commands still use the existing deterministic path. This experiment covers the four existing desktop operations only: opening configured apps/sites, placing windows, and adjacent placement. Each request can produce at most one action; requests for a sequence of operations are declined. It does not add general conversation, planning, new tools, or background watches.

This integration belongs to the coordinator's `ellie say` path. Ellie Life already has separate local records, conversation workflows, and task stores, while the native clients have their own household interfaces. Decision routing does not read or write those stores and is not yet connected to Life conversation or native-client commands.

Routing is off when `decisionRouting` is absent from the coordinator configuration. Both setup commands below start in **shadow** mode: an unmatched request can display a proposed action, but it creates no job, changes no pronoun context, and executes nothing. Existing deterministic commands continue to execute normally in shadow mode. `say` returns exit status 1 for an unexecuted proposal.

## TypeSafe setup

On the coordinator Mac, with its native Keychain helper already installed:

```sh
bun run ellie routing typesafe --allow-cloud
```

The command explains disclosure and prompts for the API key without echoing it. The key is stored in macOS Keychain under `decision.typesafe`; it is not saved in JSON, shell arguments, or logs. Use `--model MODEL_ID` after `--allow-cloud` to select a particular available model. The default is `jev-latest`; record the actual returned model in evaluations because the alias can change.

Enabling TypeSafe permits unmatched command text, configured app/site candidate descriptions, and the previous successful app context to leave the Mac. Shadow mode also makes these requests. Known grammar commands never go to this provider. Ellie does not add prompt/response persistence or analytics, but the hosted provider's data handling is a separate consideration. The endpoint is fixed to `https://api.typesafe.ai/v1/systemone`; redirects are rejected.

Restart the foreground coordinator or use the existing background service commands:

```sh
bun run ellie service stop coordinator
bun run ellie service start coordinator
bun run ellie routing status
bun run ellie say "Bring up Notes"
```

`routing status` shows saved configuration, not a live health probe. Missing credentials or an unavailable provider do not disable ordinary deterministic commands. A provider error on an unmatched command returns an unexecuted result and is not retried automatically.

## Local setup

An already installed, operator-managed local model can provide the same decisions using an OpenAI-compatible chat-completions endpoint on the coordinator Mac:

```sh
bun run ellie routing local MODEL_ID --endpoint http://127.0.0.1:1234
```

Replace `MODEL_ID` and the port with those of the installed runner. Only literal `127.0.0.1` or `[::1]` HTTP(S) origins are accepted. The adapter calls `/v1/chat/completions` with JSON output instructions, temperature zero, and a bounded output budget. It validates the returned distributions and choices. The runner must support JSON object responses; generated or self-reported probabilities are an evaluation baseline, not evidence of calibration. The runner's own networking and privacy behavior remain operator-controlled.

This adapter runs on the coordinator, separately from Ellie's independent compute-worker probe. It does not install a model or silently switch providers.

## Execution and disabling

After evaluating a provider on appropriate cases, the operator can explicitly enable bounded execution:

```sh
bun run ellie routing mode execute
```

Restart the coordinator after every configuration change. To return to proposals use `routing mode shadow`; to remove the integration from the saved configuration use `routing off`. Disabling preserves the Keychain item, which can be removed through Keychain Access if no longer needed.

The saved `decisionRouting` object supports `timeoutMs` (100–10000; default 3000), `minProbability` (default 0.98), and `minMargin` (default 0.2). Thresholds range from zero to one. These defaults are provisional engineering choices, **not measured error guarantees**. The router checks the selected probability and gap from the runner-up for every required decision, including whether this is a single action request. It does not treat the provider's distribution-derived `confidence` as empirical correctness or multiply probabilities to estimate full-plan correctness.

Choices include unknown/not-applicable values. App/site candidate IDs map back to code-owned allowlisted values. Only arguments belonging to the selected operation are used. Missing required arguments, unresolved references, uncertain choices, and unsupported/multiple actions produce fixed clarification or unsupported messages. Some obvious negations and compound commands are rejected before inference; these checks are deliberately conservative and are not a proof that a model understood the user correctly.

The existing protocol validators, coordinator capability checks, and node-local allowlists apply to semantic actions. The coordinator reserves the node while interpreting, cancels on caller disconnect, revocation, reconnect, shutdown, or deadline, and rechecks session validity before dispatch. Context advances only on a successfully reported action. There is no automatic replay, expanded permission, or new execution operation.

## Evaluation

The checked-in dataset contains only synthetic commands, with development and held-out splits. It labels complete single-action arguments and requests that should abstain, including multi-operation requests. Start with the offline deterministic baseline:

```sh
bun run eval:routing
bun run eval:routing --split heldout
```

Compare an installed local model:

```sh
bun run eval:routing --provider local --endpoint http://127.0.0.1:1234 --model MODEL_ID --split development
```

The standalone evaluator deliberately uses an explicit process environment key instead of reading private installation state or Keychain. With `TYPESAFE_API_KEY` already supplied securely to that process:

```sh
bun run eval:routing --provider typesafe --allow-cloud --split development --limit 20
```

No external evaluation runs by default. A semantic run first uses the grammar, then evaluates unmatched requests, matching production routing. It never dispatches desktop actions. `--limit` bounds the number of examples and `--output PATH` writes an aggregate JSON report. Reports include a dataset hash, selected split/model, exact action accuracy, wrong plans, false executions on abstention cases, missed plans, coverage, fallback rate, latency percentiles, and reported token usage. Optional `--price-input` and `--price-output` accept explicit USD rates per million tokens for a labeled estimate; an estimate is omitted when provider usage is incomplete.

Use `--min-probability` and `--min-margin` to explore thresholds on the development split, then assess the chosen policy on held-out cases. `--timeout-ms` defaults to 3000 and accepts 100–10000, matching the production configuration bounds. Semantic reports record these settings and the actual observed model IDs. Evaluate incorrect actions and false executions separately from overall accuracy; a high score from correctly declining unsupported requests can hide poor command coverage. The synthetic split is a regression aid, not a substitute for independently labeled real requests, larger samples, or observed native outcomes. Actual Jev quality and latency have not been established by the offline tests.

## Extension boundary

`@ellie/decisions` defines Choice, Score, and Noul questions with validated responses. `@ellie/router/decision` converts these judgments into a bounded desktop action. Life memory retrieval, source ranking, notification relevance, and plugin selection remain separate workflows. Any future reuse of the provider boundary there needs a narrow question set, code-owned policy, existing store and permission checks, and its own labeled evaluation before activation.

Sources: [TypeSafe API](https://docs.typesafe.ai/api), [confidence semantics](https://docs.typesafe.ai/confidence), and [function-calling pattern](https://docs.typesafe.ai/cookbooks/function_calling).
