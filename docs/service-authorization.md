# Service manifest authorization envelope

`ellie-service-installer inspect-authorization RELEASE AUTHORIZATION_APP --publisher-team-id TEAMID`
is a read-only public-distribution foundation. `TEAMID` is an independently supplied, exact
ten-character uppercase ASCII Apple Team ID. The candidate cannot provide the trusted Team ID,
code requirement, component identifier, or policy format.

The command requires a Developer ID Application signature satisfying the fixed Ellie authorization
bundle identifier, Apple certificate chain, supplied Team ID, strict validation, and all-architecture
validation. Its signed resource seal must contain required SHA-256 entries for the exact bounded
`manifest.json`, `SOURCE.txt`, and canonical `authorization.json` resources. Those sealed bytes must
equal the separate release files byte for byte. The authorization record binds their SHA-256 values
and a canonical digest of the trusted policy inputs.

Success returns an `AuthenticatedEnvelope`. It does not parse or verify the payload inventory, does
not authorize installation, and does not change staging, selection, recovery, receipts, launchers,
services, or credentials. Existing development inspection remains a separate explicit policy. A
later atomic change must verify the full release and bind the authorization version, policy digest,
and manifest digest through receipts, recovery evidence, selection, and launch before this can
authorize production installation.

The verifier rejects ad-hoc signatures in production. Tests use a compile-time-only explicit switch
that relaxes only the Developer ID requirement; Security.framework still validates the ad-hoc test
bundle and its resource seal with strict and all-architecture flags. The shipping binary does not
recognize that switch. Tests do not establish Developer ID, notarization, Gatekeeper, or distribution
channel acceptance.

This slice reads an owner-controlled bundle after static-code validation. It checks descriptors,
identity, modes, links, sizes, exact bytes, and hashes. The returned envelope contains copied
manifest and source bytes so a caller does not need to reread the candidate. The policy digest binds
the complete fixed requirement text, scope `manifest-envelope`, `payloadVerification` value
`not-performed`, required resource names, SHA-256 algorithm, and strict all-architecture signature
semantics. It does not claim a descriptor-relative, atomic snapshot of a bundle concurrently changed
by an attacker who already controls the owning account. The verifier holds the opened bundle and
rejects a final path rebind to a different device or inode, which narrows but does not eliminate that
path-based Security.framework limitation. A future installer transaction must use an owned immutable
capture and revalidation strategy before mutation.

## Validation — 2026-09-14

The focused native test compiles both production and test-only installers and passed 1/1. It covers
an actual ad-hoc sealed bundle through Security.framework, production rejection of that bundle,
exact returned byte counts and hashes, policy changes when requirement text changes, a substituted
final bundle inode, canonical-path aliases, exact Info.plist package type, external and sealed byte changes,
canonical record shape, Team ID grammar, symlink rejection, and direct CodeResources parser cases
for optional resources, unknown resources, and incorrect SHA-256 data. Every test-created external
command has a 15-second deadline. This does not test a Developer ID identity, notarization,
Gatekeeper, installation, payload inventory, receipts, or concurrent hostile filesystem mutation.

The final reviewed source passed the complete repository gate on the physical Mac mini: 306 tests
passed, one skipped, with lint, formatting, contracts, type checks and the web build passing. The
retained log is `ellie-service-authorization-root-final-check.log`. These tests use synthetic owned
fixtures, including the native signature checks; they do not exercise the installed household stack.

A preceding unchanged-source CI run exceeded the lifecycle fixture's 20-second aggregate test
deadline before the app tests ran. That budget includes Swift compilation, signing and deliberately
slow operation probes. The follow-up gives that one aggregate test 30 seconds while preserving
every product deadline and assertion; its focused Mini run passed in 9.312 seconds. The failing CI
record does not identify an individual slow operation or prove a product lifecycle failure.
The complete final gate also passed 306 tests with one skip after this correction, plus lint,
formatting, contracts, type checks and the web build. Its retained log is
`ellie-service-authorization-lifecycle-final-check.log`.
