# Ellie for iPhone

Ellie's iPhone app is a native SwiftUI target for iOS 17 and later. It shares the macOS dashboard model and persistence source directly, has no third-party dependencies, and imports and exports the browser dashboard editor's version 1 JSON schema.

The dashboard list supports create and native navigation. A dashboard supports rename, delete, widget add/reorder/remove, clock settings and note editing through native forms and sheets. State lives in the app's Application Support/Ellie/dashboardsv1.json container. Files import validates the 128 KB bound and complete schema before replacing local state; Files export writes the same browser-v1 schema. The app does not inspect browser storage or coordinator credentials.

Build and test with full Xcode:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project apps/ios/EllieIOS.xcodeproj -scheme EllieIOS -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/test-ios.mjs
```

The Xcode project creates the iPhone-only `org.ellie.dashboard.ios` app. These commands do not install on hardware or request a signing identity.

## QR enrollment: next slice requirements

Before QR enrollment is implemented, the coordinator must define an authenticated native-session endpoint and credential lifecycle; the existing browser cookie is not a native app credential. The native bootstrap remains an open protocol design. A likely controller-originated QR would carry a versioned trusted origin, certificate pin material and a single-use invitation scoped to the intended native role, but its canonical encoding is not defined yet. It must not assume that the existing browser-only QR payload is sufficient.

- Consume only a controller-issued, single-use, short-lived invitation and require the user to confirm the displayed coordinator identity and origin before enrollment. Do not invent an invitation, identity or household grant.
- Validate the coordinator connection against the QR-provided origin and certificate pin, including hostname, pin shape, certificate validity interval and a reviewed rotation/recovery path. A native app can perform scoped trust evaluation without requiring installation of a system-wide CA profile. It must never accept an invalid certificate, suppress a trust error or silently change origins.
- Bind the issued native session credential to the confirmed origin and store it in Keychain with an explicitly reviewed accessibility class. Define server-side revocation, local removal, device migration and coordinator certificate rotation behavior.
- Start camera capture only after a user action; decode locally; stop on success, cancellation, backgrounding or timeout; and never persist or log QR contents.
- Recover an uncertain pairing response by reading session state without replaying the pairing mutation automatically.

This dashboard slice does not define the QR wire format, pair a household, scan a QR code, install a certificate profile, touch Keychain or contact a coordinator.
