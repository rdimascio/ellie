# Service payload builder validation — 2026-09-13

The focused Node test suite uses synthetic archives, dependencies, Git trees, and release trees. It
checks archive checksum and runtime architecture, host-only target selection including the distinct
Node `x64` and Swift `x86_64` names, workspace export traversal and symlink rejection, lifecycle
script suppression, stripped build environment, payload mutation, unsafe modes, linked metadata,
and source-record agreement. It does not validate an Intel build host.

The full Node 24 and Bun 1.4.2 check passed locally. A separately reviewed official Node.js 24.21.0
arm64 archive and checksum were supplied to the offline builder; the builder did not download them.
A temporary Bun 1.4.2 argument probe confirmed that `bun run NAME -- ARGUMENTS` removes the separator
and forwards the following arguments to the named script, matching the documented builder command.
A copied payload outside the checkout imported the production server, authentication, job store,
transport, protocol, node loop, and certificate modules. Over owned loopback TLS, one synthetic
`app.open` reached a fake executor. Restarting the node retained registration and executed no replay.
No live Ellie service, Keychain, desktop helper action, personal configuration, or network identity
was used.

The exact arm64 ZIP was copied to an owned temporary directory on a macOS 15.1 MacBook. Its packaged
Node reported v24.21.0 arm64. `vtool` reported the ad-hoc helper as platform macOS with minimum OS
14.0, and `codesign` reported identifier `org.ellie.helper`. The packaged CLI ran `doctor` under a
synthetic home and invoked the copied helper read-only. It listed the two tools available without
Accessibility and exited with the expected Accessibility guidance. This proves the helper launches
on macOS 15.1; it does not grant Accessibility, install services, exercise desktop actions, validate
Intel, or establish Developer ID signing or notarization. The owned remote directory was removed.

This artifact is owner-writable preparation material. The checksum and archive source are reviewed
operator inputs, and manifest verification is scoped to builder-owned staging and round-trip trees.
Installer validation, immutable installed permissions, LaunchAgents, upgrade, rollback, and
concurrently hostile filesystem handling remain separate release gates.
