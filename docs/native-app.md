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

This is the first macOS client slice. Live coordinator controls, model-backed voice, connected provider widgets, native iPhone packaging, shared profiles and signed/notarized distribution remain later slices. An ad hoc development signature is not a notarized release.

## Connected device status

Open **Devices** from the dashboard toolbar or View menu (Command-Shift-D). Choose the existing **Coordinator** or **Node** identity on this Mac, then select **Connect**. The app does not initialize an identity or change pairing. A coordinator identity sees household node registrations; a node identity sees only its own registration. The coordinator is not automatically an execution node.

On macOS versions with Local Network privacy controls, Ellie needs its own Local Network consent to reach another Mac. Allow the system prompt, or enable Ellie in System Settings → Privacy & Security → Local Network, then reconnect. Existing terminal or node-service permission does not grant it to this new application. The bundle includes a purpose description and does not alter these privacy settings itself.

Select a Mac to inspect its ID, desktop capabilities and last registration. Online status requires a fresh registration from a reachable, authenticated coordinator. During an interruption, cached rows show **Status unavailable**. Refresh does not run a desktop action.

The app reads the selected role's existing private configuration and pinned certificate under `~/.ellie`. It retrieves the existing Keychain item through the installed Ellie native helper, using only `keychain.get`. Credentials stay in memory; there are no configuration writes, Keychain changes, new service processes or analytics calls. If the identity is missing, finish the existing CLI installation/pairing flow before connecting.

Requests use an ephemeral HTTPS session with exact certificate pinning, a five-second deadline and a bounded response. Redirects, cookies and shared credential/cache storage are disabled. Successful reads refresh every ten seconds while the Devices window is open. Availability failures permit three retries after two, four and eight seconds; then monitoring stops until an explicit reconnect. Invalid trust, rejected credentials and malformed responses stop immediately. Closing Devices or selecting another identity cancels monitoring and drops the connection state.

This slice is read-only. Granted app commands and cancellation/outcome controls will follow separately; no desktop action is queued or replayed by the device screen.

## Validation and next slices

The [dated validation record](validation/2026-09-13-native-app.md) separates actual Mac UI checks from automated model tests. CI runs the Swift tests and builds/verifies the app bundle on macOS.

The [native connection record](validation/2026-09-13-native-connection.md) covers 44 Swift tests, including real localhost HTTPS, and the physical UI check that identified pending Local Network consent. Live native LAN inventory remains an acceptance step after that consent.

Next, add a native connection and device view using the existing authenticated coordinator protocol, followed by an explicitly targeted granted command. Then add the native iPhone target and pairing flow, and local microphone capture feeding the reviewed transcription adapter. Chores and weather can advance independently with shared data models and native widgets. Provider accounts, signing credentials and microphone consent remain separate acceptance steps.
