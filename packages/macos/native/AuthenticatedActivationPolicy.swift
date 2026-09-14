import CryptoKit
import Foundation

// This constructor defines deterministic policy bytes only. It does not compile policy authority
// into a binary or authorize candidate selection, installation, lifecycle control, or launch.

private struct AuthenticatedActivationRole: Codable {
  let bundleIdentifier: String
  let name: String
}

private struct AuthenticatedActivationPolicyV1: Codable {
  let authorizationFormatVersion: Int
  let candidateBindingScope: String
  let candidateBindingVersion: Int
  let digestAlgorithm: String
  let envelopePolicyDigest: String
  let launcherVerification: String
  let payloadPolicyDigest: String
  let publisherTeamID: String
  let receiptVersion: Int
  let roles: [AuthenticatedActivationRole]
  let scope: String
  let selectionJournalVersion: Int
  let version: Int
}

struct AuthenticatedActivationPolicyDefinition {
  let data: Data
  let trustedPolicyDigest: String
  let envelopePolicyDigest: String
  let payloadPolicyDigest: String
}

func authenticatedActivationPolicyV1(
  publisherTeamID: String, targetArchitecture: String
) throws -> AuthenticatedActivationPolicyDefinition {
  let envelope = try authenticatedEnvelopePolicyDigest(teamID: publisherTeamID)
  let payload = try authenticatedPayloadPolicyDigest(
    teamID: publisherTeamID, architecture: targetArchitecture)
  let value = AuthenticatedActivationPolicyV1(
    authorizationFormatVersion: 1,
    candidateBindingScope: "authenticated-candidate-capture", candidateBindingVersion: 1,
    digestAlgorithm: "sha256", envelopePolicyDigest: envelope,
    launcherVerification: "full-candidate-and-installed-role-v1", payloadPolicyDigest: payload,
    publisherTeamID: publisherTeamID, receiptVersion: 2,
    roles: [
      AuthenticatedActivationRole(
        bundleIdentifier: "org.ellie.assistant.coordinator.app", name: "coordinator"),
      AuthenticatedActivationRole(
        bundleIdentifier: "org.ellie.assistant.node.app", name: "node"),
    ],
    scope: "authenticated-service-activation", selectionJournalVersion: 2, version: 1)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  var data = try encoder.encode(value)
  data.append(0x0a)
  let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  return AuthenticatedActivationPolicyDefinition(
    data: data, trustedPolicyDigest: digest, envelopePolicyDigest: envelope,
    payloadPolicyDigest: payload)
}

#if ELLIE_ACTIVATION_POLICY_TESTING
  func runAuthenticatedActivationPolicyTest(_ arguments: [String]) throws -> Never {
    guard arguments.count == 3, arguments[0] == "test-authenticated-activation-policy" else {
      throw InstallerFailure.rejected
    }
    let policy = try authenticatedActivationPolicyV1(
      publisherTeamID: arguments[1], targetArchitecture: arguments[2])
    FileHandle.standardOutput.write(policy.data)
    print(policy.trustedPolicyDigest)
    exit(0)
  }
#endif
