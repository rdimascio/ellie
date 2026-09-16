# Ellie for iPhone

Ellie's iPhone app is a native SwiftUI target for iOS 17 and later. It shares the macOS dashboard model and persistence source directly, has no third-party dependencies, and imports and exports the browser dashboard editor's version 1 JSON schema.

The dashboard list supports create and native navigation. A dashboard supports rename, delete, widget add/reorder/remove, clock settings and note editing through native forms and sheets. State lives in the app's Application Support/Ellie/dashboardsv1.json container. Files import validates the 128 KB bound and complete schema before replacing local state; Files export writes the same browser-v1 schema. The app does not inspect browser storage or coordinator credentials.

For an attended physical-iPhone development setup, run `bun run ios:doctor` on the Mac that will build and connect to the phone (`--json` emits only status codes and counts). It checks the effective full-Xcode selection and iPhoneOS SDK, visible Apple Development identities, and CoreDevice observations of an iPhone, pairing, and Developer Mode. It does not unlock a Keychain, sign, build, install, or change device settings. Exit code 0 means the limited observations were available; 1 means a prerequisite is missing or unknown, and 2 means invalid usage. A favorable `observed` result does **not** verify an app-specific provisioning profile, an unlocked phone, a successful build/install, or working microphone and Local Network permissions. `DEVELOPER_DIR` may select a specific Xcode for this command without changing global `xcode-select`. See Apple’s [physical-device setup](https://developer.apple.com/documentation/xcode/building-and-running-an-app) and [Developer Mode guidance](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device) for the attended steps.

Build and test with full Xcode:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project apps/ios/EllieIOS.xcodeproj -scheme EllieIOS -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/test-ios.mjs
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bun run test:ios-ats
```

The Xcode project creates the iPhone-only `org.ellie.dashboard.ios` app. These commands do not install on hardware or request a signing identity.

The app-hosted transport and Keychain runner creates its own simulator, temporary loopback HTTPS certificate and private credential test namespace. It checks the production transport, wrong pin and hostname rejection, and the built app's narrowly scoped `NSAllowsLocalNetworking` policy. TLS 1.2 or later, the exact pin, SSL hostname and certificate validity are still enforced by the client. The app does not enable arbitrary loads. Apple documents the local networking policy in [NSAllowsLocalNetworking](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking). Failure reports remain in `test-results/native-ios-ats.xcresult`; successful runs clean only their owned temporary resources. This simulator workflow does not validate physical-device Local Network or Camera consent.

## Native enrollment protocol foundation

The coordinator now has a separate native-app authorization lifecycle. A controller can issue a ten-minute, single-use `native_phone_controller` invitation with explicit `app.open` grants for named nodes. The QR payload uses the versioned `ellie-native:v1:` format and binds the invitation to the exact HTTPS origin and the SHA-256 digest of the listener's actual leaf-certificate DER. Native session tokens use a separate bearer channel, domain-separated hashes, a bounded 90-day lifetime and independent list, logout and revocation operations. They never authenticate as a browser, node or controller.

The native client generates and persists its candidate session token before the pairing POST. If the response is lost, an explicit read-only `GET /native/v1/session` request can determine whether pairing committed, including after relaunch; the client must not replay the POST automatically. If the local credential is later removed or lost, the server may retain an orphaned session until it expires or a controller revokes it. A new device without that credential requires a new invitation. A changed origin or certificate also requires explicit re-enrollment; the client must never rotate either silently.

The iOS client provides a user-started camera flow, an explicit confirmation screen, pinned native transport and app-specific Keychain storage. Camera capture stops after a code, cancellation, backgrounding or a 60-second timeout. The client treats the exact leaf as a local trust anchor only for that request, while still enforcing its SHA-256 pin, SSL hostname and certificate validity; it does not install a CA or change the system trust store.

After confirmation, the app generates the candidate credential and atomically stores one versioned, device-only Keychain envelope with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. Pending state contains the candidate, confirmed origin and pin, label and grants. It never contains the QR or invitation. The invitation remains in memory for one pairing POST. An uncertain result retains pending state and offers only the read-only session recovery request. The app never replays pairing automatically. Confirmed pairing atomically replaces pending state with the active native credential. Logout retains local authority when its result is uncertain and reports that the action may have happened.

## Enrollment wire surfaces

Controller management uses the coordinator API and its existing controller bearer authentication. These routes are included in `contracts/openapi.v1.json`:

- `POST /v1/native/invitations` accepts an exact `{label, grants}` JSON object and returns the fields encoded into the QR.
- `GET /v1/native/clients` lists active native clients without credentials.
- `POST /v1/native/revoke` accepts an exact `{id}` JSON object and revokes that client.

The canonical QR envelope is bounded to 2,300 ASCII bytes so it remains below the terminal renderer's level-M byte capacity. Its decoded JSON and native listener request bodies are bounded to 4 KiB. The QR's exact origin identifies a separate native HTTPS listener. The listener requires the QR origin's exact `Host`, one `X-Ellie-Version: 1` header, no cookies, no browser `Origin` header and no `Sec-Fetch-*` headers. JSON requests accept one `Content-Type: application/json` header, optionally with UTF-8 charset. Its three version 1 routes are:

- `POST /native/v1/pair` accepts exact JSON `{invitation, token}` without authorization. Both values are 64 lowercase hexadecimal characters. `token` is the native client's candidate credential. Success returns `{client}` containing the public client record.
- `GET /native/v1/session` accepts the candidate as `Authorization: Bearer <token>` and returns `{client}` containing its public client record. This is the read-only recovery operation for an uncertain pair response.
- `POST /native/v1/logout` accepts exact empty JSON `{}` and the same native bearer. It revokes that session.

The listener routes deliberately do not inherit controller authentication and are not represented as coordinator operations in `contracts/openapi.v1.json`. The dedicated `contracts/native-openapi.v1.json` describes these implemented routes with their separate native bearer scheme. [The native API guide](native-api.md) covers generation, shared Swift/TypeScript fixtures and mutation uncertainty; the protocol parser and synthetic TLS integration tests remain runtime evidence.

The controller CLI exposes `native invite --label NAME --node ID --allow CAPABILITIES`, `native clients` and `native revoke ID`. `CAPABILITIES` is an explicit comma-separated subset of `app.open`, `browser.read` and `browser.control`; it cannot be empty or contain duplicates or unknown values. The Mac pairing sheet defaults to `app.open` and lets the controller select the same capabilities individually. Invitation creation validates the label, target, exact grants and maximum QR bytes before mutating invitation state. QR certificate material always comes from the listener's active leaf certificate. Speech transcription remains a separate post-enrollment grant.

The current development integration also includes granted app opening, separately granted push-to-talk, and explicit household dashboard synchronization. Enrollment still requires a controller-issued invitation and explicit confirmation; the app does not create household authority or reuse browser, node or controller credentials. App-opening grants do not imply speech or household-data access. See the [native API guide](native-api.md), [household authority contract](native-household-state.md), and [delivery queue](delivery-queue.md) for the implemented boundaries and remaining physical-phone and distribution acceptance gates.
