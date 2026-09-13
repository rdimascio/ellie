# iPhone dashboard sync foundation validation — 2026-09-13

This slice adds explicit iPhone dashboard synchronization through an already enrolled native client. It checks granted profiles, reads a selected server copy, prepares an immutable copy of the local dashboard file, and performs one conditional save. It never reads or writes on startup, retries a mutation, or replaces the local dashboard without a separate confirmation.

Pending saves are stored without the bearer token in a bounded private file tied to the coordinator origin, pinned certificate, enrolled client, profile, base revision, and dashboard value. A lost response is recovered only by a user-started GET. A later matching revision is described as the server's current value, not proof that this client's PUT committed. Revocation and logout clear sync-only data while retaining the ordinary local dashboard file; failed private cleanup blocks further sync and logout.

Validated on an isolated MacBook source copy with Xcode 16.2:

- `swift test --filter DashboardSyncTests`: 8 tests passed, covering private persistence, symlink rejection, no startup request, persist-before-PUT, one-shot conflict behavior, no PUT after persistence failure, qualified GET recovery, revocation cleanup failure, enrollment isolation, and late read rejection after backgrounding.
- `swift test`: 138 tests passed with no failures.
- `xcodebuild -project apps/ios/EllieIOS.xcodeproj -scheme EllieIOS -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`: succeeded.

With Node 24.21.0 and Bun 1.4.2, `bun run check` passed: formatting, generated contracts, TypeScript, 233 Node tests (one platform-specific skip), and the command-center production build.

The existing backend integration suite covers two independently authenticated native clients sharing conditional server revisions and private-profile isolation over real TLS. This client slice uses the same pinned transport and API contract. It does not add OAuth, Mac controller access, automatic synchronization, chores synchronization, physical-phone testing, or live coordinator access.

After the uncertainty and enrollment-binding review, a final isolated MacBook source snapshot was validated again. The sync store now permits PUT only from an explicitly prepared state; restored, cancelled, or failed-recovery saves remain GET-only. A pending copy tied to another enrollment is retained but sealed until the user explicitly discards it, and logout waits for an exact private-file deletion plus parent-directory fsync.

- The bounded desktop runner passed 142 tests with no failures, including 12 `DashboardSyncTests` covering unknown-outcome access refresh and recovery failure, restored-draft no-replay, explicit orphan discard, cleanup failure blocking the credential action, and rejection of a late cancelled read after a newer result.
- The app-hosted iOS ATS runner passed its pinned HTTPS, rejection, Keychain, built-policy, and exact-source unit checks on an owned iOS 18.3.1 simulator. Its successful runner cleanup removes the transient result bundle.
- `bun run check` passed with Node 24.21.0 and Bun 1.4.2: lint, formatting, generated contracts, typechecking, 233 of 234 Node tests with the existing platform-specific skip, and the command-center production build.
- A local clean scratch `swift build` completed successfully before the full MacBook test run.
