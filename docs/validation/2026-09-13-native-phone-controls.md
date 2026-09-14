# Native iPhone app controls — 2026-09-13

This slice adds explicit SwiftUI Mac/app selection and native app-opening requests through the separate enrolled phone credential. It builds on PR35. The controls do not use the browser interface, save a desktop action, or automatically retry a mutation.

## Recorded validation

- Node24/Bun full check passed 194 tests with one platform skip after the first native API implementation. Lint, formatting, generated-contract drift, type checking and browser compatibility build passed.
- The real synthetic HTTPS listener tests covered grant-filtered inventory, exact finite commands, no browser authority, revocation after asynchronous discovery, missing/offline/incapable devices, shared browser/native reservations, client disconnect before and after dispatch, discovery/command deadlines, retained reservations for a noncooperative upstream, and redacted unknown outcomes. Timers in the deadline tests were advanced deterministically; these are simulated network/scheduler conditions.
- The final initial Swift control-source run on the authorized MacBook/full Xcode passed 35 tests, including seven phone-control tests. Negative cases include numeric values masquerading as JSON booleans, duplicate or ungranted node IDs, unknown fields/capabilities, malformed result/error bodies, canonical pre-dispatch errors, cancelled inventory and immutable command selection. An earlier isolated-copy run omitted the shared contract fixtures and failed one existing fixture test; copying the fixtures resolved that failure.
- The generic iOS 18.2 Simulator build passed with signing disabled.
- A separate temporary, distinctly identified iOS test app hosted the production PhoneControlView with an injected synthetic transport. One UI workflow passed in 21.313 seconds on a dedicated iPhone16/iOS18.3.1 simulator: initial Open disabled; explicit refresh; target and Messages selection; completed result; a second explicit command waiting; Stop waiting yielding unknown/check-before-retry guidance; terminate/relaunch returning without a persisted result. Store tests separately verify zero initialization calls and no automatic retry.
- The UI harness injected fixtures only into its temporary source copy. No test switch, fake credential or fixture target was added to the shipped app. Owned simulator/source/DerivedData resources were removed; logs and the result bundle were retained outside the checkout.

## Service lifecycle wiring

The final service bridge adds lazy acquisition of the existing controller identity only when the optional client listener is configured. Tests cover one bridge instance, listener failure cleanup, shutdown during delayed credential loading and cleanup of its eventual result, dynamic bounded registered inventory, finite commands and propagated cancellation. Full Node24/Bun checks passed 198 tests with one platform skip after this wiring. These runtime tests use injected secret stores and clients; they do not access the installed service or Keychain.

## Actual Swift-to-Node interoperability

The five-test app-hosted iOS ATS/Keychain suite was extended to run the production Node `createBrowserServer` with in-memory native/browser auth and a finite simulated execution Mac. The real iOS `PhoneControlTransport` recovered its session, fetched granted nodes, issued one Safari command, rejected an ungranted target locally, logged out through the actual server, and rejected a subsequent read with the revoked credential. Server counters confirmed exactly two inventory reads (listing and pre-dispatch validation) and one Safari dispatch. The exact pin and hostname rejection, four isolated Keychain tests and built app ATS-policy assertions remain present.

The final isolated MacBook/full-Xcode run exited successfully; the Xcode test phase took 9.218 seconds. An initial async assertion compile error in the new test was corrected before two complete successful harness runs. Owned simulator/source/certificate/derived resources were cleaned. This is real Swift-to-Node HTTPS interoperability in a simulator, with simulated desktop execution; it is not physical iPhone or household LAN acceptance.

## Acceptance limits

No physical iPhone enrollment, camera or microphone, default Keychain identity, installed coordinator/node service or household desktop action was exercised by the tests above. Simulator UI uses a synthetic transport; real Node HTTPS server tests use a synthetic execution target. Native Local Network consent and signed physical-phone distribution remain separate gates. A published change is not a live deployment.
