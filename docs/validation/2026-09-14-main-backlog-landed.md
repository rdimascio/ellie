# Native backlog integrated into main, September 14

PR87 merged at `f66f948a43967a23915bbdc635dad71c04417d9d` on September 14 at 17:25:26 UTC. Its tree is `cb599270f17ccfb9c62078d5758c300c86f7604b`, exactly the reviewed and CI-tested integration of main and the complete native release history. No application or security logic was introduced by conflict resolution. See the [preceding follow-through](2026-09-14-native-main-merge-followthrough.md) for component reviews and retained earlier failures.

The final native workflow `34872810194`, job `104072608844`, checked out PR merge `5e3f5b8a51598f48443d6f5279b943b1ce7476b0`, parents `e4e98bd` and `862fe87`, with that exact tree. It passed 328 Node tests with one skip, 158 Swift tests and two iPhone UI tests. App-hosted pinned HTTPS, speech, cancellation, rejected-authority, Keychain and built-policy checks passed. Requests and responses matched session 1, inventory 2, command 1, logout 1 and unexpected 0. Owned Simulator shutdown/deletion and derived-data cleanup completed. The full native log `/tmp/ellie-pr87-run34872810194-native104072608844.log` has SHA-256 `0647961bd6a440d55e45b7e3695c03513680d92d0d979e2466ab8d4292ed9292`. TypeScript, browser and security checks also passed before the exact-head guarded merge.

## Verified prerequisite closure

After the main merge, all 41 entries below were still open. Each current GitHub head was fetched and matched to its current metadata, proved ancestral to actual main `f66f948a43967a23915bbdc635dad71c04417d9d`, checked unchanged immediately before closure, and confirmed closed. No branch was deleted. This closes redundant review entries while preserving every commit in main; it does not discard or replace their work.

The retained machine-readable proof is `/tmp/ellie-main-integration-closure-proof.json`, SHA-256 `0b4e67a43f1e6d05827d4d9967f3dcb1f52287e28c59429431151697e61e4264`. Immediately after these closures, the initial 66 open PRs had fallen to five, including the separately managed new PR88. The exact closed heads remain independently verifiable with `git merge-base --is-ancestor HEAD_SHA f66f948a43967a23915bbdc635dad71c04417d9d`.

| PR  | Verified complete head in main             |
| --- | ------------------------------------------ |
| 25  | `f85c42f80ac7c17172ccf2b7ae77675cc98d4fda` |
| 26  | `a21393da58a4bdc2f5b054a1632e2ee1e7a08903` |
| 28  | `528db100c0fefe5f64221e09aed8a1152076a6f2` |
| 29  | `58e96d13274c3b32079d137806ea7281047d961f` |
| 30  | `1713ddadeaae287d34ff563e0ecdeb84b0632550` |
| 31  | `1fdc1809369b8e638c64f5b969d5f2a21ccdf4ee` |
| 32  | `d0f0e7ffa6e5219293cd741960e747b7eba4c500` |
| 33  | `68730d8c3bd34e54f1a8b601d1891ca567e269f8` |
| 34  | `b929581f0771e0855871c73a33af6db3dc502d7a` |
| 35  | `bdcd678262534eb2fe4fd2bdf4fac52b4f24b77e` |
| 36  | `c02803edc82d7a335e9dffdb0c430cd67be62135` |
| 37  | `919d0921fbacb8b7ff793db6f98267aa77284d01` |
| 38  | `88d156855c2cbd67f7ea1d2d22dd145f5009fae7` |
| 39  | `9e759234106b979145dd8722010545b43e41b592` |
| 41  | `b48bed1899297a9400a8cdac475dd741f8a3d332` |
| 42  | `b4945a3f7960c21cebbab77d1cc29188cedf5009` |
| 43  | `1ecad24452fcc3478dc14ecfe3bafba404c288be` |
| 44  | `ac2692131b5e647a88e77d826c078e47240a22a0` |
| 45  | `5deac304ab78dc6767b2a5089fe1802c46a5fc01` |
| 46  | `1f975a5e0321368ddeebf2ad58144b7d55eeeb11` |
| 47  | `9b410b885337bf94a45fd16398208a67870af03a` |
| 48  | `31c85aa2f7ca72de5a2578e5353d637072489496` |
| 49  | `0838a00c99a17c7517c5d6c858e380f3c17e3dbc` |
| 50  | `e23db80dcaeb8d27adb269c48a41d4968ad550bd` |
| 51  | `db6c4b207fd4b915a4ba9abf400a6d5707534640` |
| 52  | `e1cb8a19129119eca9ec1b274802ec4cc44b7d92` |
| 53  | `46051e0d5d896070a05f8501a86bbd1b6801b265` |
| 54  | `e1868a5a9a2438c15476ba925dd33f72b78364e0` |
| 55  | `2cbf6cc614965b977c09d12bc6d18577a7de7db2` |
| 56  | `a7f220b0745caad143886095776fc6f0b8cc21c5` |
| 57  | `496237bdd5ae1cb40366ac891604db6e293f33e6` |
| 58  | `5b435d941bfb2f82852f2f9fcfa8f38c4c0b2e3e` |
| 59  | `f79b871f8fc529c17744616d81ec2f657050b5e3` |
| 60  | `baccc883c4701eecacd2d1ca13d35327aa997292` |
| 61  | `9cd4b1a564a492f7cd9928ca8989e14a766d57b2` |
| 62  | `89720c3a017bcf8853af2538d8fc99ff9759e45b` |
| 63  | `13223f71e1eaf9f520c0cbb3369684a15a09b123` |
| 64  | `193575c8e99abf6178cb017690b32d9ba07113d9` |
| 67  | `cec3248fa297f1b2ec97a5d5555788584b20ead2` |
| 69  | `aeb65c8341a454727c12a558f4ac793f0912152d` |
| 72  | `ea8f0434cc9213b5d4276de028f211c6c0d20b8d` |

## Remaining independent work

PR78 contains fixed redacted certificate diagnostics; PR80 contains bounded speech-test diagnostics; PR77 contains explicit Developer ID validation tooling. Their source publication and actual signing acceptance are separate decisions. They are being combined in that order on the reviewed native base, with full checks and current CI required before each merge. PR40 remains the parked browser companion. PR88 is the separately managed household feature task and is holding its merge until the readiness base settles.

PR80's first current-base run `34873204341` / native `104073924926` passed 335 Node tests with one skip, 158 Swift tests, two UI tests and the exact app-hosted endpoint counts. The actual CI checkout was merge `2f9ee2523b7445a9210b8234421fece2d37aedfd`, parents `862fe87` then `fed5f102`, tree `6e2e2630c0585c3c19f9c00daa9821f9801038fb`. Its new closed diagnostics reported five uploads, five worker starts and exits, five settled turns and no active turn. Log `/tmp/ellie-pr80-fed5f102-native104073924926.log`, SHA-256 `d4ca0f4f6ab055072556c5880c46fb3e2992639c952f7629ecf3cdb8e8209ce9`. That pass applies to its `fed5f102` source before combination with certificate diagnostics; later combined CI is separate evidence.

No new physical iPhone interaction, microphone use, household desktop action, Keychain modification, service installation or migration occurred. The MacBook evidence in the preceding record covers real Swift execution and an iPhone Simulator on unchanged native app source, not physical-phone acceptance. The already-requested owner Keychain unlock remains a prerequisite for another actual Developer ID experiment. No third signing attempt was made. Authenticated activation binding, production signing/notarization and installed-service lifecycle/upgrade/rollback acceptance remain release gates. These merges make development source available on main; they do not constitute a public release.

The complete local readiness union combines main `f66f948`, certificate head `72c4119`, speech head `9e44508` and the original signing-tooling implementation. Independent review confirmed that the three signing tool/test files remain byte-identical to the original reviewed PR77 source; the merge had no conflicts. The final Node24/Bun1.4.2 check passed 341 tests with one skip, plus lint, formatting, contracts, types and web build. Log `/tmp/ellie-pr77-final-diagnostics-union-check.log`, SHA-256 `0fc8a872d2520050bf9c9c4bbaf7cb6b46a4f857b9d9ac48156a3e2f47d9ab36`. Each remaining PR still requires passing current hosted CI and a prospective main source tree equal to its tested tree before merging. No actual signing experiment ran.
