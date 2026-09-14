# macOS 15 staging publication compatibility

The five failed native CI jobs on PR59 and PR60 stopped in the native installer tests within
`bun run check`. Inspection of the synthetic source payload succeeded, but normal staging failed
before the injected post-rename checkpoint. No Swift app or iPhone test stage was reached.

The exact PR60 baseline (`baccc883c4701eecacd2d1ca13d35327aa997292`) reproduced on the physical
arm64 MacBook running macOS 15.1: one of four installer tests passed. A test-only diagnostic
reported `publish-exclusive` with the fixed `permission` category. A minimal probe on the same
owned temporary filesystem established that `renameatx_np(RENAME_EXCL)` returned `EACCES` for a
source directory with mode 0555 and succeeded for mode 0700. The failure was not explained by
signature validation, source copying, or an iPhone simulator timeout.

[PR62](https://github.com/rdimascio/ellie/pull/62), commit
`89720c3a017bcf8853af2538d8fc99ff9759e45b`, verifies immutable payload contents while the private
root remains 0700, performs the exclusive rename, then seals the held root directory to 0555 and
syncs it and its parent. A launcher still refuses an incomplete 0700 root. Retry may finalize that
root only after the complete contents and manifest match the explicitly requested source.

The patched source passed five of five focused installer tests on the MacBook. These tests cover
successful publication, malformed/hostile payload rejection, interrupted publication, refusal to
launch an incomplete release, preserving a mismatched retry, successful exact retry and the
absence of diagnostics in a production build. Local Node checks passed 223 tests with one
platform skip; lint, format, contracts, types and the demo build also passed.

The physical tests compiled the installer with test-only destination and fault seams and used
synthetic payloads under exact owned temporary roots. The production diagnostic-privacy test used
a separately compiled production binary. This establishes real macOS filesystem compatibility
for the tested source and simulated interruption boundaries; it is not a production-user install,
service restart, sleep/wake, Keychain or GUI-control acceptance. All remote test roots, logs and
probe artifacts were removed after process exit, and the Xcode slot was released.

A separate clean committed-source archive was built and its shipping inspector passed:
`EllieServices-0.1.0-dev-89720c3a-macos-arm64.zip`, SHA-256
`a798bee73361ca513a6e77055bf92b7700de14f6b8057184577182537ca9270a`. Its manifest names the exact
published commit, with 411 files and 29 components. That archive was not used to stage a release
into a real user's Services directory. All seven current exact-head PR62 GitHub checks passed,
including both native jobs; this does not extend the physical acceptance scope above.
