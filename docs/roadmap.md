# Roadmap

Ellie is working toward a local-first, open-source household command center: a Mac can coordinate the home, a TV can show shared information, and a paired phone can act as a remote. This roadmap is ordered by dependency and learning value. It is not a promise of dates.

## Current foundation

The repository currently provides a developer milestone, not a household product:

- A TypeScript coordinator and outbound-polling node communicate over authenticated, certificate-pinned HTTPS on a trusted local network.
- The deterministic router can open allowed macOS apps and HTTPS sites and can place or tile windows through an isolated Swift Accessibility helper.
- Pairing, per-node credentials, revocation, capability checks, local allowlists, bounded messages, and ephemeral command context are implemented.
- Optional, explicitly configured Macs can advertise installed local models and resource telemetry. The coordinator schedules a non-streaming inference probe on one eligible independent worker. Separate Macs run concurrently but do not pool memory.
- Portable certificate generation and basic independent-worker admission, reservation, and scheduling are implemented with regression coverage.
- A canonical registry drives the four desktop operations, their types, validation, and capability policy. Generated JSON Schema and OpenAPI document the existing protocol and seventeen coordinator route paths; drift checks run in CI.
- A safe macOS smoke runner builds and signs only a temporary helper and records manual acceptance separately. The operator has validated a MacBook coordinator and LAN-paired Mac mini for foreground app opening, window tiling, Netflix, and Messages beside Arc. Direct model inference, same-Mac scheduling, one LAN request, distinct two-worker placement, and inference cancellation have bounded hardware validation. Sustained load, runner or network interruption, sleep/wake, and distributed MLX remain unvalidated. See [the dated inference record](validation/2026-09-12-inference.md).
- Per-user GUI LaunchAgents provide source-checkout service lifecycle commands and bounded redacted logs. Role-specific diagnostics inspect configuration, Keychain, certificates, helper permissions, service state, and connectivity. Dedicated Ellie app identities and icons are implemented. Two-Mac native commands, queued cancellation, delivered-job crash recovery, and coordinator endpoint reconnection have partial physical acceptance; sleep/wake and active native cancellation remain pending. See [the dated service validation record](validation/2026-09-12-services.md).

A synthetic phone/TV command-center prototype is available for interface testing. An opt-in authenticated phone app-control demo has user-reported physical acceptance. A shared household dashboard, TV client, calendar/routine engine, household profile store, full voice path, MCP server, packaged installer, analytics service and automatic updater remain future work. The development workflow uses Bun for package management and scripts, Oxlint and Oxfmt for source checks, TypeScript for type checking, Node.js 24 for production and test execution, and the existing Swift helper for native macOS behavior.

## Active product queue

The maintained [delivery queue](delivery-queue.md) now drives ongoing work on editable widget dashboards, full local voice, Gmail/Calendar, weather, chores/charts and selected YouTube playlists. Product interfaces use native SwiftUI on macOS and iPhone. The browser prototype remains a compatibility and protocol reference, including version 1 dashboard import/export. PR33 combines local dashboards, chores, weather, bounded command controls, reviewed voice preparation and playlists into an isolated native integration candidate. It has not been deployed as a household release. A separate native agenda slice supports explicit offline snapshot import; live Google Calendar remains pending. The queue records implementation boundaries, next ready slices and external acceptance gates. [iPhone testing](iphone-testing.md) separates browser automation from physical camera/microphone and trust setup; the native iPhone target has its own isolated simulator workflow.

## Foundation sequence and current queue

The first three implementation slices were merged in PR #1 with passing CI. The durable job safety, LaunchAgent lifecycle/logs, diagnostics, app identities, and self-test slices were merged in PRs #2–#7. Two-Mac service recovery, all four desktop tools, and bounded local and LAN inference scenarios have partial physical acceptance. Physical sleep/wake, login/reboot, sustained inference, and repeatable installed-worker acceptance remain pending. Bounded hardware checks are recorded separately from release acceptance. The synthetic command-center demo is implemented as the next interface slice. Each change should preserve the deterministic fast path and use synthetic public fixtures.

### 1. Foundation and macOS smoke gate

**Status:** script, checklist, and automated regression coverage implemented; foreground two-Mac desktop actions and bounded local and LAN inference scenarios validated on physical Macs. Full service recovery and repeatable installed inference acceptance remain pending. See [the dated inference record](validation/2026-09-12-inference.md) for hardware and software scope.

**Depends on:** the prepared certificate and independent-worker changes.

- Run the existing automated suite, Swift helper build, geometry tests, and documented commands as one recorded release-candidate check.
- Add a small smoke script and checklist for pairing two physical Macs, executing the five README commands, revoking a node, and probing one already-installed local model.
- Fix only failures exposed by that gate; do not add product features.

**Accepted when:** the automated check passes from a clean checkout and the sanitized physical-Mac record states the hardware and macOS versions tested, every expected result, and any known limitation. A model runner remains optional.

### 2. Bun package management, Oxlint, and Oxfmt

**Status:** implemented with a pinned Bun version, frozen lockfile, hoisted workspace installation, and Oxc checks; Node.js remains the runtime.

**Depends on:** the prepared changes as the behavior baseline. Implementation may proceed while PR 1's physical-Mac validation is pending; that validation still gates release.

- Adopt Bun for workspace installation and package scripts with a committed lockfile.
- Add narrowly configured Oxlint and Oxfmt checks and format the tree once.
- Preserve Node.js as the production runtime until HTTPS, certificate, Keychain, signals, and test behavior have demonstrated parity under Bun.

**Accepted when:** a clean checkout has one documented check command; CI reproduces the lockfile install, lint, format, type, test, and Swift checks; runtime behavior and protocol fixtures are unchanged.

### 3. Operation registry and OpenAPI contracts

**Status:** implemented for all four existing operations and the original ten coordinator route paths, with generated artifact checks and runtime boundary tests. Slice 4 adds three job lifecycle paths to the same generated OpenAPI document. CLI and MCP adapter generation remain later work.

**Depends on:** the existing protocol and router. Coordinate merge order with PR 2's formatting changes; the contract design can proceed independently.

- Define one versioned machine-readable registry for the four implemented actions, including input, output, capabilities, limits, and stable error shapes.
- Derive TypeScript types, runtime validators, JSON Schema, and OpenAPI components from that registry.
- Make the router, coordinator, node, and CLI consume the shared definitions while preserving version 1 wire behavior. Do not add new tools or an MCP server in this PR.

**Accepted when:** changing a synthetic operation fixture updates every generated artifact; malformed, unknown, oversized, and unauthorized calls fail consistently at the coordinator and node; all existing end-to-end commands still pass.

### 4. Minimal SQLite job state and cancellation

**Status:** implemented with payload-free lifecycle metadata, fail-closed delivery commits, restart recovery, cancellation propagation, and bounded reconnect behavior. A bounded inference cancellation completed on hardware; physical sleep/wake and native desktop cancellation validation remain pending.

**Depends on:** the implemented operation registry (slice 3).

- Persist coordinator job identity, target, lifecycle state, timestamps, and bounded outcome metadata in a local SQLite database with a schema version and migration test.
- Keep command text, inference prompts and responses, credentials, and transient pronoun context out of the database.
- On restart, mark delivered or running work as having an unknown outcome; never replay it automatically. Expired queued work must not dispatch.
- Propagate an abort signal through the client and coordinator so callers can cancel queued work and request cancellation of delivered work.

**Accepted when:** restart tests cover queued, delivered, completed, failed, cancelled, and expired jobs; no case executes a delivered operation twice; cancellation reaches a waiting client and node; the result states that native side effects may still finish once execution has begun; corrupt or unsupported schemas fail with recovery guidance.

### 5. LaunchAgent lifecycle and doctor

**Status:** merged source-checkout LaunchAgents, diagnostics, branded app identities, and safe service testing. Real two-Mac Accessibility, Keychain, native commands, queued cancellation, delivered-job recovery, coordinator endpoint outage, and coordinator uninstall/reinstall passed. Physical sleep/wake, login/reboot, and active native cancellation remain pending; see the dated service validation record.

**Depends on:** physical-Mac acceptance (slice 1) and job state/cancellation (slice 4).

- Add idempotent install, start, stop, status, and uninstall commands for per-user coordinator and node LaunchAgents.
- Extend `doctor` to check service state, configuration permissions, Keychain access, certificate validity, port reachability, helper build/signature, Accessibility, and node freshness without printing secrets.
- Document process failure, login, sleep/wake, and uninstall behavior.

**Accepted when:** a physical two-Mac test recovers from an injected process failure and sleep/wake; repeated install and uninstall are safe; actionable checks distinguish required failures from optional model-worker issues; logs contain no credentials or command content.

### 6. Synthetic command-center demo

**Status:** implemented as an isolated React prototype with sample devices and agenda, simulated actions, honest job states, responsive remote/TV layouts, and browser regression checks. It does not connect to a household coordinator. See [the design and acceptance notes](command-center-design.md).

**Depends on:** the implemented contracts (slice 3) for generated display types; it does not depend on a live server.

- Add a small React demo driven entirely by synthetic fixtures for a MacBook control view, a TV agenda/status view, and a touch-first phone remote.
- Exercise responsive layout, large type, focus visibility, keyboard/remote navigation, loading, offline, empty, success, and failure states.
- Label the demo clearly: it has no authentication, real household data, calendar synchronization, or ability to execute commands.

**Accepted when:** fixture scenarios render at documented phone, laptop, and TV viewports; keyboard-only navigation reaches every control; automated checks catch fixture/schema drift; the build contains no private configuration or live endpoint.

## Alpha milestones after the foundation sequence

These milestones should continue as small reviewable changes rather than one alpha-sized pull request.

1. **Authenticated clients:** the isolated browser-session state and policy foundation is implemented with one-time phone and TV invitations, separate revocable roles, fixed grants, expiry, strict cookie construction, and exact Host/Origin guards. An optional separate HTTPS listener, controller invitation/revocation CLI, and focused pairing page are implemented. The default listener exposes browser identity and session management. An opt-in [phone-control demo](phone-control-demo.md) now adds granted app opening through a private bridge; production bridge setup remains pending. An isolated attended iPhone check now covers public-certificate profile setup, pairing, refresh persistence, private-tab isolation and revocation; production browser service setup and target TV acceptance remain pending. QR pairing is implemented with a terminal display and a local in-page scanner, preserving single-use invitations and private credential handling; an isolated attended iPhone QR-image check now covers pairing, camera shutdown and refresh persistence. Terminal QR optical validation and production browser setup remain pending. The focused phone page can open three allowed apps through that bridge; the broader command center and household data remain disconnected.
2. **Profiles and routines:** add a local profile store with migrations, explicit shared/private fields, export and deletion, then a deterministic routine scheduler with previews, time-zone rules, missed-run policy, cancellation, and per-operation grants.
3. **Google Calendar:** add one selected calendar account as an optional read-only source. Store OAuth secrets in Keychain, minimize scopes, make sync status visible, and keep cached agenda data subject to explicit retention and deletion controls.
4. **Production command center:** connect native SwiftUI macOS and iPhone views to authenticated APIs in vertical slices: health, agenda, routines, then allowed phone commands. Reuse reviewed protocol behavior and dashboard import/export compatibility. The TV role remains read-only by default; its client platform is a later decision.
5. **Rolling-upgrade contract:** negotiate protocol versions and capabilities, document server-first ordering for incompatible changes, and test old-node/new-server plus new-node/old-server behavior. A newer node must report a useful incompatibility instead of looping on a heartbeat error.
6. **Signed distribution:** create signed and notarized macOS application and helper artifacts, then produce an idempotent shell installer and Homebrew formula or cask from the same checksummed artifacts.
7. **Robust updates:** add signature verification, staged download, health check, rollback, release-channel pinning, and a manual-update fallback. Coordinate database backup/migration recovery with binary rollback and assign one update owner per installation. Never update during an active operation or routine.

## First household alpha acceptance

The first alpha is ready only when:

1. A fresh supported Mac installs signed coordinator and node services, starts them after reboot, and rolls back an injected failed update without a development checkout.
2. A TV pairs with a read-only role and shows a privacy-safe agenda, routine state, and accurate offline state at the target resolution.
3. A phone pairs once, invokes only granted operations for an explicitly selected profile, and loses access immediately after revocation.
4. Two synthetic profiles keep private settings separate; shared Google Calendar items and routines appear only where allowed; deletion and export cover locally held data.
5. A routine survives restart and a daylight-saving boundary, while cancellation or grant removal prevents work that has not begun.
6. Existing deterministic commands and independent multi-Mac workers still operate offline; failures, cancellations, and uncertain native outcomes never appear as success.

Physical macOS hardware is a release blocker because CI cannot grant Accessibility, reproduce TV browser behavior, or validate sleep/wake and real window management. Signed distribution and unattended updates require Apple signing and notarization credentials. Google Calendar requires configured OAuth credentials and redirect setup; failure or absence of OAuth must not block local commands, routines, or the dashboard.

## Later milestones

- **MCP and public APIs:** generate CLI, OpenAPI, and MCP adapters from the shared operation registry. Give each client a distinct revocable identity and capability grant; keep non-loopback exposure explicit.
- **Local voice:** ship push-to-talk before wake words, using replaceable streaming STT and TTS adapters, one cancellation scope per turn, barge-in, explicit microphone consent, and optional locally installed voices. Voice identity does not grant profile access or tool permission.
- **Conversational routing and knowledge:** add a small local router for uncertain intent, then replaceable conversational and retrieval providers with citations and clear uncertainty. Ambiguous actions require clarification. Cloud providers remain separate opt-ins with data disclosure.
- **Broader tools:** add browser and household integrations one operation at a time through the canonical schema, capability grant, local enforcement, failure semantics, and behavioral tests.
- **Optional analytics:** keep it off by default, document every field, exclude prompts, commands, calendar content, profile data, stable household identifiers, and local model names, and support inspection and deletion. The default must emit nothing.
- **Independent-worker improvements:** add streaming, fair queues, model warm-state signals, cancellation propagation, and operator-visible placement decisions while keeping one-Mac inference the default.
- **Distributed MLX:** only after independent workers are reliable, implement explicit per-node and per-model opt-in, measured interconnect qualification, shard plans, atomic group leases, whole-group cancellation, and failure recovery. Adding Macs or exhausting memory must never activate sharding automatically.
- **Native product clients:** use SwiftUI for macOS and iPhone interfaces, with Swift for Accessibility, Keychain and platform integration. Preserve the Node 24 coordinator and protocol contracts. Add Rust only where profiling or distribution constraints show a concrete benefit.
