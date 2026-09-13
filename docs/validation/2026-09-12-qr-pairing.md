# QR browser pairing validation — 2026-09-12

This slice displays an existing single-use browser invitation as a terminal QR and scans it
locally from the trusted pairing page. It preserves the manual code fallback, authorization roles
and grants, expiry, cookie policy, and no-retry pairing behavior. The prior attended manual iPhone
check is recorded separately in [browser pairing validation](2026-09-12-browser-pairing.md).

## Automated and local checks

- On an Apple silicon Mac with Node 24 and Bun 1.4.2, `bun run check` passed lint, formatting,
  generated-contract drift, both TypeScript projects, 146 Node tests with one platform skip, and
  the UI build. Follow-up type and build checks passed after adding the decoder license notice.
- The full Chromium suite passed 57 checks across emulated phone, laptop and TV viewports. This
  includes 24 QR checks using synthetic camera streams and mocked API responses. The focused
  24-check QR suite passed again after strengthening the camera-before-POST assertion.
- Follow-up WebKit 26.6 checks passed all 14 manual and QR pairing cases on macOS with an emulated
  phone viewport. The expanded regular browser suite passed 71 checks; CI now includes that
  WebKit project. Camera cleanup
  assertions inspect each retained track's actual `ended` state instead of replacing its `stop`
  method. This verifies cleanup across both engines, including before the pairing POST.
  The keyboard check uses macOS WebKit's Option-Tab navigation for links, as described in
  [Apple's Safari shortcuts](https://support.apple.com/en-gb/guide/safari/cpsh003/mac).
- A separate private QR candidate harness passed strict loopback TLS and page readiness, then
  stopped and removed its temporary runtime. It used memory-only keys and no installed identity,
  helper, Keychain item or LaunchAgent. Its preflight certificate artifacts are stale and must
  not be installed; an attended phone session requires a fresh active harness and profile.
- QR tests render real encoder output into camera frames and run the production decoder under
  the browser listener's CSP and Permissions Policy. They cover a single pairing POST, camera
  shutdown before that POST, response-loss recovery without resubmission, rejection of URL QR
  contents, permission denial with manual fallback, late camera permission after cancellation,
  hidden-page cleanup, the one-minute scanner limit, and no camera request for a paired page.
- Tests reconstruct the actual terminal half-block output, verify its four-module white border,
  and decode it back to the exact invitation envelope. The encoder library's compact terminal
  renderer ignores its margin option, so Ellie renders the encoder's module matrix itself.
- The actual built pairing dependency set loaded within its existing limits: six assets totaling
  1,459,209 bytes, with the synthetic dashboard excluded and the decoder's Apache license included.
- Phone and narrow pairing screenshots and the active scanner screen were visually reviewed.
  Screenshots use synthetic fixtures and remain local. No household identifiers, credentials,
  camera captures or invitation images were added to the repository.

## Attended iPhone QR check

The operator reported installing and trusting a fresh public certificate profile, then connecting
after instructions to scan inside Ellie in Safari. The QR was displayed as a PNG in Preview on
the MacBook. An authenticated query to the isolated coordinator independently confirmed exactly
one paired browser with the TV role and no household-action grants.

The operator then reported that the camera indicator turned off and refreshing Safari kept the
phone connected. These are user-reported physical observations, separate from the automated
camera tests. The temporary client was revoked through the controller, and a second query
confirmed zero clients. The matching harness was stopped gracefully; its runtime, lock and
listener were removed. Both matching files transferred to the MacBook were removed after
ownership and hash checks. Removal of the latest test profile from the phone is awaiting the
operator's confirmation.

An earlier QR attempt expired without a reported scan result; the coordinator had zero clients
at its last observation. That attempt is not counted as successful camera acceptance.

## Remaining hardware limits

The iPhone model and iOS version, explicit absence of TLS warnings, and rear-camera selection
were not separately recorded. The optical check used a QR image, so it does not validate reading
the terminal's rendered QR on hardware. TV camera behavior, production Keychain setup, installed
service replacement and household actions were not tested. The isolated harness used memory-only
keys and synthetic controller state and preserved existing household services and identities.
