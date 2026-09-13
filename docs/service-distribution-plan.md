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
  receipts/installed.json             # current and previous release IDs
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
- Keychain service and helper identity: the existing `org.ellie.assistant` contract

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
4. **Isolated lifecycle acceptance.** Under a fresh local test user or owned temporary home, install
   from the archive, start synthetic coordinator and node configurations, run status and doctor,
   stop, upgrade, restart, and rollback. Exercise the existing real-process recovery test separately
   to show a coordinator interruption produces an unknown result and no replay. Do not use a live
   identity, service, Accessibility grant, or household endpoint for automated acceptance.
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
