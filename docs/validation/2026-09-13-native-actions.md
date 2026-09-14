# Native app controls validation — September 13, 2026

This independently reviewable slice extends the native Devices window with explicit Arc, Safari and Messages app opening. It uses existing coordinator or node credentials and the existing command endpoint. No service, identity, Keychain item, capability grant or pairing changed.

## Automated validation

All 55 Swift tests passed on a physical MacBook running macOS 15.1 with full Xcode Swift 6.0.3. The new tests cover finite command encoding, actual loopback pinned HTTPS POST, strict Boolean response validation, fixed error text, refusal of stale/incapable targets, one request under repeated clicks, cancellation and late completions, and a new action remaining independent of an earlier cancelled action. Existing private credential, trust, bounded read transport, inventory and dashboard tests also passed. Network and action results are synthetic; the loopback server does not execute desktop actions.

The Node 24/Bun 1.4.2 workspace check passed 162 tests with one platform skip, alongside lint, formatting, contracts, types and browser build. The final macOS release bundle built and passed code-signature verification on the Mac mini running macOS 26.6.2 with Swift 6.3.3.

## Physical native UI with synthetic outcomes

On the mini, an isolated temporary app compiled the production Devices view and stores with injected inventory/action fixtures and a separate bundle ID. Its window was explicitly labeled synthetic. Native UI checks passed for connecting, selecting a target, finite app selection, a successful result, an uncertain result, Stop waiting, changing targets during an active wait, and disabled app opening for offline and capability-limited nodes. The original target/result remained visible after selection changed. This exercised real SwiftUI controls but used no network requests, real credentials or desktop actions. The fixture app was closed afterward; no test-only behavior was added to the production bundle.

## Acceptance boundaries

Household LAN command acceptance remains pending the new app's Local Network consent described in the [connection validation record](2026-09-13-native-connection.md). No real app-opening command was sent by this slice. There was no service restart, household-network interruption, sleep/wake test or physical iPhone test.

Stopping a command cancels the client request; the existing coordinator requests cancellation when it detects the closed response. Native side effects may already have happened. The UI deliberately reports an unknown outcome after interrupted/ambiguous responses and never retries a desktop command automatically. This does not establish hardware acceptance for stopping an already executing native action.
