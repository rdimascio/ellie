import CryptoKit
import Darwin
import Foundation

enum CaptureFailure: Error { case rejected, busy, recoveryRequired, cleanupIncomplete }

let captureScope = "authenticated-candidate-capture"
let captureDigestPattern = "[0-9a-f]{64}"
#if ELLIE_AUTHENTICATED_PAYLOAD_TESTING
  let captureAllowsAdHoc = true
#else
  let captureAllowsAdHoc = false
#endif

struct CaptureBinding: Codable, Equatable {
  let authorizationRecordSHA256: String
  let authorizationVersion: Int
  let envelopePolicyDigest: String
  let manifestSHA256: String
  let payloadPolicyDigest: String
  let publisherTeamID: String
  let releaseID: String
  let scope: String
  let sourceSHA256: String
  let version: Int
}

struct CaptureIdentity {
  let device: dev_t
  let inode: ino_t
  let owner: uid_t
}

// The caller owns `root` and must close it. `rootIdentity` is a verification-time snapshot;
// callers must still retain the descriptor and rebind the canonical ancestor chain immediately
// before mutation. Stage names are admitted for capture recovery, so callers also enforce that a
// published candidate name equals `candidateID`.
struct VerifiedAuthenticatedCandidate {
  let binding: CaptureBinding
  let candidateID: String
  let root: Int32
  let rootIdentity: CaptureIdentity
  let inspection: AuthenticatedPayloadInspection
}

func captureIdentity(_ fd: Int32) throws -> CaptureIdentity {
  var info = stat()
  guard fstat(fd, &info) == 0 else { throw CaptureFailure.rejected }
  return CaptureIdentity(device: info.st_dev, inode: info.st_ino, owner: info.st_uid)
}

func sameIdentity(_ lhs: CaptureIdentity, _ rhs: CaptureIdentity) -> Bool {
  lhs.device == rhs.device && lhs.inode == rhs.inode && lhs.owner == rhs.owner
}

func captureHash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func canonicalBinding(_ value: CaptureBinding) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  var data = try encoder.encode(value)
  data.append(0x0a)
  guard data.count <= 4 * 1024 else { throw CaptureFailure.rejected }
  return data
}

func binding(from inspection: AuthenticatedPayloadInspection, teamID: String) -> CaptureBinding {
  CaptureBinding(
    authorizationRecordSHA256: inspection.envelope.authorizationRecordSHA256,
    authorizationVersion: inspection.envelope.version,
    envelopePolicyDigest: inspection.envelope.policyDigest,
    manifestSHA256: inspection.inventory.manifestSHA256,
    payloadPolicyDigest: inspection.inventory.payloadPolicyDigest,
    publisherTeamID: teamID, releaseID: inspection.inventory.releaseID, scope: captureScope,
    sourceSHA256: inspection.envelope.sourceSHA256, version: 1)
}

func decodeBinding(_ data: Data) throws -> CaptureBinding {
  guard data.count <= 4 * 1024,
    let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == [
      "authorizationRecordSHA256", "authorizationVersion", "envelopePolicyDigest",
      "manifestSHA256", "payloadPolicyDigest", "publisherTeamID", "releaseID", "scope",
      "sourceSHA256", "version",
    ]
  else { throw CaptureFailure.recoveryRequired }
  let value = try JSONDecoder().decode(CaptureBinding.self, from: data)
  guard try canonicalBinding(value) == data, value.version == 1, value.authorizationVersion == 1,
    value.scope == captureScope,
    exactMatch(value.publisherTeamID, "[A-Z0-9]{10}", maximum: 10),
    exactMatch(value.releaseID, "[0-9]+\\.[0-9]+\\.[0-9]+-[a-f0-9]{40}-(arm64|x64)", maximum: 128),
    [
      value.authorizationRecordSHA256, value.envelopePolicyDigest, value.manifestSHA256,
      value.payloadPolicyDigest, value.sourceSHA256,
    ]
    .allSatisfy({ exactMatch($0, captureDigestPattern, maximum: 64) })
  else { throw CaptureFailure.recoveryRequired }
  return value
}

func captureDirectory(_ parent: Int32, _ name: String, modes: Set<mode_t>) throws -> Int32 {
  let fd = try openDirectory(at: parent, name)
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_uid == getuid(), modes.contains(info.st_mode & 0o7777)
  else {
    closeFD(fd)
    throw CaptureFailure.rejected
  }
  return fd
}

func rebindCandidateChain(
  servicesRoot: String, heldServices: Int32, heldNamespace: Int32, candidateName: String,
  heldCandidate: Int32, candidateModes: Set<mode_t> = [0o555]
) throws {
  let expectedServices = try captureIdentity(heldServices)
  let expectedNamespace = try captureIdentity(heldNamespace)
  let expectedCandidate = try captureIdentity(heldCandidate)
  let services = try openAbsoluteDirectory(servicesRoot)
  defer { closeFD(services) }
  guard sameIdentity(try captureIdentity(services), expectedServices) else {
    throw CaptureFailure.recoveryRequired
  }
  let namespace = try captureDirectory(services, "authenticated-candidates", modes: [0o700])
  defer { closeFD(namespace) }
  guard sameIdentity(try captureIdentity(namespace), expectedNamespace) else {
    throw CaptureFailure.recoveryRequired
  }
  let candidate = try captureDirectory(namespace, candidateName, modes: candidateModes)
  defer { closeFD(candidate) }
  guard sameIdentity(try captureIdentity(candidate), expectedCandidate) else {
    throw CaptureFailure.recoveryRequired
  }
}

func verifyCapturedCandidate(
  namespace: Int32, name: String, teamID: String, expected: CaptureBinding? = nil,
  allowPrivateRoot: Bool
) throws -> VerifiedAuthenticatedCandidate {
  let root = try captureDirectory(
    namespace, name, modes: allowPrivateRoot ? [0o555, 0o700] : [0o555])
  do {
    guard try directoryNames(root, maximum: 4) == ["authorization", "binding.json", "release"]
    else {
      throw CaptureFailure.recoveryRequired
    }
    let data = try readFile(at: root, "binding.json", mode: 0o444, maximum: 4 * 1024)
    let stored = try decodeBinding(data)
    guard stored.publisherTeamID == teamID, expected == nil || stored == expected! else {
      throw CaptureFailure.recoveryRequired
    }
    let release = try captureDirectory(root, "release", modes: [0o555])
    defer { closeFD(release) }
    let authorization = try captureDirectory(root, "authorization", modes: [0o555])
    defer { closeFD(authorization) }
    let app = try captureDirectory(
      authorization, "Ellie Service Authorization.app", modes: [0o555])
    defer { closeFD(app) }
    let inspected = try verifyCapturedAuthenticatedPayload(
      releasePath: try pathFromFD(release), authorizationPath: try pathFromFD(app),
      publisherTeamID: teamID, testAllowAdHoc: captureAllowsAdHoc)
    guard binding(from: inspected, teamID: teamID) == stored else {
      throw CaptureFailure.recoveryRequired
    }
    let digest = captureHash(data)
    guard exactMatch(digest, captureDigestPattern, maximum: 64) else {
      throw CaptureFailure.recoveryRequired
    }
    return VerifiedAuthenticatedCandidate(
      binding: stored, candidateID: digest, root: root, rootIdentity: try captureIdentity(root),
      inspection: inspected)
  } catch {
    closeFD(root)
    throw error
  }
}
