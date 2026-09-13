# Household-state validation — 2026-09-13

This backend is an isolated development slice based on the native integration at `88d1568`. The branch was pushed before implementation. No installed household service, owner credential, personal document, Keychain item or physical-phone enrollment was used or changed.

## Coordinating review

Independent reviews covered storage/authorization and protocol/native compatibility. The initial check passed 218 Node tests with one existing platform skip. Review then found concrete gaps that were corrected before publication:

- A request could expire while waiting for the household mutation queue. Authorization is now rechecked inside that queue while preserving native revocation ordering.
- A serialized-file capacity rejection could poison the store. The limit is now checked before persistence; rejecting an oversized candidate leaves the existing state usable.
- Grant listing after store close was allowed. Closed stores now reject listing and later work, with shutdown-drain coverage.
- The new TypeScript document validator differed from the Swift schema in identifiers, widget configuration, optional completion dates and other values. Shared cross-language fixtures now check actual native decoding rather than assuming the schemas agree.
- The generated household API shapes were too broad, and duplicate preconditions used the missing-header response. The contract and handler now distinguish exact shapes and malformed versus missing preconditions.
- Uncertain CLI authority changes now give read-only listing guidance and make exactly one mutation request; arbitrary upstream error details are not printed.

## Final validation

- Full Node 24/Bun check: **233 passed, zero failures, one existing platform skip** (234 tests). Lint, formatting, generated contracts, type checking and the browser compatibility build passed.
- Independent storage re-review: **14 focused tests passed**, including expiry while queued, revocation ordering, authority/document persistence failure, capacity recovery, shutdown drain, unsafe file types/permissions and global row limits.
- Shared schema fixtures: **two valid and nine invalid document fixtures** passed the TypeScript checks and an actual full-Xcode Foundation decoder test on the MacBook. That focused Swift test passed; its unique source copy was removed. The unchanged native app suite was not repeated.
- After final OpenAPI-only additions for ETag, UTF-16 limits and request-channel details, **10 contract/protocol tests passed**, with lint, formatting, types and contract-drift checks repeated successfully.

The first combined review check stopped at a lint rule for an intentional control-character regex. A narrowly documented suppression was added to the Foundation whitespace expression; the complete check above then passed. Earlier in-progress protocol type errors were resolved before that final check.

Timezone compatibility is verified for representative IANA and Foundation-style GMT offset values. This record does not claim an exhaustive comparison of every Foundation/Node ICU timezone alias.

## Actual local HTTPS integration with synthetic clients

The integration test uses the production `createBrowserRuntime`, durable native/household stores, `createEllieServer`, pinned controller `Client`, and the actual household CLI parser/command handlers. Only the configured listener's bind port is redirected to a kernel-selected loopback port. Secrets are held in a test-owned memory store; no OS Keychain is involved. Both HTTPS servers use freshly generated test certificates and normal certificate verification.

Two native clients enroll through the actual listener. The test grants their data permissions through the controller CLI handlers, writes and reads shared/private documents, and checks default denial and isolation. It destroys one connection after the server commits but before the success response is sent. A subsequent GET finds the saved revision without a repeated PUT. A stale second-client write receives a privacy-preserving conflict response.

The dedicated runtime is stopped and reopened against the same private test directory. Both client authentication and document contents survive. Data-grant revocation removes only the intended document access; session revocation then denies private reads. Request counts show four explicitly issued document writes, zero execution calls and an empty desktop-job ledger. The test closes its listeners and removes only its owned temporary directory.

This exercises CLI command handlers over real local TLS; it does not invoke the installed `ellie` entry point or its Keychain loader. These are synthetic process-level tests, not physical household command, sleep/wake, microphone, camera or two-device native UI acceptance. Native synchronization views remain a later slice.
