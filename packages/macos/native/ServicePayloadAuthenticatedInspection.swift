import CryptoKit
import Darwin
import Foundation
import Security

private let authenticatedPayloadError =
  "Ellie could not authenticate and inspect this service payload; no payload was installed or changed."
private let authenticatedPayloadScope = "authenticated-payload-inspection"
private let authenticatedPayloadSignatureSemantics =
  "security-framework-strict-all-architectures-explicit-nested-code"
private let maximumMachLoadCommands: UInt32 = 4_096
private let maximumMachLoadCommandBytes: UInt32 = 16 * 1024 * 1024
private let maximumFatArchitectures: UInt32 = 32

struct VerifiedPayloadInventory {
  let releaseID: String
  let payloadPolicyDigest: String
  let manifestSHA256: String
}

struct AuthenticatedPayloadInspection {
  let envelope: AuthenticatedEnvelope
  let inventory: VerifiedPayloadInventory
}

private struct ProductionSignedComponent: Decodable {
  let identifier: String
  let signature: String
  let architecture: String
  let minimumOS: String
}
private struct ProductionLauncher: Decodable {
  let role: String
  let name: String
  let identifier: String
  let signature: String
  let architecture: String
  let minimumOS: String
}
private struct ProductionRuntime: Decodable {
  let version: String
  let architecture: String
  let archive: String
  let sha256: String
  let source: String
  let checksums: String
  let license: String
}
private struct ProductionBuildTools: Decodable {
  let node: String
  let bun: String
}
private struct ProductionComponent: Decodable {
  let name: String
  let version: String
  let license: String
  let files: [String]
}
private struct NativeCodeRecord: Codable, Equatable {
  let path: String
  let kind: String
  let identifier: String
  let machOPaths: [String]
  let entitlements: [String: Bool]
}
private struct ProductionManifest: Decodable {
  let version: Int
  let productVersion: String
  let sourceRevision: String
  let sourceModified: Bool
  let platform: String
  let architecture: String
  let minimumOS: String
  let lockSha256: String
  let buildTools: ProductionBuildTools
  let runtime: ProductionRuntime
  let helper: ProductionSignedComponent
  let launchers: [ProductionLauncher]
  let components: [ProductionComponent]
  let nativeCode: [NativeCodeRecord]
  let files: [Entry]
}

private func payloadHash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func payloadRequirement(_ teamID: String, _ identifier: String) -> String {
  "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"\(teamID)\" and identifier \"\(identifier)\""
}

private func expectedNativeCode() -> [NativeCodeRecord] {
  [
    NativeCodeRecord(
      path: "bin/node", kind: "executable", identifier: "org.ellie.runtime.node",
      machOPaths: ["bin/node"],
      entitlements: [
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.allow-unsigned-executable-memory": true,
      ]),
    NativeCodeRecord(
      path: "bin/ellie-service-installer", kind: "executable", identifier: "org.ellie.installer",
      machOPaths: ["bin/ellie-service-installer"], entitlements: [:]),
    NativeCodeRecord(
      path: "helpers/ellie-macos", kind: "executable", identifier: "org.ellie.helper",
      machOPaths: ["helpers/ellie-macos"], entitlements: [:]),
    NativeCodeRecord(
      path: "launchers/Ellie Coordinator.app", kind: "bundle",
      identifier: "org.ellie.assistant.coordinator.app",
      machOPaths: ["launchers/Ellie Coordinator.app/Contents/MacOS/EllieService"], entitlements: [:]
    ),
    NativeCodeRecord(
      path: "launchers/Ellie Node.app", kind: "bundle",
      identifier: "org.ellie.assistant.node.app",
      machOPaths: ["launchers/Ellie Node.app/Contents/MacOS/EllieService"], entitlements: [:]),
  ]
}

private func payloadPolicyDigest(
  teamID: String, envelopePolicyDigest: String, architecture: String
) throws -> String {
  struct Policy: Encodable {
    let version: Int
    let digestAlgorithm: String
    let envelopePolicyDigest: String
    let hardenedRuntimeRequired: Bool
    let machOAllowedCPUs: [String]
    let machOFileType: String
    let machOFatArchitecturesMaximum: UInt32
    let machOLoadCommandBytesMaximum: UInt32
    let machOLoadCommandsMaximum: UInt32
    let machOMagic: [String]
    let machOParserVersion: Int
    let manifestVersion: Int
    let nativeCode: [NativeCodeRecord]
    let payloadVerification: String
    let payloadDepthMaximum: Int
    let payloadEntriesMaximum: Int
    let payloadFileBytesMaximum: UInt64
    let payloadFilesMaximum: Int
    let payloadTotalBytesMaximum: UInt64
    let requirements: [String]
    let scope: String
    let signatureSemantics: String
    let targetArchitecture: String
    let teamID: String
  }
  let native = expectedNativeCode()
  let value = Policy(
    version: 1,
    digestAlgorithm: "sha256", envelopePolicyDigest: envelopePolicyDigest,
    hardenedRuntimeRequired: true,
    machOAllowedCPUs: ["arm64:0,1,2", "x86_64:3,8"], machOFileType: "MH_EXECUTE",
    machOFatArchitecturesMaximum: maximumFatArchitectures,
    machOLoadCommandBytesMaximum: maximumMachLoadCommandBytes,
    machOLoadCommandsMaximum: maximumMachLoadCommands,
    machOMagic: [
      "cafebabe", "cafebabf", "befabeca", "bfbafeca", "cefaedfe", "cffaedfe", "feedface",
      "feedfacf",
    ],
    machOParserVersion: 1,
    manifestVersion: 2, nativeCode: native, payloadVerification: "full-inventory-performed",
    payloadDepthMaximum: maximumPayloadDepth, payloadEntriesMaximum: maximumPayloadEntries,
    payloadFileBytesMaximum: maximumFileBytes, payloadFilesMaximum: maximumPayloadFiles,
    payloadTotalBytesMaximum: maximumPayloadBytes,
    requirements: native.map { payloadRequirement(teamID, $0.identifier) },
    scope: authenticatedPayloadScope, signatureSemantics: authenticatedPayloadSignatureSemantics,
    targetArchitecture: architecture, teamID: teamID)
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  var bytes = try encoder.encode(value)
  bytes.append(0x0a)
  return payloadHash(bytes)
}

private struct StrictJSONScanner {
  let bytes: [UInt8]
  var index = 0

  mutating func scan() throws {
    try value(depth: 0)
    whitespace()
    guard index == bytes.count else { throw InstallerFailure.rejected }
  }

  mutating func whitespace() {
    while index < bytes.count && [9, 10, 13, 32].contains(bytes[index]) { index += 1 }
  }

  mutating func value(depth: Int) throws {
    guard depth <= 64 else { throw InstallerFailure.rejected }
    whitespace()
    guard index < bytes.count else { throw InstallerFailure.rejected }
    switch bytes[index] {
    case 0x7b: try object(depth: depth + 1)
    case 0x5b: try array(depth: depth + 1)
    case 0x22: _ = try string(key: false)
    case 0x74: try literal("true")
    case 0x66: try literal("false")
    case 0x6e: try literal("null")
    case 0x2d, 0x30...0x39: try number()
    default: throw InstallerFailure.rejected
    }
  }

  mutating func object(depth: Int) throws {
    index += 1
    whitespace()
    var keys = Set<String>()
    if index < bytes.count && bytes[index] == 0x7d {
      index += 1
      return
    }
    while true {
      whitespace()
      let key = try string(key: true)
      guard keys.insert(key).inserted else { throw InstallerFailure.rejected }
      whitespace()
      guard index < bytes.count, bytes[index] == 0x3a else { throw InstallerFailure.rejected }
      index += 1
      try value(depth: depth)
      whitespace()
      guard index < bytes.count else { throw InstallerFailure.rejected }
      if bytes[index] == 0x7d {
        index += 1
        return
      }
      guard bytes[index] == 0x2c else { throw InstallerFailure.rejected }
      index += 1
    }
  }

  mutating func array(depth: Int) throws {
    index += 1
    whitespace()
    if index < bytes.count && bytes[index] == 0x5d {
      index += 1
      return
    }
    while true {
      try value(depth: depth)
      whitespace()
      guard index < bytes.count else { throw InstallerFailure.rejected }
      if bytes[index] == 0x5d {
        index += 1
        return
      }
      guard bytes[index] == 0x2c else { throw InstallerFailure.rejected }
      index += 1
    }
  }

  mutating func string(key: Bool) throws -> String {
    guard index < bytes.count, bytes[index] == 0x22 else { throw InstallerFailure.rejected }
    index += 1
    let start = index
    var escaped = false
    while index < bytes.count {
      let byte = bytes[index]
      if byte == 0x22 {
        let raw = Data(bytes[start..<index])
        index += 1
        guard !key || !escaped, let value = String(data: raw, encoding: .utf8) else {
          throw InstallerFailure.rejected
        }
        return value
      }
      guard byte >= 0x20 else { throw InstallerFailure.rejected }
      if byte == 0x5c {
        escaped = true
        index += 1
        guard index < bytes.count else { throw InstallerFailure.rejected }
        if bytes[index] == 0x75 {
          guard index + 4 < bytes.count,
            bytes[(index + 1)...(index + 4)].allSatisfy({
              ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x46)
                || ($0 >= 0x61 && $0 <= 0x66)
            })
          else { throw InstallerFailure.rejected }
          index += 4
        } else if ![0x22, 0x2f, 0x5c, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(bytes[index]) {
          throw InstallerFailure.rejected
        }
      }
      index += 1
    }
    throw InstallerFailure.rejected
  }

  mutating func literal(_ text: String) throws {
    let expected = Array(text.utf8)
    guard index + expected.count <= bytes.count,
      Array(bytes[index..<(index + expected.count)]) == expected
    else { throw InstallerFailure.rejected }
    index += expected.count
  }

  mutating func number() throws {
    let start = index
    if bytes[index] == 0x2d { index += 1 }
    guard index < bytes.count else { throw InstallerFailure.rejected }
    if bytes[index] == 0x30 {
      index += 1
    } else {
      guard bytes[index] >= 0x31 && bytes[index] <= 0x39 else { throw InstallerFailure.rejected }
      while index < bytes.count && bytes[index] >= 0x30 && bytes[index] <= 0x39 { index += 1 }
    }
    if index < bytes.count && bytes[index] == 0x2e {
      index += 1
      let fraction = index
      while index < bytes.count && bytes[index] >= 0x30 && bytes[index] <= 0x39 { index += 1 }
      guard index > fraction else { throw InstallerFailure.rejected }
    }
    if index < bytes.count && (bytes[index] == 0x65 || bytes[index] == 0x45) {
      index += 1
      if index < bytes.count && (bytes[index] == 0x2b || bytes[index] == 0x2d) { index += 1 }
      let exponent = index
      while index < bytes.count && bytes[index] >= 0x30 && bytes[index] <= 0x39 { index += 1 }
      guard index > exponent else { throw InstallerFailure.rejected }
    }
    guard index > start else { throw InstallerFailure.rejected }
  }
}

private func validateProductionManifestShape(_ data: Data) throws {
  var scanner = StrictJSONScanner(bytes: Array(data))
  try scanner.scan()
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(root.keys) == [
      "version", "productVersion", "sourceRevision", "sourceModified", "platform",
      "architecture", "minimumOS", "lockSha256", "buildTools", "runtime", "helper",
      "launchers", "components", "nativeCode", "files",
    ],
    exactKeys(root["buildTools"], ["node", "bun"]),
    exactKeys(
      root["runtime"],
      ["version", "architecture", "archive", "sha256", "source", "checksums", "license"]),
    exactKeys(root["helper"], ["identifier", "signature", "architecture", "minimumOS"]),
    let launchers = root["launchers"] as? [Any],
    launchers.allSatisfy({
      exactKeys($0, ["role", "name", "identifier", "signature", "architecture", "minimumOS"])
    }),
    let components = root["components"] as? [Any],
    components.allSatisfy({ exactKeys($0, ["name", "version", "license", "files"]) }),
    let native = root["nativeCode"] as? [Any],
    native.allSatisfy({
      exactKeys($0, ["path", "kind", "identifier", "machOPaths", "entitlements"])
    }),
    let files = root["files"] as? [Any],
    files.allSatisfy({ exactKeys($0, ["path", "mode", "size", "sha256"]) })
  else { throw InstallerFailure.rejected }
}

private func readExact(_ fd: Int32, offset: UInt64, count: Int, limit: UInt64) throws -> Data {
  guard count >= 0, offset <= limit, UInt64(count) <= limit - offset else {
    throw InstallerFailure.rejected
  }
  var data = Data(count: count)
  var done = 0
  while done < count {
    let amount = data.withUnsafeMutableBytes {
      pread(fd, $0.baseAddress!.advanced(by: done), count - done, off_t(offset) + off_t(done))
    }
    guard amount > 0 else { throw InstallerFailure.rejected }
    done += amount
  }
  return data
}

private func integer(_ bytes: Data, _ offset: Int, _ width: Int, _ little: Bool) throws -> UInt64 {
  guard width == 4 || width == 8, offset >= 0, offset + width <= bytes.count else {
    throw InstallerFailure.rejected
  }
  var value: UInt64 = 0
  for index in 0..<width {
    let byte = UInt64(bytes[offset + (little ? width - index - 1 : index)])
    value = (value << 8) | byte
  }
  return value
}

private let thinMagics: [Data: (is64: Bool, little: Bool)] = [
  Data([0xce, 0xfa, 0xed, 0xfe]): (false, true),
  Data([0xfe, 0xed, 0xfa, 0xce]): (false, false),
  Data([0xcf, 0xfa, 0xed, 0xfe]): (true, true),
  Data([0xfe, 0xed, 0xfa, 0xcf]): (true, false),
]
private let fatMagics: [Data: (is64: Bool, little: Bool)] = [
  Data([0xca, 0xfe, 0xba, 0xbe]): (false, false),
  Data([0xbe, 0xba, 0xfe, 0xca]): (false, true),
  Data([0xca, 0xfe, 0xba, 0xbf]): (true, false),
  Data([0xbf, 0xba, 0xfe, 0xca]): (true, true),
]

private func validateThinMachO(
  _ fd: Int32, offset: UInt64, size: UInt64, configuration: (is64: Bool, little: Bool)
) throws -> (cpu: UInt32, subtype: UInt32) {
  let headerSize = configuration.is64 ? 32 : 28
  let header = try readExact(fd, offset: offset, count: headerSize, limit: offset + size)
  let commands = try integer(header, 16, 4, configuration.little)
  let commandBytes = try integer(header, 20, 4, configuration.little)
  let cpu = UInt32(try integer(header, 4, 4, configuration.little))
  let subtype = UInt32(try integer(header, 8, 4, configuration.little))
  let fileType = try integer(header, 12, 4, configuration.little)
  guard configuration.is64, fileType == 2,
    (cpu == 0x0100_000c && [0, 1, 2].contains(subtype & 0x00ff_ffff))
      || (cpu == 0x0100_0007 && [3, 8].contains(subtype & 0x00ff_ffff))
  else { throw InstallerFailure.rejected }
  guard commands > 0, commands <= maximumMachLoadCommands, commandBytes >= 8,
    commandBytes <= maximumMachLoadCommandBytes,
    UInt64(headerSize) + commandBytes <= size
  else { throw InstallerFailure.rejected }
  var commandOffset = offset + UInt64(headerSize)
  var consumed: UInt64 = 0
  for _ in 0..<commands {
    let command = try readExact(fd, offset: commandOffset, count: 8, limit: offset + size)
    let commandSize = try integer(command, 4, 4, configuration.little)
    let alignment: UInt64 = configuration.is64 ? 8 : 4
    guard commandSize >= 8, commandSize % alignment == 0,
      commandSize <= commandBytes - consumed
    else { throw InstallerFailure.rejected }
    consumed += commandSize
    commandOffset += commandSize
  }
  guard consumed == commandBytes else { throw InstallerFailure.rejected }
  return (cpu, subtype)
}

private func expectedCPU(_ architecture: String) throws -> UInt32 {
  switch architecture {
  case "arm64": return 0x0100_000c
  case "x64": return 0x0100_0007
  default: throw InstallerFailure.rejected
  }
}

private func validateMachO(_ fd: Int32, size: UInt64, architecture: String) throws -> Bool {
  guard size >= 4 else { return false }
  let magic = try readExact(fd, offset: 0, count: 4, limit: size)
  if let thin = thinMagics[magic] {
    let header = try validateThinMachO(fd, offset: 0, size: size, configuration: thin)
    guard header.cpu == (try expectedCPU(architecture)) else { throw InstallerFailure.rejected }
    return true
  }
  guard let fat = fatMagics[magic] else { return false }
  let header = try readExact(fd, offset: 0, count: 8, limit: size)
  let count = try integer(header, 4, 4, fat.little)
  guard count > 0, count <= maximumFatArchitectures else { throw InstallerFailure.rejected }
  let stride = fat.is64 ? 32 : 20
  let tableBytes = UInt64(stride) * count
  guard 8 + tableBytes <= size else { throw InstallerFailure.rejected }
  let table = try readExact(fd, offset: 8, count: Int(tableBytes), limit: size)
  var ranges: [(UInt64, UInt64)] = []
  var architectures = Set<UInt32>()
  for index in 0..<Int(count) {
    let base = index * stride
    let declaredCPU = UInt32(try integer(table, base, 4, fat.little))
    let declaredSubtype = UInt32(try integer(table, base + 4, 4, fat.little))
    let sliceOffset = try integer(table, base + 8, fat.is64 ? 8 : 4, fat.little)
    let sliceSize = try integer(table, base + (fat.is64 ? 16 : 12), fat.is64 ? 8 : 4, fat.little)
    let alignment = try integer(table, base + (fat.is64 ? 24 : 16), 4, fat.little)
    guard sliceSize >= 4, alignment <= 30, sliceOffset >= 8 + tableBytes,
      sliceOffset % (1 << alignment) == 0, sliceOffset <= size, sliceSize <= size - sliceOffset,
      architectures.insert(declaredCPU).inserted
    else { throw InstallerFailure.rejected }
    for range in ranges {
      guard sliceOffset + sliceSize <= range.0 || range.1 <= sliceOffset else {
        throw InstallerFailure.rejected
      }
    }
    ranges.append((sliceOffset, sliceOffset + sliceSize))
    let sliceMagic = try readExact(fd, offset: sliceOffset, count: 4, limit: size)
    guard let thin = thinMagics[sliceMagic] else { throw InstallerFailure.rejected }
    let nested = try validateThinMachO(
      fd, offset: sliceOffset, size: sliceSize, configuration: thin)
    guard nested.cpu == declaredCPU, nested.subtype == declaredSubtype,
      nested.cpu == (try expectedCPU(architecture))
    else { throw InstallerFailure.rejected }
  }
  return true
}

private func nativeFileInventory(
  _ payload: Int32, entries: [Entry], architecture: String
) throws -> Set<String> {
  var result = Set<String>()
  for entry in entries {
    let fd = try fileDescriptor(at: payload, path: entry.path)
    defer { closeFD(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
      info.st_uid == getuid(), info.st_nlink == 1, info.st_size >= 0,
      UInt64(info.st_size) == entry.size, entry.size <= maximumFileBytes,
      Int(info.st_mode & 0o7777) == entry.mode
    else { throw InstallerFailure.rejected }
    if try validateMachO(fd, size: UInt64(info.st_size), architecture: architecture) {
      result.insert(entry.path)
    }
  }
  return result
}

private func validateProductionSignature(
  path: String, identifier: String, teamID: String, entitlements expected: [String: Bool],
  testAllowAdHoc: Bool
) throws {
  var code: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
    let code
  else { throw InstallerFailure.rejected }
  let requirement: SecRequirement?
  #if ELLIE_AUTHENTICATED_PAYLOAD_TESTING
    if testAllowAdHoc {
      requirement = nil
    } else {
      var value: SecRequirement?
      guard
        SecRequirementCreateWithString(
          payloadRequirement(teamID, identifier) as CFString, [], &value)
          == errSecSuccess, let value
      else { throw InstallerFailure.rejected }
      requirement = value
    }
  #else
    guard !testAllowAdHoc else { throw InstallerFailure.rejected }
    var value: SecRequirement?
    guard
      SecRequirementCreateWithString(payloadRequirement(teamID, identifier) as CFString, [], &value)
        == errSecSuccess, let value
    else { throw InstallerFailure.rejected }
    requirement = value
  #endif
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  guard SecStaticCodeCheckValidityWithErrors(code, flags, requirement, nil) == errSecSuccess else {
    throw InstallerFailure.rejected
  }
  var information: CFDictionary?
  guard
    SecCodeCopySigningInformation(
      code, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
      == errSecSuccess, let values = information as? [String: Any],
    values[kSecCodeInfoIdentifier as String] as? String == identifier,
    let codeFlags = values[kSecCodeInfoFlags as String] as? NSNumber,
    codeFlags.uint32Value & 0x0001_0000 != 0
  else { throw InstallerFailure.rejected }
  if !testAllowAdHoc {
    guard values[kSecCodeInfoTeamIdentifier as String] as? String == teamID else {
      throw InstallerFailure.rejected
    }
  }
  let entitlements = values[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
  guard Set(entitlements.keys) == Set(expected.keys),
    expected.allSatisfy({ item in
      guard let number = entitlements[item.key] as? NSNumber,
        CFGetTypeID(number) == CFBooleanGetTypeID()
      else { return false }
      return number.boolValue == item.value
    })
  else { throw InstallerFailure.rejected }
}

private func inspectProductionPayload(
  source: String, envelope: AuthenticatedEnvelope, teamID: String, testAllowAdHoc: Bool,
  testRebindPath: String? = nil
) throws -> VerifiedPayloadInventory {
  let root = try openAbsoluteDirectory(source)
  defer { closeFD(root) }
  try statSafeDirectory(root, privateMode: false)
  var held = stat()
  guard fstat(root, &held) == 0, (held.st_mode & 0o7777) == 0o755,
    try directoryNames(root) == ["SOURCE.txt", "manifest.json", "payload"]
  else { throw InstallerFailure.rejected }
  let manifestData = try readFile(
    at: root, "manifest.json", mode: 0o644, maximum: maximumManifestBytes)
  let sourceData = try readFile(at: root, "SOURCE.txt", mode: 0o644, maximum: maximumSourceBytes)
  guard manifestData == envelope.manifestData, sourceData == envelope.sourceData else {
    throw InstallerFailure.rejected
  }
  try validateProductionManifestShape(manifestData)
  let manifest = try JSONDecoder().decode(ProductionManifest.self, from: manifestData)
  let native = expectedNativeCode()
  guard manifest.version == 2,
    exactMatch(manifest.productVersion, "[0-9]+\\.[0-9]+\\.[0-9]+", maximum: 32),
    exactMatch(manifest.sourceRevision, "[a-f0-9]{40}", maximum: 40), !manifest.sourceModified,
    manifest.platform == "darwin", manifest.architecture == expectedArchitecture(),
    manifest.minimumOS == "14.0", exactMatch(manifest.lockSha256, "[a-f0-9]{64}", maximum: 64),
    exactMatch(manifest.buildTools.node, "24\\.[0-9]+\\.[0-9]+", maximum: 32),
    manifest.buildTools.bun == "1.4.2", manifest.runtime.architecture == manifest.architecture,
    exactMatch(manifest.runtime.version, "v24\\.[0-9]+\\.[0-9]+", maximum: 32),
    exactMatch(
      manifest.runtime.archive, "node-v24\\.[0-9]+\\.[0-9]+-darwin-(arm64|x64)\\.tar\\.xz",
      maximum: 128),
    manifest.runtime.archive
      == "node-\(manifest.runtime.version)-darwin-\(manifest.architecture).tar.xz",
    exactMatch(manifest.runtime.sha256, "[a-f0-9]{64}", maximum: 64),
    manifest.runtime.source
      == "https://nodejs.org/download/release/\(manifest.runtime.version)/\(manifest.runtime.archive)",
    manifest.runtime.checksums
      == "https://nodejs.org/download/release/\(manifest.runtime.version)/SHASUMS256.txt",
    manifest.runtime.license
      == "https://raw.githubusercontent.com/nodejs/node/\(manifest.runtime.version)/LICENSE",
    manifest.helper.identifier == "org.ellie.helper", manifest.helper.signature == "developer-id",
    manifest.helper.architecture == manifest.architecture, manifest.helper.minimumOS == "14.0",
    manifest.launchers.map(\.role) == ["coordinator", "node"],
    manifest.launchers.map(\.name) == ["Ellie Coordinator", "Ellie Node"],
    manifest.launchers.map(\.identifier) == [
      "org.ellie.assistant.coordinator.app", "org.ellie.assistant.node.app",
    ],
    manifest.launchers.allSatisfy({
      $0.signature == "developer-id" && $0.architecture == manifest.architecture
        && $0.minimumOS == "14.0"
    }), manifest.nativeCode == native, !manifest.files.isEmpty,
    manifest.files.count <= maximumPayloadFiles,
    Set(manifest.components.map(\.name)).count == manifest.components.count,
    manifest.components.count <= maximumPayloadFiles,
    manifest.components.allSatisfy({
      exactMatch($0.name, "(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*", maximum: 255)
        && exactMatch($0.version, "[^\\r\\n]+", maximum: 128)
        && exactMatch($0.license, "[^\\r\\n]+", maximum: 256) && !$0.files.isEmpty
        && $0.files.count <= 32
        && $0.files.allSatisfy({ exactMatch($0, "[A-Za-z0-9._-]+", maximum: 255) })
    })
  else { throw InstallerFailure.rejected }
  let expectedSource =
    "Ellie service payload\nSource revision: \(manifest.sourceRevision)\nNode.js: \(manifest.runtime.version)\nNode archive SHA-256: \(manifest.runtime.sha256)\nMinimum macOS: \(manifest.minimumOS)\nPolicy: authenticated-payload-v1\n"
  guard sourceData == Data(expectedSource.utf8) else { throw InstallerFailure.rejected }
  let payload = try openDirectory(at: root, "payload")
  defer { closeFD(payload) }
  var payloadInfo = stat()
  guard fstat(payload, &payloadInfo) == 0, payloadInfo.st_uid == getuid(),
    (payloadInfo.st_mode & 0o7777) == 0o755
  else { throw InstallerFailure.rejected }
  var total: UInt64 = 0
  var declared = Set<String>()
  for entry in manifest.files {
    guard declared.insert(entry.path).inserted, entry.size <= maximumPayloadBytes - total else {
      throw InstallerFailure.rejected
    }
    total += entry.size
    try hashAndValidate(root: payload, entry: entry, installed: false)
  }
  let modes = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0.mode) })
  guard modes["bin/node"] == 0o755, modes["bin/ellie-service-installer"] == 0o755,
    modes["helpers/ellie-macos"] == 0o755,
    modes["lib/ellie/apps/cli/src/main.ts"] == 0o644,
    native.flatMap(\.machOPaths).allSatisfy({ modes[$0] == 0o755 })
  else { throw InstallerFailure.rejected }
  var directories = Set<String>()
  for path in declared {
    var parts = path.split(separator: "/").map(String.init)
    parts.removeLast()
    while !parts.isEmpty {
      directories.insert(parts.joined(separator: "/"))
      parts.removeLast()
    }
  }
  var count = 0
  let actual = try listedFiles(
    payload, installed: false, allowedDirectories: directories, count: &count)
  guard Set(actual) == declared, actual.count == declared.count else {
    throw InstallerFailure.rejected
  }
  let discovered = try nativeFileInventory(
    payload, entries: manifest.files, architecture: manifest.architecture)
  let expectedMachO = Set(native.flatMap(\.machOPaths))
  guard discovered == expectedMachO else { throw InstallerFailure.rejected }
  let base = try pathFromFD(payload)
  for record in native {
    let target = base + "/" + record.path
    try validateProductionSignature(
      path: target, identifier: record.identifier, teamID: teamID,
      entitlements: record.entitlements, testAllowAdHoc: testAllowAdHoc)
    if record.kind == "bundle" {
      for nested in record.machOPaths {
        try validateProductionSignature(
          path: base + "/" + nested, identifier: record.identifier, teamID: teamID,
          entitlements: record.entitlements, testAllowAdHoc: testAllowAdHoc)
      }
    }
  }
  var finalPayloadInfo = stat()
  guard fstat(payload, &finalPayloadInfo) == 0,
    (finalPayloadInfo.st_mode & S_IFMT) == S_IFDIR, finalPayloadInfo.st_uid == getuid(),
    (finalPayloadInfo.st_mode & 0o7777) == 0o755,
    finalPayloadInfo.st_dev == payloadInfo.st_dev, finalPayloadInfo.st_ino == payloadInfo.st_ino
  else { throw InstallerFailure.rejected }
  #if !ELLIE_AUTHENTICATED_PAYLOAD_TESTING
    guard testRebindPath == nil else { throw InstallerFailure.rejected }
  #endif
  let rebound = try openAbsoluteDirectory(testRebindPath ?? source)
  defer { closeFD(rebound) }
  var reboundInfo = stat()
  guard fstat(rebound, &reboundInfo) == 0, (reboundInfo.st_mode & S_IFMT) == S_IFDIR,
    reboundInfo.st_uid == getuid(), (reboundInfo.st_mode & 0o7777) == 0o755,
    reboundInfo.st_dev == held.st_dev, reboundInfo.st_ino == held.st_ino
  else { throw InstallerFailure.rejected }
  let reboundPayload = try openDirectory(at: rebound, "payload")
  defer { closeFD(reboundPayload) }
  var reboundPayloadInfo = stat()
  guard fstat(reboundPayload, &reboundPayloadInfo) == 0,
    (reboundPayloadInfo.st_mode & S_IFMT) == S_IFDIR,
    reboundPayloadInfo.st_uid == payloadInfo.st_uid,
    (reboundPayloadInfo.st_mode & 0o7777) == (payloadInfo.st_mode & 0o7777),
    reboundPayloadInfo.st_dev == payloadInfo.st_dev,
    reboundPayloadInfo.st_ino == payloadInfo.st_ino
  else { throw InstallerFailure.rejected }
  let policy = try payloadPolicyDigest(
    teamID: teamID, envelopePolicyDigest: envelope.policyDigest,
    architecture: manifest.architecture)
  return VerifiedPayloadInventory(
    releaseID: "\(manifest.productVersion)-\(manifest.sourceRevision)-\(manifest.architecture)",
    payloadPolicyDigest: policy, manifestSHA256: payloadHash(manifestData))
}

func verifyAuthenticatedPayload(
  releasePath: String, authorizationPath: String, publisherTeamID: String,
  testAllowAdHoc: Bool = false, testRebindPath: String? = nil
) throws -> AuthenticatedPayloadInspection {
  let envelope = try verifyAuthenticatedManifestEnvelope(
    releasePath: releasePath, authorizationPath: authorizationPath,
    publisherTeamID: publisherTeamID, testAllowAdHoc: testAllowAdHoc)
  let inventory = try inspectProductionPayload(
    source: releasePath, envelope: envelope, teamID: publisherTeamID,
    testAllowAdHoc: testAllowAdHoc, testRebindPath: testRebindPath)
  return AuthenticatedPayloadInspection(envelope: envelope, inventory: inventory)
}

func runAuthenticatedPayloadInspection(_ arguments: [String]) throws -> Never {
  var values = arguments
  var testAllowAdHoc = false
  var testRebindPath: String?
  #if ELLIE_AUTHENTICATED_PAYLOAD_TESTING
    if values.count >= 2, values[values.count - 2] == "--test-rebind-path" {
      testRebindPath = values.last
      values.removeLast(2)
    }
    if values.last == "--test-allow-sealed-adhoc" {
      testAllowAdHoc = true
      values.removeLast()
    }
  #endif
  guard values.count == 5, values[0] == "inspect-authenticated-payload",
    values[3] == "--publisher-team-id"
  else { throw InstallerFailure.rejected }
  let result = try verifyAuthenticatedPayload(
    releasePath: values[1], authorizationPath: values[2], publisherTeamID: values[4],
    testAllowAdHoc: testAllowAdHoc, testRebindPath: testRebindPath)
  print(
    "Authenticated payload \(result.inventory.releaseID), envelope policy \(result.envelope.policyDigest), payload policy \(result.inventory.payloadPolicyDigest), manifest \(result.inventory.manifestSHA256); installation was not authorized and nothing was changed."
  )
  exit(0)
}

func failAuthenticatedPayloadInspection(_ error: Error) -> Never {
  FileHandle.standardError.write(Data((authenticatedPayloadError + "\n").utf8))
  exit(1)
}

#if ELLIE_AUTHENTICATED_PAYLOAD_TESTING
  func runAuthenticatedMachOParserTest(_ arguments: [String]) throws -> Never {
    guard arguments.count == 4, arguments[0] == "test-authenticated-macho",
      arguments[2] != ".", arguments[2] != ".."
    else { throw InstallerFailure.rejected }
    let directory = try openAbsoluteDirectory(arguments[1])
    defer { closeFD(directory) }
    let fd = try fileDescriptor(at: directory, path: arguments[2])
    defer { closeFD(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
      info.st_nlink == 1, info.st_size >= 0, UInt64(info.st_size) <= maximumFileBytes
    else { throw InstallerFailure.rejected }
    print(
      try validateMachO(fd, size: UInt64(info.st_size), architecture: arguments[3])
        ? "native" : "data")
    exit(0)
  }
#endif
