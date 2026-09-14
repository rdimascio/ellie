# Authenticated candidate capture validation

Scope: immutable authenticated manifest-v2 candidate capture and exact named recovery under `Services/authenticated-candidates`.

The native installer sources compile together on the local macOS runner with Swift 5 language mode and Security.framework in both production and test configurations. The dedicated capture test compiles finite production and test installers, proves malformed and reordered capture/recovery grammar fails before the supplied synthetic Services root is accessed, and proves shipping code rejects the test-only root selector.

Commands use the pinned validation toolchain path:

```text
PATH=/Users/ryan/.volta/tools/image/node/24.21.0/bin:/Users/ryan/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin
node --test tests/service-payload-capture.test.ts
node --test --test-name-pattern='compiled installer templates|installer stage diagnostics' tests/service-payload-installer.test.ts
```

The focused capture suite reported 7 passing tests, including a first-attempt signed fixture capture, immutable topology and full reinspection, full hidden-stage capacity idempotence, named recovery, retained crash states, source mutation, namespace type inversion, sparse-byte quota and finite lock-contention scenarios. The combined capture and native installer run reported 18 passing tests. Each individual compiler or command child retains the existing 15 second tool deadline and 1 MiB output bound; only the once-per-test aggregate fixture scenarios use a 60 second test budget. Cleanup was limited to unique `mkdtemp` roots after every retained direct child was observed and reaped and the operation outcome was certain.

No validation command accessed `~/.ellie`, the production Services tree, TCC, Keychain, LaunchAgents, or an installed application.

Coordinating and independent production review covered creation after authentication, canonical source and destination rebinding, converted modes, bounded cleanup with descriptor and name identity checks, recovery descriptor ownership and refusal by existing selection. The final local full gate passed 315 tests with one platform skip, plus lint, formatting, contracts, types and web build. The synthetic capture suite passed seven cases; the exact 128-valid-candidate and 65,536-descendant boundary fixtures remain untested at full scale. Production ceilings and overflow-safe accounting were reviewed. Developer ID, notarization and installed-service acceptance remain separate gates.

Final pre-integration log: `ellie-authenticated-capture-final2-check.log`, SHA-256 `1742c747181762f74e58c5d995e7c33541c3cf5f8113885d06d706206f591bb5`. Capture source SHA-256: `519ce5767090c97510a9f66fb518d4ef2d0d920ba982b452b373a6d8cb4c3591`. Earlier failed and passing intermediate checks remain retained; their passes do not establish later source acceptance.
