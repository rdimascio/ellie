# Node 24 hardened-runtime validation — 2026-09-14

This validation checks whether the exact official macOS arm64 Node 24 archive used by the Ellie
service payload can run a bounded representative workload after an isolated copied `node` executable
is ad-hoc signed with hardened runtime and only these exceptions:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

Run from a clean source checkout on an arm64 Mac with Xcode command-line tools and OpenSSL:

```sh
node scripts/test-node-hardening.mjs \
  --node-archive /absolute/path/node-v24.21.0-darwin-arm64.tar.xz \
  --node-sha256 6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe
```

The harness verifies the archive checksum and shape, extracts only its Node executable into a new
private temporary root, ad-hoc signs that copy, and verifies the strict signature, hardened-runtime
flag, identifier, and exact entitlement keys. It then runs V8 warmup, a worker thread, SHA-256,
dynamic standard-module import, and an ephemeral loopback TLS exchange. Inputs and certificates are
synthetic. The child environment has an owned HOME and temporary directory and excludes inherited
Node injection variables and Ellie configuration.

Every external tool and workload is a retained direct child with bounded output, TERM/KILL deadlines,
and read-only process-group absence verification. The harness removes its exact owned root only after
all children are reaped and no group member remains; otherwise it reports and retains that root.

Passing this harness establishes only local ad-hoc hardened-runtime compatibility for this workload.
It does not establish Developer ID identity, same-team library validation, secure timestamps,
notarization, stapling, Gatekeeper acceptance, native add-on compatibility, or a real service launch.
Those remain separate public-distribution gates. No production builder or installer consumes this
validation automatically.

On 2026-09-14 the exact cached Node 24.21.0 arm64 archive and checksum above passed this
workload on a physical Mac mini (`Mac16,10`, arm64) running macOS 26.6.2. The copied executable's
observed signature was ad-hoc with hardened-runtime enabled and exactly the two entitlement keys
listed above. The owned temporary root was removed after all direct children were reaped. This is
local compatibility evidence for that machine and remains subject to the public-distribution limits
above.

The final reviewed harness passed eight focused regressions and the complete repository gate:
305 tests passed, one skipped, with lint, formatting, contracts, type checks and the web build passing.
The regressions use synthetic archives and finite child processes. They cover version mismatch,
oversized input members, the streaming extraction limit, TERM escalation, output overflow,
interruption, actual cleanup refusal with descendants, and semantic entitlement validation. The
plist conversion regression runs only on macOS; the pure dictionary checks run on every platform.
These source checks and the physical Mini workload do not exercise installed Ellie services.

## Explicit Developer ID mode

The harness also implements an explicit Developer ID validation mode by adding both
`--developer-id-sha1 CERTIFICATE_SHA1` and `--team-id TEAM_ID`. The certificate selector must be an
uppercase 40-character SHA-1 fingerprint supplied privately at invocation time; the independently
provided Team ID must be ten uppercase letters or digits. Neither value is stored in source.

This mode signs only the copied Node executable with the same two entitlements, hardened runtime,
the fixed `org.ellie.validation.node` identifier, and a secure timestamp. Verification requires all
architectures, an Apple-anchored designated requirement with the supplied Team ID and fixed
identifier, a Developer ID Application chain, an observed timestamp, and the exact semantic
entitlement dictionary. Ad-hoc signatures and missing timestamps are rejected in this mode.

The Developer ID signing subprocess is the sole isolation exception: it receives the validated
absolute caller HOME so `codesign` can use the caller's existing standard Keychain search list. Its
PATH, locale, and temporary directory remain fixed and isolated, and no other inherited environment
variables are admitted. Extraction, verification, certificate generation, and the Node workload keep
the owned HOME. Known missing-identity, disallowed-interaction, and timestamp failures are reported as
fixed classes without printing codesign output. The harness does not modify a Keychain search list or
ACL.

The final reviewed signed-mode source passed the complete repository gate: 310 tests passed, one
skipped, with lint, formatting, contracts, type checks and the web build passing. Thirteen focused
regressions cover the original isolation behavior plus option validation, signing environment,
requirement syntax, metadata rejection and redacted failure classes. The requirement syntax check
uses the actual macOS verifier with a synthetic publisher requirement; it expects rejection of an
unrelated system executable, not acceptance of an Ellie publisher.

Two authorized physical MacBook attempts on macOS 15.1 arm64 failed in the signature phase before
the Node workload ran. Read-only diagnosis after the first attempt showed that an owned HOME hid
the existing signing identity; the signing-only caller HOME exception above corrects that lookup.
The second attempt still failed. Fresh read-only Keychain status and explicit identity inventory
then established that the selected identity resides in the locked default Keychain. Both attempts
used an earlier shared `signature-create` stage for signing and verification, so their fixed failure
messages do not distinguish which of those commands failed. The final harness gives verification
its own stage for the next attempt. The final source gate is retained in
`ellie-node-developer-id-publish-final-check.log`; the failed physical run logs are
`ellie-node-developer-id-final-macbook.log` and `ellie-node-developer-id-reviewed-macbook.log`.

No successful Developer ID runtime acceptance, notarization or installed-service validation is
claimed. An owner unlock of the Keychain is required before another signing attempt. No password,
private key, Keychain ACL, search list or household service was changed. The earlier successful
ad-hoc Mini workload is evidence for its original reviewed source only.
