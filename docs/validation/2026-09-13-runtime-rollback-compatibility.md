# Runtime rollback compatibility — 2026-09-13

Status: **passed for the bounded synthetic compatibility scope below.** An earlier draft completed
the sequence without the final source-isolation, deterministic-dispatch, and setup-process ownership
requirements and remains prior-draft evidence only. The first reviewed final run then stopped safely
because its pre-crash assertion expected `delivered`; source inspection and the observed fixture phase
showed the blocked executor is specifically `running`. After that assertion-only correction, the one
authorized final run passed.

The bounded harness targets exact source revisions
`004d8ef8baa3e586e5a40ee13781ca663e88683e` →
`0cb2a4ad6f51ce9195bcc4f79b830f000ed97809` → `004d8ef8…` against one owned synthetic state
directory. It uses Node 24, frozen offline dependencies, loopback TLS, random synthetic credentials,
and the finite packaged-runtime helper. It does not read the user's Ellie state or Keychain and does
not use launchd, TCC, LAN, an installer, a browser listener, or a GUI.

The revised harness verifies a dependency-free process bootstrap by exact SHA-256 before importing
it, archives the new revision, and then imports lifecycle, authentication, defaults, transport, and
additive-store modules from that exact frozen snapshot. It verifies and compiles the helper from that
snapshot as well. A synthetic matching certificate and key are generated directly through the owned
OpenSSL subprocess boundary and validated with the platform crypto library; this fixture does not
claim to test production certificate generation. The old revision is archived and installed using
the selected snapshot lifecycle. Setup subprocesses use retained direct child handles, monotonic
deadlines, exact reaping, and read-only process-group disappearance checks. Cleanup uncertainty
retains the exact owned root.

The scenario must track the exact interrupted job from `running` to
`unknown_after_restart`. A distinct explicit action in the new phase and another in the rollback
phase each prove that the corresponding node is polling. The final assertion requires exactly three
jobs: the interrupted job remains unknown with the expected outcome, and both fresh jobs are
completed. The three helper effects must match only those authorized actions, proving no replay.

Exact core configuration, authentication, and certificate bytes must remain unchanged. Exact
production authority-store modules create additive empty browser/native/household state between the
new and rollback CLI phases, close every opened store even when later initialization fails, and the
old runtime must leave those files byte-identical. This is store compatibility coverage, not CLI
browser initialization; it does not change the machine's LocalHostName or bind port 8444.

This scope does not prove app/plist restoration, launchd selection, real credential access, attended
migration, or an installed executable rollback. Final tool versions, focused checks, repository gate,
scenario results, and cleanup evidence are recorded below.

Validation used Node.js 24.21.0, Bun 1.4.2, an explicit offline dependency cache, bootstrap SHA-256
`9fb75874a466953b3602b03492a84bb225633ed0d91ebec4764c3e14faa624c1`, and final runner SHA-256
`945bae47f8560decc658e87c14f9494b2a10d5451581cbccfa0a9f05a41afb99`. Root independently ran the five focused isolation and cleanup cases against the
reviewed pre-format source, all of which passed. The final formatted code is covered by the complete
repository gate and the exact formatted-source scenario log at
`/tmp/ellie-runtime-rollback-final-formatted-scenario.log`; it reports exactly three effects, three
jobs, the interrupted job as `unknown_after_restart`, two completed fresh jobs, no replay, five
byte-preserved core files, four byte-preserved additive files, old-node re-registration, and
`cleanupCertain: true`.

The repository check log is `/tmp/ellie-runtime-rollback-final-check.log`. Lint, repository formatting,
contract generation, TypeScript checks, 282 tests passed with one platform smoke test skipped, and the
command-center production build completed. No retained owned state remained from the successful final
scenario.

The first corrected scenario passed before repository formatting; its log remains
`/tmp/ellie-runtime-rollback-final-scenario.log`. Formatting changed the bootstrap bytes and therefore
the runner's pinned bootstrap digest. The exact formatted hashes above were then exercised in a
separately authorized run at `/tmp/ellie-runtime-rollback-final-formatted-scenario.log`, with the same
passing result and certain cleanup. The earlier `running` versus `delivered` assertion failure was not
piped to an original log; an explicitly labeled transcription is stored at
`/tmp/ellie-runtime-rollback-reviewed-failure.log`. That run emitted no cleanup-uncertainty result,
and bounded read-only enumeration after all runs found no owned rollback root retained.

These are synthetic local process and state-compatibility results. They provide no physical-device,
hardware, installed-app, launchd, Keychain, TCC, LAN, or executable installer/rollback acceptance.
