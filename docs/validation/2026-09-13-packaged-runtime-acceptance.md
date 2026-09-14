# Packaged runtime derivative acceptance — 2026-09-13

Status: **passed for the derivative scope below.** Two earlier draft runs exposed `EPERM`
during negative process-group signaling and retained their owned diagnostic roots. That
rejected cleanup design was removed. The reviewed runner now signals only retained direct
role handles and completed a fresh bounded run with `cleanupCertain: true`.

Source revision: `1934afbb8b0085f34f64f9962e84009b9b867ad6`  
Original archive SHA-256: `f335cdd7e75c8f746d56fc31769258891e00091f91622f0adea1577e5aa097a1`  
Original manifest files: 421

The original release was built from the clean source revision with Node.js 24.21.0, Bun
1.4.2, the reviewed Node archive SHA-256
`6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe`, and the
explicit offline Bun cache. The acceptance runner checks the unchanged ZIP digest,
expands that exact archive into its owned root, and runs the shipping installer `inspect`
command against the extracted release before making a derivative.
The manifest records `sourceModified: false`. This independently rebuilt `f335…` archive
is the candidate exercised here; it is distinct from the separately existing archive
whose observed checksum begins `d107…`.

Before writing any archive member, the runner validates the complete ZIP central
directory: at most 4,096 entries, depth 16, 128 MiB per file, 512 MiB expanded total,
ASCII relative paths, one exact release root (plus bounded macOS metadata for that root),
canonical components with no empty aliases, unique names, regular files/directories only,
and matching local headers for release and metadata entries. Its own extractor checks each
expanded size and CRC before an exclusive write. Focused regressions reject an extra
top-level root, an empty-component alias, a central/local name mismatch, and an
expanded-size excess without extracting any archive.

The executable acceptance uses an owned copied release. It replaces only
`payload/helpers/ellie-macos` with the finite synthetic helper, changes only that file's
size and SHA-256 manifest fields, and projects the complete derivative to installed
read-only modes. The original helper hash was
`9acb252be2234367cb93627028a6fab9cafeaee45abf3ca0c4d9b96ddcdc8193`; the synthetic
helper hash in this run was
`6d44f50fb1c1ea15e8de744e48c34d968c39dbea37b0cf59931868171e5dfda8`.
The same helper is copied to the owned `.ellie/bin/ellie-macos` path solely to satisfy the
baseline service validator's legacy executable-presence check. Actual helper calls use
the packaged path set by the verified launcher.

The runner used both unchanged shipping launcher executables, packaged Node 24, and the
packaged CLI. It created synthetic coordinator and node configurations, TLS identity,
controller/node credentials, and effect files under one private temporary HOME. Both
roles used one isolated loopback HTTPS origin. It observed:

- coordinator start and API readiness;
- node start, registration, stop, restart, and reconnection;
- one delivered `app.open` effect interrupted by a coordinator kill;
- the recovered job state `unknown_after_restart`;
- no replay after both roles restarted; and
- one fresh explicit `app.open` effect completing afterward.

Role stdout, stderr, and stdin were ignored so a bootstrap descendant could not retain
the runner's pipes. Cleanup signaled only each retained direct role handle, escalated that
same handle from TERM to KILL when needed, and required its exit event and reap. A private
per-run token released the intentionally blocked synthetic helper; its acknowledgement
proved only receipt of the release. The runner separately required every recorded helper
PID to disappear. After direct-role reaping, bounded `ps` checks verified both process
groups were empty; these checks are read-only and never authorize signaling. Only then did
the runner remove its exact owned temporary root. Uncertain cleanup retains the root and
reports its path.

Command (paths are explicit build artifacts, not repository inputs):

```sh
/path/to/node-v24.21.0/bin/node \
  scripts/test-packaged-runtime.mjs \
  /path/to/EllieServices-0.1.0-dev-1934afbb-macos-arm64.zip \
  f335cdd7e75c8f746d56fc31769258891e00091f91622f0adea1577e5aa097a1 \
  1934afbb8b0085f34f64f9962e84009b9b867ad6
```

Result: exit 0. The runner reported two effects, no replay, both roles, and the exact
source revision and hashes above, including `cleanupCertain: true`. The focused archive,
direct-process, and helper-release regressions passed 5/5. `bun run check` passed 275 tests
with one platform smoke test skipped; lint, formatting,
contract generation, TypeScript checks, and the Vite production build also passed.

This is derivative runtime acceptance. It does not execute the unchanged production
helper, use Keychain or TCC, mutate launchd, install a release, test lifecycle selection,
exercise LAN transport, or prove signed/notarized distribution. The initial runner
attempt exited before its main function because checkout dependencies were absent; it
launched no role process. Dependencies were then installed offline with scripts disabled.
A later archive-binding preflight used macOS's symlinked temporary-directory spelling,
which the shipping inspector correctly rejected before any role launch. The runner now
canonicalizes its owned temporary root before inspection.

The separate preview relaunch, offline-row, Safari-control, and physical sleep/wake checks
are hardware evidence recorded by their owner. They are not part of this packaged-runtime
derivative run.
