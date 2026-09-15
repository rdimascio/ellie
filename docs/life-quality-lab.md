# Ellie quality lab

The quality lab evaluates whether Ellie remembers, prepares and follows through correctly over realistic sequences. It complements the release coordinator's build, packaging, installation and device acceptance work. It does not substitute synthetic checks for a user's actual experience.

## Schedule and ownership

The existing Life heartbeat is repurposed as **Ellie quality lab**, every two hours. The release coordinator retains its thirty-minute schedule and owns shared merges, complete release gates, packaging, installation, signing, Xcode and physical-device reservations. These are two distinct owners; the former overnight feature-building prompt must not be resumed. Task identifiers and local schedule configuration remain in the private coordination ledger.

The lab works in its own isolated checkout on a `codex/` quality branch. It checks the current branch, uncommitted work, active agents, relevant release handoffs and its private checkpoint before doing anything. It never resets or overwrites unfinished work. Source changes outside this checkout remain with their existing owners.

Check the reviewed upstream revision as well as the local branch so the lab does not keep evaluating an obsolete candidate. Fetching upstream is read-only to the checkout. Advance a clean owned branch safely when possible, or start a fresh `codex/` quality branch from reviewed main after the previous work has been integrated. Preserve unpublished work and coordinate conflicts before changing the candidate.

Reuse Sol engineers for bounded independent evaluation or fixes. Astra reviews the design, expected behavior and evidence independently. Each assignment names specific files and a concrete result. Do not create extra user-facing tasks for routine subtasks.

## One bounded run

1. Reserve a single in-flight lab run in the private ledger so scheduled and manual work do not overlap. Identify the exact source revision, relevant runtime and dependency-lock hashes, scenario/oracle content hashes, toolchain and model mode, and feedback revision. Reuse valid evidence only when all relevant inputs match. Skip a covered, unchanged input with no actionable backlog instead of rerunning the full suite.
2. Pick one useful uncovered scenario or reproduced failure. Normally stop admitting new work after twenty minutes, then drain owned work and record any interruption or error. Consult the feature contract and prior evidence before writing its expected outcome. Keep some scenarios independent of the implementation so an adjusted test does not silently redefine success.
3. Use private, isolated synthetic stores, accounts, credentials and clocks. Prefer the actual rendered application, HTTP and persistence boundaries. Use agent-browser for user-facing flows, taking a fresh accessibility snapshot before interacting with observed controls and checking the visible result afterward. Release fixture gates, close owned processes and remove ephemeral state even when an assertion fails.
4. Record expected and observed behavior, pass/fail/skipped status, exact code and scenario revisions, environment, command, report path, elapsed time and limitations. A skipped or unavailable capability is not a pass.
5. Reproduce failures before fixing them. Claim the relevant files, make a narrow change, preserve the regression, and obtain independent review. Publish a focused PR when useful; the release coordinator integrates and merges after the appropriate checks.
6. Update the private coverage ledger and release the in-flight reservation after cleanup. Notify the release coordinator only for a concrete failure, reviewed fix, resource dependency or handoff. Notify the user for a meaningful finding, completion or required action. Keep unchanged wakes quiet.

The private ledger lives outside the repository in an operator-selected directory. It separates execution status from scenario outcomes: a completed evaluation may contain failures. It includes the report hash so changing a report cannot silently reuse its old acceptance. The source revision and scenario digest also prevent old passing results being carried forward to a new candidate.

## Evaluation tracks

| Track                   | Useful evidence                                                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation and memory | Retained qualifications and corrections reach later sessions; assistant inventions stay out of user memory; retries do not repeat effects; private scopes remain separate. |
| Proactive assistance    | Duplicate observations do not multiply preparations; rescheduling, cancellation, completion, explicit preferences and dismissal affect future help correctly.              |
| Long-running behavior   | Interrupted, cancelled, expired and offline work settles without late writes or duplicate replay; restart preserves accepted work.                                         |
| Generated apps          | A requested widget can be used, stores results correctly and can be revised or rolled back while remaining isolated.                                                       |
| Responsiveness          | Time to first visible response and final completion are measured separately with sample counts, model identity, context size and comparable conditions.                    |

The initial memory pilot uses a deterministic model transport to inspect the real context delivery path. Its timings measure the local service and fixture, not Qwen inference. That cannot establish answer correctness, reasoning quality, natural-language understanding or end-user latency. Real-model trials require a separately reserved model process and a clear baseline; missing model/device/provider access remains visible in the report. Never silently use the live preview model or real connected accounts.

## Running focused checks

Use Node 24 and the pinned Bun version. From the owned checkout:

```sh
ELLIE_QUALITY_REPORT=/absolute/private/report.json bun run life:quality
node --test tests/life-quality-proactivity.test.ts
node --test tests/life-quality-forgetting.test.ts
```

Run independent checks separately so one failure does not hide another track's result. Keep ordinary logs and generated fixture state out of the repository. Preserve actionable synthetic failure evidence in the private ledger, and promote useful regression cases to the test suite.

The forgetting scenario checks the entire outbound model request, cached memory inspection and generated Markdown after suppression, request recovery, restart and conversation deletion. The visible conversation remains available until deletion; unrelated memories must remain available throughout.

Do not run an unchanged broad CI gate, occupy Xcode/Simulator or a shared model process without the release coordinator's reservation, alter the existing preview, modify `~/.ellie` or Keychain, change device permissions, deploy, or independently merge main. The lab can prepare reviewable fixes while phone and release work continue. Live provider consent, physical-device acceptance and production release claims remain separate.

## Agent-browser verification loop

`bun run life:quality:browser` rebuilds the real Life UI and drives its dashboard, orb and plugin frames with pinned local agent-browser. Set `REPORT_DIR` to a unique private absolute directory and `AGENT_BROWSER_EXECUTABLE_PATH` to an installed Chromium executable when one is already available. The runner creates a private fixture with actual HTTP handlers, stores and TaskRuntime, an isolated named browser session and an explicit empty browser configuration. It never connects to the user's browser or retained Life preview. Agent-browser 0.37.1 has a nested sandbox-frame inspection limitation; a Playwright bridge attaches to that same owned browser before opening plugins and handles their visible controls and read-only results. The original iframe sandbox and normal host persistence remain in place. The report names this driver fallback.

```sh
REPORT_DIR=/absolute/private/browser-run \
AGENT_BROWSER_EXECUTABLE_PATH=/absolute/path/to/chromium \
bun run life:quality:browser
```

The synthetic baseline inspects actual outbound memory context, acts through rendered controls, and distinguishes those checks from model-answer quality. Arcade acceptance must earn points through gameplay, let the round save naturally, and read the persisted score after reopening. Calling the plugin storage API to write a high score is not gameplay acceptance. MLB uses explicitly synthetic provider data. A reminder passes only with actual delivery evidence and an actionable notification, not a scheduling acknowledgment.

Set `LIFE_QUALITY_SCENARIOS` to a comma-separated selection of `memory,pending-status,reminder,arcade,mlb` for a focused rerun. Unselected cases are recorded as skipped. Preserve failed screenshots and snapshots, reproduce the defect, apply a narrow fix and rerun the affected scenario. Pending chat and uncertain recovery require separate assertions: a healthy in-flight request must not display failure recovery, while an interrupted request must retain a way to check its outcome. Record built-asset digests in addition to source and scenario digests so stale UI builds cannot reuse acceptance.

The optional `LIFE_QUALITY_MODEL_URL` and `LIFE_QUALITY_MODEL_ID` must both identify a separately reserved literal-loopback model. Never silently fall back to an existing preview or interpret synthetic replies as Qwen reasoning. Real-account authorization, WebKit/phone installation and arbitrary model-generated app quality remain separate coverage. Automatable UI checks belong in the lab before an owner-facing manual checklist; reserve manual testing for unavailable devices/accounts and subjective experience.
