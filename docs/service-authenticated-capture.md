# Authenticated candidate capture implementation contract

Source reviewed: `da32f34db601a1a5fdb80aeddb091689838cfb58`.

This slice publishes an immutable, authenticated, **unselected** candidate under the existing service state root. It creates no receipt or launch authority. It does not use or change the separate `~/.ellie` identity root.

## Commands and result types

Add two production commands to the existing installer:

```text
capture-authenticated-payload RELEASE AUTHORIZATION_APP --publisher-team-id TEAMID
recover-authenticated-capture TARGET --publisher-team-id TEAMID
```

Tests may retain the existing explicit test services-root argument. Shipping commands always resolve the current per-user root:

```text
~/Library/Application Support/Ellie/Services
```

CLI grammar is closed and validated before opening or creating Services, the namespace or the lock. `capture-authenticated-payload` requires exactly the two nonempty absolute source paths followed by `--publisher-team-id` and a Team ID matching `^[A-Z0-9]{10}$`; canonical absolute-path component, length, dot/dotdot and NUL checks use the existing verifier rules. `recover-authenticated-capture` requires exactly one `TARGET`, the same fixed option and Team ID. `TARGET` must match either the exact lowercase UUID stage form `^\.capture-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` or `^[0-9a-f]{64}$`. Unknown, repeated or reordered arguments fail before state access.

`capture-authenticated-payload` first performs the existing external, read-only manifest-v2 authentication and payload inspection. Only a successful `AuthenticatedPayloadInspection` may enter the capture transaction. It returns a distinct `CapturedAuthenticatedCandidate` containing the candidate ID, release ID and five evidence digests. This type must not conform to or convert into `SelectionRelease`.

`recover-authenticated-capture` accepts exactly one strict `TARGET`: either a hidden `.capture-<lowercase UUID>` stage or a 64-character lowercase hexadecimal published candidate. It never scans and mutates all retained entries. A hidden target is verified solely from its captured release, authorization app and binding; it requires no external source fallback. A digest target similarly verifies and, if necessary, seals only that published candidate. The command either completes publication, reports that the exact candidate is already valid, or preserves the target with a fixed recovery-required error. It has no delete or discard mode in this slice.

Both success messages must say that the candidate is authenticated and captured but remains unselected and cannot run.

## Namespace and closed layouts

Create or open this exact namespace as an owned regular directory with mode `0700`:

```text
Library/Application Support/Ellie/Services/authenticated-candidates
```

The namespace contains only:

- `.capture.lock`, an owned regular single-link `0600` file;
- at most 32 retained hidden stages named `.capture-<lowercase UUID>`;
- at most 128 published candidates named by a 64-character lowercase SHA-256 binding digest.

Reject symlinks, hard links, special files, unknown top-level names, overlong names and a top-level entry count above 161. The streaming bounded no-follow namespace scan must also sum regular-file bytes across published candidates and retained stages and reject a total above 8 GiB, with overflow-safe accounting. It must stop after 65,536 total descendant entries across the namespace; directories consume this global count but add no bytes. It must not accumulate the full tree in memory. Directory enumeration must distinguish error from EOF and must not recurse beyond the capture topology/depth bounds. Creating or opening `.capture.lock` is the sole mutation allowed before this grammar/quota validation because it is necessary coordination. After locking, reject an invalid namespace before creating or changing candidate data. The capture lock is private to this namespace; do not create, acquire or interpret `Services/selection.lock`.

A published digest entry must always have the complete closed candidate topology. A hidden stage may be an untouched, bounded construction prefix: any subset of the fixed top-level `release`, `authorization` and eventual `binding.json` topology; ordinary payload paths must satisfy the shared safe relative-path/depth/count grammar; authorization paths must be a subset of the six fixed files and their implied directories. All present entries must be owned, no-follow, single-link regular files or directories with only the defined construction/final modes and per-file/total bounds. `binding.json`, when present, is allowed only with the complete release and authorization topology. A missing binding or incomplete allowed subtree does not invalidate the namespace and does not authorize recovery, publication or deletion. Unknown entries outside those construction-prefix rules, symlinks, hard links and special files reject the namespace before candidate-data mutation. Every partial stage remains counted against hidden-stage, entry and byte quotas.

A hidden stage and a published candidate have this exact topology:

```text
<root>/
  binding.json
  release/
    manifest.json
    SOURCE.txt
    payload/...
  authorization/
    Ellie Service Authorization.app/
      Contents/
        Info.plist
        MacOS/
          EllieServiceAuthorization
        Resources/
          manifest.json
          SOURCE.txt
          authorization.json
        _CodeSignature/
          CodeResources
```

No other file or directory is permitted. The release payload topology is exactly manifest v2's declared inventory and implied directories.

Published and fully prepared modes are:

| Entry                                                                         | Mode   |
| ----------------------------------------------------------------------------- | ------ |
| candidate root and every child directory                                      | `0555` |
| `binding.json`, release metadata, authorization plist/resources/CodeResources | `0444` |
| manifest-declared payload file originally `0644`                              | `0444` |
| manifest-declared payload file originally `0755`                              | `0555` |
| authorization executable                                                      | `0555` |

The namespace remains `0700`; the lock remains `0600`. During construction only the hidden stage root and not-yet-sealed child directories may be `0700`. Published roots may temporarily remain `0700` only in the post-rename recovery state described below.

The authorization copy is not a generic recursive bundle copy. Enumerate and copy the six fixed regular files above through held directory descriptors with no-follow opens, captured pre/post metadata, owner and single-link checks, and fixed per-file limits:

- Info.plist: 64 KiB
- authorization executable: 16 MiB
- CodeResources: 1 MiB
- sealed manifest: 4 MiB
- sealed SOURCE: 16 KiB
- authorization.json: 4 KiB

The payload retains the shipping limits: 4 MiB manifest, 16 KiB SOURCE, at most 2,048 manifest files, 4,096 total entries, depth 16, 128 MiB per file and 512 MiB total. Test builds retain the existing smaller shared-constant variant (100 files and 128 entries); capture must reuse those constants rather than restating shipping values in executable logic. The complete capture adds exactly 9 regular files beyond the manifest payload inventory: release manifest and SOURCE, six authorization files, and `binding.json`. `binding.json` is at most 4 KiB. Every numeric addition must be overflow checked.

## Canonical binding

Derive binding only from a successful verification of the **captured and mode-converted** bytes. Never accept binding fields from the supplied release.

Canonical `binding.json` has exactly these sorted-key fields and a trailing newline:

```json
{
  "authorizationRecordSHA256": "<64 lowercase hex>",
  "authorizationVersion": 1,
  "envelopePolicyDigest": "<64 lowercase hex>",
  "manifestSHA256": "<64 lowercase hex>",
  "payloadPolicyDigest": "<64 lowercase hex>",
  "publisherTeamID": "<10 uppercase ASCII>",
  "releaseID": "<bounded existing release ID>",
  "scope": "authenticated-candidate-capture",
  "sourceSHA256": "<64 lowercase hex>",
  "version": 1
}
```

Extend the read-only envelope result narrowly to return the copied authorization-record digest; do not return or trust candidate-provided authority. The envelope and payload policy digests already bind their actual trusted requirement and inventory policies. `publisherTeamID` is independently supplied and included explicitly so later consumers need not infer the authority tuple.

The candidate ID is SHA-256 of the exact canonical `binding.json` bytes. The capture verification result carries all fields and the ID separately. A future change to topology, modes, binding fields or capture semantics requires binding version 2; it must not reinterpret version 1.

## Transaction and durability order

1. Fully inspect the external release and authorization app with the existing external-mode verifier. Retain its copied authenticated manifest bytes and parsed entries as the only payload-copy admission list; never parse the mutable external manifest a second time to choose source paths. No service-state path is created on rejection.
2. Resolve the existing production Services root through the same descriptor-based initializer used by current staging. If required ancestors are newly created, use their current private modes and fsync each new child and its parent before proceeding. Open and retain the canonical Services descriptor chain, verify owner/type/modes, create/open `authenticated-candidates` as `0700`, fsync a newly created namespace and Services, then create/open and acquire nonblocking exclusive `flock` on `.capture.lock`. Identity/config under `~/.ellie` is never initialized or touched.
3. Reopen the canonical chain and prove the namespace device/inode matches the held descriptor. Reject contention without retry.
4. With only the lock created if it was absent, validate the bounded namespace grammar, counts and 8 GiB byte quota. From the already authenticated manifest entries and the bounded exact six-file authorization inventory, compute the prospective stage before `mkdirat`: payload bytes plus release manifest/SOURCE bytes plus all authorization bytes plus a 4 KiB binding reserve; and the exact payload descendant count plus 18 fixed capture entries (stage root, release/payload/authorization bundle directories, metadata, six authorization files and binding). Require hidden-stage count `< 32`, current top-level count plus one `<= 161`, current bytes plus projected bytes `<= 8 GiB`, and current descendant count plus projected entries `<= 65,536`, all with checked addition. If the deterministic digest already exists, the implementation may avoid stage capacity only through the no-stage idempotence route below. If it does not exist, require published count `< 128`; a full published namespace rejects a new digest. Never transiently exceed any quota. Create one UUID hidden stage with `mkdirat(..., 0700)` only after these checks; retain its descriptor.
5. Write release metadata from the verifier's copied bytes, copy the manifest-declared payload through held descriptors, and copy the exact authorization layout. Use fresh regular files with `O_EXCL|O_NOFOLLOW|O_CLOEXEC`; never preserve source ownership, extended attributes or arbitrary metadata.
6. Convert payload and authorization files to the table above; recursively seal child directories `0555`. Keep only the stage root `0700`.
7. Run the complete authenticated-payload verifier against `stage/release` and `stage/authorization/Ellie Service Authorization.app` in explicit captured-layout mode. Signature checks occur after conversion. External-mode inspection remains unchanged.
8. Derive and write canonical `binding.json` as a fresh `0444` file, fsync it, then reopen and decode it with strict closed grammar.
9. Reopen the canonical Services/namespace/stage path. Compare root and child device/inode/owner/mode metadata with the held descriptors. Fully rerun authorization seals/signatures, external-byte equality within the captured pair, manifest inventory/hashes/Mach-O policy and canonical binding derivation. Require the recomputed candidate ID to equal the intended publication name.
10. Fsync every modified file when written, all sealed child directories bottom-up, the `0700` stage root, and the namespace.
11. If the candidate ID is absent, publish with `renameatx_np(..., RENAME_EXCL)` while the stage root is still `0700`.
12. Fchmod the held published root to `0555`, fsync it, reopen the canonical candidate path and fully revalidate it, then fsync the namespace.
13. Release the lock only after success or after failure handling completes.

After external verification computes the deterministic binding, an already-present digest may take an explicit no-stage idempotence route: under the lock, reopen and fully verify the captured candidate against the externally authenticated evidence, require final `0555` mode and all ancestor rebinds, then report success without creating a stage. A `0700` digest requires explicit recovery and cannot use this shortcut. This is the only route allowed when another hidden stage would exceed capacity.

If `RENAME_EXCL` reports an existing candidate, do not remove or replace it. Reopen that exact candidate and perform the same complete verification against the requested binding. A valid `0700` candidate is a recoverable post-rename publication: verify it completely, seal it `0555`, revalidate and fsync. A valid `0555` candidate is eligible for idempotent success only after this invocation removes its own still-hidden, fully verified UUID stage. That cleanup must use the proven descriptor/name ownership path; cleanup uncertainty returns the fixed cleanup-incomplete failure and preserves both entries rather than reporting success. Any candidate mismatch is recovery-required and both entries remain preserved.

Before reporting success, reopen the canonical Services-to-candidate chain and compare every retained ancestor and candidate identity. This is not an atomic filesystem snapshot against an attacker controlling the same account; retain the existing caveat.

## Descriptor ownership

Keep descriptor use bounded independently of manifest size. Retain only the canonical Services ancestors, namespace/lock, current stage or candidate root, and the single directory/file chain being copied or verified. Store bounded immutable metadata records for authenticated manifest entries and the six authorization files; do not retain one descriptor per payload file. Reopen each child relative to its held parent, validate before and after read/copy, close it before advancing, and perform final root/ancestor rebinds. The projected byte and entry accounting is therefore computable from the copied authenticated manifest entry records and the exact bounded authorization inventory without trusting a second source parse.

## Failure and recovery states

| State                                              | Required outcome                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| External inspection fails                          | No namespace or stage mutation                                                                          |
| Lock unavailable                                   | Fixed busy error, no retry                                                                              |
| Stage created; failure before exclusive rename     | Remove only this invocation's exact UUID stage after descriptor/owner/name checks                       |
| Pre-rename cleanup fails or ownership is uncertain | Return cleanup-incomplete and retain the exact stage                                                    |
| Complete stage root remains `0700` after crash     | Explicit recover command may fully verify and publish it                                                |
| Partial/malformed stage remains                    | Recovery-required; preserve it unchanged                                                                |
| Rename succeeded; root remains `0700`              | Publication-uncertain; next exact capture or recover fully verifies, seals and fsyncs it                |
| Root sealed but final rebind/fsync fails           | Publication-uncertain; preserve candidate                                                               |
| Existing valid `0555` candidate                    | Remove only this invocation’s fully verified hidden stage with certain cleanup, then idempotent success |
| Existing invalid/unknown candidate                 | Recovery-required; never replace or recursively remove it                                               |

Do not use unconditional recursive cleanup. Reuse `removeTree` only for the invocation's pre-rename UUID stage after the namespace and stage identities are still proven and enumeration remains within the closed bounds. Never remove a published digest name in this slice.

For a hidden-stage target, the explicit recover command derives the candidate ID by fully verifying the retained stage and its canonical binding, with no external source input. It publishes only to that exact digest name under the same lock and transaction order. If that digest already names a fully verified candidate, recovery removes only the named, fully verified stage after proving cleanup certainty; cleanup failure preserves it and fails. For a 64-hex target, recovery verifies and seals only that named post-rename candidate and never searches for a stage. The caller-supplied Team ID must equal the binding field and must pass the same production signature requirements. Missing or malformed binding is preserved, not reconstructed heuristically.

## Required code seams

- `ServicePayloadAuthenticatedInspection.swift`
  - Add explicit `.external` and `.captured` mode policies.
  - Add strict canonical binding encode/decode and a captured-pair verification function.
  - Do not expose a `SelectionRelease`.

- `ServicePayloadAuthorization.swift`
  - Add a fixed-layout descriptor copy/verification seam or return a fixed captured-file descriptor list.
  - Reuse the exact bundle topology, resource bounds, requirement and CodeResources validation.
  - Do not add arbitrary bundle traversal.

- New `ServicePayloadCapture.swift`
  - Own command parsing support, capture-specific namespace/lock, bounded authorization copy, binding, publication and recovery transaction.
  - Keep transaction and recovery state out of the already large installer source.

- `ServicePayloadInstaller.swift`
  - Add only narrow command dispatch and expose the reviewed descriptor/copy/fsync primitives needed by capture.
  - Reuse `writeCapturedFile`, descriptor-based payload copy, `makeImmutable`, fsync and exclusive rename through narrow helpers.
  - Parameterize destination file modes explicitly; do not silently reuse v1's `installed: Bool` as v2 policy.

No changes in this slice to `ServicePayloadSelection.swift`, `ServicePayloadLifecycle.swift`, migration, receipts, installed Applications, LaunchAgents, packaged launchers or identity/config storage.

## Consumer rejection and tests

The existing v1 stage command must reject manifest v2. `verifiedSelectionRelease` continues to resolve only `Services/releases/<releaseID>`; a candidate digest and a candidate release ID must both fail there. Lifecycle reads only receipt-selected applications. Migration and recovery must ignore `authenticated-candidates` and must not treat its lock or retained stages as selection evidence. Packaged launchers must not discover or execute candidates.

Add a new bounded `tests/service-payload-capture.test.ts` rather than enlarging the existing installer fixture test. Update the native source/compiler lists in `scripts/build-service-payload.mjs` and the shared fixture template only after its current owner reports quiescence; do not make simultaneous edits to the owned installer test file. Meaningful tests use unique owned roots and bounded subprocesses:

- successful capture, exact modes/topology, full reinspection, repeat no-stage idempotence at full capacity, and no leaked hidden stage;
- changed release source during payload copy and changed authorization resource/executable during authorization copy;
- substitution of each binding field and noncanonical/unknown/duplicate binding keys;
- wrong Team ID, authorization record, envelope policy, payload policy, manifest or source digest;
- symlink, hard link, FIFO, wrong owner/mode, extra/missing file, shipping/test constant variants, exact projected `payloadEntries + 18` accounting, hidden/published/top-level boundaries, and the 8 GiB namespace/65,536-descendant/depth/per-file/payload limits without transient overage;
- crash/fault points after stage creation, child sealing, binding fsync, pre-rename fsync, rename, root seal and final namespace fsync;
- valid and invalid competing candidates;
- explicit no-source recovery of a named complete pre-rename stage and a named post-rename `0700` candidate;
- safe bounded construction-prefix partial stages do not block unrelated capture, while malformed/unknown entries reject mutation; selected incomplete recovery and cleanup-incomplete evidence remain preserved;
- lock contention with a retained direct finite child that is observed and reaped before fixture removal;
- v1 stage/select/lifecycle/migration behavior unchanged and unable to consume either candidate ID or release ID from this namespace;
- shipping build rejects every test-only root, fault and ad-hoc publisher selector.

Negative subprocess results require a normal exit with the expected fixed status and redacted fixed error category, not merely nonzero. Test cleanup removes only roots whose finite children are reaped and whose operation completed with certain ownership; otherwise it retains the exact root.
