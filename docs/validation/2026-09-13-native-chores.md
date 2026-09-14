# Native chores validation — September 13, 2026

This slice replaces the native dashboard's chores placeholder with a local dated task list and weekly completion chart. It is stacked on the initial SwiftUI app, independently from the coordinator connection work. It does not synchronize household data or run routines.

## Physical Mac interface

On the Apple Silicon Mac mini running macOS 26.6.2, the release bundle built, passed signature verification and launched. The real native interface was used to:

- Add a chores widget to the synthetic “Native preview” dashboard.
- Open the native management and add-task sheets.
- Create “Water the plant,” assigned to “Demo,” due on the current household day.
- Complete the task and observe the current day's chart count change from zero to one.
- Undo completion and observe the chart return to zero.
- Quit and reopen Ellie, then verify the saved widget and uncompleted task remain.

Only synthetic task data was used. Delete behavior was tested in the model suite; a physical deletion was not performed. VoiceOver operation, another household time zone in the physical UI, an iPhone client, shared synchronization and recurrence were not hardware-validated.

## Automated checks

On the MacBook running macOS 15.1 with Xcode Swift 6.0.3, all 15 Swift tests passed: nine existing dashboard tests and six chore model/store tests. Coverage includes canonical Gregorian dates, invalid/future schemas, duplicate identifiers, data and collection/text bounds, a DST week and non-UTC Monday boundary, completion/undo/deletion, persisted data and private permissions, and corrupt-file preservation. These use synthetic temporary files; they are not household integration tests.

The Node 24/Bun 1.4.2 workspace check passed with 162 tests and one platform skip, including lint, formatting, contracts, types and browser build. The final SwiftUI release bundle also built and passed its ad hoc code-signature check on the mini. The new Swift tests run in the existing macOS CI job.

Chores live in a separate private `Application Support/Ellie/choresv1.json`. Dashboard layout exports do not contain task content. Existing services, pairing, Keychain items and browser-v1 layout schema were not changed. A local development build is not a notarized release.
