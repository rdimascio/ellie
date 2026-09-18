# Offline service payload builder

`bun run services:package -- --node-archive PATH --node-sha256 SHA256 --bun-cache PATH --output PATH` prepares a
checkout-free development payload from a completely clean source revision. `PATH` must name an
official architecture-specific Node.js 24 macOS `.tar.xz` archive. The command never downloads a
runtime and never substitutes the Node executable that happens to run the builder.

The checksum is an operator-supplied trust input: the offline builder proves that the supplied
archive matches it, but does not independently establish that it came from Node. Obtain and record
the archive and checksum through a separately reviewed release-input step. Node publishes
versioned macOS archives and `SHASUMS256.txt` in its [official release directory](https://nodejs.org/download/release/latest-v24.x/).
Node's versioned [license file](https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE)
contains the runtime license and bundled third-party notices; the builder extracts that exact file
from the verified archive.

The builder captures one clean Git revision and uses that revision explicitly for every source
read. It installs the frozen dependency graph from Bun 1.4.2's explicit pre-populated cache with
network access disabled and lifecycle scripts ignored. Bun and the browser-asset build receive only
an owned temporary home, temporary directory, cache path, and minimal executable path. It then builds the browser pairing assets, computes the runtime workspace
closure, and replaces workspace links with ordinary JavaScript package facades that resolve copied
TypeScript source outside `node_modules`. It requires license files and declared license identifiers
for every external production package. It compiles an ad-hoc development helper, writes a per-file
payload manifest, round-trips manifest verification, and creates a ZIP plus `SHA256SUMS`. Output and
runtime caches belong outside the repository and remain ignored. Populate and review the Bun cache
as a separate release-input step; a missing cached package fails the build.

The ZIP omits resource forks, extended attributes, quarantine, and ACLs. None are part of the
manifested runtime identity. This keeps macOS AppleDouble metadata from inflating the archive
entry count beyond the bounded offline runtime check; the builder still verifies extracted app
signatures and the complete manifest after the ZIP round trip.

The payload includes the complete unpacked browser companion at
`payload/lib/ellie/apps/browser-media-extension`. Its manifest entrypoints and transitive literal
relative JavaScript references are checked before copy and in the copied payload; release
verification repeats the closure check when the directory is present. This avoids provider-module
lists in the builder while rejecting a missing controller. An older release without that directory
remains valid for rollback, but does not provide a packaged companion. Loading the extension in a
browser is a separate attended step using the same exact release as its native messaging host.

The development payload has a finite inventory budget shared by the builder, native inspector,
and bundled launchers: at most 3,072 files and 4,096 total file/directory entries, depth 16,
128 MiB per file, 512 MiB of files in total, and a 4 MiB manifest. The builder rejects an
over-budget payload before publication. This bound accommodates the current pinned AI SDK while
retaining the other native inspection checks. Changing it also changes the authenticated v2
inspection-policy digest; it does not make a development payload eligible for production activation.

This builder targets only its current Mac architecture. It verifies both the archive name and the
extracted runtime's reported architecture; cross-building the native helper is outside this slice.
The helper explicitly targets macOS 14.0, and the builder checks its Mach-O architecture and build
version before recording them in the manifest.

The payload also contains prebuilt **Ellie Coordinator** and **Ellie Node** launchers with the stable
bundle identifiers in the distribution plan. Each launcher has one compiled role. At runtime it
accepts the release root only as launchd's working directory, validates the complete declared
payload and its read-only installed-mode projection, removes Node preload and certificate override
environment variables, pins the executable path, and executes the packaged Node 24 CLI. It passes
the verified packaged native helper through a dedicated absolute environment value; Keychain,
desktop execution, and diagnostics share that resolver. Existing checkout workflows retain the
`~/.ellie/bin/ellie-macos` fallback.

The output remains owner-writable preparation material. The included native installer verifies it
and stages an unselected immutable release. Selection and rollback stay outside this foundation.

Each expanded archive now contains the prebuilt native command
`payload/bin/ellie-service-installer`. `inspect RELEASE_DIRECTORY` verifies the exact manifest,
payload contents, modes, architecture, and installer-controlled ad-hoc development identities.
`stage RELEASE_DIRECTORY` copies through no-follow file descriptors into the current user's fixed
`~/Library/Application Support/Ellie/Services/releases` directory, verifies the copy again, removes
write access from every payload file and directory, and verifies that installed-mode projection.
It keeps the private staging root at 0700 for the no-replace rename required by macOS 15, then
immediately seals the renamed root to 0555 and syncs the root and releases directory. The launcher
requires a 0555 release root, so an incomplete 0700 publication cannot run. The published name is
derived from the product version, full source revision, and architecture. Staging requires no
installed Node, Bun, checkout, or build tools.

An older installed launcher retains its compiled file limit. A stopped upgrade must select the new
release through the supported installer transaction so the selected application and launcher come
from that release; pointing an old launcher directly at a larger new payload is unsupported.

Staging does not select the release: it does not create or update a receipt, application,
LaunchAgent, service state, private Ellie identity, or Keychain item. Installer-controlled ad-hoc
signature checks protect development payload integrity; they do not establish Developer ID
authenticity. Selection, upgrade, crash journal, and rollback transactions remain a later gate.
If failure cleanup cannot remove the installer's exact private staging directory, the command
reports a fixed cleanup-incomplete result and retains that evidence. If the final no-replace rename
succeeds but sealing the release root or a subsequent directory sync fails, it reports publication
uncertainty and retains the unselected release. A retry accepts a 0700 root only after verifying its
entire installed-mode contents, identity, and manifest against the requested source, then seals and
syncs it. A mismatch is preserved without changing its mode. Retrying never selects or starts the
release.

The copied CLI, Node runtime, role launchers, and native helper resolve from the payload without the
checkout. LaunchAgent generation, final app and helper publication, and service start remain later
installer and lifecycle work.

`verifyManifest` validates builder-owned staging and archive round-trip trees: exact top-level
layout, regular no-follow metadata files, allowed payload modes, hashes, and exact `SOURCE.txt`
agreement. It is not an installer verifier for a concurrently hostile filesystem; descriptor-relative
validation and copying are implemented by the shipped native `inspect` and `stage` commands.

The launcher deliberately rejects the builder's owner-writable 0644/0755 preparation tree. The
native installer verifies it first and publishes the exact corresponding 0444/0555 file modes and
0555 directory modes. This slice does not select an installed release or mutate launchd.

This slice does not install LaunchAgents, update a running service, access `~/.ellie` or Keychain,
or create distribution signatures. The helper signature is for isolated development validation.
Developer ID signing, notarization, installation, upgrade, and rollback remain separate gates in
the checkout-free service distribution plan.
