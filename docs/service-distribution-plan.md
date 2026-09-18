# Checkout-free macOS service distribution plan

## Current boundary

The development candidate produced by `scripts/package-desktop.mjs` contains `Ellie.app`, its
ad-hoc signature, source provenance, a ZIP checksum, and a source record. Inside the application,
the only JavaScript resources are the local speech bridge and its speech adapter source. It does
not contain the coordinator, execution node, CLI, workspace packages, third-party Node modules,
Node.js, the native Accessibility/Keychain helper, role launchers, LaunchAgent definitions, or a
service installer. Installing that ZIP therefore does not install or update either background
service.

The current service command is a developer workflow. Its LaunchAgent uses the source checkout as
`WorkingDirectory`; each role app records absolute checkout and `process.execPath` locations in
`runtime.json`; and the installer compiles and ad-hoc signs the role launcher locally. Moving the
checkout or version-manager Node installation invalidates the installed service. The distribution
work must replace those inputs rather than describe the existing app ZIP as self-contained.

## Proposed artifact

Build one architecture-specific, checksum-addressed service archive from a clean tagged commit and
the committed lockfile. Keep the dashboard app as a separately installable artifact. The service
archive expands to this immutable payload before installation:

```text
EllieServices-0.1.0-dev-REVISION-macos-ARCH/
  manifest.json
  SHA256SUMS
  SOURCE.txt
  LICENSES/
    Ellie-LICENSE
    Node.js-LICENSE
    THIRD-PARTY-NOTICES.txt
    components.spdx.json
  payload/
    bin/node
    lib/ellie/apps/{cli,node,server}/...
    lib/ellie/packages/...
    lib/ellie/node_modules/...
    lib/ellie/package.json
    lib/ellie/bun.lock
    helpers/ellie-macos
    launchers/Ellie Coordinator.app/...
    launchers/Ellie Node.app/...
```

The payload contains only the production dependency closure needed by the CLI entrypoint and the
two roles. Workspace imports must resolve entirely inside `payload/lib/ellie`; an acceptance test
runs both entrypoints after renaming the source checkout out of reach. Do not rely on Bun, a shell,
version-manager shims, globally installed modules, Xcode, or files from the build checkout at run
time. Each prebuilt role launcher takes the validated release directory from launchd's
`WorkingDirectory`, resolves `payload/bin/node` and the packaged CLI entrypoint beneath it, and adds
its fixed role. It rejects a missing, writable, linked, or mismatched manifest rather than reading a
destination-generated resource inside its signed bundle. Its final `execv` preserves launchd's PID,
signal, exit-status, and process-group behavior.

`manifest.json` records the exact Ellie revision and version, target architecture and minimum
macOS version, lockfile hash, every payload file's relative path, mode, size, and SHA-256, and the
bundle identifiers and signing identity used for each executable. It also records the upstream
Node.js 24 release, archive filename, official download URL, and published SHA-256 used by the
offline build. The release job verifies a previously acquired Node archive; the installer never
downloads a runtime or dependency.

Ship the corresponding Node.js license and notices, Ellie license, and an SPDX inventory generated
from the frozen production dependency tree. A release gate rejects missing license metadata,
unlocked dependencies, undeclared files, absolute build paths, symlinks, device files, and mutable
or group/world-writable payload entries. Dependency and license generation belongs in the artifact
builder; it is not reconstructed on the destination Mac.

## Per-user installation

Install without `sudo` into a user-owned root:

```text
~/Library/Application Support/Ellie/Services/
  releases/0.1.0-dev-REVISION-ARCH/   # verified immutable payload
  receipts/installed.json             # current release and hashes for each selected role
~/Applications/Ellie Coordinator.app
~/Applications/Ellie Node.app
~/Library/LaunchAgents/org.ellie.assistant.coordinator.plist
~/Library/LaunchAgents/org.ellie.assistant.node.plist
```

The release directory name is derived from validated manifest fields, not archive input. Create a
private staging directory on the same volume, copy with exclusive creation, verify every manifest
entry and code signature, remove write access from the completed payload, then rename it into
`releases`. Reject unsafe ownership, links, unexpected existing paths, or a differing payload at an
existing release ID. The receipt is private, contains no credential or private path beyond the
fixed installation root, and is atomically replaced only after every published file succeeds.

The native installer exposes `select RELEASE --roles coordinator|node|coordinator,node` and an
explicit `recover` command. Selection uses a private lock and a durable intent journal, verifies
the full old selection before changing either role, refuses loaded LaunchAgents and unmanaged or
developer-checkout collisions, and publishes the receipt last. Recovery verifies exact old/new
receipt bytes and app/plist contents before restoring a pre-commit transaction or completing a
post-commit transaction. `recover` and the next `select` both attempt this recovery. Unsafe,
ambiguous, or incomplete evidence retains the journal and remains blocked; selection never starts
a service or removes a release. The unloaded check covers the managed LaunchAgent labels. It does
not coordinate arbitrary foreground processes; a shared runtime lease remains future work.

Before selection, run the native installer's
`preflight-select RELEASE --roles coordinator|node|coordinator,node` against an already staged
development release. It checks the candidate, existing receipt and applications, destination
collisions, transaction evidence, selection lock and requested LaunchAgent states. It reads the
existing installation without creating directories or a lock, repairing a transaction, selecting
a release, or changing launchd. A fresh installation can pass with no receipt or lock yet.

Valid invocations return one redacted JSON object with `version`, `command`, `releaseID`, `roles`,
`ready` and `status`. Exit status is zero only for `ready`; invalid arguments produce a fixed error
before inspecting the installation. Roles must use the order shown above. The report describes an
observation, not a reservation: a later `select` revalidates the installation and can still refuse.
It does not establish endpoint readiness, permission continuity or production authenticity.

| Status                 | Meaning and next step                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`                | The staged development release and observed stopped destination passed preflight. Continue only with the reviewed selection/rollout.         |
| `loaded`               | A requested managed role is loaded. Let work settle, explicitly stop it and check its status before trying again.                            |
| `busy`                 | Selection state is in use or a lock appeared during observation. Wait for the other operation to finish, then rerun the read-only preflight. |
| `recovery_required`    | Transaction evidence or installed state is incomplete, unsafe or changed. Preserve it and use the applicable reviewed recovery procedure.    |
| `destination_conflict` | An unmanaged role application/plist or changed destination blocks selection. Existing checkout services need the migration workflow.         |
| `candidate_invalid`    | The requested staged development release is absent or fails verification. Check its release ID and the retained stage/inspection result.     |
| `unavailable`          | The logged-in GUI launchd domain or role state could not be observed reliably. Restore that context and rerun preflight.                     |

The same native installer exposes read-only `status coordinator|node|all` and explicit
`start coordinator|node` and `stop coordinator|node` commands. They accept only a complete,
verified selection with no pending journal and share the selector lock. Status does not create an
installation or mutate launchd. Start enables the fixed managed label when necessary and uses
`bootstrap` without restart semantics; stop disables it and uses the fixed selected plist for
`bootout`. Queries have a two-second bound and mutations have a twenty-second bound. A timeout or
failed observation after a request reports an uncertain or partial outcome and is never retried.
Parsed `launchctl print` text is a strict compatibility observation of the selected plist,
executable, arguments, and state; it is not a stable API or a filesystem compare-and-swap. The
final preflight narrows the local replacement window but cannot coordinate an external launchctl
caller after that check. A successful start means the selected LaunchAgent is enabled and loaded;
reported running or waiting state does not prove that an application endpoint is ready. A
successful stop means that managed label is disabled and unloaded. These commands do not claim to
find or stop arbitrary foreground processes. Every successful start or stop prints the same
redacted observed-state JSON as status so a waiting result is explicit rather than implied ready.

`unselect coordinator|node` removes exactly one stopped, receipt-selected managed role. It takes
the selection lock, verifies the full installed selection, journals the old and new receipt, and
removes only that role's verified application and LaunchAgent plist. The other role may remain
loaded and its receipt and files are unchanged. `recover` restores verified backups if the receipt
was not committed, or removes verified backups after commit; unexpected or changed files retain
the journal and require operator reconciliation. An absent role or loaded target is rejected. This
does not remove staged releases, private configuration, identities, certificates, Keychain items,
logs, or household data. After a stopped node is unselected, the receipt records `node: null`.

Generate each LaunchAgent with its stable label and release directory as `WorkingDirectory`; its
program arguments are the corresponding stable role app and fixed `--launch-agent` mode. Preserve the existing per-user
`gui/<uid>`, Aqua-session,
`RunAtLoad`, `KeepAlive`, umask, resource limits, null output, and no-`sudo` rules. Installation does
not bootstrap, enable, kickstart, or otherwise launch a service. A separate explicit start action
continues to control that mutation.

Keep these production identities stable across releases:

- Dashboard: `org.ellie.dashboard`
- Coordinator launcher: `org.ellie.assistant.coordinator.app`
- Node launcher: `org.ellie.assistant.node.app`
- LaunchAgents: `org.ellie.assistant.coordinator` and `org.ellie.assistant.node`
- Keychain service: the existing `org.ellie.assistant` contract
- Native helper signing identifier: `org.ellie.helper`

The final distribution must use the same reviewed Developer ID Application team and designated
requirements on every upgrade. Bundle IDs alone do not preserve TCC or Keychain trust. Ad-hoc
development builds can validate layout and lifecycle, but they are not evidence that Accessibility,
Local Network, microphone, or Keychain authorization will carry to a public build. Changing the
signing team, requirement, launcher path strategy, or helper identity requires an explicit migration
and fresh physical permission testing.

## Upgrade and rollback

Never update a loaded coordinator or node. Preflight both managed LaunchAgent states and refuse the
upgrade if either selected role is loaded, running, or waiting. The operator must let active work
settle, explicitly stop the role, and verify stopped status before installation. The installer does
not cancel jobs, edit job metadata, replay a command, or infer that an interrupted command failed.
Existing restart recovery remains responsible for converting delivered or running work to an
unknown outcome without replay.

After verification, publish the new release, stage new role apps and plists beside their targets,
and atomically exchange each managed file while retaining the prior release and receipt. If any
publication step fails, restore the previous apps, plists, and receipt and leave the new release
unselected. Only after all files and the receipt agree may the operator explicitly start the roles.
Keep one prior release until the replacement has passed status and doctor checks.

Rollback uses the same stopped-service transaction: verify the prior manifest and signatures,
restore its apps and plists, update the receipt, and leave services stopped for an explicit start.
Neither direction deletes or rewrites `~/.ellie`, `~/Library/Application Support/Ellie` dashboard
data outside the `Services` subdirectory, service logs, or any Keychain item. Uninstall removes only
managed LaunchAgents, role apps, receipts, and unreferenced verified release payloads after stopping
the roles; private identities and state remain available to a reinstalled compatible version.

### Legacy service preparation

The native installer can explicitly prepare a stopped `ellie-service-v1` developer installation for
a later migration. It verifies both fixed LaunchAgent labels are unloaded, validates the exact
generated app and plist bytes against their recorded checkout build, and writes an immutable,
content-addressed snapshot under the private `Services/migrations` directory. The snapshot contains
only the app and plist bytes. It records bounded fingerprints for the external checkout entrypoint
and Node executable, but it does not copy or freeze either external dependency.

Preparation leaves the original apps, plists, launchd state, identities, and Keychain items
unchanged. An interrupted preparation retains a private intent and requires the explicit
`recover-migration` command; a later prepare never performs hidden recovery. Recovery verifies the
owned partial or completed snapshot before removing only transaction-owned evidence. A changed
checkout is reported as a stale build and is preserved rather than rebuilt or resigned.
The installer reopens and compares the fixed directory chain immediately before reporting a
publication or recovery complete. This detects bounded testable replacement races, but it is not a
filesystem compare-and-swap and cannot exclude an arbitrary same-user change after the final check.

This snapshot is migration input, not a promise of executable rollback. A future switching change
must separately verify that the recorded external runtime remains available and that the old code
can read the current state schema. Matching bundle identifiers alone does not establish Keychain or
TCC continuity. This foundation does not select a packaged release, switch services, start or stop
launchd jobs, or implement rollback.

The stopped-only `adopt-migration` switch consumes one verified snapshot containing exactly every
installed legacy role and one already staged packaged release. Partial or mixed-role adoption is
rejected. It requires both fixed labels to remain unloaded, writes a
private journal before staging or moving any application, and treats only an absent packaged receipt
as the legacy pre-commit state. The exact new receipt is written after both packaged applications and
plists are in place. Recovery restores snapshot-verified legacy backups before that commit or
completes the exact packaged selection after it; any other receipt or competing artifact preserves
the journal and requires review. The immutable legacy snapshot and verified transaction backups
remain available after selection as explicit rollback evidence; this slice does not erase them.
Before commit, complete or interrupted packaged copies are moved by exclusive rename to deterministic
transaction evidence paths before legacy files are restored. An interrupted file is accepted only
when every byte is an exact prefix of its immutable staged-release source and its path, type, mode,
owner, link count, depth, entry count, and total size remain within the release manifest bounds.
Unknown or altered content blocks recovery and is preserved. A completed canonical record embeds the
original journal and records whether recovery committed the packaged selection or restored legacy;
partial plist and receipt writes remain inert and are retained as transaction evidence.
The switch does not start a role, change permissions, freeze the external checkout or Node runtime,
or establish state-schema, Keychain, or TCC compatibility. Those checks remain required before an
explicit later start. As with preparation, final ancestor checks reduce a bounded replacement race
but are not a filesystem compare-and-swap against an arbitrary same-user mutation.

## Acceptance gates

Implement this plan as small independent changes:

1. **Offline payload builder.** Given a clean revision, frozen lockfile, and explicitly supplied
   official Node.js 24 archive plus checksum, produce the layout, license inventory, manifest, and
   archive. Test traversal, links, modes, undeclared files, dependency resolution, source provenance,
   and archive round-trip. Establish whether byte-for-byte archive reproduction is achievable on
   the supported build host; until then claim reproducible inputs and independently verifiable
   contents, not identical ZIP bytes.
2. **Packaged launchers.** Build the two stable-identity role apps and helper in the release job,
   record their signatures, and prove they run the packaged entrypoint from a copied artifact after
   the checkout and developer Node path are unavailable. No destination Mac compilation is allowed.
3. **Transactional installer.** Add install, upgrade, rollback, and inspect commands with injected
   filesystem and launchctl adapters. Test unsafe-path preservation, exact manifest verification,
   loaded-role refusal, failure at every publication step, restoration of the prior selection, and
   byte-for-byte preservation of synthetic `~/.ellie` and unrelated application data.
4. **Isolated lifecycle acceptance.** Under a fresh macOS user or VM, install from the archive, start
   synthetic coordinator and node configurations, run status and doctor,
   stop, upgrade, restart, and rollback. Exercise the existing real-process recovery test separately
   to show a coordinator interruption produces an unknown result and no replay. Do not use a live
   identity, service, Accessibility grant, or household endpoint for automated acceptance. Adapter
   tests may use an owned temporary home, but it does not isolate the fixed launchd labels.
5. **Distribution signing.** With release credentials available, enable hardened runtime as reviewed,
   sign the nested helper, Node runtime, launchers, and dashboard in inside-out order, notarize the
   final archives, staple applicable artifacts, and run Gatekeeper assessment on a separate Mac.

A development candidate is installable for isolated local testing after gates 1–4. Public release
remains blocked on Apple Developer Program credentials, stable Developer ID signing, hardened-runtime
compatibility, notarization and stapling, Gatekeeper validation on a clean Mac, and physical checks
for Keychain, Accessibility, Local Network, microphone, login/reboot, sleep/wake, and both supported
architectures. The iPhone app separately needs an assigned team, provisioning, physical-device
Keychain and Local Network consent, and attended device acceptance. None of those permissions or
credentials should be requested by the artifact builder or unattended installer.
