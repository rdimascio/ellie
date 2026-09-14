# Service policy artifact audit

This prerequisite makes the policy in a finished installer and both launchers independently readable without executing those artifacts. A single C byte array in `__TEXT,__ellie_policy` holds either the exact canonical activation-policy record or an explicit unavailable sentinel. A fixed C header and Clang module expose that same array to Swift. Generated Swift policy literals are removed; the external audit and Swift consumer must agree on the same bytes.

The Swift consumer bounds the record, derives the public Team ID from it, and reconstructs the unchanged authoritative policy using the binary's compiled architecture. It requires exact canonical equality. The payload-policy digest already binds the architecture; this work does not change the canonical policy schema or its digests.

The offline audit accepts only the current builder's single-target, thin 64-bit executable format. It checks the CPU and the policy section's load-command, file and memory mapping before comparing its bytes with an independently expected record. A policy copied from the artifact itself is not a trusted expectation. This audit establishes the embedded build record, not publisher authenticity; code signing and the full authenticated payload verifier remain separate requirements.

The implementation uses supported C imports and a retained Mach-O section. [Apple's C interoperability documentation](https://developer.apple.com/documentation/swift/imported-c-and-objective-c-apis) describes the import boundary; [Clang's `used` attribute](https://clang.llvm.org/docs/AttributeReference.html#used) documents retention under Mach-O linker garbage collection. Tests must verify the actual optimized binaries as well as the source wiring.

## Current scope

The ordinary development package remains manifest version 1 and ad-hoc signed, with an unavailable activation policy. This prerequisite adds no authenticated production build mode, receipt-v2 conversion, lifecycle authority, service selection or direct-launch authorization. Those transitions remain governed by the [activation contract](../service-authenticated-activation.md).

Implementation source is `84573ed5277a94604973a49cfddf405d31dd8f74`. Independent source review cleared the shared-record, compiled-architecture, compiler-input, finished-artifact and process-ownership boundaries. The final cleanup correction reports the owned scratch path when successful-build cleanup itself fails. Operation failures retain scratch; diagnostics expose fixed guidance and that path, without raw compiler output. No deterministic cleanup-only fault was injected because the existing API has no clean seam for it.

The canonical Node 24.21.0/Bun 1.4.2 gate passed 747 tests with one existing skip, plus lint, formatting, generated contracts, all three TypeScript projects and both web builds. Source hashes remained unchanged during its 233.82-second run. Full log SHA-256: `41e708a1b43ff3c4d4ca1936941dfedf4b21051dd6a7992168215e6716517231`; source-evidence JSON SHA-256: `a772d723d186c0a3e8afc889585a9a8c120d0fedeab8affb1dfd0924f3060bc0`. This local gate preceded only the final cleanup-error wrapper; that correction passed source review, formatting and lint. The clean package and final hosted checks must use the final source.

Coverage includes optimized/dead-strip retention in actual host-architecture binaries, configured and unavailable records in the installer and both launchers, opposite-architecture canonical bytes rejected by the Swift loader, deterministic/exclusive source generation, input substitution and bounded child cleanup. The independent Mach-O/file-reader matrix passed 48 tests; log SHA-256: `daab813ae5763f666e8451788cba4da9db2d1d52a5ede57e405ffde1c6ef9a59`. Its x64 headers and policy vectors are simulations, not x64 hardware execution.

The first complete gate had 746 passes, one failure and one skip. The launcher build emitted three Swift unreachable-code warnings from the existing non-testing constants, which the strict compiler runner rejected. The launcher now uses the same warning-suppression flag as the installer, while compiler errors still fail. The original failure log remains preserved with SHA-256 `cc468f03a62fe43112bcf14eee8773d1c8cff334138d9a55fc3dc89f751228dc`; its test scratch was already deleted by the old finalizer, so retained compiler input evidence is not claimed for that run. A separate reproduction retained the raw warning evidence. The corrected focused launcher test passed before the complete passing gate.

## Clean package and physical Mac checks

A clean detached checkout of final implementation `84573ed5277a94604973a49cfddf405d31dd8f74` produced `EllieServices-0.1.0-dev-84573ed5-macos-arm64.zip` using the cached official Node 24.21.0 arm64 archive and Bun 1.4.2. Package SHA-256: `2e01dbf0961a122d429045b68deb8a0ae4a165e10f360a6076e9d54e00c53c23`. The successful 66.19-second build log SHA-256 is `62dc7af1135aaad53696951ef27c41b7a61b47cf29cf6cb28e261b198d56a241`. Build scratch cleanup completed on this successful path; no cleanup fault was injected.

The exact archive was checked independently on physical arm64 Macs running macOS 26.6.2 and 15.1. A separate Python extractor verified one exact 39-byte unavailable record in the installer and both role launchers, alongside their manifest hashes, sizes, modes, signatures and architecture. Each executable rejected the test-only policy command without standard output. The bundled Node 24.21.0 runtime executed a fixed arithmetic and SHA-256 probe on both machines. The MacBook copy's archive checksum matched before extraction.

| Evidence                          | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| Mac mini artifact acceptance JSON | `736f01d13710f2883b1c8f5c772d78f973aa229d411d8963168a24505484ea7f` |
| MacBook artifact acceptance JSON  | `104d3742ab2ad5e2e4ef067f9170ea4f69cc3560eefac9fd0ec94be91edc8f60` |

The first local harness invocation used a temporary-directory symlink alias and produced no artifact; validation required an actual ZIP and reran from the canonical checkout path. The first remote checksum attempt encountered an unsupported inherited locale; per-command `C` locale settings corrected the validation environment without changing system settings. Neither attempt establishes a package pass.

These are physical build/artifact/runtime checks in owned temporary directories. They do not establish GUI control, Developer ID acceptance, installed-service upgrade/rollback, live deployment or physical phone acceptance. No service was installed, selected or started, and household identities and permissions were preserved. Final hosted CI remains pending.

## Landed prerequisite

PR94 merged at `0740fe0665b0d6bce08525b40bd017e86c5623a0` after all five current-head checks passed. Its actual tree `7b2a8c1e20ace9a0147ef82d3b49684bc83702ab` equals the hosted tested tree; parents are `eaee6d6612f3ea6eef2d76e4ffe46fe22ba0ac07` and `efee4049f7fca610c51f3f73fb0507aecabe0cc5`.

Native CI run `34890347743`, job `104131162494`, passed 698 Node tests with one existing skip, 158 Swift tests and two Simulator UI tests. App-hosted HTTPS request/response counts and speech settlement counts were exact, and owned Simulator cleanup completed. Full native log SHA-256: `3af67e9d69a3d0c48d4cabdcd50723fb3c0d4e30efecf312fbebba3276991110`. This is separate from PR94's physical Mac mini development-package checks recorded in the [preceding checkpoint](2026-09-14-activation-policy-build.md). The separate main push run `34893515696`, native job `104141712671`, also passed on exact merge `0740fe0665b0d6bce08525b40bd017e86c5623a0`: 698 Node passes/one skip, 158 Swift passes, two UI passes, exact HTTPS/speech counts and completed standard UI cleanup. Its full log SHA-256 is `7810c7fc2729d80ad602fe81d43ba81f5725c65a934d3597d9caba972b282963`. The ATS summary prints its cleanup state before the finalizer; the successful job has no later explicit ATS cleanup-complete line, so that particular observation is not claimed.

Only the parked browser-media PR40 remains from the original open backlog. Its real-website and native-bridge acceptance is still required. Backlog closure does not establish an installable production release or make the separate loopback-only Life application available to native clients.

## First hosted run and bounded test correction

PR95 head `bfd49bd443f26b6965091f2ee324b852c45f93a4` passed TypeScript, command-center, Life browser and GitGuardian checks. Native run `34899126186`, job `104160537288`, reached the 180-second aggregate limit in the test that compiled both configured and unavailable policies. The Node result was 748 total, 746 passed, zero assertion failures, one cancellation and one skip. Later Swift/UI/ATS stages did not run. Full failed log SHA-256: `901f7e568b4cc55cd0e6ccc443aad12c1f366184adab963944fd2fa51a5b047b`.

The correction separates configured and unavailable checks into independently bounded 180-second and 120-second cases. It preserves every compiler invocation and assertion, recreates the previously shared loader fixture, and keeps success-only cleanup in each case. No shipping source or product deadline changed. Independent review cleared the exact diff. The final focused suite passed six tests: configured 98.839 seconds, unavailable 37.965 seconds, and four other checks, 210.505 seconds total. Focused log SHA-256: `d55d98e69388987baef0981150e08508ead4242ae7fd17634f9eb39965d85317`; test-source SHA-256: `be5b5b1c42c0e341508e4f806e3844cac606f40ba23854dff8f48ff4bcf1a962`.

The artifact from implementation `84573ed5` remains the tested shipping code; this follow-up changes tests and documentation only. Final hosted checks on the revised PR head remain required before merge. The owner's new manual QA handoff uses the unchanged earlier Mac preview and does not accept this package's installed lifecycle.

## Compositional test deadlines

The split alone did not resolve the hosted limit: head `ae9e7aa5d2e551d9910657fc42ae960dd70e1d29`, native run `34900829052`, job `104166115496`, cancelled the configured-only test after 180 seconds. Its Node result was 749 total, 747 passed, zero assertion failures, one cancellation and one skip. The other four checks passed; later Swift/UI/ATS stages did not run. Full failed log SHA-256: `4625c327fb54b216162e671c2e66b9ca2c0345f9f6fc1447e5b80d1965e07dac`.

Each test's aggregate ceiling now composes its existing sequential child deadlines, seven-second reap windows, independent opcode probes and fixture margin. For example, the configured path permits eleven 120-second children with their seven-second cleanup windows, three 15-second probes and 30 seconds of fixture overhead. This is an outer harness ceiling; no child or product deadline increased, no compiler work was duplicated, and all assertions, output limits and success-only cleanup remain unchanged. The same calculation covers the other cases instead of retaining aggregate limits shorter than their allowed child work. Independent review verified the invocation counts and cleanup allowance.

The exact revised test file passed six focused cases in 207.364 seconds: configured 97.584 seconds, unavailable 38.095 seconds, opposite architecture 23.120 seconds, generation 22.652 seconds, malformed Mach-O 22.731 seconds and platform-neutral refusal 3.109 seconds. Test-source SHA-256: `4b0cdea78d8b4d9b5f0b8a0808464412083fd18339af7eb90b1218b074caaa34`; focused log SHA-256: `e226b63e00ab0fa28225f4ad587d6b40c62320669c322d4b388ac5466f53c6bc`. Formatting, lint and diff checks passed. Fresh hosted checks on the final head remain required. The unchanged shipping artifact retains its earlier evidence; this test-only correction adds no installed-service or owner acceptance.
