# Ellie for iPhone

Ellie's iPhone app is a native SwiftUI target for iOS 17 and later. It shares the macOS dashboard model and persistence source directly, has no third-party dependencies, and imports and exports the browser dashboard editor's version 1 JSON schema.

The dashboard list supports create and native navigation. A dashboard supports rename, delete, widget add/reorder/remove, clock settings and note editing through native forms and sheets. State lives in the app's Application Support/Ellie/dashboardsv1.json container. Files import validates the 128 KB bound and complete schema before replacing local state; Files export writes the same browser-v1 schema. The app does not inspect browser storage or coordinator credentials.

Build and test with full Xcode:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project apps/ios/EllieIOS.xcodeproj -scheme EllieIOS -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/test-ios.mjs
```

The Xcode project creates the iPhone-only `org.ellie.dashboard.ios` app. These commands do not install on hardware or request a signing identity.

## Native enrollment protocol foundation

The coordinator now has a separate native-app authorization lifecycle. A controller can issue a ten-minute, single-use `native_phone_controller` invitation with explicit `app.open` grants for named nodes. The QR payload uses the versioned `ellie-native:v1:` format and binds the invitation to the exact HTTPS origin and the SHA-256 digest of the listener's actual leaf-certificate DER. Native session tokens use a separate bearer channel, domain-separated hashes, a bounded 90-day lifetime and independent list, logout and revocation operations. They never authenticate as a browser, node or controller.

The native client generates its candidate session token before the pairing POST. If the response is lost while the app remains running, it can make a read-only `GET /native/v1/session` request with that candidate token to determine whether pairing committed; it must not replay the POST automatically. If the unconfirmed token is lost in a crash, the server may retain an orphaned session until it expires or a controller revokes it. Reinstallation or migration requires a new invitation. A changed origin or certificate also requires explicit re-enrollment; the client must never rotate either silently.

This slice deliberately stops at the server, protocol and controller CLI foundation. The iOS camera flow, explicit confirmation screen, pinned native transport and Keychain storage remain a dependent implementation. That client must use an app-specific Keychain item with reviewed accessibility, start camera capture only after user action, stop it on success/cancellation/backgrounding/timeout, and avoid persisting or logging QR contents. It must perform hostname and certificate-validity checks in addition to the exact QR leaf pin and must not install a system-wide CA profile.

## Enrollment wire surfaces

Controller management uses the coordinator API and its existing controller bearer authentication. These routes are included in `contracts/openapi.v1.json`:

- `POST /v1/native/invitations` accepts an exact `{label, grants}` JSON object and returns the fields encoded into the QR.
- `GET /v1/native/clients` lists active native clients without credentials.
- `POST /v1/native/revoke` accepts an exact `{id}` JSON object and revokes that client.

The canonical QR envelope is bounded to 2,300 ASCII bytes so it remains below the terminal renderer's level-M byte capacity. Its decoded JSON and native listener request bodies are bounded to 4 KiB. The QR's exact origin identifies a separate native HTTPS listener. The listener requires the QR origin's exact `Host`, one `X-Ellie-Version: 1` header, no cookies, no browser `Origin` header and no `Sec-Fetch-*` headers. JSON requests accept one `Content-Type: application/json` header, optionally with UTF-8 charset. Its three version 1 routes are:

- `POST /native/v1/pair` accepts exact JSON `{invitation, token}` without authorization. Both values are 64 lowercase hexadecimal characters. `token` is the native client's candidate credential. Success returns `{client}` containing the public client record.
- `GET /native/v1/session` accepts the candidate as `Authorization: Bearer <token>` and returns `{client}` containing its public client record. This is the read-only recovery operation for an uncertain pair response.
- `POST /native/v1/logout` accepts exact empty JSON `{}` and the same native bearer. It revokes that session.

The listener routes deliberately do not inherit controller authentication and are not represented as coordinator operations in `contracts/openapi.v1.json`. A dedicated native-listener OpenAPI contract remains follow-up work before the Swift client is implemented. The reviewed contract for this slice is the protocol parser plus the server integration and synthetic TLS tests.

The controller CLI exposes `native invite --label NAME --node ID --allow app.open`, `native clients` and `native revoke ID`. Invitation creation validates the label, target, grant and maximum QR bytes before mutating invitation state. QR certificate material always comes from the listener's active leaf certificate.

As of 2026-09-13, this repository implements the protocol, server lifecycle, controller CLI and synthetic tests only. The iOS app does not scan this QR, contact the listener, store a native credential in Keychain or enroll a household. Those client features require their own review and validation.
