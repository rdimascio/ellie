# Ellie native app

Ellie provides native SwiftUI dashboard applications for macOS and iPhone. The macOS app is a normal Dock application on macOS 14 and later. The iPhone target shares its versioned dashboard model and persistence implementation; see the [iPhone development guide](native-ios.md).

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

Live coordinator controls, model-backed voice, connected provider widgets, iPhone distribution, shared profiles and signed/notarized macOS distribution remain later slices. An ad hoc development signature is not a notarized release.

## Validation and next slices

The [dated validation record](validation/2026-09-13-native-app.md) separates actual Mac UI checks from automated model tests. CI runs the Swift tests and builds/verifies the app bundle on macOS.

Next, review the native trust and credential bootstrap described in the iPhone guide before implementing enrollment. Native coordinator commands, local microphone capture, chores and weather can advance independently. Provider accounts, signing credentials and microphone consent remain separate acceptance steps.
