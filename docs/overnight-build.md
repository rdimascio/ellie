# Life harness overnight build

The user requested an overnight implementation with Sol engineers working in parallel. The owned checkout is `/Users/ryan/ellie-life-harness`, branch `codex/life-harness-build`, based on `c88c58e354e4da2dd831c5cc11447f406c41e1ed`. The original `/Users/ryan/ellie` checkout and its planning edits remain preserved. This work does not deploy to the existing household installation.

## Coordination

- `life_memory` (Sol) owns `packages/life-core`, `apps/life`, and their tests/docs.
- `task_runtime` (Sol) owns `packages/task-runtime`, `packages/life-harness`, `packages/life-import`, and their tests/docs.
- `life_interface` (Sol) owns `apps/life-ui`, `packages/life-ingest`, and their tests/docs.
- Root owns `packages/life-plugins`, `packages/life-context`, `packages/life-learning`, `packages/life-teaching`, root/CLI integration and acceptance. Model transport ownership has returned to the runtime engineer; root owns `tests/life-model.test.ts`.

All engineers share the isolated worktree. Root coordinates commits after writers quiesce. Do not modify live installation state, Keychain, services or other worktrees. The separate task **Add macOS launchd services**, ID `01a09480-7b02-7d33-8c1e-ec9fc2894c15`, owns installer/native lifecycle/recovery. Avoid its `ServicePayload*.swift`, `PackagedServiceLauncher.swift`, `scripts/test-ios.mjs` and service-payload installer tests. No main merge or production deployment is part of this checkpoint.

## Working implementation

This is a working opt-in local application with real persistent data. It is not a production release of every feature in the broader product plan.

- **Life records:** private SQLite memory, people, places, commitments, needs, routines, sources and feedback; enforced user/group access; revisions; source provenance; atomic settings and imports. Settings resolve defaults, active group, user and task preferences separately from authority.
- **Teaching:** text, Markdown, HTML, email/transcript content, PDF text extraction and PDF/PNG/JPEG OCR through macOS PDFKit/Vision. Private temporary files, size/deadline limits, cancellation and process cleanup. Scoped retrieval includes references; source replacement/deletion removes chunks and invalidates dependent records. Explicitly adopted guidance has retained versions, source revisions, pause/resume and bounded model context; ordinary content remains inert.
- **Imports:** ICS/vCard preview, selection, server reparse, atomic commit, stable reimport identity and conflict handling that preserves user edits. Unsupported recurrence and ambiguous dates produce warnings.
- **Conversation:** supported commands remember/correct/forget facts, link birthdays/gift budgets/preparation, set timers/reminders/daily or weekly routines, finish/cancel needs, retrieve sources, evaluate explicit shopping context and create/revise/roll back apps. An optional literal-IP loopback model supplies broader replies and custom HTML generation with bounded requests and scoped personalization.
- **Background work:** durable tasks, time-zone/DST schedules, parent/child primitives, dependencies, scoped capabilities, cancellation, progress, missed-run handling and uncertain outcomes. Watch lifecycle and retention are bounded. Shared elapsed tree deadlines are explicit. Source summaries now use an atomic root with up to four parallel source workers, concurrency two and a shared deadline. Current source revisions are rechecked before returning/citing results. Explicit reruns create a fresh workflow while retaining the old result as history.
- **Extensions:** versioned API, guarded updates/rollback, retained revisions, bounded storage, an actual playable arcade shooter/high-score widget and live MLB standings/games. Provider requests coalesce/cache and label failures/staleness. Custom apps require a configured local model and receive only storage capability. Manage controls expose correction, revision history, rollback with retained data and intentional removal. Group storage identities are encoded to avoid cross-user key collisions.
- **Proactivity:** fresh explicit shopping/location/price/preparation signals matched to open needs, dates, budgets, currency, quiet hours and cooldowns. Notification/cooldown writes are atomic. Completed/cancelled or invalidated-source records stop suggestions; raw coordinates are not retained.
- **Learning:** rated/corrected examples, inspectable feedback, explicit personal export selection and bounded local JSONL export. No automatic upload, model-weight change or RL training.
- **Service/client:** authenticated loopback HTTP, one-use fragment token, HttpOnly SameSite session, Host/Origin checks, limits, private state and graceful draining. Chat, Today, Your world, Your space, Activity and Settings use real APIs with empty default data. Visible views refresh every five seconds/on focus with scope/race guards; closing the arcade refreshes its score immediately. Bounded SQL summaries, separate paginated agenda/notifications, lazy full details and scoped search let sources grow without hiding commitments. Calendar helpers handle malformed dates, yearless/leap birthdays and extreme time zones. Activity exposes valid controls, readable progress and verified cited results.
- **Plugin isolation:** trusted outer broker and nested opaque plugin document. A trusted bootstrap creates the original document channel; navigation cannot acquire a fresh host port. Browser tests verify ordinary persistence and rejected navigation/storage attempts. Generated code never runs on the server.

## Latest verified implementation

Use Node 24 explicitly: `/Users/ryan/.volta/tools/image/node/24.21.0/bin`. Ambient version-manager resolution sometimes selects Node 22.

- Frozen dependency installation passed.
- Full `bun run check` passed after final integration: lint, formatting, generated contracts, all TypeScript projects, **396 tests: 395 passed, one existing skip, zero failures**, and both web builds. Latest log: `/tmp/ellie-life-check.log`.
- `bun run life:test` passed against the actual authenticated service with private temporary databases. It covers memory create/edit, real PDF extraction, source retrieval, imports, birthday/gift completion, idle timer delivery, learning export, settings, arcade play/storage/reload, MLB data or honest failure, mobile layout and plugin isolation. Expanded acceptance covers full source editing, source search/pagination, an older appointment surviving 100+ newer records, malformed/extreme-zone dates, app revision/rollback/removal, stale result suppression and a distinct fresh summary rerun. Latest log: `/tmp/ellie-life-e2e.log`.
- Artifacts: `/tmp/ellie-life-e2e-artifacts/`. Final screenshots were inspected after correcting compact MLB summaries, accurate date grouping with month/year, completed-item filtering, and a visible first arcade target. Browser coverage now proves the first actual shot scores 130 points. Retained app history exposes metadata without copying generated HTML into normal refreshes.
- No live household services changed. Tests close their own services and remove their temporary state.

## Current checkpoint and next work

The first implementation is `61e1da1` (`Build the local Ellie life harness`). The second accepted checkpoint is saved under title `Add coordinated learning and inspectable life workflows`; find its exact revision with `git log -1 --format=%H --grep="Add coordinated learning and inspectable life workflows"`.

All three Sol engineers are quiescent after that acceptance. Root reviewed final browser artifacts including app management and task results. The next bounded slices are being assigned after the checkpoint:

1. Runtime: durable personal-owner freeze, cancellation/drain, export and purge primitives, with late-callback protection and restart-safe idempotency.
2. Core/service: user-reviewed personal export/deletion workflow across stores, with a durable journal and truthful limits. Preserve shared group data; explicitly define whether memberships remain. Coordinate API contracts and source/model context invalidation.
3. Interface: personal data review/export/deletion controls and versioned guidance inspection/edit/review controls, using actual server APIs and synthetic E2E state only.
4. Root: plugin personal export/purge primitives and integration; an opt-in automatic preparation monitor so upcoming events can surface without another chat command, within existing proactivity settings, quiet hours and cooldowns.

Current core-only `deletePersonal` is not comprehensive forgetting: it leaves tasks, plugin data and some derived payloads, and removes non-owner memberships. The next workflow must freeze/drain relevant work, remove owned plugin state including unambiguous per-user group keys, clear scoped model context, and journal completion across stores. Do not claim cross-database atomicity, external undo, erased downloaded exports or model unlearning. No real user data has been deleted during development.

Native continuous location, alerts during sleep, third-party account connectors, arbitrary server plugins, cloud model setup, multi-device identity integration and model-weight training remain separate work. Downloaded exports cannot be recalled by deleting their source. The app currently has one local trusted actor per process.

## Overnight continuation

Heartbeat `build-ellie-life-harness-overnight` continues every thirty minutes using this checkpoint, branch and existing agents. Owned `/usr/bin/caffeinate -i -t 31620` (exec session `54237`, started around 06:13 UTC) prevents idle sleep until approximately 08:00 local, then exits. It does not change saved power settings. If ending early, stop only this handle.

At or after **September 14, 2026 at 08:00 America/Los_Angeles**, finish the current bounded integration, run final checks, provide the morning handoff and pause this heartbeat. Keep unchanged runs quiet. Do not mark the entire vision complete because a development slice passes.

See the [runbook](life-runbook.md) for launch commands and [product plan](life-harness-plan.md) for the larger direction.
