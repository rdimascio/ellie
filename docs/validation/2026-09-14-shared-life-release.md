# Shared native Life release integration

This development milestone combines explicit Life account grants, the native pinned web container and the coordinator's embedded Life runtime. It also packages the Life UI and its transitive workspace dependencies. A paired device needs a separate Life grant; pairing or an existing desktop-control grant does not grant account access.

The existing household preview and services remain unchanged. This record distinguishes source checks, automated native tests, package validation and owner acceptance. The combined candidate is not yet ready for installation or milestone QA.

## Source and review

The Life implementation is `18ade2772239a56b6688f81b35ae4dd7d47353a1`, with native trust and test compatibility follow-up `bedfda0855315fba511174413d4805096fb86bd1`. Both original commits are retained in the integration history. Independent backend review cleared the configuration, authority, admission and shutdown boundaries. Native review found a missing effective-port check in the WebKit trust delegate; the follow-up now checks HTTPS, the enrolled host and port before the existing certificate pin and validity checks.

Packaging commit `18aae9cbc9db3a092958de9d0c5b481518d4c692` builds Life UI from the clean captured source and stages `apps/life-ui/dist`. The declared `@ellie/cli` dependency on `@ellie/life` supplies the runtime's complete transitive workspace closure. The Life workflow now includes its native HTTPS browser acceptance suite. Independent review cleared these changes; eight focused payload tests passed, including staged runtime facades, UI asset bytes and rejection of a missing Life build. Log SHA-256: `d8d8cd56b2a9c286c5ff9627e288f93b507d84ca3154257dab8937381711d4f8`.

## Native validation

On exact integration source `84fd926fa5ee8c9f388753227840ce1224d41ed8`, tree `751a1bdaab8c12abec23f4f953da01405a57d7ba`, all nine `LifeWebSessionTests` passed on an arm64 MacBook running macOS 15.1 and Xcode 16.2. The focused cases took 0.422 seconds after compilation. A generic iOS Simulator build also succeeded with the iPhoneSimulator 18.2 SDK and signing disabled. The local and uploaded source archive checksums matched before extraction.

| Evidence               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Exact source archive   | `a235173b29c51c6719961568772da21258c242d6d5326b0401830f100b1676d0` |
| Focused Swift test log | `11913eeafc4e3c89af25c8355b775ad6de42d8b26acd92503e65c6609501df39` |
| Generic iOS build log  | `8d9e4af95656d56bc715a261514edc013c39f7f7c1f7a87cc2d2721f362c7b59` |

The test cases exercise session validation, cookie construction, navigation and trust endpoint policy, expiry, cancellation and stale callback handling. This was an automated test run on a physical Mac and a Simulator-target compile. No Simulator was booted, no app was installed, and no phone, microphone, real website or household UI behavior was accepted. The exact owned remote workspace was removed only after both commands completed successfully; the earlier compilation-failure evidence was preserved.

The preceding source `18ade277` failed to compile the original cookie assertion on Xcode 16.2, so none of its eight tests executed. The follow-up compares Foundation's actual SameSite raw value with `"strict"` while preserving Secure and HttpOnly assertions. The original generic iOS build passed independently; its pass did not substitute for the later focused test rerun.

## Explicit service configuration

The coordinator now saves only an explicit, versioned private config-path selection. Configuration applies on the next explicit restart; both native launchers and the service entrypoint strip inherited `ELLIE_LIFE_CONFIG`. Status validates the selected target and reports only whether Life is selected for the next start. Disable preserves identities and Life data, including when the old target has disappeared. Malformed or replaced metadata is retained rather than overwritten.

Independent review cleared the revised directory, pointer and lock checks. Eight focused tests passed, including concurrent updates, pointer/parent/lock replacement, restrictive umask, real CLI configuration under an isolated home and byte-for-byte preservation of a synthetic existing identity. Missing selections and OAuth registration files produce redacted Life-specific guidance. Final focused log SHA-256: `4d24f06a16f16a8a20961326e6b0d148056a38d75ed93ef404e358451c726067`. A compiled packaged-launcher test also passed with an inherited Life config variable present and proved that the child did not receive it. These checks did not modify live service state, Keychain or launchd.

## Combined validation and package correction

The first complete integration at `2115d7cfe0ae71cd42c93e5eda9aba67a9a1c0f5` passed the canonical gate: 779 Node tests, one skipped, no failures; lint, formatting, generated contracts, all TypeScript projects and both UI builds passed. The native HTTPS Chromium acceptance also passed, including shared plans, arcade isolation, selective revocation and persistence after embedded runtime restart. These checks used synthetic identities and data. The gate log SHA-256 is `20829f1111dad796ceb241d4fd6ecd19d7fd304fd2138d7dc8948281d941150e`; the browser log is `5f781deee2e91417cdba278164566f0468737c9887eef40d04b7ff408326f446`.

The first actual arm64 development archive built and verified its manifest, but the external bundled-runtime smoke failed before application creation: `life-connectors/research.ts` imports `life-anticipation`, which was absent from the declared production dependency closure. The failed archive is retained with SHA-256 `9633d16a768074e72171b36155eed7d5ad69f212933c12f18a5344cf9df1cacb`; its failure log is `244e4857dfc5da822a399b174987c7fae350b999a44918a5d82d7db34a80d35c`. No synthetic server or household service started in that attempt.

The correction declares the three directly imported runtime workspaces on `life-connectors`: `life-anticipation`, `life-core` and `task-runtime`. The builder also cold-imports the staged Life entrypoint using the bundled Node and an isolated environment before native compilation. It checks exports without invoking the application factory. Its focused regression rejects a missing relative dependency even when a checkout might contain it. The first correction gate stopped at TypeScript because the builder's separate declaration file did not yet export the new helper; the matching declaration is now included. Existing manifest and installer receipt schemas remain unchanged by the Life asset addition.

## Corrected artifact validation

Exact source `def61c38a87cab6a02a3d48080b87a42f88d945d`, tree `c3187b2d1b8857c02fc509f45f9e783c59b3b049`, passed the complete canonical gate: 780 Node tests, one skipped, no failures or cancellations, plus lint, formatting, contracts, all TypeScript projects and both UI builds. The Node tests took 225.312 seconds. Native client and browser application code remain unchanged from the native and browser acceptance sources above; later changes cover service configuration, dependency declarations, packaging validation, regressions/declarations and evidence documentation.

A clean arm64 development archive was then built from that captured source with Bun 1.4.2 and the checksum-verified Node 24.21.0 archive. Its 536-file manifest records the exact source and `sourceModified: false`. The archive round-trip, signatures, metadata and policy checks completed successfully. It remains a version-one development manifest with ad-hoc Ellie signatures and the unavailable activation-policy marker; it is not an authenticated production release or installed authority.

The external smoke ran on the Mac mini's macOS 26.6.2 using only the artifact's bundled Node and modules, a private temporary home/state directory and synthetic loopback HTTPS credentials. It checked the default bundled HTML and referenced asset bytes, denied an ungranted enrollment, minted an explicitly granted session, created a plan and completed a step, closed and recreated the embedded runtime/gateway against the same state, recovered the completed step, and rejected the revoked session. In-memory enrollment and authority objects intentionally survived that embedded restart; this is not a full coordinator-process restart acceptance claim. The run passed and removed its owned synthetic state after shutdown.

| Evidence                  | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| Corrected complete gate   | `379fbdfb2566869206333bd0f9027e8b395fb20ddf777786bda5604246412054` |
| Corrected development ZIP | `e83fdac831b4d7084f4877cb129a3bf1a383d451958184a5fb4979c3b070b861` |
| Package build log         | `680c2f95dfbcb35f392c513ffcec190776cd860e03076b361834f28be12fa92d` |
| External smoke runner     | `cc64273bc86cb4e9efc9d643a74bc5923cecf4e9cf358626563d97ff1ea76c49` |
| Mini packaged smoke log   | `65ce902624d2aa8eb9b2fb8b7af4292bae7e6bb001680b6191f4f73f3e3c3ac3` |

The same exact archive and smoke runner also passed on the physical MacBook running macOS 15.1 (24B2083), using bundled Node 24.21.0. Both SHA-256 values matched before extraction. The one smoke execution produced the same successful JSON/log digest shown above. Its owned remote workspace was removed after commands settled, with identity/mode and final absence checks. A wrapper bookkeeping assignment to zsh's reserved `status` variable then returned SSH exit 1; the completed smoke was not rerun or misclassified as a second pass. The retained receipt distinguishes the runner result from that wrapper error. This remains synthetic packaged-runtime acceptance on two physical Macs, not GUI service installation or phone acceptance.

## Remaining acceptance gates

The owner will receive a concrete build, enrollment/grant setup and the H01 checklist from the [manual QA catalogue](../manual-qa.md) before shared native Life is accepted. That handoff must check shared data, denied access without a grant, revocation, reconnect and persistence. The currently pending QA-MAC-LOCAL-1 session covers the older Mac dashboard preview only; it does not accept this integration or an installed package. Physical iPhone enrollment, microphone use, signed distribution and installed upgrade/rollback remain separate gates.
