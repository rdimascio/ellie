# Local model readiness

Life commands, schedules and the built-in arcade/MLB apps remain available without a model. Broader conversational interpretation and custom app generation use the local runner explicitly selected at launch. The web interface can inspect that setup; it does not change the runner, download a model or configure cloud processing.

`LocalModelReadiness` reads the configured runner's `models` endpoint relative to the same base URL used for chat. It accepts only unauthenticated literal-loopback HTTP URLs without query strings or fragments, follows no redirects and never sends a prompt. A successful inventory must contain the exact configured model ID. Responses are bounded to 128 KiB and 256 model entries, with a two-second deadline and a fifteen-second cache. Concurrent callers share a probe. A late, noncooperative transport cannot cause overlapping probes or change an already returned result. Application shutdown aborts an active probe.

The authenticated `/api/life/model/status` route reports mode, configuration, availability, configured model ID, check time and configured feature flags. It omits the runner URL, other installed model IDs and raw failure text. Feature flags identify configured model features; `available` separately reports whether the inventory verified the selected model.

Reasons distinguish `not-configured`, `runner-unreachable`, `model-not-installed`, `probe-unsupported` and `ready`. Unsupported inventory means readiness could not be verified; a compatible chat endpoint may still work. Ready means the runner listed the chosen model, not that a generated answer has been behaviorally evaluated. A manual refresh may reuse the current fifteen-second cached result.

Start a model-enabled Life service with your already running model's exact base URL and installed ID:

```sh
bun run life:start --model-url http://127.0.0.1:8080/v1 --model YOUR_INSTALLED_MODEL_ID
```

Tests use synthetic inventories and an ephemeral local HTTP server. They verify absent configuration makes no request, exact model matching, cache coalescing, malformed/oversized inventories, redirect rejection, deadline behavior and private result shaping. They never start inference or contact the live household installation.
