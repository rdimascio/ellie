# Browser pairing integration validation — 2026-09-12

This record covers optional coordinator browser startup, management CLI/API, static pairing assets,
and the pairing page. Automated, physical LAN, and attended iPhone results are separated below.
The checks did not change the running household services or identities.

- On a physical Apple silicon Mac, Node 24 and Bun 1.4.2 passed lint, formatting, generated contract
  drift, both TypeScript projects, 142 Node tests with one platform-specific skip, and the UI build.
  Tests use temporary files, synthetic identities, injected secret stores, and loopback sockets.
- Real HTTPS integration used distinct generated agent and browser certificates, an explicitly
  trusted synthetic CA, exact hostname/SNI verification, and the configured Host/Origin. It covered
  controller invitation, browser cookie session, controller revocation, rejection of the revoked
  session, durable reopen, and exclusive coordinator ownership. No TLS verification was disabled.
- Fault tests covered optional identity/assets/auth/listener failures, slow startup interrupted by
  shutdown, authorization persistence drained before lock release, corrupt or unsafe files, and
  credential/Origin separation. The coordinator remained available when browser startup failed.
- Chromium passed 33 browser checks across emulated phone, laptop, and TV viewports: 15 existing
  synthetic dashboard checks and 18 pairing checks. Pairing checks covered successful connection,
  lost pairing responses, failed or malformed logout responses, outage/revocation recovery, role
  presentation, code handling, and a 320 px viewport. API responses in these UI checks were mocked.
- The built pairing dependency set was loaded successfully and excluded the synthetic demo entry.
  Rendered phone, laptop, and narrow screenshots were visually reviewed; screenshots remain local.

The automated slice made no live Keychain calls, installed no trust, replaced no service, and
performed no household command, physical phone interaction, or inference test. Existing hardware
inference and service evidence remains in its separate dated records. Subsequent attended phone
results appear below; target TV acceptance remains pending under the
[phone acceptance and rollback procedure](../browser-pairing.md).

## Bounded physical LAN check

A subsequent check used a Node 24 HTTPS client on a physical MacBook and the candidate browser
listener on a physical Mac mini over their household LAN. The listener used an isolated temporary
coordinator, its own JobStore lock and authorization state, in-memory keys, and a temporary public
CA. The existing household coordinator and node continued running.

The peer resolved the mini's actual `.local` hostname, verified its TLS identity against the
explicitly supplied test CA, loaded the pairing HTML and three referenced script/style assets,
observed an unauthenticated session rejection, and paired a zero-grant shared-display identity.
The returned cookie carried Secure, HttpOnly, and SameSite=Strict attributes. Session access
succeeded, invitation replay and an agent route were rejected, and a controller revocation made
the next peer session request return 401. The temporary client supplied the cookie explicitly;
this was not a browser cookie-policy or Safari trust-store test.

Before/after snapshots of the existing Ellie configuration, certificates, authorization files,
installed helper, and listed service processes matched on both Macs. The harness stopped and
removed temporary runtime credentials and state; port 8444 was free afterward. The test installed
no certificate or trust profile and performed no household action. This LAN check preceded the
attended iPhone check below. Private hostnames, credentials, and detailed reports stay outside the
repository.

## Attended physical iPhone check

The operator tested the pairing page in Safari on a physical iPhone against candidate `cd55256`
using the same isolated Mac mini harness and a fresh temporary certificate. A profile containing
exactly one public root certificate was validated locally, copied to the operator's MacBook through
authorized SSH with a matching file hash, and transferred to the phone by AirDrop. The operator
reported installing the profile and enabling full certificate trust on the phone.

The operator then reported successful pairing, retention of the paired state after refreshing the
normal Safari tab, and a pairing prompt in a private Safari tab. An authenticated controller query
independently confirmed exactly one active shared-display session with no operation grants. The
controller revoked that specific session and confirmed that no active browser clients remained.
The operator reported that refreshing the original normal tab returned to the pairing prompt.
These phone observations were reported by the operator, not obtained from a simulator or automated
control of Safari. The phone model and iOS version were not recorded.

The temporary server shut down gracefully. Its runtime credentials, authorization state and lock
were removed; port 8444 was verified free. The transferred MacBook profile file was removed after
checking its ownership and hash. Removal of the installed phone profile and its trust entry is
still awaiting operator confirmation. Existing services, helpers and Keychain items were not used
or replaced by the isolated harness.

This supplies bounded physical evidence for manual profile setup, pairing, refresh persistence,
private-tab isolation and revocation. It does not validate production browser Keychain/service
installation, phone operation grants, actual household controls, target TV behavior, QR scanning,
or certificate-policy edge cases.
