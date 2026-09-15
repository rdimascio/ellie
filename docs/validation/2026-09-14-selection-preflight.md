# Read-only service selection preflight

This change adds an operator check before selecting a staged development service release. It
builds on the shared native Life integration merged in PR97 at `f70ee89`. The working branch was
pushed successfully before implementation.

The native command is `preflight-select RELEASE --roles coordinator|node|coordinator,node`.
It returns a fixed redacted status and never creates installation state, recovers a transaction,
selects a release or changes launchd. It preserves the existing development receipt-v1 verifier;
authenticated receipt-v2 activation and production signing remain separate work. See the
[operator contract](../service-distribution-plan.md#per-user-installation).

## Validation stage

The final focused regression passed against a compiled native installer using synthetic homes
and test-only LaunchAgent observations on macOS: one test passed in 6.856 seconds under Node
24.21.0. Its retained log SHA-256 is
`3cd95e3d090bc3e31652884f8c9f1ed0b518d387d68e4ff7e0d20b82e2767e4b`.
Coverage includes fresh and already selected destinations, a fresh home after explicit recovery,
loaded and unavailable launchd observations, lock contention, partial lock/receipt topology,
invalid candidates and receipts, application collisions, pending selection/migration journals,
strict argument grammar and before/after filesystem identity/content comparisons.

Review found and corrected missing-lock acceptance, non-private receipt directory acceptance,
permissions changing during observation, and candidate errors masking pending recovery. Final
descriptor checks also reject lock/receipt topology changing between inspection and opening.
Compile-time-only hooks exercise final Services, receipts and lock permission drift; the hooks'
intentional permission changes are distinguished from the read-only command checks. Independent
review cleared the corrected source. Complete-source checks and actual packaged-command
acceptance remain required. No live services, identities, Keychain items or permissions were
changed by these tests.

## Candidate acceptance

This operator command is part of the installed release milestone, not an installed acceptance
result. The coordinator will supply an exact archive, checksum, release ID and reviewed destination
before requesting manual QA. A fresh logged-in test user can use the existing development
inspect/stage/select/status/start/stop path. A user with checkout service applications must use the
reviewed stopped migration path instead of removing conflicting files.

For that candidate, the manual handoff will verify preflight is read-only, explicit selection
leaves roles stopped, an explicit start reaches a healthy endpoint, terminal-free GUI control
works, and upgrade/recovery preserves identity and never replays a desktop action. Synthetic
installer tests do not establish those hardware or owner results.
