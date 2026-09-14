# Packaged migration candidate

[PR59](https://github.com/rdimascio/ellie/pull/59) is published at
`c88c58e354e4da2dd831c5cc11447f406c41e1ed`. Its merge preserves `8bebfe5c` and
PR69 `aeb65c83`; the preceding merge preserves the previous combined candidate and
PR68 `39e8e550`. Root independently verified that all six PR68 and seven PR69 files
remain byte-identical to their reviewed slices.

The combined gate passed lint, formatting, generated contracts, TypeScript, 282 tests
with one platform skip, and the command-center production build. The clean arm64 ZIP
contains 423 files and 29 components, declares macOS 14 minimum, and records the exact
source revision with `sourceModified: false`. Its SHA-256 is
`17e9ae7adaf607446a49f00e200be5b1ea9e8e0ae1e390782e7b4caf3d0353e5`.
Root independently verified its checksum, manifest, approved official Node 24.21.0 input
and shipping inspection. The author also verified both launcher signatures.

Two build invocations failed before the successful build: an incorrect input digest,
then an output path that already existed. The corrected invocation used the verified
input digest and an absent output path. The successful build log overwrote the earlier
redacted failures; no separate original failure logs are claimed. No source changed
between these invocations.

PR68's exact runtime scenario covers `004d8ef8` → `0cb2a4ad` → `004d8ef8`, using
synthetic identities and a finite helper. That result is not a runtime execution of this
later combined revision. PR69's final focused migration tests passed on macOS 26.6.2 and
on the physical macOS 15.1 MacBook with synthetic apps and a fake launchctl adapter.
No additional GUI or physical desktop action was performed for this integration.

Current-head CI is pending. The prior combined head's mixed native CI remains documented
in [its separate record](2026-09-13-packaged-integration-ci.md). This candidate has not
been installed into the household stack. Real launchd, credential and permission
continuity, login/sleep/wake after migration and installed upgrades remain separate gates.
Committed packaged-to-legacy restoration is also unimplemented; retained evidence and
precommit recovery do not provide that inverse operation.
