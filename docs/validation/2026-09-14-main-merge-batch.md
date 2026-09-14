# Main merge and readiness checkpoint — September 14

The owner explicitly requested starting to merge the open PR backlog. There were 66 open PRs at the initial inventory. Source merges into `main` are authorized after review and passing checks; installation over the household services remains a separate gate. This record supersedes earlier statements that main merges were unauthorized or agents remained stopped by usage limits. Those earlier failures and validation records remain retained.

## Merged foundations

Root and independent review cleared the inference admission, browser identity/session and synthetic command-center foundations. PR17's command deadline regression controls time rather than depending on disk persistence speed. All five PRs had passing exact-head checks immediately before merge. Merge commits preserve the original histories; no branch was deleted or force-pushed.

| PR                                               | Reviewed head                              | Main merge commit                          |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| [17](https://github.com/rdimascio/ellie/pull/17) | `723535bd231e5b1771ea0430fa14bcac2c8b4c21` | `632487bca3d9505d3b495cf8f5c3cb45be30c794` |
| [8](https://github.com/rdimascio/ellie/pull/8)   | `848da2b87ee25aa9b48275f19dcb0771c819c957` | `9afe56a7d29694184a2fc386070e519bb6f09aa2` |
| [9](https://github.com/rdimascio/ellie/pull/9)   | `08776c626afeddbdce1cd76b9988457e11554df6` | `cef0dbfea18964042108248e29bc2f10b2db031f` |
| [10](https://github.com/rdimascio/ellie/pull/10) | `8d1f41ad5300e35cf5088404ffdd976bb3dfa7bf` | `c25ae34c307ca06719a49045510d0b3dffef440e` |
| [11](https://github.com/rdimascio/ellie/pull/11) | `a73732db0ff41e2dfb0f6f26dacf2c7d18fdc713` | `68bf08980d19bfd3d025056ba9328db7b84adb36` |

The combined source passed the full local repository gate with Node 24.21.0 and Bun 1.4.2: 104 Node tests passed, one skipped, plus lint, formatting, contracts, types and web build. PR11's actual tracked tree `b9c722cc84cdfa9798751d0448e3b0c121ecf11b` matches that independently tested integration tree. Its only integration conflict was the roadmap's acceptance paragraph; both accurate hardware limits and the synthetic demo milestone were preserved. Log `ellie-foundation-merge-check.log`, SHA-256 `22a0b046ff7bceab9fc70d492f0fe898ff868c8a1699c133a9311e177eb738c5`.

PR18 subsequently merged at 15:36:47 UTC after all ten current checks passed, including three complete native jobs and three Chromium/WebKit jobs. Main merge commit: `7d1156da8391914aeff3c4203e59e490d89b3be1`. GitHub left the prerequisite PR entries open because their bases were other stack branches. Root verified the exact heads below are ancestors of that main merge, then closed PR12–16 with a provenance comment; all their commits remain on main. Six PRs were merged directly and five already-integrated prerequisite entries were closed, reducing the initial 66 open PRs to 55 at this point.

| Closed prerequisite | Exact head included in main                |
| ------------------- | ------------------------------------------ |
| PR12                | `0eff94f5a044304b08e9d3657f11b7219be3953e` |
| PR13                | `73dc187c02d3c79a3a3b0444aab77c354e2409e8` |
| PR14                | `72d08b0bfb1c9d7029b95c38b2b8cfcaf51ac18c` |
| PR15                | `5f33bf59ac91c4c9e0c6e20f970f87c5ed8468ba` |
| PR16                | `73ca4e6233883c94c8020045c6ab065dfd8f6976` |

## Browser pairing and command admission

PR18 was retargeted to `main` at `d861e4bfb10374fec4acdf21a8d4d17f4840e15c`. It joined current main with the existing pairing stack without changing the preceding PR18 tracked content. The stack preserves PR12–16 and the exact final PR9 identity history. Full local gate: 146 tests passed, one skipped, plus all other repository checks. Log `ellie-pr18-main68bf-check.log`, SHA-256 `586481126c88372da23e4442999f4f1808e8241b5201fd1a222ac0d447001dab`. A local browser attempt did not execute because its fixed preview port was occupied; the unrelated listener was preserved. Fresh GitHub browser and native checks passed before merge.

Review of PR19 found a concrete authorization race: synchronous authentication could use old state while an earlier queued revocation was still being durably saved. Reviewed correction `49b5527` queues command admission behind authorization mutations and rechecks expiry, phone role, exact target and `app.open`. Revoke/logout first prevents dispatch; a failed save poisons admission. Admission first may finish or remain unknown after later revocation, with no replay. The result wait does not hold the authorization queue.

Deterministic tests block persistence to exercise revoke, logout, expiry and failed-save ordering; they also verify a once-admitted command dispatches exactly once. Independent review cleared the four-file correction. Root's full check passed 159 tests, one skipped, plus all other repository gates. Log `ellie-pr19-auth-order-root-check.log`, SHA-256 `14dd70329adc6048ea0b726c449fdaefdb27a1a5b6e80c67cfdd3b1a83e3a46f`. Published PR19 `5b247b91af1d5fc4a962f72c8dd8b6e701c0f713` also incorporates main history with no content delta from that tested correction. Fresh CI is pending. This is synthetic transport and authorization validation; no new phone command or household action was tested.

Both complete CI runs at `5b247b9` passed. PR19 then incorporated the newly merged pairing history and was retargeted to `main` at `b5ee7c4a98cfeb1cf1011bda7088fdba5157e6bd`. Its tracked tree remains `4a38791f8c445aa521bf197f988b445b49f51315`, with no content change from the reviewed and tested correction. Fresh checks on this final merge head are pending.

All ten checks on `b5ee7c4` passed. PR19 merged at 15:40:10 UTC with main commit `8bbb4995c1f005a07344a8a44c76552e60acc668`. Seven PRs have now merged directly and five prerequisite PR entries were closed after proving their entire heads are on main: **66 open PRs became 54**.

The same admission race was then found in the later native command handler at PR59 `ac1aef4`: its two synchronous checks can use old state while an earlier native revoke/logout save is blocked. A bounded fix is assigned in a separate worktree based on reviewed PR79 `34678d8`, with queued admission and deterministic ordering regressions required before publication. The speech path already uses queued native authorization and speech-grant checks; no analogous admission gap was found there. Preserve the browser fix already on main when later native stacks are integrated.

## Native acceptance follow-ups

PR83's original `e117f88` completed both complete native CI runs successfully. Jobs `104025486507` and `104025500959` used different checkout commits with the same tracked tree `06df5a1baa78f95fe4bdeaf32a71d30fb6379a3b`. Each passed 308 Node tests with one skip, 158 Swift tests, both standard iOS UI tests and app-hosted HTTPS/speech checks. These are hosted synthetic and Simulator results.

Final review bound the fixture's serialized build key and output hashes to the original in-memory key, rather than accepting a later reread as the expected value. Published PR83 is now `74ddf4923bf8993ebc1fcf71f91265497887d0fc`. The full physical Mini check passed 308 tests with one skip in 43.137 seconds; setup was 5.980 seconds and migration preparation 7.631 seconds. Log `ellie-native-fixture-template-bound-key-final-check.log`, SHA-256 `7138a57d05bfeb5fcf9c1f4aa0ac78c99a75bf0b2f40612940d2fce0a347af97`. Native CI for this final change remains pending. Existing scenario and child-process deadlines were preserved.

PR79 is now `34678d82a4e0f3b3a76f5adb797f4e7a73d62192`. Each typed chunk has one exact cumulative accessibility value check before continuing, without the competing two-second predicate waiter. The keyboard gate, final SwiftUI character-count gate, Save, exact labels, relaunch persistence and create/rename/delete checks remain. No input retry was added. Swift syntax parsing passed locally; fresh CI must establish actual execution. Earlier input and zero-request HTTPS failures remain in the preceding checkpoint; their underlying causes are not claimed resolved. TypeScript/browser checks pass and native checks remain pending.

Final PR83 native results are now complete. Push run `34861139894`, job `104033351975`, checked out exact `74ddf49`; PR run `34861146350`, job `104033375248`, checked out merge `4bf468bc73bb8570560090e6fa7edda6c7db0065`. Both have tree `439de0ce6fa2ec810f63931a45249369620878ea`. Each passed 308 Node tests with one skip, 158 Swift tests, two standard iOS UI tests, and app-hosted pinned HTTPS/speech/cancellation/Keychain checks. Request and response counts each matched session 1, inventory 2, command 1, logout 1 and unexpected 0; owned Simulator cleanup completed. Logs `ellie-pr83-74ddf49-run34861139894-native104033351975.log` and `ellie-pr83-74ddf49-run34861146350-native104033375248.log` have SHA-256 `1e2c5428291bd84712b6c7523afed858d8923782308a6e6cbc00a56aa67bd0c0` and `f22634916b5c1f79236f36811d2992d72c3d0ca0fa1c9a826eb971b64906cc91`. PR83 merged into PR81 at 15:42:42 UTC, preserving history in `05230cd232dcc96d13039b659fbb946c0093c3b1` with that same tested tree. PR81's fresh integration checks are separate. This eighth direct merge is within the release stack, not main; open PR count is now 53.

Final PR79 has one full pass and one failure. PR run `34861334653`, job `104034032560`, used merge `15327eceeba38573fea4c684e53390dc8e770500` with tree `60c7f3864a0d421006f9cc14baf2da32286c8cb4`, identical to `34678d8`. It passed 306 Node tests with one skip, 158 Swift tests, both standard iOS UI tests and app-hosted HTTPS/speech checks with exact endpoint counts and completed cleanup. Log `ellie-pr79-34678d8-run34861334653-native104034032560.log`, SHA-256 `bec35a775a08da6dc2311afee750f5027b90d77f578ea6f892f257c6cfd558e9`.

Push run `34861330051`, job `104034017440`, used exact `34678d8` and failed the standard UI runner's global xcode-test deadline (`stageMs` 603578; total 712563). Node and Swift passed; HTTPS was not reached. The retained session log shows the first Coordinator navigation test opened the screen, entered its five-second wait for “Scan enrollment code,” then received repeated Accessibility process-status notifications with no later waiter completion or test result before the global deadline. This supports an automation hang inside that wait, not a recorded product assertion failure; the underlying cause remains unknown. Simulator shutdown/deletion and derived-root cleanup completed. Log `ellie-pr79-34678d8-run34861330051-native104034017440.log`, SHA-256 `d76530bdaf77f2cdd86e828c3085e363cbe6891a56e0adef5a611970bead18ad`; original result ZIP SHA-256 `bf2d7160acd2fec632adefbe18f68379ab855505dd1d600d481150cb41512b12`. PR79 remains open; no failed run was retried.

PR59 stays at `ac1aef4`, with its retained old UI helper failure. PR77, PR78 and PR80 retain the precise open gates in the preceding record. PR81 now includes the reviewed fixture correction at `05230cd`, as detailed above. They must not be represented as wholly passing or merged merely because an earlier run succeeded.

## Authenticated candidate capture

Implementation resumed in the existing push-verified `codex/authenticated-candidate-capture` worktree after usage became available. It already incorporates PR83's original `e117f88` fixture history. A first draft compiled and passed CLI rejection checks, but those did not establish successful capture or crash recovery. Independent production review found captured-mode, ancestor rebind, owned cleanup, recovery fsync, restrictive-umask prefix and path-type gaps. The author is correcting them and adding real signed positive capture, named recovery and rejection tests before publication. The reviewed contract remains [service-authenticated-capture.md](../service-authenticated-capture.md).

Capture remains an immutable, unselected candidate operation. It has no permission to publish role receipts, select, start or migrate household services.

## Hardware and preservation

No new household hardware acceptance or deployment occurred in this merge batch. Local native fixture validation used real compilation and ad-hoc signatures on the physical Mini with synthetic state. Hosted iOS tests use Simulators. Existing owner-reported Arc/Safari, terminal-free, offline-row and sleep/wake acceptance still applies only to the checkout-backed installation.

The original working checkout and its unrelated edits, MacBook checkout, identities, Keychain credentials, certificates, Accessibility consent, household services and separate life-harness task were preserved. The inspected development ZIP is unchanged. Developer ID runtime validation still awaits the already-requested owner Keychain unlock; no further attempt or permission change occurred. Installed packaged acceptance needs an isolated logged-in GUI context or separately authorized migration.
