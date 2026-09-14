# Native app validation — September 13, 2026

This record covers the first SwiftUI macOS client on `codex/native-dashboard`. It is a development build with an ad hoc signature, not an installed or notarized release. Existing coordinator/node services, identities and Keychain items were not changed.

## Physical Mac interface

On an Apple Silicon Mac mini running macOS 26.6.2, the release app bundle built, passed code-signature verification and launched as a normal Dock application. Automated UI interaction through the macOS accessibility tree verified:

- Native sidebar, toolbar, menus and widget gallery appear.
- Create a dashboard, add a note, edit its title and multiline text, and rename the dashboard.
- Quit the process, reopen the app, and select the persisted dashboard: name and note content survive.
- Inspect dark-mode rendering of the clock, notes and unconnected weather card; fix note contrast and the digital clock period label.

These checks used synthetic notes. A development dashboard named “Native preview” remains available for inspection. Light-mode visual acceptance, VoiceOver navigation, older-macOS UI behavior and signed distribution were not tested.

## Automated validation

- On a physical Apple Silicon MacBook with macOS 15.1 and Xcode Swift 6.0.3, all nine XCTest cases passed. Only public Swift source was copied into an isolated temporary directory. Tests cover browser-v1 JSON round-trip compatibility, unknown/duplicate fields and IDs, collection/note/serialized limits, persisted edits and permissions, corrupt-file recovery, rejected imports, failed-mutation rollback and state-file symlinks. These are synthetic model/filesystem tests, not live household integration tests.
- The Mac mini’s Command Line Tools built the SwiftUI release app with a macOS 14 deployment target. Its Command Line Tools installation cannot run XCTest, so the MacBook’s full Xcode installation ran those tests instead.
- The Node 24/Bun 1.4.2 workspace check passed: lint, format, contracts, type checking, 162 passing tests with one platform skip, and the browser build.
- The bundle builder’s syntax/help/format checks passed. A focused filesystem check verified that an existing dangling `.app` symlink is refused and preserved.

No native iPhone app, live coordinator controls, microphone capture, speech recognition, provider widgets, shared dashboard synchronization or hardware sleep/wake behavior is claimed by this slice. Clock and notes are functional; weather, calendar, chores and playlist cards explicitly show that connections are pending.
