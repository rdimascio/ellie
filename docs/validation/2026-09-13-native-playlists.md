# Native selected playlist validation — 2026-09-13

Implemented on `codex/native-playlists` without changing the dashboard version. Automated fixtures use only the synthetic ID `PLSynthetic_123456789`.

Validated locally:

- `xcrun swift build` passes.
- All 8 browser dashboard model tests pass, including explicit playlist config acceptance, invalid-value rejection, and v1 round-trip cases.
- Command-center TypeScript typecheck passes.

Validated in an isolated temporary directory on the authorized MacBook with full Xcode:

- The initial 24-test Swift suite passes: 9 dashboard, 4 playlist, and 11 weather tests. The two subsequently added content-rule tests pass with the complete 6-test playlist suite in an isolated focused run.
- Playlist tests cover canonical IDs and URL normalization, unsafe URL forms, native v1 round-trip, invalid/unknown config, exact main/subframe navigation policy, and player error mapping.
- The remote source and build directories were deleted after the run.

No live provider request is part of automated acceptance. The physical mini check described below separately used a public playlist from the official YouTube documentation.

During attended setup acceptance, WebKit immediately rejected the first content-rule expression because its regex engine does not support disjunctions. An isolated diagnostic reproduced the parser failure without loading provider content. The production allowlist now uses one simple rule per media domain. A bounded XCTest compiles the exact production JSON without creating a web view or loading provider content, then removes its unique test-owned rule-list identifier; it passes under full Xcode. The repeated physical check passed after the further fixes described below.

A second bounded diagnostic showed the IFrame API’s initial subframe navigation uses the exact path `/embed`, without a trailing slash. The navigation policy had required `/embed/` and canceled that request, leaving the frame at `about:blank` until timeout. The policy now accepts exact `/embed` plus descendants under `/embed/`, still only on the exact privacy-enhanced HTTPS host; the observed URL has a focused regression assertion.

Playback telemetry then showed a ready player and a real 2,820-second item entering IFrame state 3 (buffering), while current time remained 0 and no player error fired. A provider-free hidden WebKit diagnostic reproduced the resource boundary: a tiny in-memory Blob fetch from a `youtube-nocookie.com` document was blocked by the production block-all rules, while the same fetch succeeded with a single `blob:https://www.youtube-nocookie.com/` exception. Production now permits only Blob URLs carrying that exact trusted origin; arbitrary Blob origins and all other unlisted schemes remain blocked. The repeated physical check confirmed playback after this fix.

## Physical mini acceptance

On macOS 26.6.2, the production SwiftUI widget and player were tested in an isolated signed app with only a distinct QA identity and owned dashboard-state path. Configuration retained a public Google I/O playlist from YouTube’s official player-parameter documentation; no personal account or playlist was used. After explicit Play, the actual provider resolved a 47-minute video. Its elapsed time advanced from 3 to 20 seconds with the Pause control shown; pausing at 25 seconds changed the control back to Play. Time stayed fixed while paused. Closing removed the player from the native sheet; after quitting and reopening the app, the configured widget persisted and playback remained stopped until another explicit Play. That new player started at zero seconds. This is real network media playback, separate from the provider-free automated tests.

The three failures found during physical testing—unsupported WebKit regex syntax, exact `/embed` navigation, and trusted Blob media blocked by the resource policy—have regression coverage against the actual WebKit engine or the observed navigation URL. No system trust setting, household identity, service, Keychain item, or provider account was changed. No private household playlist or recording appears in public fixtures.

The final Node 24/Bun full check passed 165 tests with one platform skip, including lint, format, generated-contract drift, type checking and the compatibility build. The final production app bundle built on the mini and passed strict code-signature verification. These are development signatures, not notarized distribution.
