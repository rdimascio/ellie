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

This builder targets only its current Mac architecture. It verifies both the archive name and the
extracted runtime's reported architecture; cross-building the native helper is outside this slice.
The helper explicitly targets macOS 14.0, and the builder checks its Mach-O architecture and build
version before recording them in the manifest.
The output remains owner-writable preparation material. A future transactional installer must
verify it and remove write access before describing an installed release as immutable.

The copied CLI and Node runtime resolve their JavaScript dependencies without the checkout. The
current CLI still expects the native helper at `~/.ellie/bin/ellie-macos`, and this slice includes a
prepared helper without changing that production resolution. Isolated acceptance may copy that
helper into a synthetic home. Role launchers, their final helper placement, and a self-contained
service start remain later work.

`verifyManifest` validates builder-owned staging and archive round-trip trees: exact top-level
layout, regular no-follow metadata files, allowed payload modes, hashes, and exact `SOURCE.txt`
agreement. It is not an installer verifier for a concurrently hostile filesystem; descriptor-relative
installation validation remains part of the installer slice.

This slice does not install LaunchAgents, update a running service, access `~/.ellie` or Keychain,
or create distribution signatures. The helper signature is for isolated development validation.
Developer ID signing, notarization, installation, upgrade, and rollback remain separate gates in
the checkout-free service distribution plan.
