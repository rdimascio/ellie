# Native connection validation — September 13, 2026

This slice adds a read-only Devices window to the SwiftUI Mac app. It uses an explicitly selected existing coordinator or node identity, without changing services, pairing, Keychain items or configuration. It is independently stacked on the initial native dashboard app.

## Automated checks on physical Macs

On the MacBook running macOS 15.1 with full Xcode Swift 6.0.3, all 44 Swift tests passed:

- Existing dashboard model/store regressions.
- Private file, role/account mapping, invalid configuration, symlink, FIFO and permission boundaries.
- Synthetic helper output fragmentation, output limits, timeout and cancellation, without using the real helper or Keychain.
- Node schema/freshness validation, fixed error messages, explicit selection, bounded reconnects, late-completion rejection and revocation clearing cached inventory.
- Security-framework tests for the exact certificate pin, server policy and current/expired/future validity.
- Five real URLSession tests against an ephemeral HTTPS server bound only to `127.0.0.1`: required path/headers, refused redirects with no sink request, streaming response limit, absolute deadline on a slow stream, and cancellation. The server, certificates, credentials and node records are synthetic and temporary. These tests do not establish household LAN acceptance.

The Node 24/Bun 1.4.2 workspace check passed with 162 tests and one platform skip, including lint, format, contracts, types and browser build. Release bundles built and passed ad hoc signature verification on the Mac mini running macOS 26.6.2. The macOS CI job includes all Swift tests and app-bundle verification.

## Physical native UI and remaining consent

On the mini, the real native Devices window, identity picker, Connect/Disconnect and unavailable/reconnect states were exercised. The Node role retrieved its existing credentials and attempted the configured LAN connection. It did **not** successfully load the household node registration: macOS reported `Local network prohibited` and URLSession error `-1009`. In the same session, the existing CLI doctor successfully reached the coordinator and confirmed a fresh registration with all four desktop capabilities.

The bundle now includes `NSLocalNetworkUsageDescription`, and the unavailable state explains how to enable Ellie under System Settings → Privacy & Security → Local Network. The final app was opened through Finder and retried in the foreground; consent remained unavailable. No privacy setting was changed. The owner must enable Local Network for the new Ellie app before native LAN acceptance can continue. Existing terminal/node-service permission does not establish this app's permission. See [Apple's Local Network privacy guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

This is a development app with an ad hoc signature. Stable release identity and notarization remain pending; Apple recommends an Apple-issued signing identity for reliable macOS Local Network identity tracking.

No desktop command, service interruption, credential rotation, pairing change, sleep/wake test or native iPhone test was performed by this slice. Controlled retry/revocation/timeout cases above are automated fixtures, not disruptions to the running household services.
