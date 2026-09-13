# Ellie native app

Ellie is a macOS-first SwiftUI application. The initial app provides the dashboard experience as a normal Dock application on macOS 14 and later. Its dashboard model and persistence layer are kept separate from the views so a future iPhone app can share those concepts; an iOS app is not part of the current build.

## Requirements

- macOS 14 or later
- Xcode Command Line Tools with Swift 6 to build; full Xcode for XCTest
- Node.js 24 and Bun 1.4.2 for workspace commands

The Swift package uses Swift 5 language mode and has no third-party dependencies.

## Develop and test

Build the Swift package directly while working on the app:

```sh
xcrun swift build --package-path apps/desktop
bun run desktop:test
```

`desktop:test` runs the `EllieTests` XCTest target. Tests import the `Ellie` executable module with `@testable import Ellie`.

## Build the application bundle

```sh
bun run desktop:build
```

The command creates `dist/desktop/Ellie.app`, including the existing Ellie icon, an `org.ellie.dashboard` Info.plist, and an ad hoc code signature. It builds in a private temporary directory and refuses to replace an existing app bundle. Remove or move a previous build before rebuilding.

To choose another destination, provide an absolute, non-existing `.app` path:

```sh
bun run desktop:build -- --output /absolute/path/to/Ellie.app
```

Building the desktop app does not install or launch it. It does not read or change the installed native helper, `~/.ellie`, LaunchAgents, Accessibility authorization, or Keychain items.

## Native experience and data

The app uses SwiftUI NavigationSplitView, system toolbar/sidebar, SF Symbols, native menus, editable widget sheets and macOS open/save dialogs. Edit reveals inline layout controls; contextual actions and adding notes remain available while browsing. Clock and notes work; weather/calendar/chores/playlist cards clearly show that provider connections are not implemented. There is no web view or embedded browser in the app.

The versioned JSON schema accepts the browser dashboard editor’s export. Use File → Import Dashboards to carry layouts and notes over; the app does not reach into browser storage. Native state lives in Application Support/Ellie/dashboardsv1.json with private permissions. Invalid startup data remains intact and blocks writes until explicit import/reset recovery. `--state-path /absolute/private/dashboards.json` selects an isolated file for validation. Existing coordinator/node identities, Keychain credentials and services are untouched.

The Mac client also provides connected device status, explicitly targeted app opening and reviewed local push-to-talk commands. Conversational voice, connected provider widgets, native iPhone packaging, shared profiles and signed/notarized distribution remain separate slices. An ad hoc development signature is not a notarized release.

## Connected device status

Open **Devices** from the dashboard toolbar or View menu (Command-Shift-D). Choose the existing **Coordinator** or **Node** identity on this Mac, then select **Connect**. The app does not initialize an identity or change pairing. A coordinator identity sees household node registrations; a node identity sees only its own registration. The coordinator is not automatically an execution node.

On macOS versions with Local Network privacy controls, Ellie needs its own Local Network consent to reach another Mac. Allow the system prompt, or enable Ellie in System Settings → Privacy & Security → Local Network, then reconnect. Existing terminal or node-service permission does not grant it to this new application. The bundle includes a purpose description and does not alter these privacy settings itself.

Select a Mac to inspect its ID, desktop capabilities and last registration. Online status requires a fresh registration from a reachable, authenticated coordinator. During an interruption, cached rows show **Status unavailable**. Refresh does not run a desktop action.

The app reads the selected role's existing private configuration and pinned certificate under `~/.ellie`. It retrieves the existing Keychain item through the installed Ellie native helper, using only `keychain.get`. Credentials stay in memory; there are no configuration writes, Keychain changes, new service processes or analytics calls. If the identity is missing, finish the existing CLI installation/pairing flow before connecting.

Requests use an ephemeral HTTPS session with exact certificate pinning and bounded responses. Device reads have a five-second deadline. Redirects, cookies and shared credential/cache storage are disabled. Successful reads refresh every ten seconds while the Devices window is open. Availability failures permit three retries after two, four and eight seconds; then monitoring stops until an explicit reconnect. Invalid trust, rejected credentials and malformed responses stop immediately. Closing Devices or selecting another identity cancels monitoring and drops the connection state.

## Open an app on a selected Mac

Connect, select an online Mac with the **Open applications** capability, choose Arc, Safari or Messages, then click **Open**. The selected Mac and app are shown with the result. A node identity can control only itself; an existing coordinator identity can target its paired nodes. The coordinator and node still enforce their existing capabilities, app allowlists and macOS permissions. The screen does not grant permissions or accept arbitrary command text.

Only one command can be in flight. Commands have a 35-second absolute deadline to accommodate the coordinator's default 30-second operation timeout. They are never retried automatically. Opening a window, connecting, refreshing status and restarting the app do not submit desktop actions.

**Stop waiting** closes the command request. The coordinator requests cancellation when it observes that disconnection, but a native action may already have run. Ellie therefore shows an unknown outcome after cancellation, timeouts, interrupted connections or an ambiguous unsuccessful response. Check the target Mac before repeating the command. An already opened app is not closed by cancellation.

## Local push to talk

Devices includes an explicit **Start recording** control. The first use is the only point at which macOS can ask for microphone access. Recording stops when requested or after 30 seconds, stays under 1.1 MB, and is transcribed by the configured local Node.js 24, whisper-cli and GGML model. Choose those three existing files through **Voice Settings**; Ellie does not download a model or use a cloud fallback. The source-checkout app bundle includes the small Node bridge, so this is a development distribution workflow rather than a signed installer promise.

Audio and intermediate transcript files use a private temporary directory. Ellie attempts exact-file cleanup followed by removal of its empty per-turn directory after success, error or cancellation; cleanup failure is reported without exposing a path. Ellie writes neither content to logs. Cancelling recording or transcription terminates the local turn and cannot restore a late result.

The transcript is editable. Only the exact commands Open, Launch or Start followed by Arc, Safari or Messages can be prepared. Preparing a reviewed command changes only the application picker: it does not choose a Mac or send a request. Review the selected Mac and application, then click the existing **Open** button to dispatch through the same capability, allowlist, timeout and cancellation checks. Speech is input, not authentication.

Changing the selected Mac or identity, disconnecting, closing Devices, or losing authenticated availability stops an active wait. While the window remains open, it preserves that uncertainty in the visible result. Rejected credentials immediately discard the connection and cached inventory. The result captures the original target and app; a late response cannot overwrite a cancellation result. There is no persisted command payload, background queue or replay on launch. This initial control does not present a durable job ID or claim confirmation that a running native action stopped.

## Validation and next slices

The [dated validation record](validation/2026-09-13-native-app.md) separates actual Mac UI checks from automated model tests. CI runs the Swift tests and builds/verifies the app bundle on macOS.

The [native connection record](validation/2026-09-13-native-connection.md) covers 44 Swift tests, including real localhost HTTPS, and the physical UI check that identified pending Local Network consent. Live native LAN inventory remains an acceptance step after that consent.

The [native app control record](validation/2026-09-13-native-actions.md) distinguishes synthetic command outcomes from physical Mac UI and LAN acceptance.

Next, add the native iPhone target and pairing flow. Expand local voice only after the reviewed push-to-talk boundary has physical acceptance. Chores and weather can advance independently with shared data models and native widgets. Provider accounts, signing credentials and microphone consent remain separate acceptance steps.
