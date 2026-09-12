# Browser pairing acceptance

This developer slice pairs a browser and displays its own revocable identity. Household data and
commands remain unavailable. An attended physical iPhone check covers manual profile setup,
pairing, refresh persistence, private-tab isolation and revocation; see the
[dated validation record](validation/2026-09-12-browser-pairing.md). Production browser service setup
and target TV acceptance remain pending. The [session boundary](browser-sessions.md) and [TLS setup](security.md) describe the
separate credentials and certificate identity.

## Coordinator preparation

Use Node 24 and Bun 1.4.2. Build the UI with `bun run demo:build`. The current native helper needs
browser Keychain presence/add/delete support. `bun run build:macos` replaces the installed helper
and may require fresh Keychain consent: do not run it during an existing installation's preservation
test. Such a test should use a private temporary helper through the injectable
`BrowserSetupEnvironment.secrets`, limited to the two new browser Keychain accounts. Existing agent
credentials must continue through the installed helper.

On a prepared installation, run:

```sh
bun run ellie browser init
bun run ellie browser status
bun run ellie browser export-ca /absolute/private/output/ellie-browser-ca.pem
bun run ellie service stop coordinator
bun run ellie service start coordinator
bun run ellie browser connection
```

Initialization alone starts no listener. The next coordinator start enables browser port 8444 if
the identity and built assets validate. It uses the same bind address as the agent coordinator; a
loopback-only coordinator remains loopback-only. Use the exact persisted `.local` hostname shown by
`browser connection`, including port 8444. Hostname drift or expired identity fails closed; do not
use an IP, bypass a TLS warning, or rotate the agent certificate to repair browser trust.

`browser connection` distinguishes disabled, identity, assets, authorization, and listener failures.
`service logs coordinator` records only fixed browser-ready/unavailable startup event names.
The existing agent listener stays available if optional browser setup fails.

## Pair and revoke

The first physical trust check should use a zero-grant shared-display invitation:

```sh
bun run ellie browser invite tv --label "Test display"
bun run ellie browser clients
bun run ellie browser revoke CLIENT_ID
```

`CLIENT_ID` is the real ID returned by `browser clients`. Invitations are issued only by the
authenticated controller. Their displayed codes work once and expire after ten minutes. The CLI displays a QR code with the same invitation, plus a manual fallback code. Show it
privately to the intended device; anyone who can scan or copy it can consume that invitation.
Keep codes and QR captures out of URLs, issues, logs and shared screenshots.
Session revocation is durable. Unused invitations currently cannot be listed or revoked: issue one
only when the recipient is ready, and let it expire if pairing is abandoned. An interrupted invite
may have persisted even if its code was lost; wait ten minutes before issuing a replacement.

### Scan the QR code

First open the exact trusted HTTPS origin reported by `browser connection` on the phone. On the
pairing page, tap **Scan QR code**, allow camera access, and point the phone at the QR displayed
in the coordinator's terminal. Use Ellie's in-page scanner; the QR contains a versioned invitation,
not a web address for the standalone Camera app. If scanning is unavailable, the manual code
field remains available. Certificate installation and trust are still separate attended steps.

The scanner reads frames locally with a bundled decoder. It sends only the decoded invitation
through the existing pairing request; it never uploads or stores camera images, places an
invitation in a URL, or grants additional authority. Camera access starts only after tapping Scan.
Tracks stop on a successful read, cancellation, leaving or hiding the page, errors, or a one-minute
limit. Denied or unsupported camera access returns to manual entry. A lost pairing response checks
the session and never repeats the pairing request automatically.

Keep the entire QR and its white border visible. Increase terminal text size if needed. A QR uses
the same one-time, ten-minute invitation as its manual fallback; it is not a reusable login.
Physical iPhone camera scanning and target TV camera/manual behavior still require acceptance.

Phone invitations require explicit `--node ID --allow app.open,url.open` grants alongside
`browser invite phone --label NAME`. These reserve authority for future routes; this version exposes
no household operation even for a phone role. TV invitations reject those options.

The page checks its session after an uncertain pairing or logout response, never repeats a mutation
automatically, and retries read-only connectivity with an eight-second timeout and capped backoff.
Hidden pages stop polling; returning to the page or reconnecting checks the session. Codes are
cleared on submission and remain absent from browser storage and URLs.

## Physical phone check and rollback

Before a preservation-focused test, record existing config/certificate/helper/service hashes,
service health, node freshness, and idle job state privately. Build only a temporary helper, export
only the public CA, and verify exact-hostname TLS locally using that CA. Keep the current service
checkout, plist, and app unchanged. The coordinator lifetime lock forbids a second coordinator, so
use a bounded temporary GUI LaunchAgent handoff with guaranteed restoration of the original service.

Transfer the public CA through an already trusted channel. iPhone profile installation and full TLS
trust require the device owner's consent; [Apple's trust instructions](https://support.apple.com/en-au/102390)
explain that installing a profile alone does not enable SSL trust. Recognition of the PEM export by
iOS is not yet proven; if it is not recognized, stop and prepare a public-only supported certificate
artifact. Do not disable device protections or bypass warnings. Approve local-network access only
if the phone prompts for it.

Open the exact HTTPS origin in Safari, confirm there is no warning, pair the zero-grant identity,
refresh to verify the secure cookie, and confirm a private Safari session is unauthenticated.
Disconnect in the page and verify the client is absent through `browser clients`. If the response
is uncertain, inspect and explicitly revoke the session. No desktop command is part of this test.

Stop the temporary candidate, restore the original coordinator, and recheck agent health, node
freshness, and the recorded hashes. Remove temporary harnesses, helper, LaunchAgent, and public
export. Leave successfully created browser-only state inert for later use; there is no supported
reset command, and partial or uncertain state must be preserved for diagnosis. Remove the validation
certificate profile from the phone and confirm its full-trust entry disappears. Keychain, firewall,
profile, passcode, and trust prompts remain attended OS interactions.

## Automated scope

`bun run check` exercises temporary authorization files, mocked runtime failures, real loopback
HTTPS with synthetic CA verification, controller invitation through browser pairing and revocation,
coordinator availability during browser failure, and exclusive state ownership. It builds the UI.
`bun run demo:test` adds synthetic browser responses at phone, laptop, and TV viewports in Chromium,
plus manual and QR pairing at phone size in WebKit, including
interrupted pairing/logout, reconnects, revocation, code handling, and a 320 px layout.
These tests never install trust, access Keychain, alter a live service, or execute a desktop action.
