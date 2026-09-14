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

The app uses SwiftUI NavigationSplitView, system toolbar/sidebar, SF Symbols, native menus, editable widget sheets and macOS open/save dialogs. Edit reveals inline layout controls; contextual actions and adding notes remain available while browsing. Clock, notes, and local dated chores work. The optional [weather widget](native-weather.md) shows current conditions for an explicitly configured place; calendar and playlist connections are separate slices. There is no web view or embedded browser in the app.

The versioned JSON schema accepts the browser dashboard editor’s export. Use File → Import Dashboards to carry layouts and notes over; the app does not reach into browser storage. Dashboard state lives in Application Support/Ellie/dashboardsv1.json with private permissions. Dated chores use the separate private `choresv1.json`; dashboard import and export continue to contain layouts and notes only, never chore content. Invalid startup data remains intact and blocks writes so a malformed file is not silently replaced. `--state-path /absolute/private/dashboards.json` and `--chores-state-path /absolute/private/chores.json` select isolated files for validation. Existing coordinator/node identities, Keychain credentials and services are untouched.

Chore due and completion days are Gregorian date-only values (`YYYY-MM-DD`) interpreted in the household time zone saved with the chore file. The current day changes at midnight in that zone, completion records the household day when the action occurs, and the weekly chart runs Monday through Sunday across daylight-saving transitions. This first local slice has no recurrence, reminder scheduling, chore sync, or chore import/export.

This is the first macOS client slice. Live coordinator controls, model-backed voice, connected provider widgets, native iPhone packaging, shared profiles and signed/notarized distribution remain later slices. An ad hoc development signature is not a notarized release.

## Validation and next slices

The [dated validation record](validation/2026-09-13-native-app.md) separates actual Mac UI checks from automated model tests. CI runs the Swift tests and builds/verifies the app bundle on macOS.

The [native chores validation record](validation/2026-09-13-native-chores.md) covers task creation, completion/undo, chart updates and persistence on the physical mini, plus date and state regression tests on the MacBook.

Next, add a native connection and device view using the existing authenticated coordinator protocol, followed by an explicitly targeted granted command. Then add the native iPhone target and pairing flow, and local microphone capture feeding the reviewed transcription adapter. Chores and weather can advance independently with shared data models and native widgets. Provider accounts, signing credentials and microphone consent remain separate acceptance steps.
