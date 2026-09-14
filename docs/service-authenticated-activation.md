# Authenticated service activation contract

This is the next production boundary after authenticated candidate capture. It atomically binds selection, recovery, lifecycle control and direct launch to the same independently trusted publisher policy and captured evidence. It does not start a service, change household identity, grant permissions, discard candidates or add Developer ID credentials.

## Closed authority

The shipping build must receive an explicit public Ellie Team ID and a closed policy definition. It embeds one canonical policy record in the installer and both role launchers. Swift and the external artifact auditor must read the same record; a separate audit marker alongside independently generated Swift constants is insufficient. A shipping binary with no configured policy, a malformed Team ID or ad-hoc policy must refuse authenticated activation and launch. Candidate fields, receipts, command arguments and environment variables never select or weaken this policy.

The test build may compile a separate explicit ad-hoc relaxation. That flag must be absent from shipping binaries and preserves every topology, hash, identity, mode, receipt and recovery check.

`AuthenticatedActivationPolicyV1` is canonical sorted-key JSON with a trailing newline. Its SHA-256 is `trustedPolicyDigest`. Its exact fields are:

```json
{
  "authorizationFormatVersion": 1,
  "candidateBindingScope": "authenticated-candidate-capture",
  "candidateBindingVersion": 1,
  "digestAlgorithm": "sha256",
  "envelopePolicyDigest": "<compiled 64 lowercase hex>",
  "launcherVerification": "full-candidate-and-installed-role-v1",
  "payloadPolicyDigest": "<compiled 64 lowercase hex>",
  "publisherTeamID": "<compiled 10 uppercase alphanumeric>",
  "receiptVersion": 2,
  "roles": [
    { "bundleIdentifier": "org.ellie.assistant.coordinator.app", "name": "coordinator" },
    { "bundleIdentifier": "org.ellie.assistant.node.app", "name": "node" }
  ],
  "scope": "authenticated-service-activation",
  "selectionJournalVersion": 2,
  "version": 1
}
```

The compiled envelope and payload digests must be recomputed from the same closed policy constructors used by verification. A change to any trusted requirement, identifier, entitlement, native inventory, parser bound, verification mode, receipt meaning or launcher evidence rule requires the corresponding policy version/digest update. Renaming a policy without changing its digest has no effect.

## Candidate verification seam

Extract one internal, descriptor-based verifier shared by installer, lifecycle and launcher builds. It accepts only a candidate ID under the canonical existing `Services/authenticated-candidates` directory and the compiled policy. It must:

- require the candidate ID to equal SHA-256 of exact canonical `binding.json` bytes;
- require binding version/scope, authorization version, Team ID, envelope policy digest and payload policy digest to equal compiled values;
- reopen and bind the canonical home-to-Services-to-namespace-to-candidate chain;
- fully reverify captured modes and closed topology, authorization signature/resources, manifest and source bytes, every payload file, native inventory, signatures, identifiers and entitlements;
- locally recompute the complete binding tuple and compare exact bytes;
- return held directory identity plus immutable per-role file inventory; and
- rebind ancestors, candidate and relevant installed destinations immediately before mutation or execution.

It must not execute the candidate's installer. Capture remains unselected and gains no receipt or launch authority.

## Command and whole-receipt transition

Add a distinct command with closed grammar, for example:

```text
select-authenticated --coordinator CANDIDATE_ID --node CANDIDATE_ID
```

At least one role is required, each appears at most once and arguments are in fixed role order. Every currently selected role must be supplied as an authenticated candidate in the same transaction; omission is allowed only for an already unselected role, and this command does not deselect. A receipt v2 update likewise supplies every selected role. No receipt may mix v1 and v2 role records. Legacy `select RELEASE` must reject when receipt v2 or a v2 journal exists and must never resolve `authenticated-candidates`.

All roles must be unloaded before the transaction. The stopped preflight may use the existing bounded read-only launchctl queries. Successful selection installs and seals role applications and plists, writes receipt v2 and completes recovery, but sends no mutating launchctl command and does not start a role. Existing stopped receipt-v1 migration and its journals keep their current semantics; they cannot target or produce receipt v2.

## Receipt v2

`receipts/installed.json` remains owner-only mode `0600`, canonical sorted-key JSON plus newline. The exact top-level keys are `version`, `scope`, `trustedPolicyDigest`, `coordinator`, and `node`. `version` is `2`, scope is `authenticated-service-selection`, the digest is 64 lowercase hex, and each role is either `null` or this exact record:

```json
{
  "appSHA256": "<64 lowercase hex>",
  "authorizationRecordSHA256": "<64 lowercase hex>",
  "authorizationVersion": 1,
  "candidateID": "<64 lowercase hex>",
  "envelopePolicyDigest": "<64 lowercase hex>",
  "manifestSHA256": "<64 lowercase hex>",
  "payloadPolicyDigest": "<64 lowercase hex>",
  "plistSHA256": "<64 lowercase hex>",
  "publisherTeamID": "<10 uppercase alphanumeric>",
  "releaseID": "<canonical manifest-v2 release ID>",
  "sourceSHA256": "<64 lowercase hex>"
}
```

Every non-null role record must equal a freshly verified candidate binding and the compiled policy. `appSHA256` is the existing canonical installed role inventory digest, computed from manifest hashes; `plistSHA256` hashes exact generated plist bytes. Candidate ID already binds the exact canonical binding bytes, so a second binding digest field is forbidden.

Receipt v1 parsing remains exact. Receipt dispatch first validates the closed top-level key set and version; unknown versions, v1 fields in v2, v2 fields in v1, malformed nulls and noncanonical bytes require recovery. Once any receipt v2 commits, selection and recovery never write receipt v1.

## Journal v2 and recovery

The journal remains at the existing `Services/selection-journal.json` path. Version 2 has exactly `version`, `transactionID`, `roles`, `oldReceipt`, and `newReceipt`. `newReceipt` is exact canonical receipt-v2 bytes encoded by `Data`, as in v1. `oldReceipt` is either encoded exact canonical receipt bytes or JSON `null`; null means there was no installed receipt and is valid only when no selected app or plist exists. `roles` is the fixed ordered set of every non-null role in `newReceipt`. An old receipt may be v1 only for the single whole-state v1-to-v2 transition, or v2 only when its `trustedPolicyDigest` equals the new receipt and the verifier's compiled digest. A v2-to-v1 transition, mixed receipt or selected-policy rotation is invalid.

Before writing the journal, fully verify every new candidate and the current installed state under its actual receipt version. Before every app/plist move and before receipt commit, reverify and rebind the relevant candidate and source/destination ancestors. New staged and target applications are checked against receipt v2 and their authenticated candidates. Old v2 targets and backups use the same compiled policy and candidate verification. Old v1 targets and backups have no authenticated candidate and are checked only through the exact existing v1 release, application, plist and signature rules.

Recovery is phase-directed by the installed receipt. If it equals `newReceipt`, v2 is committed: recovery may only finish the v2 state, validate any old v1 backup with v1 rules before removing it, and never restore v1. If it equals non-null `oldReceipt`, or is absent when `oldReceipt` is null, receipt v2 is not committed: recovery may roll back using the old receipt's exact version-specific rules. Any other receipt state is recovery-required. A missing, substituted or unverifiable new candidate prevents forward completion; after v2 commit it must retain all evidence rather than downgrade. A mismatch between an existing v2 receipt's policy digest and the compiled policy is likewise recovery-required; support for bounded previous policies and explicit policy migration is deferred.

A candidate referenced by either receipt or journal is retained in `authenticated-candidates`. This slice performs no garbage collection or discard. Existing namespace quotas continue to count it honestly.

## Lifecycle and launcher enforcement

`withLifecycleSelection` dispatches receipts by exact version under the existing shared selection lock. For v2 it fully verifies every selected role's candidate, installed app and plist before reporting selected status or issuing launchctl, and repeats canonical ancestor/receipt/candidate validation in the existing revalidation closure immediately before mutation.

Each installed production launcher compiles the same policy and Security-backed verifier. On `--launch-agent`, it derives the canonical owner Services root, reads receipt v2, selects only its compile-time role, verifies the complete role record and referenced candidate, verifies its own installed app bytes and signature against that candidate, and executes Node/helper/entrypoint only from the verified candidate release. The generated plist uses that exact candidate's `release` directory as `WorkingDirectory`. Missing receipt v2, receipt v1, wrong role, policy mismatch, changed candidate, changed installed app/plist, unsafe ancestor or noncanonical evidence exits before `exec`.

`--register` retains its current bounded registration behavior and grants no launch authority.

## Behavioral acceptance

Tests use isolated synthetic roots and fixed finite subprocess bounds. They must cover:

- valid one-role and two-role v1-to-v2 activation, v2 replacement, idempotence and no autostart;
- every receipt and candidate binding field changed independently, noncanonical schemas, same-policy v2 updates and selected-policy rotation remaining recovery-required;
- missing build policy and shipping rejection of ad-hoc candidates, with test relaxation absent from shipping;
- external candidate, authorization, manifest, payload, native signature and ancestor substitution before each mutation boundary;
- installed app and plist substitution, hardlinks, symlinks, wrong modes and signatures;
- legacy select against v2 state, authenticated select with a v1 release, partial-role conversion, mixed receipts and v2-to-v1 downgrade;
- every journal/app/plist/receipt fault point, fresh null-old recovery, pre-commit v1 rollback, post-commit v2-only forward completion, mismatched journal versions and missing referenced candidates;
- lifecycle status/start/stop refusal on each evidence mismatch without launchctl mutation;
- direct launcher refusal for v1/missing/mismatched receipt, policy, candidate, installed app or working directory, plus successful V8, worker, crypto and loopback TLS execution from a valid candidate; and
- retained candidates continuing to count toward quota while selection, recovery, lifecycle and migration preserve their existing locks, deadlines, descriptor bounds and finite-child ownership.

## Fit and build input

The design fits the existing single `installed.json`, `Services/selection-journal.json`, selection lock, stopped-role preflight, role-specific installed apps and launch plist working directory. Journal v2 makes `oldReceipt` optional rather than synthesizing an empty v1 receipt, while retaining exact embedded bytes when a receipt exists. It requires splitting currently private capture/inspection helpers into compile-safe shared sources and updating installer and launcher compiler input lists together.

The production builder adds required `--publisher-team-id TEAMID` input for the authenticated production mode. It validates literal bounded ASCII, computes the closed envelope, payload and activation policy digests, and emits deterministic policy bytes rather than accepting runtime authority. Development and production compiler flags remain separate; missing production policy fails the build and development never silently selects ad-hoc authority for production. Artifact audit must recover and assert the compiled policy from each finished installer and launcher against the independently expected build record and manifest before packaging, without executing those artifacts. The Swift consumer reconstructs the canonical policy using the compiled CPU architecture and requires exact equality; the payload-policy digest binds that architecture even though the activation record has no separate architecture field. No signing credential or private key belongs in this input or generated source.
