import CryptoKit
import Darwin
import Foundation
import Security

private let authorizationIdentifier = "org.ellie.service.authorization"
private let authorizationError =
  "Ellie could not authenticate this service manifest envelope; no payload was installed or changed."
private let authorizationManifestLimit = 4 * 1024 * 1024
private let authorizationSourceLimit = 16 * 1024
private let authorizationRecordLimit = 4 * 1024

struct AuthenticatedEnvelope {
  let version: Int
  let policyDigest: String
  let manifestSHA256: String
  let sourceSHA256: String
  let manifestData: Data
  let sourceData: Data
  let authorizationRecordSHA256: String
  let authorizationDevice: dev_t
  let authorizationInode: ino_t
}

struct AuthorizationCaptureFile {
  let path: String
  let data: Data
  let executable: Bool
}

struct AuthorizationCaptureSnapshot {
  let files: [AuthorizationCaptureFile]
  let device: dev_t
  let inode: ino_t
}

private struct AuthorizationRecord: Codable {
  let version: Int
  let manifestSHA256: String
  let policyDigest: String
  let sourceSHA256: String
}

private enum AuthorizationFailure: Error { case rejected }
#if ELLIE_AUTHORIZATION_TESTING
  private var authorizationTestStage = "arguments"
  private func authorizationCheckpoint(_ value: String) { authorizationTestStage = value }
#else
  private func authorizationCheckpoint(_ value: String) {}
#endif

private func authorizationHex(_ value: String, count: Int) -> Bool {
  value.utf8.count == count
    && value.utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func authorizationTeamID(_ value: String) -> Bool {
  value.utf8.count == 10
    && value.utf8.allSatisfy {
      ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90)
    }
}

private func authorizationHash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func authorizationCanonical<T: Encodable>(_ value: T) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  var data = try encoder.encode(value)
  data.append(0x0a)
  return data
}

private func authorizationPolicyDigest(teamID: String, requirementText: String? = nil) throws
  -> String
{
  struct Policy: Codable {
    let authorizationIdentifier: String
    let authorizationVersion: Int
    let digestAlgorithm: String
    let payloadVerification: String
    let requiredResources: [String]
    let requirement: String
    let scope: String
    let signatureSemantics: String
    let teamID: String
  }
  return authorizationHash(
    try authorizationCanonical(
      Policy(
        authorizationIdentifier: authorizationIdentifier, authorizationVersion: 1,
        digestAlgorithm: "sha256", payloadVerification: "not-performed",
        requiredResources: ["SOURCE.txt", "authorization.json", "manifest.json"],
        requirement: requirementText ?? authorizationRequirementText(teamID: teamID),
        scope: "manifest-envelope",
        signatureSemantics: "security-framework-strict-all-architectures", teamID: teamID)))
}

func authenticatedEnvelopePolicyDigest(teamID: String) throws -> String {
  guard authorizationTeamID(teamID) else { throw AuthorizationFailure.rejected }
  return try authorizationPolicyDigest(teamID: teamID)
}

private func authorizationRequirementText(teamID: String) -> String {
  "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\" and identifier \"\(authorizationIdentifier)\""
}

private func authorizationOpenDirectory(_ parent: Int32, _ name: String) throws -> Int32 {
  guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), name.utf8.count <= 255
  else { throw AuthorizationFailure.rejected }
  let fd = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw AuthorizationFailure.rejected }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
    [0o555, 0o700, 0o755].contains(Int(info.st_mode & 0o7777))
  else {
    close(fd)
    throw AuthorizationFailure.rejected
  }
  return fd
}

private func authorizationOpenAbsoluteDirectory(_ path: String) throws -> Int32 {
  guard path.hasPrefix("/"), path.utf8.count <= 4096 else {
    throw AuthorizationFailure.rejected
  }
  let parts = path.split(separator: "/", omittingEmptySubsequences: false)
  guard parts.first == "",
    parts.dropFirst().allSatisfy({ part in
      !part.isEmpty && part != "." && part != ".." && part.utf8.count <= 255
        && !part.utf8.contains(0)
    })
  else {
    throw AuthorizationFailure.rejected
  }
  var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard fd >= 0 else { throw AuthorizationFailure.rejected }
  do {
    for part in parts.dropFirst() {
      let next = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      guard next >= 0 else { throw AuthorizationFailure.rejected }
      var info = stat()
      guard fstat(next, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
        close(next)
        throw AuthorizationFailure.rejected
      }
      close(fd)
      fd = next
    }
    var final = stat()
    guard fstat(fd, &final) == 0, final.st_uid == getuid(),
      [0o555, 0o700, 0o755].contains(Int(final.st_mode & 0o7777))
    else { throw AuthorizationFailure.rejected }
    return fd
  } catch {
    close(fd)
    throw error
  }
}

private func authorizationRead(
  _ parent: Int32, _ name: String, maximum: Int, allowedModes: Set<Int>
) throws -> Data {
  let fd = openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw AuthorizationFailure.rejected }
  defer { close(fd) }
  var before = stat()
  guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
    before.st_uid == getuid(), before.st_nlink == 1, before.st_size >= 0,
    before.st_size <= maximum, allowedModes.contains(Int(before.st_mode & 0o7777))
  else { throw AuthorizationFailure.rejected }
  var result = Data(count: Int(before.st_size))
  let length = result.count
  var offset = 0
  while offset < length {
    let readCount = result.withUnsafeMutableBytes {
      read(fd, $0.baseAddress!.advanced(by: offset), length - offset)
    }
    guard readCount > 0 else { throw AuthorizationFailure.rejected }
    offset += readCount
  }
  var trailing: UInt8 = 0
  guard read(fd, &trailing, 1) == 0 else { throw AuthorizationFailure.rejected }
  var after = stat()
  guard fstat(fd, &after) == 0, (after.st_mode & S_IFMT) == S_IFREG,
    after.st_uid == getuid(), after.st_nlink == 1,
    allowedModes.contains(Int(after.st_mode & 0o7777)), before.st_dev == after.st_dev,
    before.st_ino == after.st_ino, before.st_mode == after.st_mode,
    before.st_size == after.st_size,
    before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec
  else { throw AuthorizationFailure.rejected }
  return result
}

private func authorizationNames(_ directory: Int32) throws -> [String] {
  let duplicate = dup(directory)
  guard duplicate >= 0, let stream = fdopendir(duplicate) else {
    if duplicate >= 0 { close(duplicate) }
    throw AuthorizationFailure.rejected
  }
  defer { closedir(stream) }
  var result: [String] = []
  while true {
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw AuthorizationFailure.rejected }
      break
    }
    let name = withUnsafePointer(to: &item.pointee.d_name) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
    }
    if name == "." || name == ".." { continue }
    guard result.count < 16 else { throw AuthorizationFailure.rejected }
    result.append(name)
  }
  return result.sorted()
}

private func authorizationRequirement(teamID: String) throws -> SecRequirement {
  var requirement: SecRequirement?
  guard
    SecRequirementCreateWithString(
      authorizationRequirementText(teamID: teamID) as CFString, [], &requirement) == errSecSuccess,
    let requirement
  else { throw AuthorizationFailure.rejected }
  return requirement
}

private func authorizationValidateSignature(path: String, teamID: String, testAllowAdHoc: Bool)
  throws
{
  var code: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
    let code
  else { throw AuthorizationFailure.rejected }
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  let requirement: SecRequirement?
  #if ELLIE_AUTHORIZATION_TESTING
    requirement = testAllowAdHoc ? nil : try authorizationRequirement(teamID: teamID)
  #else
    guard !testAllowAdHoc else { throw AuthorizationFailure.rejected }
    requirement = try authorizationRequirement(teamID: teamID)
  #endif
  guard
    SecStaticCodeCheckValidityWithErrors(code, flags, requirement, nil) == errSecSuccess
  else { throw AuthorizationFailure.rejected }
  var information: CFDictionary?
  guard
    SecCodeCopySigningInformation(
      code, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
      == errSecSuccess, let values = information as? [String: Any],
    values[kSecCodeInfoIdentifier as String] as? String == authorizationIdentifier
  else { throw AuthorizationFailure.rejected }
  if !testAllowAdHoc {
    guard values[kSecCodeInfoTeamIdentifier as String] as? String == teamID else {
      throw AuthorizationFailure.rejected
    }
  }
}

private func authorizationValidateSealedResources(
  _ signature: Int32, resources: [String: Data], record: AuthorizationRecord
) throws {
  let codeResources = try authorizationRead(
    signature, "CodeResources", maximum: 1024 * 1024, allowedModes: [0o444, 0o644])
  guard
    let root = try PropertyListSerialization.propertyList(from: codeResources, format: nil)
      as? [String: Any], let files2 = root["files2"] as? [String: Any],
    Set(files2.keys) == Set(resources.keys.map { "Resources/" + $0 })
  else { throw AuthorizationFailure.rejected }
  for (name, data) in resources {
    let path = "Resources/" + name
    guard let item = files2[path] as? [String: Any],
      Set(item.keys).isSubset(of: ["hash", "hash2"]), Set(item.keys).contains("hash2"),
      let digest = item["hash2"] as? Data,
      digest == Data(SHA256.hash(data: data))
    else { throw AuthorizationFailure.rejected }
    if let legacy = item["hash"] {
      guard let legacy = legacy as? Data, legacy == Data(Insecure.SHA1.hash(data: data)) else {
        throw AuthorizationFailure.rejected
      }
    }
  }
  guard authorizationHex(record.manifestSHA256, count: 64),
    authorizationHex(record.sourceSHA256, count: 64),
    authorizationHex(record.policyDigest, count: 64)
  else { throw AuthorizationFailure.rejected }
}

func verifyAuthenticatedManifestEnvelope(
  releasePath: String, authorizationPath: String, publisherTeamID: String,
  testAllowAdHoc: Bool = false, testRebindPath: String? = nil
) throws -> AuthenticatedEnvelope {
  guard authorizationTeamID(publisherTeamID) else { throw AuthorizationFailure.rejected }
  authorizationCheckpoint("external")
  let release = try authorizationOpenAbsoluteDirectory(releasePath)
  defer { close(release) }
  let externalManifest = try authorizationRead(
    release, "manifest.json", maximum: authorizationManifestLimit, allowedModes: [0o444, 0o644])
  let externalSource = try authorizationRead(
    release, "SOURCE.txt", maximum: authorizationSourceLimit, allowedModes: [0o444, 0o644])

  let bundle = try authorizationOpenAbsoluteDirectory(authorizationPath)
  defer { close(bundle) }
  var heldBundleInfo = stat()
  guard fstat(bundle, &heldBundleInfo) == 0 else { throw AuthorizationFailure.rejected }
  guard try authorizationNames(bundle) == ["Contents"] else { throw AuthorizationFailure.rejected }
  let contents = try authorizationOpenDirectory(bundle, "Contents")
  defer { close(contents) }
  guard try authorizationNames(contents) == ["Info.plist", "MacOS", "Resources", "_CodeSignature"]
  else { throw AuthorizationFailure.rejected }
  let macOS = try authorizationOpenDirectory(contents, "MacOS")
  defer { close(macOS) }
  let resources = try authorizationOpenDirectory(contents, "Resources")
  defer { close(resources) }
  let signature = try authorizationOpenDirectory(contents, "_CodeSignature")
  defer { close(signature) }
  guard try authorizationNames(macOS) == ["EllieServiceAuthorization"],
    try authorizationNames(resources) == ["SOURCE.txt", "authorization.json", "manifest.json"],
    try authorizationNames(signature) == ["CodeResources"]
  else { throw AuthorizationFailure.rejected }
  let infoData = try authorizationRead(
    contents, "Info.plist", maximum: 64 * 1024, allowedModes: [0o444, 0o644])
  guard
    let info = try PropertyListSerialization.propertyList(from: infoData, format: nil)
      as? [String: Any], info["CFBundleIdentifier"] as? String == authorizationIdentifier,
    info["CFBundleExecutable"] as? String == "EllieServiceAuthorization",
    info["CFBundlePackageType"] as? String == "APPL"
  else { throw AuthorizationFailure.rejected }
  _ = try authorizationRead(
    macOS, "EllieServiceAuthorization", maximum: 16 * 1024 * 1024, allowedModes: [0o555, 0o755])
  let sealedManifest = try authorizationRead(
    resources, "manifest.json", maximum: authorizationManifestLimit, allowedModes: [0o444, 0o644])
  let sealedSource = try authorizationRead(
    resources, "SOURCE.txt", maximum: authorizationSourceLimit, allowedModes: [0o444, 0o644])
  let recordData = try authorizationRead(
    resources, "authorization.json", maximum: authorizationRecordLimit,
    allowedModes: [0o444, 0o644])
  guard externalManifest == sealedManifest, externalSource == sealedSource else {
    throw AuthorizationFailure.rejected
  }
  let decoder = JSONDecoder()
  authorizationCheckpoint("record")
  guard let recordObject = try JSONSerialization.jsonObject(with: recordData) as? [String: Any],
    Set(recordObject.keys) == ["manifestSHA256", "policyDigest", "sourceSHA256", "version"]
  else { throw AuthorizationFailure.rejected }
  let record = try decoder.decode(AuthorizationRecord.self, from: recordData)
  guard record.version == 1, try authorizationCanonical(record) == recordData,
    record.manifestSHA256 == authorizationHash(sealedManifest),
    record.sourceSHA256 == authorizationHash(sealedSource),
    record.policyDigest == (try authorizationPolicyDigest(teamID: publisherTeamID))
  else { throw AuthorizationFailure.rejected }
  var bundlePath = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  guard fcntl(bundle, F_GETPATH, &bundlePath) == 0 else { throw AuthorizationFailure.rejected }
  authorizationCheckpoint("signature")
  try authorizationValidateSignature(
    path: String(cString: bundlePath), teamID: publisherTeamID, testAllowAdHoc: testAllowAdHoc)
  authorizationCheckpoint("resources")
  try authorizationValidateSealedResources(
    signature,
    resources: [
      "SOURCE.txt": sealedSource, "authorization.json": recordData,
      "manifest.json": sealedManifest,
    ], record: record)
  #if !ELLIE_AUTHORIZATION_TESTING
    guard testRebindPath == nil else { throw AuthorizationFailure.rejected }
  #endif
  let rebound = try authorizationOpenAbsoluteDirectory(testRebindPath ?? authorizationPath)
  defer { close(rebound) }
  var reboundInfo = stat()
  guard fstat(rebound, &reboundInfo) == 0, reboundInfo.st_dev == heldBundleInfo.st_dev,
    reboundInfo.st_ino == heldBundleInfo.st_ino
  else { throw AuthorizationFailure.rejected }
  return AuthenticatedEnvelope(
    version: record.version, policyDigest: record.policyDigest,
    manifestSHA256: record.manifestSHA256, sourceSHA256: record.sourceSHA256,
    manifestData: Data(sealedManifest), sourceData: Data(sealedSource),
    authorizationRecordSHA256: authorizationHash(recordData),
    authorizationDevice: heldBundleInfo.st_dev, authorizationInode: heldBundleInfo.st_ino)
}

func authorizationCaptureFiles(_ authorizationPath: String) throws -> AuthorizationCaptureSnapshot {
  let bundle = try authorizationOpenAbsoluteDirectory(authorizationPath)
  defer { close(bundle) }
  var bundleInfo = stat()
  guard fstat(bundle, &bundleInfo) == 0 else { throw AuthorizationFailure.rejected }
  guard try authorizationNames(bundle) == ["Contents"] else { throw AuthorizationFailure.rejected }
  let contents = try authorizationOpenDirectory(bundle, "Contents")
  defer { close(contents) }
  let macOS = try authorizationOpenDirectory(contents, "MacOS")
  defer { close(macOS) }
  let resources = try authorizationOpenDirectory(contents, "Resources")
  defer { close(resources) }
  let signature = try authorizationOpenDirectory(contents, "_CodeSignature")
  defer { close(signature) }
  return AuthorizationCaptureSnapshot(files: [
    AuthorizationCaptureFile(path: "Contents/Info.plist", data: try authorizationRead(contents, "Info.plist", maximum: 64 * 1024, allowedModes: [0o444, 0o644]), executable: false),
    AuthorizationCaptureFile(path: "Contents/MacOS/EllieServiceAuthorization", data: try authorizationRead(macOS, "EllieServiceAuthorization", maximum: 16 * 1024 * 1024, allowedModes: [0o555, 0o755]), executable: true),
    AuthorizationCaptureFile(path: "Contents/Resources/SOURCE.txt", data: try authorizationRead(resources, "SOURCE.txt", maximum: authorizationSourceLimit, allowedModes: [0o444, 0o644]), executable: false),
    AuthorizationCaptureFile(path: "Contents/Resources/authorization.json", data: try authorizationRead(resources, "authorization.json", maximum: authorizationRecordLimit, allowedModes: [0o444, 0o644]), executable: false),
    AuthorizationCaptureFile(path: "Contents/Resources/manifest.json", data: try authorizationRead(resources, "manifest.json", maximum: authorizationManifestLimit, allowedModes: [0o444, 0o644]), executable: false),
    AuthorizationCaptureFile(path: "Contents/_CodeSignature/CodeResources", data: try authorizationRead(signature, "CodeResources", maximum: 1024 * 1024, allowedModes: [0o444, 0o644]), executable: false),
  ], device: bundleInfo.st_dev, inode: bundleInfo.st_ino)
}

func rebindAuthorizationSource(_ envelope: AuthenticatedEnvelope, path: String) throws {
  let bundle = try authorizationOpenAbsoluteDirectory(path)
  defer { close(bundle) }
  var info = stat()
  guard fstat(bundle, &info) == 0, info.st_dev == envelope.authorizationDevice,
    info.st_ino == envelope.authorizationInode
  else { throw AuthorizationFailure.rejected }
}

func runAuthorizationInspection(_ arguments: [String]) throws -> Never {
  var values = arguments
  var testAllowAdHoc = false
  var testRebindPath: String?
  #if ELLIE_AUTHORIZATION_TESTING
    if values.count >= 2, values[values.count - 2] == "--test-rebind-path" {
      testRebindPath = values.last
      values.removeLast(2)
    }
    if values.last == "--test-allow-sealed-adhoc" {
      testAllowAdHoc = true
      values.removeLast()
    }
  #endif
  guard values.count == 5, values[0] == "inspect-authorization",
    values[3] == "--publisher-team-id"
  else { throw AuthorizationFailure.rejected }
  let result = try verifyAuthenticatedManifestEnvelope(
    releasePath: values[1], authorizationPath: values[2], publisherTeamID: values[4],
    testAllowAdHoc: testAllowAdHoc, testRebindPath: testRebindPath)
  #if ELLIE_AUTHORIZATION_TESTING
    print(
      "Authenticated copies manifestBytes \(result.manifestData.count) manifestSHA256 \(authorizationHash(result.manifestData)) sourceBytes \(result.sourceData.count) sourceSHA256 \(authorizationHash(result.sourceData))."
    )
  #endif
  print(
    "Authenticated manifest envelope version \(result.version), policy \(result.policyDigest), manifest \(result.manifestSHA256); payload inventory was not verified and nothing was installed."
  )
  exit(0)
}

#if ELLIE_AUTHORIZATION_TESTING
  func runAuthorizationPolicyTest(_ arguments: [String]) throws -> Never {
    guard arguments.count == 3, arguments[0] == "test-authorization-policy",
      authorizationTeamID(arguments[1]), !arguments[2].isEmpty, arguments[2].utf8.count <= 2048
    else { throw AuthorizationFailure.rejected }
    print(try authorizationPolicyDigest(teamID: arguments[1], requirementText: arguments[2]))
    exit(0)
  }

  func runAuthorizationResourcesTest(_ arguments: [String]) throws -> Never {
    guard arguments.count == 3, arguments[0] == "test-authorization-resources"
    else { throw AuthorizationFailure.rejected }
    let signature = try authorizationOpenAbsoluteDirectory(arguments[1])
    defer { close(signature) }
    let resources = try authorizationOpenAbsoluteDirectory(arguments[2])
    defer { close(resources) }
    let manifest = try authorizationRead(
      resources, "manifest.json", maximum: authorizationManifestLimit, allowedModes: [0o444, 0o644])
    let source = try authorizationRead(
      resources, "SOURCE.txt", maximum: authorizationSourceLimit, allowedModes: [0o444, 0o644])
    let recordData = try authorizationRead(
      resources, "authorization.json", maximum: authorizationRecordLimit,
      allowedModes: [0o444, 0o644])
    let record = try JSONDecoder().decode(AuthorizationRecord.self, from: recordData)
    try authorizationValidateSealedResources(
      signature,
      resources: [
        "SOURCE.txt": source, "authorization.json": recordData, "manifest.json": manifest,
      ],
      record: record)
    print("Authenticated resource seal parser accepted the exact required resources.")
    exit(0)
  }
#endif

func failAuthorizationInspection(_ error: Error) -> Never {
  FileHandle.standardError.write(Data((authorizationError + "\n").utf8))
  #if ELLIE_AUTHORIZATION_TESTING
    FileHandle.standardError.write(
      Data("Authorization test stage: \(authorizationTestStage)\n".utf8))
  #endif
  exit(1)
}
