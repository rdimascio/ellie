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

## Hardware limits

No physical camera, iPhone QR scan, TV camera, production Keychain setup, installed service
replacement or household action was part of this slice. The earlier physical iPhone manual
pairing, refresh persistence, private-tab isolation and revocation results do not substitute for
camera acceptance. A later attended check must confirm Safari camera permission, rear-camera
selection and readable terminal size/contrast, then pairing and camera shutdown on the real phone.
