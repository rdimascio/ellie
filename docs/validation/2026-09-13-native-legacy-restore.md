# Stopped legacy file restoration validation — 2026-09-13

This slice adds explicit `restore-legacy TRANSACTION_ID --roles ...` and
`recover-legacy-restore` commands. They consume one exact committed adoption record, require its
exact selected packaged receipt and verified snapshot/backup evidence, and restore only the recorded
legacy application and LaunchAgent files while both managed labels remain unloaded. The packaged
receipt is removed last. Output reports `runtimeCompatibility: unverified`; the commands do not
start a service, migrate shared state, replay work, or establish checkout, Node, Keychain, signing,
or TCC compatibility.

The production legacy snapshot contract remains root mode `0700`. An intermediate review expanded
that admission to `0555`; the physical macOS 15 focused fixture then failed at the existing forward
recovery matrix (test line 1631 expected an interrupted recovery to fail, but it exited successfully).
The unsupported admission and fixture change were removed without claiming a more specific cause.
Inverse staging remains private `0700` through publication and restores the snapshot-recorded mode
after the no-replace rename.

Validation used only owned synthetic homes, generated application fixtures, and fake unloaded-label
observations. The exact final source passed the focused migration test on the development Mac in
11.233 seconds and on a physical macOS 15.1 MacBook in 15.630 seconds, one test each. Coverage includes
single- and two-role restore, exact later-receipt refusal, umask `027` and `077` partial copies,
altered-prefix/extra-entry refusal, complete-evidence missing-file refusal, precommit packaged
recovery, postcommit legacy completion, phased `0700` roots, and repeated crash recovery.

A prior source revision passed the full Node gate with 226 tests and one skip. The final combined full
gate remains a coordinating integration check. These results do not cover real LaunchAgents,
Keychain, Accessibility, TCC, a live checkout/runtime, household state, or desktop commands, and do
not constitute installed executable rollback acceptance.
