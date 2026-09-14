# Authenticated activation policy definition

The shared candidate verifier landed in PR90 at main `e2b5ab851bc32521d6c14d261c0259176e07ddca` on September 14 at 18:45:58 UTC. Its actual tree, `f79af2ea6cfc1126037e2bd47ce75e00c61d5f66`, matched the reviewed source and CI checkout `03ef0b30d544d379a4b8069f4e44a9de0f16a841`. All checks passed: 644 Node tests with one skip, 158 Swift tests, two iPhone Simulator UI tests, app-hosted HTTPS/speech/cancellation/Keychain checks, and both browser workflows. Owned Simulator and fixture cleanup completed. Native run `34879656686`, job `104095495587`, has log SHA-256 `1be1e14c5d7ca8ae4d3991a12c9ae4a8ef3ce2ced36687a7b277be98b1701565`. The preceding main-push workflows also passed. See the [readiness follow-through](2026-09-14-readiness-followups.md) for earlier merges and retained failures.

## Current prerequisite

`AuthenticatedActivationPolicy.swift` defines the exact 13-key policy record in the [activation contract](../service-authenticated-activation.md). Construction accepts only a strictly validated public Team ID and an `arm64` or `x64` target. It derives the envelope and payload policy digests from the existing authoritative constructors through narrow validated helpers. The optional requirement override remains private and available only through the existing test interface. Callers cannot supply replacement policy digests, requirements, native inventory or parser limits.

The result contains canonical sorted-key JSON with a trailing newline and its SHA-256, including the fixed coordinator/node role order. Existing envelope and payload constructors and their computed policy bytes are unchanged. The installer compiler includes the new source; launchers are unchanged.

This is the policy-definition prerequisite. It adds no production command, environment-based authority, receipt or journal version, selection, lifecycle or launcher enforcement. The production-limits probe uses only a test-interface compile flag; it does not enable installer-test limits or ad-hoc verification. The ordinary unflagged installer rejects that test command with empty stdout.

## Validation

On the Mac mini, canonical Node24 focused tests passed 2/2. The full Node24/Bun1.4.2 check passed 645 tests with one skip, including lint, formatting, contracts, types and both web builds. Focused log SHA-256: `8926262579c077627de47ac254bb3b7d5b82c743f230010b5cfc1a6b4d26cace`. Full log SHA-256: `32e27c8928a53a4d04f3a8bf7cfd60de99b1321298322a03b9d8849da61332ac`. Root and an independent reviewer verified all seven implementation files and both logs. Hosted CI subsequently passed on the exact reviewed tree; see the merged checkpoint below.

Tests verify exact canonical bytes and SHA, role order, Team ID and architecture changes, modified-requirement separation, malformed/empty/non-ASCII/extra inputs, and the absence of the test command from an unflagged binary. Independent Python calculations from the existing closed policy definitions match fixed vectors for both architectures. The tests distinguish the fixture's 100-file/128-entry limits from production's 2,048-file/4,096-entry limits because those limits are included in the payload policy digest. The `x64` coverage calculates policy records; it does not execute an x64 binary.

All new compiler calls are bounded. An initial focused invocation before dependency installation failed module resolution and did not exercise this implementation; the retained passing evidence comes from the configured commands after frozen dependency installation.

## Merged checkpoint

PR91 merged on September 14 at 19:25:30 UTC as `36fb0bb78f500adc04b5718ef3828407bfa3c76b`. Its actual tree, `4b3f56b7745af4aaa2ac6a1b59960a485482d5b6`, matched the reviewed and tested prospective merge, with parents `e2b5ab851bc32521d6c14d261c0259176e07ddca` and `8e1ea4e42ec8c5cf1803919246f09874ab22b09d`.

CI run `34884291699` (native job `104110950147`) and Life browser run `34884291766` (job `104110950374`) checked out `8c814afa06293ebcb12ad70ed35e4bee7c79121a` with those same parents and tree. All checks passed: 645 Node tests with one skip, 158 Swift tests, two iPhone Simulator UI tests, and app-hosted HTTPS, speech, cancellation, rejection and Keychain acceptance. The harness verified exact session/inventory/command/logout counts of 1/2/1/1, zero unexpected requests, five settled speech processes and zero active processes; owned cleanup completed. Native log SHA-256: `3dcd8676a93659e9427dbf9f6b5bee81bad422167c743533d62f1d618dc65344`. The preceding `e2b5ab8` main-push CI also passed separately.

These are isolated native fixtures and Simulator checks. They add no physical-phone or installed-household service acceptance.

## Next boundary

The current service builder still produces development/ad-hoc manifest-v1 artifacts. Deterministic build-source generation, explicit public publisher input, identical compiled policy in installer and both launchers, and artifact-level policy verification remain subsequent work. Receipt-v2 activation and recovery follow the reviewed contract after those prerequisites.

No household service, identity, Keychain permission, physical phone or microphone was changed. The outstanding owner Keychain-unlock prerequisite for another actual Developer ID experiment is unchanged. Signing/notarization and installed GUI lifecycle, migration, upgrade and rollback acceptance remain release gates.
