# Validation

## Automated

`npm run check` runs strict TypeScript checking and Node tests for deterministic command mapping, safe input rejection, capability and allowlist enforcement, isolated private state, hashed credentials, invitation expiry/single use, pinned HTTPS, peer isolation, command timeouts, context updates, and actual server/node round trips with a simulated native executor.

No model, cloud API, microphone, browser session, or personal fixture is required. Tests generate ephemeral test credentials and certificates in memory/temporary directories, and delete their fixture state after completion. No private key fixture is committed.

On macOS, `npm run build:macos` compiles and ad-hoc signs the production helper. The CI geometry job additionally compiles the pure coordinate/tiling functions with `tests/GeometryTests.swift`; it covers primary, above, below, and negative-coordinate screens. These tests cannot verify Accessibility consent or a real application's window behavior.

## Manual acceptance on physical Macs

After the README setup, check each row. This is a manual checklist, not a record of a completed hardware test.

| Step | Expected behavior |
| --- | --- |
| Start server and paired node | Node reports ready; server lists its opaque ID |
| `Ellie, open Arc` | Installed Arc opens/activates; client receives success |
| `put it in the top-left` | Arc's target window occupies the usable top-left quarter |
| `open Netflix` | Arc opens the configured HTTPS site using its existing browser profile |
| `move Arc to the big monitor and make it fullscreen` | Arc moves to the largest logical display and enters native fullscreen |
| `put Messages next to it` | Arc leaves fullscreen; Arc left and Messages right on that display |
| Move a display above or left in macOS settings | Repeated placements use the correct screen and coordinates |
| Disable Accessibility and restart node | App opening remains available; window tools are unavailable |
| Enter an incorrect server fingerprint during pairing | No pairing credential is sent; pairing fails |
| Stop the node during a command | Failure/timeout is explicit; reconnect does not replay the action |
| Revoke the node | Subsequent authenticated requests fail |
| Try an unrecognized sentence or a shell fragment | No native action occurs |

macOS can constrain sizes, delay Space transitions, or limit operations on minimized, modal, and unusual windows. Use a standard non-minimized window for first validation. Report OS/app versions and sanitized behavior, without sharing live config, node output, certificate material, or private paths.
