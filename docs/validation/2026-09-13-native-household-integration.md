# Native household integration validation — 2026-09-13

This is an isolated integration candidate, not a deployment. It preserves PR37's native Mac pairing history, PR36's iPhone enrollment/control history and PR34's imported-agenda history. The two local merge commits are `26bb9b1` and `ee4ef79`. No GitHub stack merge or household service restart was performed.

## Automated baseline at ee4ef79

- Node 24/Bun full check: 208 tests passed, one platform skip; lint, formatting, contracts, type checking and browser build passed.
- Full macOS Swift suite on the separate full-Xcode host: 126 tests passed.
- Generic iOS Simulator build with signing disabled passed.
- Existing iOS simulator UI runner: two tests passed in 55.010 seconds. It checked Coordinator navigation without starting enrollment, note edit/relaunch persistence, and dashboard create/rename/delete.
- App-hosted iOS ATS runner: five tests passed. Swift used the production Node native listener on loopback with synthetic authorization and execution. Server assertions observed exactly two inventory reads and one finite simulated app-open. Pin/hostname rejection, isolated Keychain lifecycle and the built app's `NSAllowsLocalNetworking`-only ATS exception were checked. Test origin/pin settings were absent from the app.

The two iOS runners owned separate simulators and temporary source/build directories, which were removed after success. Logs were retained outside the repository. No live household credential, listener or default Keychain item was used.

## Coordinating review and correction

Review confirmed that the merged Mac app owns and passes the chores, weather and agenda stores to the appropriate widgets, retains per-widget playlist configuration and preserves the Devices scene. The iOS target includes enrollment, controls and app-hosted test sources; no background capability or automatic command dispatch was added.

Review found that saving an iPhone widget edit replaced its configuration with an empty dictionary for unsupported widget kinds. This could erase a playlist ID imported from the Mac. The editor now uses a shared schema-validating helper to preserve that configuration; note and clock edits still replace their editable settings, including clearing an explicitly blank clock time zone. Three model regressions cover preservation, clearing and rejection of out-of-schema settings. Two stale Mac gallery strings now describe the working agenda snapshot feature.

After this correction, the full Swift suite passed 129 tests and both standard iPhone simulator UI tests passed again. A separate temporary offline UI fixture drove the production `IOSWidgetEditor`: it changed an imported playlist's title and size, then encoded/decoded the result and confirmed that its playlist ID survived. That targeted UI test passed. The final source copy and all three owned simulators were removed; test logs remain outside the repository. The unchanged ATS transport/target suite was not repeated. Final repository formatting and diff checks passed.

## Physical Mac UI with synthetic content

A separately named, ad-hoc-signed QA bundle was built on the Mac mini from `ee4ef79`. Only its application identity, private temporary state path and coordinator loader were injected: the loader fails locally and cannot read an installed identity or reach a household service. This UI run precedes the iPhone helper and two gallery-copy corrections above.

The actual SwiftUI interface displayed an imported synthetic agenda beside a note, chores, playlist setup, weather setup and clock. Completing a synthetic chore changed its remaining count and the native weekly chart. The calendar inspector exposed snapshot import/clear controls; saving a new widget title preserved the agenda. The Devices toolbar opened the separate native window. After an actual process quit/relaunch, the renamed calendar, imported event and chore completion were all present.

The first handwritten chore fixture used a non-UUID ID and was correctly rejected while preserving the file. The fixture was corrected to a synthetic UUID before the successful workflow; this was not a production source failure. The UI automation had to raise the native window before keyboard quit; a returned unchanged tree was not counted as a process restart.

This run did not connect Devices, enable a weather provider, play media, grant permissions, access a microphone or scan a QR. The separate earlier feature records retain their own hardware evidence. Physical iPhone enrollment, signing/distribution, native LAN command acceptance, microphone input and two-device household synchronization remain unvalidated or unimplemented as described in their records.
