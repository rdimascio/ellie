# Release diagnostics landed and shared verification prepared

PR89 merged into main at `b849635dd044a0129077a23910a823f2312b4c9e` on September 14 at 18:10:12 UTC. Its tree, `2b017f9391d5b2a42716e020b6f4acdd27ba2bf7`, exactly matches the reviewed and CI-tested combination of certificate diagnostics, speech fixture diagnostics, explicit Node signing-validation tooling, and the native HTTPS test correction. Production transport and deadlines were unchanged.

CI run `34877294446`, native job `104087539706`, checked out merge `85fd97a39f3cf0d2b54446eed9ab9795e9d9253d`, with parents `7a26f257f45abaf03f7ec8756ded127bf00e4b20` and `85a6cfacb2bfb73cb3637c8bf73aa38e0730157a`. That was the original PR77 base. After the complete component review and passing CI, the unchanged head was retargeted directly to main. Fresh prospective-tree verification and all current checks passed before the exact-head guarded merge; the actual main tree was verified again afterward.

The run passed 341 Node tests with one skip, 158 Swift tests, and two iPhone Simulator UI tests. Swift covered the delayed default HTTPS recovery in 4.609 seconds, the existing slow-drip absolute deadline and cancellation test, and immediate cancellation. App-hosted pinned HTTPS, speech, cancellation, rejected authority, Keychain and built-policy checks passed. Session/inventory/command/logout/unexpected request and response counts were exactly `1/2/1/1/0`; speech reported five uploads, starts, exits and settled turns, with zero active. Owned Simulator and derived-data cleanup completed. The native log has SHA-256 `51ee910f0fd09363e0b088896a4273f76c8e9227b81b88a432b96a2eb8ca13d2`.

The original PR78 initial recovery timeout remains retained and unexplained. Its 22 other tests, including all six later speech tests, passed. The [deadline correction record](2026-09-14-native-ats-production-deadline.md) describes the test-to-production mismatch and the separate MacBook positive and negative controls. Passing corrected-source CI does not establish the original delay's cause.

## Preserved prerequisite histories

GitHub recognized these PRs as merged after PR89 landed. Their current heads were fetched, matched to GitHub metadata, proved ancestral to actual main, and confirmed unchanged. No branch was deleted.

| PR  | Complete head preserved in main            |
| --- | ------------------------------------------ |
| 77  | `7a26f257f45abaf03f7ec8756ded127bf00e4b20` |
| 78  | `72c411946f1fc71ed043b5788d54552e9a6dd0f6` |
| 80  | `9e44508a60b07c22a8ffc939ab08b1ae6b717318` |

Proof: `/tmp/ellie-readiness-prerequisite-closure-proof.json`, SHA-256 `13cde845db873c342730fc4251bb9f2ff3c92a78075ccc0adebe18edf844d8d4`. Together with the [preceding 41 verified prerequisite closures](2026-09-14-main-backlog-landed.md), this reduced the initial 66 open PRs to two before publishing the next readiness slice: the parked browser companion and the separately managed Life feature task. The Life task subsequently merged PR88 at `a4ee32864712fd9524476d1f1a7280bd06f01df6` after its final hosted checks passed and its prospective main tree matched tested tree `4ea2ea1e9c63ab3efb76a59c8e5e476b56545cd4`. That separately reviewed work is included in the verifier branch before its final combined validation.

## Shared verifier prerequisite

The next slice extracts existing captured-candidate verification into `AuthenticatedCandidateVerifier.swift`. Capture remains its sole caller. It returns immutable binding and inspection evidence plus a held candidate-directory descriptor; callers own that descriptor and retain every published-name check and canonical ancestor revalidation before mutation. Existing canonical parsing, signatures, policy checks, mode boundaries, recovery and error behavior remain equivalent. Installer and test compiler inputs include the new source together. No command, activation policy, receipt version, selection, lifecycle or launcher authority is introduced.

Root and an independent reviewer verified the exact five-file implementation. On the Mac mini with synthetic files and test signatures, the configured Node24 command passed all seven capture scenarios. The full Node24/Bun1.4.2 gate passed 341 tests with one skip, plus lint, formatting, contracts, types and web build. The focused log has SHA-256 `93d6f36438e89c448480b3cab062001c789b8745082d78e8268f4ec2ec8ddd38`; the full log has SHA-256 `329743c0aeb12c6b03e55d4715e55680b25cc0499b5f5a6a9de03f0384dd02f6`. After incorporating actual Life main `a4ee32864712fd9524476d1f1a7280bd06f01df6` without conflicts, the complete source passed 644 tests with one skip and every canonical check, including both web builds. Its log has SHA-256 `3bc8fcd982618785465fbd773bd22455abc2f45006201ad98f4377ab33dc53c4`. The five reviewed implementation files were unchanged by that merge. Hosted CI subsequently passed, and PR90 merged at `e2b5ab851bc32521d6c14d261c0259176e07ddca` with the exact tested tree. The [activation-policy definition record](2026-09-14-activation-policy-definition.md) contains its final provenance and the next bounded prerequisite.

An initial direct `bun test` invocation encountered Bun's five-second default. That unsupported-runner evidence was retained separately; the configured `node --test` command passed without changing test deadlines, lock timing or caching.

## Release limits

These are development-source integrations and isolated synthetic tests. They add no physical-phone, microphone, installed household service, or Developer ID acceptance. The previously requested owner Keychain unlock remains a prerequisite for another signing experiment; no third attempt was made. The next implementation boundary is compiled publisher policy, followed by the reviewed receipt, recovery and launcher contract. Production signing/notarization and installed GUI lifecycle, migration, upgrade and rollback remain release gates.
