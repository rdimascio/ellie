# Native service selection and recovery

[PR63](https://github.com/rdimascio/ellie/pull/63), commit
`13223f71e1eaf9f520c0cbb3369684a15a09b123`, adds selection of a previously staged release for
the coordinator, node, or both. It is based on the macOS 15 staging fix in PR62. Coordinating,
protocol, and filesystem reviews cleared the final five-file slice before publication.

Selection verifies the full existing selection, refuses loaded selected LaunchAgents or
unmanaged application/plist collisions, records durable intent before staging, and publishes
the receipt last. Recovery compares verified old/new evidence to restore the pre-commit state
or finish the committed state. Unknown evidence remains available for diagnosis. No desktop
job is submitted or replayed by selection or recovery.

The final local gate passed 224 Node tests with one platform skip, including six focused
installer/selection cases; lint, formatting, contracts, types and the demo build passed. These
tests compile test-only destination, launchctl-state and interruption seams and use synthetic
payloads under owned temporary homes. They cover true A-to-B upgrades with the other role
remaining on A, successful replacement, old-root unseal and backup, new app/plist publication,
receipt commit, crash recovery, lock contention, invalid arguments, parent modes/symlinks,
loaded-state changes, altered installed targets and developer-install collisions.

One focused selection test also passed on the physical arm64 MacBook running macOS 15.1. That
source snapshot exercised the A-to-B and macOS directory-mode transitions with synthetic
payloads and launchctl state, in an isolated owned home. It predates the final ancestor-symlink
and error-classification regression additions and success-message wording. The remote source
copy was removed after exit and its absence verified. Error-classification regressions inject
after completed seal/unseal helpers; they do not force an actual filesystem sync failure.

The clean committed-source archive is `EllieServices-0.1.0-dev-13223f71-macos-arm64.zip`,
SHA-256 `a8b29596001f30cd2cba9e3d72610359dbd1e11f06bb41eae91e0f360e24c00f`. Root independently
verified the checksum, exact source revision, `sourceModified=false`, 412-file manifest and
successful read-only shipping inspection through the canonical `/private/tmp` path. This
archive was not installed or selected into the owner's home.

PR63 CI has one passing native job and one failing native job. The failed job checked out
GitHub's merge `f98656b8e2aa484ea4d597aac077c17ef28b6a84`, combining the exact PR head and base.
Its Node suite passed 224 tests with one skip, the selector test passed, all 129 Swift tests
passed and the generic iOS build passed. The failure occurred after Simulator creation and
before `xcodebuild` testing. There was no result bundle. The older runner did not identify the
active startup phase, so neither the precise operation nor its cause is established. The
passing job used a different GitHub-hosted macOS 15 runner; overlapping times do not establish
shared-host contention. The combined candidate already includes PR51's bounded phase
diagnostics, so no duplicate diagnostic change or blind retry was made.

[PR59](https://github.com/rdimascio/ellie/pull/59) includes the selection history at
`1934afbb8b0085f34f64f9962e84009b9b867ad6`. Its exact parents are the previously published
combined candidate `4d9861eb0962653f88bd9221fcc7efa33519a86a` and PR63. Root verified the five
integrated files remain byte-identical to PR63. The combined Node gate passed 270 tests with
one skip, and the clean captured-source payload contains 421 files and 29 components. Its ZIP
SHA-256 is `d10780b960e7c4d99e53b9c6a9867fb204669489c8cc55553c34b268266406a7`; root independently
verified source/checksum/manifest and read-only shipping inspection. Fresh combined CI is a
separate gate; the earlier `4d9861eb` head passed all seven checks.

The unloaded-state guarantee applies to selected managed LaunchAgent labels, not arbitrary
foreground processes or external uncoordinated launchctl commands. Actual packaged start/stop,
source-checkout migration, installed upgrade/rollback, Keychain and permission continuity,
sleep/wake and signed distribution remain separate acceptance gates. No household service,
identity, credential, permission, registration or preview was changed by this work.
