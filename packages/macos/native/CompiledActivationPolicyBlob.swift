import EllieActivationPolicyBlob
import Foundation

private let unavailableActivationPolicy = Data("ELLIE-ACTIVATION-POLICY-UNAVAILABLE-V1\n".utf8)

private struct CompiledActivationHint: Decodable {
  let publisherTeamID: String
}

struct CompiledActivationPolicy {
  let data: Data
  let trustedPolicyDigest: String
  let envelopePolicyDigest: String
  let payloadPolicyDigest: String
  let publisherTeamID: String
}

private enum CompiledActivationPolicyFailure: Error { case rejected }

func compiledActivationPolicy() throws -> CompiledActivationPolicy? {
  let count = ellie_activation_policy_size()
  guard count > 0, count <= 16 * 1024, let pointer = ellie_activation_policy_bytes() else {
    throw CompiledActivationPolicyFailure.rejected
  }
  let data = Data(bytes: pointer, count: count)
  if data == unavailableActivationPolicy { return nil }
  guard data.last == 0x0a,
    let hint = try? JSONDecoder().decode(CompiledActivationHint.self, from: data)
  else { throw CompiledActivationPolicyFailure.rejected }
  #if arch(arm64)
    let architecture = "arm64"
  #elseif arch(x86_64)
    let architecture = "x64"
  #else
    throw CompiledActivationPolicyFailure.rejected
  #endif
  let authoritative = try authenticatedActivationPolicyV1(
    publisherTeamID: hint.publisherTeamID, targetArchitecture: architecture)
  guard authoritative.data == data else { throw CompiledActivationPolicyFailure.rejected }
  return CompiledActivationPolicy(
    data: authoritative.data, trustedPolicyDigest: authoritative.trustedPolicyDigest,
    envelopePolicyDigest: authoritative.envelopePolicyDigest,
    payloadPolicyDigest: authoritative.payloadPolicyDigest, publisherTeamID: hint.publisherTeamID)
}
