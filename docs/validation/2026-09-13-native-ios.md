# Native iPhone dashboard validation — 2026-09-13

The iOS 18.2 SDK built the `EllieIOS` app with no external dependencies. A dedicated iPhone 16 simulator running iOS 18.3.1 exercised `EllieIOSUITests`: it edits a note, relaunches to verify persistence, creates and renames a dashboard through native controls, deletes it and verifies navigation returns to the dashboard list.

The final simulator workflow passed one test with zero failures. All ten shared macOS model/store tests passed on the MacBook with full Xcode, including explicit UTC versus Los Angeles clock formatting. The Node 24/Bun 1.4.2 full check passed 162 tests with one platform skip, plus lint, formatting, contract generation checks, type checking and the browser compatibility build.

The validation checkout, derived data and simulator were temporary. The bounded test runner creates and deletes only its uniquely identified simulator. No installed Ellie service, `~/ellie-test`, existing simulator, physical phone, signing identity, Keychain item or browser identity was read or changed.

Reproduction commands are in [the iPhone development guide](../native-ios.md). The runner selects a compatible installed iOS 17-or-newer runtime and iPhone type, creates a uniquely named simulator and private derived-data directory, bounds every subprocess, and removes owned resources after each run. A failure retains its synthetic XCTest result at `test-results/native-ios.xcresult`; CI uploads it for three days. Physical-device layout, Files-provider round trip, signing, distribution and an accessibility review remain untested. The shared macOS XCTest suite covers schema validation, persistence, import safety and dashboard/widget mutations.

The native enrollment foundation was validated on 2026-09-13 with `bun run check` under Node 24 and Bun 1.4.2. Synthetic tests cover the canonical bounded QR contract, exact native request channel, controller-only management, single-use pairing and candidate-token recovery, private-file reopen, persistence failure, expiry, logout and revocation. Tests use temporary private state directories and synthetic loopback TLS only. They do not access an installed coordinator, real credentials, Keychain, a camera or an iPhone.

This validation covers the protocol, server and controller CLI. The iOS camera flow, explicit origin confirmation, pinned transport and Keychain lifecycle have not been implemented or validated. A dedicated native-listener OpenAPI contract also remains follow-up work before that client is added.
