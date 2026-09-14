# Packaged launcher compatibility on MacBook — 2026-09-13

The packaged launchers from [PR57](https://github.com/rdimascio/ellie/pull/57) passed a bounded compatibility check on the physical MacBook running macOS 15.1. No source was compiled on that Mac.

The copied original archive was `EllieServices-0.1.0-dev-496237bd-macos-arm64.zip`, SHA-256 `4540d2b107d602cc59ba0315561fd5814ed476e3fa5d6d0f7b0b21a923127af6`. Its manifest source revision matched published commit `496237bdd5ae1cb40366ac891604db6e293f33e6`. All 409 extracted payload entries matched their declared paths, modes, sizes and hashes. Both original extracted app bundles passed strict code-signature verification, and their bundle identifiers matched the manifest.

Execution used a separate owned copy of the extracted release. Only `payload/bin/node` was replaced with a finite script, and only that manifest entry was updated. The entire copy was converted to the installed read-only mode projection. Each copied shipping launcher then verified the complete tree and replaced itself with the finite script. Both roles exited successfully with the exact packaged CLI path, fixed `service run coordinator` or `service run node` arguments, packaged helper path, minimal executable path and cleared injected `NODE_OPTIONS`. HOME and temporary state remained inside owned test directories.

The original archive was verified unchanged. The execution check intentionally substituted the runtime, so it does not establish real Node-to-CLI execution, credential access or installed-service operation on this Mac. It did not invoke the real CLI, native helper, Keychain, Accessibility, TCC settings, launchd or household endpoints. Ad-hoc signature validity does not establish Developer ID trust or permission continuity.

Finite processes completed and were reaped before cleanup. Read-only permissions were restored only within the exact owned fixture directory so it could be removed; removal was verified. An earlier copy attempt stopped before extraction because of a destination filename mismatch, and its owned directory was also removed. Existing apps, services, identities and credentials were preserved.
