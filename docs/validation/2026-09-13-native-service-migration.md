# Legacy service migration preparation

[PR67](https://github.com/rdimascio/ellie/pull/67), commit
`cec3248fa297f1b2ec97a5d5555788584b20ead2`, adds `prepare-migration` for explicitly
selected coordinator/node roles and `recover-migration`. It preserves verified legacy
app and LaunchAgent bytes in a private immutable snapshot while both fixed service labels
are unloaded. It does not switch or start services.

Preparation verifies the finite legacy app/plist topology, original file and directory
modes, signatures, metadata and runtime bindings. The snapshot records Node and entrypoint
hashes. A durable intent precedes staging, and explicit recovery retains unknown or
competing evidence. Verified immutable staged releases remain available. Final publication
rechecks canonical ancestor identities; this is not a filesystem compare-and-swap and
does not eliminate every uncoordinated same-user race.

Coordinating and independent reviews cleared the final source. The complete repository
gate passed 226 Node tests with one platform skip; all eight installer tests passed.
Root independently reran the final migration regression: one passed in 6.459 seconds.
The fixtures use owned temporary homes, ad-hoc signed synthetic legacy bundles and fake
launchctl observations. Covered cases include intent/copy/rename interruption, canonical
parent replacement before and after snapshot rename, explicit recovery, stale checkout
bindings, unsafe plist paths, malformed maximum-size entries, incorrect snapshot root
modes, original-byte preservation and preservation of staged releases.

The clean committed-source archive is `EllieServices-0.1.0-dev-cec3248f-macos-arm64.zip`,
SHA-256 `66df0d66fa62829cb00a0411d8d44f56383d86715136889338ca48c8474d53a6`.
Root independently verified its checksum, exact source revision, 414-file manifest,
`sourceModified: false` and shipping read-only inspection. Inspection correctly rejected
the symlinked temporary-directory alias; inspection through the canonical path passed.

No live launchctl mutation, installation, Keychain or Accessibility change occurred.
Snapshotting the old app/plist files does not freeze their external checkout or dependencies,
prove future state-schema compatibility, or establish executable rollback. The stopped-only
switch and its explicit recovery are the next independently reviewable slice; real installed
migration, upgrade/rollback and permission continuity remain separate acceptance gates.
