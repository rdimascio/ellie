# Packaged native service lifecycle

[PR64](https://github.com/rdimascio/ellie/pull/64), commit
`193575c8e99abf6178cb017690b32d9ba07113d9`, adds read-only `status coordinator|node|all`
and explicit single-role `start` and `stop` commands to the packaged native installer.
It builds on the reviewed selection transaction in PR63. Coordinating and independent
reviews cleared the final source before publication.

The commands validate the complete selection under the selector lock, reject pending
recovery and unmanaged definitions, and revalidate the selected paths around launchctl
observations. Status creates no installation files. Start enables and loads the selected
service; stop disables and unloads it. Every successful mutation prints redacted observed
state. Loaded or waiting does not establish endpoint readiness. Failures after dispatch
report partial or unknown outcomes, with no automatic retry or job submission.

The final production source passed the full repository gate: 225 Node tests passed with
one platform skip, plus lint, formatting, contract, type and production-demo checks. The
coordinator independently repeated the final focused lifecycle test: one passed in 7.55
seconds. It compiles a test-only launchctl adapter and destination seam, using synthetic
payloads and an owned temporary home. No actual launchd service was modified.

The regression includes exact argument boundaries, malformed and duplicate state output,
current and legacy enabled-state values, unavailable GUI domains, bounded output and
timeouts, busy and unsafe locks, foreign service definitions, partial mutations and
uncertain post-dispatch observations. A deterministic replacement of the LaunchAgents
ancestor during the final pre-bootstrap observation is rejected; the captured argument
log proves that no bootstrap command was sent. A concurrent unload cannot report stop
success while the managed label remains enabled.

The clean committed-source archive is `EllieServices-0.1.0-dev-193575c8-macos-arm64.zip`,
SHA-256 `a9db34ee3764f07199ca4033a34f3e2b419dc169e68b946c782795472373cbc2`. The coordinator
independently verified its checksum, exact source revision, `sourceModified: false`,
413-file manifest and successful shipping read-only inspection. The official Node 24.21.0
input and explicit offline Bun cache were used. This artifact was not installed or selected.

Read-only observations on the physical mini running macOS 26 and MacBook running macOS
15.1 established the actual launchctl text forms used by the parser. Apple documents this
output as diagnostic text rather than a stable API. Strict parsing and final revalidation
do not eliminate races with external launchctl callers or arbitrary filesystem changes.

Actual fixed-label packaged start/stop, source-checkout migration, installed upgrade and
rollback, Keychain and Accessibility continuity, sleep/wake and signed distribution remain
separate acceptance gates. The owner's live services, identities, credentials, permissions
and preview were preserved.
