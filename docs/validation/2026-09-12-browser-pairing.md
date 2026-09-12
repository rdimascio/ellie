# Browser pairing integration validation — 2026-09-12

This record covers optional coordinator browser startup, management CLI/API, static pairing assets,
and the pairing page. It does not establish physical phone or TV acceptance and did not change the
running household services or identities.

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

No live Keychain calls, trust installation, service replacement, household command, physical phone
interaction, or inference test was performed for this slice. Existing hardware inference and
service evidence remains in its separate dated records. Safari certificate import/trust, physical
cookie persistence, and target TV behavior remain pending under the
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
no certificate or trust profile and performed no household action. Physical iPhone and TV
acceptance remain pending. Private hostnames, credentials, and detailed reports stay outside the
repository.
