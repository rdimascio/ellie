# Repeatable iPhone testing

The phone-control demo has user-reported physical acceptance. The exact command and keyboard dictation were not separately recorded. Existing Chromium/WebKit automation is simulated browser coverage, not proof of iPhone microphone, camera, certificate settings or native playback behavior.

## Supported paths

- **Safari WebDriver:** Apple supports automating Safari on a connected, trusted iPhone. Enable the Mac's Safari remote automation and the phone's Safari Advanced → Remote Automation setting; connect and unlock the phone for session creation. WebDriver sessions use isolated browser storage, so issue a new one-use invitation for each run. Use `platformName: iOS` and an explicit device target to avoid silently testing desktop Safari. Source: [Apple/WebKit](https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/).
- **Certificate installation:** manually downloaded profiles need an explicit SSL trust step. Apple Configurator or MDM-installed certificate payloads are automatically trusted for SSL. Configurator provides `cfgutil` for scripting on a connected device. First verify the exact certificate fingerprint and target, and install only the intended public CA profile. This does not justify device supervision, erasure or MDM enrollment. Sources: [Apple certificate trust](https://support.apple.com/en-ca/102390), [Configurator automation](https://support.apple.com/en-ie/guide/apple-configurator-mac/cad935fc6678/mac).
- **iPhone Mirroring:** useful for attended Settings and UI work after the phone unlocks and connects, but camera and microphone are unavailable through Mirroring. It cannot validate spoken input or QR optical capture. Source: [Apple Mirroring](https://support.apple.com/en-gb/guide/iphone/iph505911a40/ios).
- **Xcode/XCTest:** use paired physical devices for native app tests and simulators for broad regression checks. Simulator results do not establish physical device behavior. Source: [Apple device testing](https://developer.apple.com/documentation/Xcode/running-your-app-on-simulated-or-physical-devices).

Use a persistent private development CA for repeat sessions; do not rotate trust just to refresh a pairing invitation. Keep ephemeral CI CAs in isolated state and never reuse an expired demo's discarded keys. Do not disable TLS checks or automatically dismiss certificate warnings.

## Acceptance matrix

| Layer                   | Automate                                                                                                     | Separately verify                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Pure model and API      | Schema, role/grant denial, revocation, timeouts, cancellation, no replay, redaction                          | None claimed as hardware                                             |
| Chromium/WebKit         | Layout editing, session UI, fake audio/player/provider responses, offline and errors                         | iOS-specific differences                                             |
| iPhone Safari WebDriver | Real page load with trusted TLS, pair by one-time code, selected target, one app request, refresh and logout | Camera QR, keyboard dictation, microphone consent and actual audio   |
| Physical Mac execution  | Pinned coordinator/node request, native success, cancellation and restart states                             | Visual result where meaningful; native cancellation may be uncertain |
| Configurator/Mirroring  | Profile delivery and supported settings interactions                                                         | Unlock/passcode/first trust and any OS restriction encountered       |

Do not put invitation codes, cookies, recordings, mail/calendar content or device identifiers in CI screenshots or logs. Use private bounded artifacts locally and publish only sanitized acceptance results. Cleanup should close the test session, revoke its browser identity and remove disposable artifacts; keep an intentionally persistent development CA until its owner requests removal.

## Runnable physical Safari smoke check

Run `node scripts/phone-smoke.mjs --config /absolute/private/test.json` on the Mac hosting Safari WebDriver. Start `/usr/bin/safaridriver --port 4444` after enabling Safari remote automation; the runner connects only to a literal loopback driver and does not enable permissions itself. On current iOS the Safari settings may be under **Settings → Apps → Safari → Advanced**. Apple documents both Web Inspector and Remote Automation as prerequisites.

The configuration and invitation files must be private regular files owned by the caller, mode `0600`, outside the repository. An example with synthetic values:

```json
{
  "driverOrigin": "http://127.0.0.1:4444",
  "origin": "https://ellie-example.local:8444",
  "deviceId": "REPLACE-WITH-CONNECTED-DEVICE-ID",
  "invitationFile": "/absolute/private/fresh-invitation.json"
}
```

Use a phone-controller invitation generated by the existing management CLI. By default the runner pairs through the page, verifies connection after refresh, and disconnects without issuing a desktop command. To test one real action, add both `"nodeId": "explicit-node-id"` and `"app": "arc"` (or `safari` / `messages`). The invocation opts into that action. The node must already be granted and online.

The runner explicitly requests a physical iOS Safari session and secure certificates, checks that navigation remains on the trusted origin before entering a code, and rejects desktop fallback. It never retries the app click. Its bounded JSON report excludes the code, device ID, origin and page content. If pairing may have succeeded but logout was not confirmed, revoke that temporary browser identity from the coordinator. Delete the consumed invitation file after the run; the runner does not delete caller-owned files. Terminate the manually started WebDriver listener when finished.

Five fake-driver regression tests cover private-file checks, configuration boundaries, pairing/refresh/logout, exactly one app click, unknown outcomes, wrong platform, redirection before credential entry, malformed/oversized responses and session cleanup. The physical-device runner has not yet been executed against an attached iPhone. Real optical QR, dictation and microphone tests remain separate.
