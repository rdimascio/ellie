# Compiled activation policy build prerequisite

PR91's canonical policy definition is on main. This slice generates deterministic Swift policy constants from the same authoritative constructors and verifies them in an installer and both role launchers. The generator accepts only an owned source checkout, a fresh output path, a strict public Team ID and an arm64/x64 policy target. Callers cannot supply replacement policy digests, requirements, inventory or limits.

The private build probe uses only ELLIE_ACTIVATION_POLICY_TESTING, retaining production parser limits and signature policy. The generated source contains exact canonical policy bytes and the publisher, architecture, envelope, payload and trusted policy digests. A test-only audit interface exposes these values; the external auditor compares every field and byte with the independently expected record. The audit interface itself grants no execution authority.

Source capture uses finite no-follow reads, owner/link/mode checks, immutable snapshots as the actual compiler input, and original/snapshot identity and hash revalidation. Child commands have bounded output and deadlines, TERM-to-KILL escalation through the retained child, bounded reaping and conservative process-group absence checks. Signal zero only checks group existence; it never grants group termination authority. Unexpected or unsettled processes retain owned evidence. Output publication is exclusive, with held-file identity, directory rebinding and fsync checks.

## Current shipping behavior

The ordinary development builder compiles an unavailable policy into the installer and both launchers and rejects unknown policy options before I/O. Its manifest remains version 1 and its artifacts remain development/ad-hoc. This work adds no production policy selection, receipt/journal version, lifecycle command, authenticated activation, launch authorization or signing credential input. The authoritative Swift policy constructors are unchanged.

These are trusted build tools operating on reviewed source. Identity checks detect substitution at the checked boundaries; this is not a claim that arbitrary malicious source can safely be compiled or executed.

## Source and validation

Reviewed code commit: `7046e6e`. Validation and package source after integrating actual connected-Life main `eaee6d6612f3ea6eef2d76e4ffe46fe22ba0ac07`: `632af14e9d62ab376cd56d72e5edd89d700fba2f`, tree `9c8d87ca4daefbae7883b5f6699c0da66506b1da`. The six reviewed implementation/test files were byte-identical after that merge. Documentation follows in a separate checkpoint commit.

- Final focused Node24 suite on the Mac mini: four passed, zero skipped. Log SHA-256: `8851dd28d32d1ec9bfc6bfde8f3725cda004a445efd88b9dc128f55aa2ef670f`.
- Frozen Bun1.4.2 install and complete Node24 gate on the combined source: 698 passed, one existing skip, plus lint, formatting, contracts, types and both web builds. Log SHA-256: `c1bc5878ad7a8b2bd7c81396e2aac667ed4cd008d45eb4cbb050ee1ad2f7c3fb`.
- Configured installer/coordinator/node audit bytes match. All three unavailable binaries refuse the audit, and all three ordinary binaries omit its command. A compiled launcher with altered policy data fails external audit.
- Fixed arm64/x64 production-limit vectors and a second synthetic publisher's arm64 vector match independent Python calculations. Other cases cover malformed/BOM/CRLF/noncanonical records, changed audit constants, unsafe source files, preserved preexisting output, concurrent publication, and finite child nonzero/stderr/overflow/TERM-ignore failures.
- The hanging fixture installs its TERM handler before announcing readiness and is reaped through escalation before its finite fallback. Source-symlink and oversize cases are covered; a deterministic in-flight source-substitution fault injection is not claimed.
- Root and an independent reviewer cleared the corrected implementation. Earlier draft checks are retained separately and are superseded by the final focused and combined gates. Hosted CI for this new PR remains a separate gate.

## Development package acceptance

A clean build from `632af14e9d62ab376cd56d72e5edd89d700fba2f` produced `EllieServices-0.1.0-dev-632af14e-macos-arm64.zip`, SHA-256 `70be557f16c5c9c3f355c9feb9b046bf569ca4ab86024c2f194cc91442af6432`. It used the cached official Node24.21.0 arm64 archive, independently matched to its recorded checksum `6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe`. The builder completed its manifest and archive round-trip checks.

On the physical Mac mini, independent checks matched the three packaged native executables to their manifest hashes/modes, verified their signatures and arm64 architecture, and confirmed empty stdout plus rejection of the test-only audit command. The copied Node24.21.0 runtime executed a fixed arithmetic and SHA-256 probe. Package acceptance record SHA-256: `5f5978071c72605629ecda4df1f41522682c3c61d09f4ffc784ed709d192c4e8`. Build log SHA-256: `8b7ffdb071b8ef8bed380843927af958848f7ae825b6517987a68cceb3f88cbb`.

The x64 checks calculate policy records; no x64 binary was executed. No physical phone, microphone, account authorization, installed GUI service, household identity or Keychain permission was exercised or changed. The package is retained as development evidence, not deployed.

## Remaining release gates

Explicit authenticated production builder mode and artifact audit come next. Receipt-v2 selection, version-directed recovery and lifecycle/direct-launcher enforcement must then follow the [activation contract](../service-authenticated-activation.md). Developer ID/notarization and installed GUI lifecycle, migration, upgrade and rollback acceptance remain separate gates. The existing owner Keychain-unlock prerequisite is unchanged.

PR92's roadmap correction landed at `ca112a506ecf15c8ae28dbb3d6b086fbf1df675b` after all exact-source checks passed. The separate Life task landed PR93 at `eaee6d6612f3ea6eef2d76e4ffe46fe22ba0ac07` after its final checks; this source includes both histories. Their merges do not transfer physical or account acceptance to the development package.
