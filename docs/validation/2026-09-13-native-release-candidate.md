# Native release candidate acceptance — 2026-09-13

This candidate assembles reviewed source history without squashing it:

- combined native validation `1f975a5e0321368ddeebf2ad58144b7d55eeeb11`
- macOS development packaging `b48bed1899297a9400a8cdac475dd741f8a3d332`
- coordinator recovery reliability `b4945a3f7960c21cebbab77d1cc29188cedf5009`

The merges had no conflicts. Two validation-only corrections were required after assembly. The iOS integration runner used a constant-condition polling loop that deterministically failed repository lint in PR 46; it now uses the same bounded deadline and minimum invocation count as its acceptance check. A dashboard cancellation regression assumed one `Task.yield()` meant the first synthetic read had started. One combined run exposed that scheduling race, failing two assertions in the same test; the test now waits up to two seconds for the first request to start before cancelling it.

Validation on the corrected combined source used Node 24.21.0, Bun 1.4.2, full Xcode, and an owned iOS 18.3.1 simulator:

- `bun run check` passed 249 of 250 Node tests with one documented platform skip, plus lint, formatting, generated-contract drift, typechecking, and the command-center production build.
- The bounded desktop runner passed all 152 Swift/XCTest tests after the deterministic test correction.
- The app-hosted pinned HTTPS runner passed all 11 tests, including the eleven-second speech result, cancellation, authority revocation, lost-response handling, Keychain isolation, and ATS policy checks.

GitHub exact-head TypeScript jobs for PR 46 failed because of the constant-condition lint error above. Command-center checks passed. At the time of this record, its native jobs had not run because they remained queued. PR 41 and PR 42 exact-head TypeScript and command-center checks passed; some native jobs remained queued or in progress, so this record does not claim they passed.

The physical dashboard review of packaging commit `b48bed1` validated an earlier archive and source revision. It is useful prior evidence, but it does not accept this newly assembled artifact. Physical iPhone enrollment, microphone permission, local-network consent, and an attended phone-to-coordinator command remain pending. No live Ellie identity, Keychain account, service, microphone, or household state was used during this candidate validation.
