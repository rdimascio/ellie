# Native installer fixture template — September 14

PR81 native job `103937795248` timed out the migration-preparation test at 30,324.8 ms under
its unchanged 30-second aggregate limit. The retained log does not identify the internal slow
operation. The test source did compile the same growing Swift installer, tiny executable and two
role launchers inside every scenario, so repeated compilation was a source-supported bottleneck but
is not established as the hosted-runner timeout cause.

The test process now compiles one private, sealed template before its scenarios. Its exact closed
inventory contains the test installer, tiny executable, two role launcher executables and canonical
build-key evidence. Input hashes, including the generated tiny source, are captured before compilation
and checked again before accepting the outputs. A frozen in-memory inventory supplies expected
artifact hashes, including the hash of the canonical build evidence. The private root and binaries are mode `0500`, and the evidence
file is `0400`. Root identity, closed inventory and each regular single-link artifact's owner, mode,
size, device, inode and hash are checked before and after every copy and before cleanup. Each test
still creates its own mutable root, application signatures, manifests, payload, Services tree and
failure evidence. The existing special variant builds and caller-supplied tiny executable behavior
remain separate.

Before the final ownership review, the focused command passed the template-isolation regression and migration-preparation test:

```text
node --test --test-name-pattern='compiled installer templates|native migration preparation' tests/service-payload-installer.test.ts
2 passed in 12.550 seconds
template setup and isolation: 4.833 seconds
migration preparation: 7.629 seconds
```

That source then passed the full repository check: 308 tests passed with one skip in
42.565 seconds; its template isolation test took 5.767 seconds and migration preparation took 7.797
seconds. Per-child 15-second limits and every scenario deadline remain unchanged. This is a synthetic
local Mini test optimization. It does not identify the hosted failure's underlying cause, exercise a
live service or change production code.

Final ownership review additionally required root identities to be captured immediately after
creation, exact current-user ownership and sealed modes, before/after input hashes, a closed
temporary source inventory and retained root paths on setup failure. Validation of those changes
is recorded separately below.

The final reviewed test source, SHA-256
`96305e7487c3e3b65f0dd6d4218873488eaf789cf78d9eee4200205f47661d05`, passed
`bun run check` on the physical arm64 Mini running macOS 26.6.2 with Node 24.21.0 and Bun 1.4.2.
All 308 tests passed, one was skipped, and lint, formatting, contracts, types and web build passed.
The Node suite took 42.509 seconds; setup/isolation took 5.699 seconds and migration preparation
took 7.470 seconds. The retained log is `ellie-native-fixture-template-root-final-check.log`,
SHA-256 `102b7909359721722deeb9e70858f1be2b900953c798ff1dcb7f6bbd02d38331`.
No MacBook run, installed-service exercise or hosted-CI acceptance is implied by this local result.

The author separately repeated that final source with 308 tests passed and one skipped in 43.220
seconds. Both original `e117f880` CI runs then passed: native jobs `104025486507` and `104025500959`
used the identical tracked tree `06df5a1baa78f95fe4bdeaf32a71d30fb6379a3b` and passed 308 Node tests
with one skip, 158 Swift tests, two standard UI tests and the app-hosted HTTPS suite. Their actual
checkouts were `e117f880cd2d6e2f1d2ef497ca9b42ca84597ca5` and merge
`bb00f4f80bedb18c7a38b35c50a34ad6f1e40636` respectively.

Independent review then required artifact inventory hashes to equal the canonical in-memory build
key and output hashes before acceptance, closing the write-to-read evidence gap. The changed test
source SHA-256 `f7223228a585a57e44709b4636e3352352b9719484e88860d69f4795833d8218` passed the
complete local gate with 308 tests passed and one skipped in 43.137 seconds. Log
`ellie-native-fixture-template-bound-key-final-check.log`, SHA-256
`7138a57d05bfeb5fcf9c1f4aa0ac78c99a75bf0b2f40612940d2fce0a347af97`.
Updated-source CI is separate from the preceding passes.
