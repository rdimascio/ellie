# Authenticated payload inspection

`ellie-service-installer inspect-authenticated-payload RELEASE AUTHORIZATION_APP --publisher-team-id TEAMID`
is a read-only production-policy inspection boundary. It first authenticates the exact manifest and
source bytes through the separately signed version-1 authorization envelope, then accepts only a
closed manifest version 2 and verifies its complete payload inventory. Success returns distinct
envelope-policy, payload-policy, and manifest digests plus the release ID. It does not stage, select,
install, start, authorize, or update a service.

Manifest version 1 remains the development and stopped-migration format. Every version-2
`nativeCode.path` and `nativeCode.machOPaths` value is relative to the release's `payload/`
directory. Version 2 requires the
exact five native components and stable identifiers: Node (`org.ellie.runtime.node`), the installer
(`org.ellie.installer`), the helper (`org.ellie.helper`), and the coordinator and node launcher apps
(`org.ellie.assistant.coordinator.app` and `org.ellie.assistant.node.app`). The launcher executable in
each bundle is explicitly inventoried. Node alone permits the boolean `allow-jit` and
`allow-unsigned-executable-memory` entitlements; other payload code permits no entitlements.

Every declared file is opened without following links, bounded, mode checked, and SHA-256 checked.
Directory traversal rejects undeclared entries, links, special files, excessive depth and excessive
entry count. Every file is classified from its first four bytes rather than its extension. Thin and
single-slice universal 64-bit executable Mach-O wrappers must use the manifest target CPU, bounded structurally
valid load commands, and, for universal wrappers, aligned nonoverlapping slices whose declared CPU
and subtype match their nested headers. Every slice must use the single manifest target CPU and
duplicate CPU records are rejected; this does not claim conventional multi-CPU universal-binary
support. Every discovered Mach-O must map exactly once to the fixed native
inventory. Security.framework then validates every native leaf, both app bundles, and their explicit
nested executables with strict all-architecture checks and requires hardened-runtime signing.
Production requires an independently supplied
Developer ID Team ID and never falls back to the development policy.

The canonical payload-policy digest binds the actual requirement strings, exact native records and
entitlements, target architecture, envelope policy digest, manifest version, digest algorithm,
signature semantics, and versioned Mach-O magic/parser bounds. It is separate from the authorization
envelope policy, which authenticates the manifest bytes but does not claim to verify the payload.
Later receipts, recovery, selection and launch must atomically bind both policy digests and the
manifest digest before this inspection can authorize installation.

## Validation — 2026-09-14

The focused synthetic test compiles the real shipping and compile-time test variants and uses actual
ad-hoc Security.framework resource and code-signature validation. The positive fixture verifies all
five native records and Node's two exact entitlements. Negative cases cover manifest v1, changed
payload bytes, undeclared data, a declared extra Mach-O, a wrong native identifier or entitlement,
altered nested launcher code, malformed native bytes, wrong mode, duplicate JSON keys, a boolean
numeric field, an unknown native key, array/false/nonboolean/unknown entitlement records and a
real ad-hoc Node signature containing integer `1` entitlement values where booleans are required,
and a changed fixed native record. A direct test-only parser seam accepts a structurally valid one-slice universal wrapper around
a real compiled executable, rejects the opposite target architecture, and rejects a four-byte
native magic without its required header. Test-created commands have finite deadlines and failed
fixture work retains its owned root.

The test-only publisher relaxation is excluded from shipping builds and relaxes only the Developer ID
requirement; identifiers, real signatures and seals, entitlements, byte inventory, parser rules and
policy binding remain enforced. These tests do not establish Developer ID, notarization, Gatekeeper,
receipt binding, installation or execution. The verifier holds and finally rebinds the release root,
but path-based Security.framework checks and per-file reads are not an atomic filesystem snapshot
against an attacker already controlling the owning account.
