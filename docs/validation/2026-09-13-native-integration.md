# Native integration validation — 2026-09-13

This record covers the isolated `codex/native-integration` branch. It is an integration build, not a release. Automated builds and physical Mac UI review used synthetic state. No household coordinator or installed service was contacted, and no Local Network, microphone, camera, Keychain, Accessibility, or signing prompt was triggered.

## Integrated history

The integration started at `1713ddadeaae287d34ff563e0ecdeb84b0632550` and merged these fetched remote heads without squashing:

- `origin/codex/native-chores` at `12e8f7263adfd6a2e8c50e764bc56860ebd9f2d5`
- `origin/codex/native-playlists` at `1fdc1809369b8e638c64f5b969d5f2a21ccdf4ee`
- `origin/codex/native-enrollment` at `58e96d13274c3b32079d137806ea7281047d961f`

The resulting enrollment merge commit is `a8c98099f4a8cd65d30a97a9dafa0af6056a6f81`. The normal conflicts were resolved additively:

- `EllieApp.swift` retains the coordinator Devices window and injects both private chores and weather stores into the dashboard.
- `DashboardView.swift` and `WidgetViews.swift` route local chores, weather, and playlist cards while retaining device navigation and dashboard editing.
- `DashboardModel.swift` retains both the browser-v1 playlist identifier validation and the explicit-time-zone clock formatter shared with iOS.
- `apps/cli/src/main.ts` exposes both the bounded local transcription command and native enrollment management commands.
- `docs/native-app.md` describes the cumulative native behavior and no longer labels implemented iPhone, chores, weather, playlist, device, or push-to-talk slices as absent.

Browser-v1 import and export remain bounded to 128 KiB. Dashboard JSON still excludes chore state, credentials, and provider secrets. Chores and weather retain separate private files. Voice cancellation still waits for recorder/transcriber cleanup, validates owned artifacts before exact-file unlink and empty-directory removal, and accepts transcription output only after bounded EOF and owned process-group cleanup.

## Reproducible checks

The Node checks ran locally with Node 24.21.0 and Bun 1.4.2:

```sh
node --version # v24.21.0
bun --version  # 1.4.2
bun install --frozen-lockfile
bun run check
```

All 190 active Node tests passed; one platform-specific smoke test was skipped. Lint, formatting, generated-contract consistency, TypeScript compilation, and the production command-center build passed.

Full Xcode validation used an owned temporary checkout on a macOS 15 validation Mac, `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, Node 24.21.0, and isolated scratch/output paths. The full macOS Swift suite passed 83 tests with zero failures. Sanitized logs remain outside the repository in the owned validation directory. The first attempt could not resolve the test harness's synthetic HTTPS `node` executable from the noninteractive SSH PATH; it made no product request. The unchanged suite passed after supplying the explicit Node 24 runtime.

The generic iOS Simulator build passed against the iOS 18.2 SDK with signing disabled. The bounded iOS runner created and deleted its own simulator and derived-data resources. Its first Node 24 run hit an XCTest input-synthesis flake that entered `Remthe blue mugr ` instead of `Remember the blue mug`; the repeated unchanged run passed note editing and relaunch persistence, rename, and dashboard deletion/navigation. Sanitized passing and failing logs and the final synthetic result bundle remain in the owned validation directory outside the repository.

The production macOS bundle built under Node 24 with an ad hoc development signature and passed bundle validation in a unique owned output directory. The bundle and sanitized log remain outside the repository. It was not launched, installed, notarized, or released.

## Physical Mac UI review

A separately identified QA bundle ran on a physical Mac mini with a compiled fallback to an owned, private temporary state directory. Its production view code was unchanged. Weather started disabled. The review created a Kitchen dashboard, added a chore assigned to a synthetic household member, completed it, and observed the current-day weekly chart count change from zero to one. A note was added and the dashboard renamed. After quitting and reopening, both the note and completed chore were still present.

The Devices toolbar opened the native Devices window; closing it returned to the dashboard without connecting. The playlist widget and its native setup sheet opened and cancelled without playback. The app was then quit. Dashboard and chores files were verified as separate mode-0600 files inside the owned mode-0700 directory. An explicit dashboard `--state-path` now also places chores beside it unless `--chores-state-path` is supplied, matching weather isolation.

The chore management list exposes its completion and deletion labels together in one accessibility row, so the visible completion circle was used for that interaction. The dashboard card exposes a separate, labelled completion button. Improving the management list's individual accessibility actions remains a usability follow-up.

## Acceptance limits

These checks use synthetic state and network fixtures. They do not accept live LAN inventory, a household command, microphone recording, camera enrollment, native TLS pinning from an iPhone, Keychain session storage, physical iPhone behavior, provider-account data, media playback in the combined build, signed distribution, or notarization. The iOS target contains the local dashboard app and enrollment protocol foundation; it does not implement the camera, transport, or credential-storage enrollment client.
