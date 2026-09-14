# Ellie morning handoff

September 14, 2026 · Working local life-harness implementation

The implementation is in `/Users/ryan/ellie-life-harness` on `codex/life-harness-build`. It is an isolated, reviewable application. The original checkout, household installation, Keychain and native services were preserved; this branch was not merged or deployed.

## Use it

The morning preview uses private state at `/Users/ryan/.ellie-life-preview` and the hash-verified local Qwen 4B model used for acceptance. Its browser launch link is issued when the preview starts. The link is single-use and expires after ten minutes; an established browser session lasts twelve hours.

The machine-local shortcut, while its temporary model assets remain available, is:

```sh
/Users/ryan/.volta/tools/image/node/24.21.0/bin/node /tmp/ellie-life-model-acceptance/launch-preview.mjs
```

Run only one preview against that state directory. Stop that launcher's own process before restarting it; a restart prints a fresh link. The shortcut is a development convenience, not a packaged installation or an automatic service.

For the standard application without a configured model:

```sh
cd /Users/ryan/ellie-life-harness
export PATH=/Users/ryan/.volta/tools/image/node/24.21.0/bin:$PATH
bun run life:build
bun run life:start --state-dir /Users/ryan/.ellie-life --port 0
```

The [runbook](life-runbook.md) covers model configuration, private data controls and operation.

## Working features

- Durable private memory, contacts, birthdays, needs, events, timers, reminders, routines and named shared spaces.
- Default, group, user and conversation preferences, with private chat history and feedback.
- Teaching from text, HTML, email/transcripts, DOCX, PDF and PNG/JPEG; retrieval, citations, source invalidation and adopted guidance.
- Calendar/contact import previews, saved checklists, completion/reopening and preparation notices.
- Durable background tasks and bounded source-summary workers, cancellation, recurrence, status and missed-run handling.
- A playable arcade/high-score widget, live MLB standings/games, and local-model-generated apps with sandboxed persistent storage, versions and rollback.
- Feedback-to-guidance proposals with offline previews, explicit adoption, revision and pause controls.
- Personal export/reset, scope isolation and authenticated loopback access.

Start with a few conversations:

1. “Remember that I prefer morning appointments.”
2. “Remind me tomorrow at 10 to call Mum.”
3. “Create a plan called Doctor visit: Confirm appointment; Gather forms; Prepare questions.”
4. “Complete step 2 of plan Doctor visit.”
5. “Every Monday at 9 am remind me to plan the week.”
6. “Build an arcade shooter with a high score widget.”
7. “Build an MLB standings and today's games widget.”

Your world exposes saved knowledge and plans; Your space holds apps; Today and Activity show commitments and work.

## Evidence and remaining work

The final integrated checks passed: **562 tests, 561 passed, one existing skip, zero failures**, plus lint, formatting, contracts, all TypeScript projects and both builds. Real authenticated browser acceptance passed. Actual local-model checks exercised conversational actions, app persistence, private improvement review and checklist creation/readback. Exact results and synthetic artifacts are recorded in the [overnight checkpoint](overnight-build.md) and [model validation report](life-model-validation.md).

This is not the entire unrestricted product vision. Native continuous location, notifications while the Mac is asleep, account connectors, multi-device identity/invitations/sync, arbitrary server-side plugins, cloud processing and model-weight training still need separate integrations. Current context suggestions use explicit fresh signals. Plans save checklist text; their steps do not execute automatically.

The tested 4B model can still make unsupported factual claims, including claiming gifts fit a budget without current prices. Functional acceptance is not a general model-quality guarantee. Its outputs and generated apps remain inspectable and correctable.
