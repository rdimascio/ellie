# Service distribution trust

The packaged service candidate is currently a development artifact. This document defines the public-distribution boundary before Developer ID support is added. It does not certify an artifact or authorize an installed upgrade.

## Authenticate the manifest as well as native code

The current release is a directory containing `SOURCE.txt`, `manifest.json` and `payload`. Its manifest detects changed payload files, but the directory itself does not authenticate the manifest. Checking a helper's signature or identifier alone therefore cannot establish the origin of the TypeScript and other resources that Node will execute.

Public distribution must provide an independently trusted bootstrap installer whose code-signature resource seal covers the exact manifest bytes. The bootstrap verifies that sealed resource before interpreting the candidate release, requires the external manifest to match byte for byte, then verifies every declared payload file, mode and path. `SOURCE.txt` must also match its sealed source record. A changed script with a recomputed external manifest must fail this check.

The authorization bundle must live outside the manifest's payload inventory to avoid a circular signature/hash dependency. The native code is signed first, the final manifest is generated next, and the bootstrap's manifest resource is sealed last. The installed release retains that authorization bundle unchanged so later inspection, selection and launch can revalidate the same authenticated manifest.

The bootstrap's initial trust comes from a trusted distribution channel or an explicitly pinned publisher policy acquired independently of the candidate. Gatekeeper and notarization are additional gates; acceptance by Gatekeeper alone does not identify a download as Ellie. Neither a manifest's Team ID nor a program's self-reported signing identity is a trust root. Apple's [code-signing policy discussion](https://developer.apple.com/library/archive/technotes/tn2206/_index.html) distinguishes signature validity from the policy used to trust it.

## Explicit policy and compatible state

The trusted verifier selects one closed policy before reading release metadata:

- Development policy accepts the existing version-1 development format. It confers no publisher authenticity and remains available for stopped legacy migration.
- Developer ID policy requires an independently pinned Ellie Team ID, fixed component identifiers, the authenticated manifest and an inventory of every payload Mach-O. The bootstrap is verified separately as the outer trust root; its exclusion from the payload inventory is not an exemption from signature validation. This policy never falls back to development policy.

Developer ID code requirements must constrain the Apple-issued Developer ID Application certificate chain, the expected Team ID and the fixed identifier. The verifier must validate signatures and resources with strict, all-architecture checks and validate nested code explicitly. Requirements come from trusted code or private owner configuration, never arbitrary requirement strings in the payload. Apple's [requirement-language reference](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html) describes the certificate and identifier constraints.

Receipts and retained authorization evidence must bind a versioned authorization format, an immutable canonical trusted-policy digest and the authenticated manifest SHA-256. The policy digest covers its format version, pinned Team ID, component identifiers, requirement templates and native-inventory rules; a human-readable policy name alone is insufficient. Selection, launch, upgrade and rollback must compare that exact binding. Changing an owner-configured policy under the same name cannot silently authorize an existing release. A development receipt cannot replace a production receipt. Existing development and legacy records remain readable for their stopped migration operations, but are not implicitly eligible production rollback targets. File restoration continues to report runtime compatibility separately.

This policy protects distribution authenticity and accidental or external artifact replacement. It does not claim to defend against an attacker already able to rewrite all state and executables as the owning macOS user.

## Node and nested code

The inspected official Node 24.21.0 arm64 archive is checksum-verified, but its signed executable includes `get-task-allow=true`. Its upstream [entitlement file](https://github.com/nodejs/node/blob/v24.21.0/tools/osx-entitlements.plist) also includes several runtime exceptions. The copied executable therefore needs an explicit Ellie signing policy; retaining every upstream entitlement is not a suitable default for public distribution.

The first runtime experiment uses an owned copy with ad-hoc hardened signing and exactly `allow-jit` and `allow-unsigned-executable-memory`. Tests must exercise actual V8, workers, crypto and loopback TLS behavior. Broader exceptions require a reproduced failure and a reviewed justification. Ad-hoc success does not establish Developer ID library-validation behavior or notarization acceptance.

The builder must inventory native code by file bytes, not filename extensions, reject undeclared native code and sign nested code before its host. The current service dependency closure is JavaScript; future native add-ons must be reviewed and included explicitly. Production signing must remove debugging authority, use a secure timestamp and apply only the reviewed executable entitlements. The final product still requires Apple's [notarization and distribution checks](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

## Reviewable implementation sequence

1. Validate the narrowed Node entitlement set with a finite, isolated harness. Keep the production builder unchanged until the result is reviewed.
2. Add the authenticated-manifest verifier and sealed authorization-bundle layout with tests for changed resources, substituted manifests, incorrect publisher policy and untrusted native components. Keep production mutation unavailable until the receipt and launch binding is implemented; never expose a partially trusted install path.
3. Bind installed receipts, selection, recovery and launch to the verified policy. Preserve the existing stopped development migration contract and reject downgrade or mismatched recovery evidence.
4. Connect the production builder to an explicit private Developer ID identity, sign inside out, verify every component and create the sealed bootstrap. Refuse missing identity or incomplete native-code inventory; never silently substitute ad-hoc signing.
5. With the owner's signing credentials and an isolated logged-in macOS context, notarize and staple the final artifact, verify its publisher and Gatekeeper behavior, then exercise installed identity/Keychain/Accessibility continuity, lifecycle recovery and one explicit cross-Mac action.

The first slice is published in [PR75](https://github.com/rdimascio/ellie/pull/75), with a passing isolated physical Mini workload and source gate. Its GitHub checks remain a separate gate. The remaining slices are a reviewed design direction, not implemented or accepted production behavior. No Team ID or signing credential is checked into the public repository.
