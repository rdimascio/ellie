# Service credential failure pause

The [credential recovery record](2026-09-17-service-credential-recovery.md) documented a required Keychain read timing out, followed by launchd restarting the service and trying again. Restoring the earlier package also stalled. The operator stopped the execution service to contain further attempts; no credential recovery was established.

This change handles the required coordinator key and node token reads before the role exposes an endpoint or connects. A typed Keychain failure records its existing redacted reason and `needs_attention`, then holds the service process idle. Launchd process liveness remains separate from Ellie readiness. Role-specific doctor reports the attention state without initiating another credential read. An explicit stop and start performs a new attempt after the prerequisite is resolved. Ordinary crashes, network recovery, foreground commands and optional browser startup keep their existing behavior. The existing LaunchAgent definitions and identities are unchanged.

The log must record `starting` before either credential read. If the later failure event cannot be written, doctor treats the unfinished startup conservatively and avoids another read. Unsafe or unreadable logs also fail diagnostics without accessing Keychain. CLI status adds runtime guidance to the selected package's process status; it does not change the native installer's status schema or infer readiness from a PID.

`keychain_cleanup_uncertain` remains uncertain: keeping the parent alive does not prove its retained helper exited. A failed coordinator cleanup after the credential rejection records the separate `service_cleanup_uncertain` event and also preserves the pause. No automatic retry or inference of safe cleanup is added. Normal logout or forced process termination can result in a later launch under the existing launchd policy.

## Automated evidence

Product source `b3cdea9` passed independent review. The integrated candidate combines that source with the process fixture from `9594def`, preserving both histories. On macOS with Node 24.21.0 and Bun 1.4.2, 41 focused config, service, diagnostics, attention and process tests passed, with no failures or skips. Lint, formatting, generated contracts and all TypeScript projects passed. Current integrated CI remains the full merge gate.

The actual CLI process fixture runs both service roles under private temporary homes with synthetic certificates and a rejecting helper. Each role remains alive after one rejection, records the fixed attention sequence, closes after SIGTERM, and makes one fresh helper attempt after an explicitly launched second process. Foreground commands still exit with failure. The unchanged production baseline exited before attention was recorded; that negative result is retained. The process fixture directly observes child lifetime, event logs and helper calls. Absence of network or desktop activity follows the reviewed pre-listener control flow, rather than a separate network or desktop probe.

No household Keychain, LaunchAgent, service, phone or website was exercised. These checks do not establish macOS consent, installed-service recovery or physical phone-to-website acceptance. No package was deployed for this change.

## Installed acceptance — not ready

The coordinator must first supply an exact reviewed package, a candidate-specific rollout and recovery procedure, and a controlled credential-failure fixture. Do not lock the household Keychain, change access controls, revoke an existing identity or stop a working service to manufacture a test.

| Case                      | Action                                                                                                                                         | Expected result                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KC01 — one failed startup | Start the supplied isolated GUI service with its rejecting credential fixture. Inspect its status and fixed event log after the first failure. | One helper attempt; process remains idle with `needs_attention`; no listener, node connection, desktop action or repeated prompt.                                      |
| KC02 — diagnostics        | Run the matching candidate's role-specific doctor and status while KC01 remains idle.                                                          | Doctor fails with fixed recovery guidance without invoking the helper. Status distinguishes process liveness from readiness. Idempotent start does not silently retry. |
| KC03 — explicit recovery  | Use the supplied stop procedure, verify owned cleanup, change only the disposable fixture to its success case, then explicitly start.          | Exactly one new startup attempt, followed by normal readiness. Existing household state is unchanged. Uncertain helper cleanup remains blocked for reconciliation.     |

Reply `Credentials: KC01 PASS, KC02 FAIL — expected …; saw …, KC03 BLOCKED — prerequisite`. All three cases are currently blocked on the exact installed candidate and attended handoff. No existing owner result is promoted by this change.
