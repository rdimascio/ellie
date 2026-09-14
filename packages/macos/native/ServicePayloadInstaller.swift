import CryptoKit
import Darwin
import Foundation
import Security

enum InstallerFailure: Error { case rejected, cleanupIncomplete, publicationUncertain }
private let fixedError =
  "Ellie service payload inspection or staging failed; existing installations were preserved."
private let cleanupError =
  "Ellie service staging failed and its private temporary release could not be fully removed."
private let uncertainError =
  "Ellie may have staged an unselected service release; no installed release was selected or started."
let maximumManifestBytes = 4 * 1024 * 1024
let maximumSourceBytes = 16 * 1024
#if ELLIE_INSTALLER_TESTING
  let maximumPayloadFiles = 100
  let maximumPayloadEntries = 128
  private var diagnosticStage = "argument-validation"
  private var diagnosticCategory = "validation"

  private func diagnosticCheckpoint(_ stage: String, category: String = "validation") {
    diagnosticStage = stage
    diagnosticCategory = category
  }

  private func syscallCategory(_ value: Int32) -> String {
    switch value {
    case EACCES, EPERM: return "permission"
    case EEXIST: return "already-exists"
    case ENOENT: return "not-found"
    case ENOSPC, EMFILE, ENFILE: return "resource-limit"
    case ENOTSUP: return "unsupported"
    case EINVAL: return "invalid-operation"
    default: return "io-failure"
    }
  }

  private func diagnosticSyscallFailure(_ stage: String) -> InstallerFailure {
    diagnosticCheckpoint(stage, category: syscallCategory(errno))
    return .rejected
  }
#else
  let maximumPayloadFiles = 2_048
  let maximumPayloadEntries = 4_096
  private func diagnosticCheckpoint(_ stage: String, category: String = "validation") {}

  private func diagnosticSyscallFailure(_ stage: String) -> InstallerFailure { .rejected }
#endif
let maximumPayloadDepth = 16
let maximumFileBytes: UInt64 = 128 * 1024 * 1024
let maximumPayloadBytes: UInt64 = 512 * 1024 * 1024

struct Entry: Decodable, Equatable {
  let path: String
  let mode: Int
  let size: UInt64
  let sha256: String
}
private struct SignedComponent: Decodable {
  let identifier: String
  let signature: String
  let architecture: String
  let minimumOS: String
}
private struct Launcher: Decodable {
  let role: String
  let name: String
  let identifier: String
  let signature: String
  let architecture: String
  let minimumOS: String
}
private struct Runtime: Decodable {
  let version: String
  let architecture: String
  let archive: String
  let sha256: String
  let source: String
  let checksums: String
  let license: String
}
private struct BuildTools: Decodable {
  let node: String
  let bun: String
}
private struct Component: Decodable {
  let name: String
  let version: String
  let license: String
  let files: [String]
}
private struct Manifest: Decodable {
  let version: Int
  let productVersion: String
  let sourceRevision: String
  let sourceModified: Bool
  let platform: String
  let architecture: String
  let minimumOS: String
  let lockSha256: String
  let buildTools: BuildTools
  let runtime: Runtime
  let helper: SignedComponent
  let launchers: [Launcher]
  let components: [Component]
  let files: [Entry]
}
private struct Inspected {
  let manifest: Manifest
  let manifestData: Data
  let sourceData: Data
  let releaseID: String
  let root: Int32
}
struct SelectionFile {
  let path: String
  let mode: Int
  let size: UInt64
  let sha256: String
}
struct SelectionRelease {
  let id: String
  let rootPath: String
  let applicationPath: String
  let applicationFiles: [SelectionFile]
}

private func fail(_ error: Error? = nil) -> Never {
  let message: String
  switch error as? InstallerFailure {
  case .cleanupIncomplete: message = cleanupError
  case .publicationUncertain: message = uncertainError
  default: message = fixedError
  }
  FileHandle.standardError.write(Data((message + "\n").utf8))
  #if ELLIE_INSTALLER_TESTING
    FileHandle.standardError.write(
      Data(
        "Ellie installer test diagnostic: stage=\(diagnosticStage) category=\(diagnosticCategory)\n"
          .utf8))
  #endif
  exit(1)
}
func closeFD(_ fd: Int32) { if fd >= 0 { _ = Darwin.close(fd) } }
func checkedComponent(_ value: String) throws -> String {
  guard !value.isEmpty, value != ".", value != "..", value.utf8.count <= 255,
    !value.contains("/"), !value.utf8.contains(0)
  else { throw InstallerFailure.rejected }
  return value
}
func components(_ path: String) throws -> [String] {
  guard path.utf8.count <= 4096 else { throw InstallerFailure.rejected }
  let values = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
  return try values.map(checkedComponent)
}
func openDirectory(at parent: Int32, _ name: String) throws -> Int32 {
  let fd = openat(
    parent, try checkedComponent(name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw InstallerFailure.rejected }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
    closeFD(fd)
    throw InstallerFailure.rejected
  }
  return fd
}
func openAbsoluteDirectory(_ path: String) throws -> Int32 {
  guard path.hasPrefix("/") else { throw InstallerFailure.rejected }
  var current = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard current >= 0 else { throw InstallerFailure.rejected }
  do {
    for part in try components(path) {
      let next = try openDirectory(at: current, part)
      closeFD(current)
      current = next
    }
    return current
  } catch {
    closeFD(current)
    throw error
  }
}
func statSafeDirectory(_ fd: Int32, privateMode: Bool) throws {
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
    info.st_uid == getuid(), !privateMode || (info.st_mode & 0o077) == 0,
    (info.st_mode & 0o022) == 0
  else { throw InstallerFailure.rejected }
}
func readFile(at parent: Int32, _ name: String, mode: mode_t, maximum: Int) throws -> Data {
  let fd = openat(
    parent, try checkedComponent(name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  guard fd >= 0 else { throw InstallerFailure.rejected }
  defer { closeFD(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
    info.st_uid == getuid(),
    (info.st_mode & 0o7777) == mode, info.st_size >= 0, info.st_size <= maximum
  else { throw InstallerFailure.rejected }
  var result = Data()
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  while true {
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
    if count == 0 { break }
    guard count > 0, result.count + count <= maximum else { throw InstallerFailure.rejected }
    result.append(buffer, count: count)
  }
  return result
}
func fileDescriptor(at root: Int32, path: String) throws -> Int32 {
  let parts = try components(path)
  guard !parts.isEmpty else { throw InstallerFailure.rejected }
  var directory = dup(root)
  guard directory >= 0 else { throw InstallerFailure.rejected }
  do {
    for part in parts.dropLast() {
      let next = try openDirectory(at: directory, part)
      closeFD(directory)
      directory = next
    }
    let fd = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    closeFD(directory)
    guard fd >= 0 else { throw InstallerFailure.rejected }
    return fd
  } catch {
    closeFD(directory)
    throw error
  }
}
func validatePath(_ path: String) throws {
  let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  guard !path.isEmpty, path.utf8.count <= 500, !path.hasPrefix("/"), !path.contains("\\"),
    parts.allSatisfy({ part in
      !part.isEmpty && part.utf8.count <= 100 && part != "." && part != ".."
        && part.utf8.allSatisfy({ byte in
          (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90)
            || (byte >= 97 && byte <= 122) || byte == 32 || "._@+-".utf8.contains(byte)
        })
    })
  else { throw InstallerFailure.rejected }
}
func exactMatch(_ value: String, _ pattern: String, maximum: Int) -> Bool {
  guard !value.isEmpty, value.utf8.count <= maximum,
    let expression = try? NSRegularExpression(pattern: pattern)
  else { return false }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return expression.firstMatch(in: value, range: range)?.range == range
}
func exactKeys(_ value: Any?, _ expected: Set<String>) -> Bool {
  guard let object = value as? [String: Any] else { return false }
  return Set(object.keys) == expected
}
private func validateManifestShape(_ data: Data) throws {
  guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(root.keys) == [
      "version", "productVersion", "sourceRevision", "sourceModified", "platform",
      "architecture", "minimumOS", "lockSha256", "buildTools", "runtime", "helper",
      "launchers", "components", "files",
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
    let files = root["files"] as? [Any],
    files.allSatisfy({ exactKeys($0, ["path", "mode", "size", "sha256"]) })
  else { throw InstallerFailure.rejected }
}
func hashAndValidate(root: Int32, entry: Entry, installed: Bool) throws {
  try validatePath(entry.path)
  guard entry.mode == 0o644 || entry.mode == 0o755, entry.size <= maximumFileBytes,
    exactMatch(entry.sha256, "[a-f0-9]{64}", maximum: 64)
  else { throw InstallerFailure.rejected }
  let fd = try fileDescriptor(at: root, path: entry.path)
  defer { closeFD(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
    info.st_uid == getuid(),
    (info.st_mode & 0o7777) == (installed ? (entry.mode == 0o755 ? 0o555 : 0o444) : entry.mode),
    UInt64(info.st_size) == entry.size
  else { throw InstallerFailure.rejected }
  var digest = SHA256()
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  var total: UInt64 = 0
  while true {
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
    if count == 0 { break }
    guard count > 0 else { throw InstallerFailure.rejected }
    total += UInt64(count)
    guard total <= entry.size else { throw InstallerFailure.rejected }
    digest.update(data: Data(buffer[0..<count]))
  }
  let value = digest.finalize().map { String(format: "%02x", $0) }.joined()
  guard total == entry.size, value == entry.sha256 else { throw InstallerFailure.rejected }
}
func listedFiles(
  _ root: Int32, prefix: String = "", installed: Bool, depth: Int = 0,
  allowedDirectories: Set<String>, count: inout Int
) throws -> [String] {
  guard depth <= maximumPayloadDepth else { throw InstallerFailure.rejected }
  guard let stream = fdopendir(dup(root)) else { throw InstallerFailure.rejected }
  defer { closedir(stream) }
  var result: [String] = []
  while true {
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw InstallerFailure.rejected }
      break
    }
    let name = withUnsafePointer(to: &item.pointee.d_name) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
    }
    if name == "." || name == ".." { continue }
    count += 1
    guard count <= maximumPayloadEntries else { throw InstallerFailure.rejected }
    _ = try checkedComponent(name)
    var info = stat()
    guard fstatat(root, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw InstallerFailure.rejected
    }
    let path = prefix.isEmpty ? name : "\(prefix)/\(name)"
    if (info.st_mode & S_IFMT) == S_IFDIR {
      guard allowedDirectories.contains(path) else { throw InstallerFailure.rejected }
      guard info.st_uid == getuid(), (info.st_mode & 0o7777) == (installed ? 0o555 : 0o755) else {
        throw InstallerFailure.rejected
      }
      let child = try openDirectory(at: root, name)
      defer { closeFD(child) }
      result += try listedFiles(
        child, prefix: path, installed: installed, depth: depth + 1,
        allowedDirectories: allowedDirectories, count: &count)
    } else if (info.st_mode & S_IFMT) == S_IFREG {
      guard info.st_nlink == 1 else { throw InstallerFailure.rejected }
      result.append(path)
    } else {
      throw InstallerFailure.rejected
    }
  }
  return result.sorted()
}
func expectedArchitecture() -> String {
  #if arch(arm64)
    return "arm64"
  #elseif arch(x86_64)
    return "x64"
  #else
    return "unsupported"
  #endif
}
private func validateSignature(path: String, identifier: String) throws {
  var code: SecStaticCode?
  guard
    SecStaticCodeCreateWithPath(URL(fileURLWithPath: path) as CFURL, [], &code) == errSecSuccess,
    let code, SecStaticCodeCheckValidity(code, [], nil) == errSecSuccess
  else { throw InstallerFailure.rejected }
  var details: CFDictionary?
  guard
    SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &details)
      == errSecSuccess,
    let values = details as? [String: Any],
    values[kSecCodeInfoIdentifier as String] as? String == identifier
  else { throw InstallerFailure.rejected }
}
func pathFromFD(_ fd: Int32) throws -> String {
  var value = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  guard fcntl(fd, F_GETPATH, &value) == 0 else { throw InstallerFailure.rejected }
  return String(cString: value)
}
private func inspect(
  _ source: String, installed: Bool = false, allowPrivateStagingRoot: Bool = false
) throws -> Inspected {
  let root = try openAbsoluteDirectory(source)
  do { try statSafeDirectory(root, privateMode: false) } catch {
    closeFD(root)
    throw error
  }
  do {
    var rootInfo = stat()
    guard fstat(root, &rootInfo) == 0 else { throw InstallerFailure.rejected }
    let rootMode = rootInfo.st_mode & 0o7777
    guard
      rootMode == (installed ? 0o555 : 0o755)
        || (installed && allowPrivateStagingRoot && rootMode == 0o700)
    else { throw InstallerFailure.rejected }
    let names = try directoryNames(root)
    guard names == ["SOURCE.txt", "manifest.json", "payload"] else {
      throw InstallerFailure.rejected
    }
    let manifestData = try readFile(
      at: root, "manifest.json", mode: installed ? 0o444 : 0o644, maximum: maximumManifestBytes)
    let sourceData = try readFile(
      at: root, "SOURCE.txt", mode: installed ? 0o444 : 0o644, maximum: maximumSourceBytes)
    try validateManifestShape(manifestData)
    let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
    guard manifest.version == 1,
      exactMatch(manifest.productVersion, "[0-9]+\\.[0-9]+\\.[0-9]+", maximum: 32),
      exactMatch(manifest.sourceRevision, "[a-f0-9]{40}", maximum: 40),
      !manifest.sourceModified, manifest.platform == "darwin",
      manifest.architecture == expectedArchitecture(),
      manifest.minimumOS == "14.0", exactMatch(manifest.lockSha256, "[a-f0-9]{64}", maximum: 64),
      exactMatch(manifest.buildTools.node, "24\\.[0-9]+\\.[0-9]+", maximum: 32),
      manifest.buildTools.bun == "1.4.2",
      exactMatch(manifest.runtime.version, "v24\\.[0-9]+\\.[0-9]+", maximum: 32),
      manifest.runtime.architecture == manifest.architecture,
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
      manifest.helper.identifier == "org.ellie.helper",
      manifest.helper.signature == "development-ad-hoc",
      manifest.helper.architecture == manifest.architecture, manifest.helper.minimumOS == "14.0",
      manifest.launchers.count == 2,
      manifest.launchers.map(\.role) == ["coordinator", "node"],
      manifest.launchers.map(\.name) == ["Ellie Coordinator", "Ellie Node"],
      manifest.launchers.map(\.identifier) == [
        "org.ellie.assistant.coordinator.app", "org.ellie.assistant.node.app",
      ],
      manifest.launchers.allSatisfy({
        $0.signature == "development-ad-hoc" && $0.architecture == manifest.architecture
          && $0.minimumOS == "14.0"
      }),
      manifest.components.count <= maximumPayloadFiles,
      Set(manifest.components.map(\.name)).count == manifest.components.count,
      manifest.components.allSatisfy({ component in
        exactMatch(component.name, "(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*", maximum: 255)
          && exactMatch(component.version, "[^\\r\\n]+", maximum: 128)
          && exactMatch(component.license, "[^\\r\\n]+", maximum: 256)
          && !component.files.isEmpty && component.files.count <= 32
          && component.files.allSatisfy({ exactMatch($0, "[A-Za-z0-9._-]+", maximum: 255) })
      }),
      !manifest.files.isEmpty, manifest.files.count <= maximumPayloadFiles
    else { throw InstallerFailure.rejected }
    let expectedSource =
      "Ellie service payload\nSource revision: \(manifest.sourceRevision)\nNode.js: \(manifest.runtime.version)\nNode archive SHA-256: \(try sourceNodeHash(manifestData))\nMinimum macOS: \(manifest.minimumOS)\nHelper: org.ellie.helper (development-ad-hoc)\n"
    guard sourceData == Data(expectedSource.utf8) else { throw InstallerFailure.rejected }
    let payload = try openDirectory(at: root, "payload")
    defer { closeFD(payload) }
    var payloadInfo = stat()
    guard fstat(payload, &payloadInfo) == 0,
      (payloadInfo.st_mode & 0o7777) == (installed ? 0o555 : 0o755),
      payloadInfo.st_uid == getuid()
    else { throw InstallerFailure.rejected }
    var total: UInt64 = 0
    var declaredPaths = Set<String>()
    for entry in manifest.files {
      guard declaredPaths.insert(entry.path).inserted else { throw InstallerFailure.rejected }
      guard entry.size <= maximumPayloadBytes - total else { throw InstallerFailure.rejected }
      total += entry.size
      try hashAndValidate(root: payload, entry: entry, installed: installed)
    }
    let requiredModes = [
      "bin/node": 0o755, "bin/ellie-service-installer": 0o755, "helpers/ellie-macos": 0o755,
      "lib/ellie/apps/cli/src/main.ts": 0o644,
    ]
    let declaredModes = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0.mode) })
    guard requiredModes.allSatisfy({ declaredModes[$0.key] == $0.value }) else {
      throw InstallerFailure.rejected
    }
    var traversalCount = 0
    var allowedDirectories = Set<String>()
    for path in declaredPaths {
      var parts = path.split(separator: "/").map(String.init)
      parts.removeLast()
      while !parts.isEmpty {
        allowedDirectories.insert(parts.joined(separator: "/"))
        parts.removeLast()
      }
    }
    let actualPaths = try listedFiles(
      payload, installed: installed, allowedDirectories: allowedDirectories,
      count: &traversalCount)
    guard actualPaths.count == declaredPaths.count, Set(actualPaths) == declaredPaths else {
      throw InstallerFailure.rejected
    }
    let base = try pathFromFD(payload)
    try validateSignature(path: base + "/helpers/ellie-macos", identifier: "org.ellie.helper")
    try validateSignature(
      path: base + "/launchers/Ellie Coordinator.app",
      identifier: "org.ellie.assistant.coordinator.app")
    try validateSignature(
      path: base + "/launchers/Ellie Node.app", identifier: "org.ellie.assistant.node.app")
    try validateSignature(
      path: base + "/bin/ellie-service-installer", identifier: "org.ellie.installer")
    let releaseID = "\(manifest.productVersion)-\(manifest.sourceRevision)-\(manifest.architecture)"
    return Inspected(
      manifest: manifest, manifestData: manifestData, sourceData: sourceData, releaseID: releaseID,
      root: root)
  } catch {
    closeFD(root)
    throw error
  }
}
private func sourceNodeHash(_ data: Data) throws -> String {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let runtime = object["runtime"] as? [String: Any], let value = runtime["sha256"] as? String,
    exactMatch(value, "[a-f0-9]{64}", maximum: 64)
  else { throw InstallerFailure.rejected }
  return value
}
func verifiedSelectionRelease(servicesRoot: String, releaseID: String, role: String) throws
  -> SelectionRelease
{
  _ = try checkedComponent(releaseID)
  guard role == "coordinator" || role == "node" else { throw InstallerFailure.rejected }
  let path = servicesRoot + "/releases/" + releaseID
  let value = try inspect(path, installed: true)
  defer { closeFD(value.root) }
  guard value.releaseID == releaseID else { throw InstallerFailure.rejected }
  let name = role == "coordinator" ? "Ellie Coordinator.app" : "Ellie Node.app"
  let prefix = "launchers/\(name)/"
  let files = value.manifest.files.compactMap { entry -> SelectionFile? in
    guard entry.path.hasPrefix(prefix) else { return nil }
    return SelectionFile(
      path: String(entry.path.dropFirst(prefix.count)), mode: entry.mode, size: entry.size,
      sha256: entry.sha256)
  }
  guard !files.isEmpty else { throw InstallerFailure.rejected }
  return SelectionRelease(
    id: releaseID, rootPath: path, applicationPath: path + "/payload/launchers/" + name,
    applicationFiles: files)
}
func selectionOpenDirectory(_ path: String, privateMode: Bool) throws -> Int32 {
  let fd = try openAbsoluteDirectory(path)
  do { try statSafeDirectory(fd, privateMode: privateMode) } catch {
    closeFD(fd)
    throw error
  }
  return fd
}
func selectionValidateSignature(path: String, identifier: String) throws {
  try validateSignature(path: path, identifier: identifier)
}
func selectionPathFromFD(_ fd: Int32) throws -> String { try pathFromFD(fd) }
func selectionRemoveTree(parent: Int32, name: String) throws {
  try removeTree(parent: parent, name: name)
}
func selectionEnsureDirectory(parent: Int32, name: String, mode: mode_t) throws -> Int32 {
  try ensureDirectory(parent: parent, name: name, mode: mode)
}
func selectionOpenChildDirectory(parent: Int32, name: String) throws -> Int32 {
  try openDirectory(at: parent, name)
}
func selectionOpenOwnedDirectory(parent: Int32, name: String) throws -> Int32 {
  let fd = try openDirectory(at: parent, name)
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o022) == 0 else {
    closeFD(fd)
    throw InstallerFailure.rejected
  }
  return fd
}
func selectionOpenOwnedDirectoryIfPresent(parent: Int32, name: String) throws -> Int32? {
  let fd = openat(
    parent, try checkedComponent(name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
  if fd < 0 {
    if errno == ENOENT { return nil }
    throw InstallerFailure.rejected
  }
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o022) == 0 else {
    closeFD(fd)
    throw InstallerFailure.rejected
  }
  return fd
}
func selectionEnsureOwnedDirectory(parent: Int32, name: String) throws -> Int32 {
  let component = try checkedComponent(name)
  let created = mkdirat(parent, component, 0o700) == 0
  if !created && errno != EEXIST { throw InstallerFailure.rejected }
  let fd = try openDirectory(at: parent, name)
  var info = stat()
  guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o022) == 0 else {
    closeFD(fd)
    throw InstallerFailure.rejected
  }
  if created {
    guard fchmod(fd, 0o700) == 0, fsync(fd) == 0, fsync(parent) == 0 else {
      closeFD(fd)
      throw InstallerFailure.rejected
    }
  }
  return fd
}
func selectionApplicationDigest(
  parent: Int32, name: String, files: [SelectionFile], identifier: String,
  rootMode: mode_t = 0o555
) throws -> String {
  let root = try openDirectory(at: parent, name)
  defer { closeFD(root) }
  var rootInfo = stat()
  guard fstat(root, &rootInfo) == 0, rootInfo.st_uid == getuid(),
    (rootInfo.st_mode & 0o7777) == rootMode
  else { throw InstallerFailure.rejected }
  var allowedDirectories = Set<String>()
  var declaredPaths = Set<String>()
  var digest = SHA256()
  for file in files.sorted(by: { $0.path < $1.path }) {
    guard declaredPaths.insert(file.path).inserted else { throw InstallerFailure.rejected }
    try validatePath(file.path)
    var parts = file.path.split(separator: "/").map(String.init)
    parts.removeLast()
    while !parts.isEmpty {
      allowedDirectories.insert(parts.joined(separator: "/"))
      parts.removeLast()
    }
    let entry = Entry(path: file.path, mode: file.mode, size: file.size, sha256: file.sha256)
    try hashAndValidate(root: root, entry: entry, installed: true)
    digest.update(data: Data("\(file.path)\u{0}\(file.sha256)\n".utf8))
  }
  var count = 0
  let actual = try listedFiles(
    root, installed: true, allowedDirectories: allowedDirectories, count: &count)
  guard actual.count == declaredPaths.count, Set(actual) == declaredPaths else {
    throw InstallerFailure.rejected
  }
  try validateSignature(path: try pathFromFD(root), identifier: identifier)
  return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
func selectionValidatePartialApplication(source: SelectionRelease, parent: Int32, name: String)
  throws
{
  let destination = try openDirectory(at: parent, name)
  defer { closeFD(destination) }
  var rootInfo = stat()
  guard fstat(destination, &rootInfo) == 0, rootInfo.st_uid == getuid(),
    [mode_t(0o700), mode_t(0o555)].contains(rootInfo.st_mode & 0o7777)
  else { throw InstallerFailure.rejected }
  let sourceRoot = try openAbsoluteDirectory(source.applicationPath)
  defer { closeFD(sourceRoot) }
  let expected = Dictionary(uniqueKeysWithValues: source.applicationFiles.map { ($0.path, $0) })
  var allowedDirectories = Set<String>()
  for file in source.applicationFiles {
    var parts = file.path.split(separator: "/").map(String.init)
    parts.removeLast()
    while !parts.isEmpty {
      allowedDirectories.insert(parts.joined(separator: "/"))
      parts.removeLast()
    }
  }
  var count = 0
  var total: UInt64 = 0
  func inspect(_ directory: Int32, prefix: String = "", depth: Int = 0) throws {
    guard depth <= maximumPayloadDepth, let stream = fdopendir(dup(directory)) else {
      throw InstallerFailure.rejected
    }
    defer { closedir(stream) }
    while true {
      errno = 0
      guard let item = readdir(stream) else {
        guard errno == 0 else { throw InstallerFailure.rejected }
        break
      }
      let entryName = withUnsafePointer(to: &item.pointee.d_name) {
        $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
      }
      if entryName == "." || entryName == ".." { continue }
      count += 1
      guard count <= maximumPayloadEntries else { throw InstallerFailure.rejected }
      _ = try checkedComponent(entryName)
      let path = prefix.isEmpty ? entryName : "\(prefix)/\(entryName)"
      var info = stat()
      guard fstatat(directory, entryName, &info, AT_SYMLINK_NOFOLLOW) == 0,
        info.st_uid == getuid()
      else { throw InstallerFailure.rejected }
      if (info.st_mode & S_IFMT) == S_IFDIR {
        guard allowedDirectories.contains(path),
          [mode_t(0o700), mode_t(0o555)].contains(info.st_mode & 0o7777)
        else { throw InstallerFailure.rejected }
        let child = try openDirectory(at: directory, entryName)
        defer { closeFD(child) }
        try inspect(child, prefix: path, depth: depth + 1)
      } else if (info.st_mode & S_IFMT) == S_IFREG {
        guard let file = expected[path] else { throw InstallerFailure.rejected }
        let finalMode: mode_t = file.mode == 0o755 ? 0o555 : 0o444
        let actualMode = info.st_mode & 0o7777
        guard info.st_nlink == 1, info.st_size >= 0,
          actualMode & finalMode == actualMode, actualMode & 0o400 != 0, actualMode & 0o222 == 0,
          UInt64(info.st_size) <= file.size
        else { throw InstallerFailure.rejected }
        total += UInt64(info.st_size)
        guard total <= maximumPayloadBytes else { throw InstallerFailure.rejected }
        let actual = try fileDescriptor(at: destination, path: path)
        defer { closeFD(actual) }
        var opened = stat()
        guard fstat(actual, &opened) == 0, opened.st_dev == info.st_dev,
          opened.st_ino == info.st_ino, opened.st_uid == info.st_uid,
          opened.st_nlink == info.st_nlink, opened.st_size == info.st_size,
          (opened.st_mode & S_IFMT) == S_IFREG,
          (opened.st_mode & 0o7777) == (info.st_mode & 0o7777)
        else { throw InstallerFailure.rejected }
        let sourceFile = try fileDescriptor(at: sourceRoot, path: path)
        defer { closeFD(sourceFile) }
        var remaining = Int(info.st_size)
        var left = [UInt8](repeating: 0, count: 64 * 1024)
        var right = [UInt8](repeating: 0, count: 64 * 1024)
        while remaining > 0 {
          let amount = min(remaining, left.count)
          let lhs = left.withUnsafeMutableBytes { Darwin.read(actual, $0.baseAddress!, amount) }
          let rhs = right.withUnsafeMutableBytes {
            Darwin.read(sourceFile, $0.baseAddress!, amount)
          }
          guard lhs == amount, rhs == amount, left[0..<amount] == right[0..<amount] else {
            throw InstallerFailure.rejected
          }
          remaining -= amount
        }
        var trailing: UInt8 = 0
        guard withUnsafeMutablePointer(to: &trailing, { Darwin.read(actual, $0, 1) }) == 0 else {
          throw InstallerFailure.rejected
        }
      } else {
        throw InstallerFailure.rejected
      }
    }
  }
  try inspect(destination)
}
func selectionUnsealPartialApplication(source: SelectionRelease, parent: Int32, name: String)
  throws
{
  try selectionValidatePartialApplication(source: source, parent: parent, name: name)
  let root = try openDirectory(at: parent, name)
  defer { closeFD(root) }
  guard fchmod(root, 0o700) == 0, fsync(root) == 0, fsync(parent) == 0 else {
    throw InstallerFailure.rejected
  }
}
func selectionCopyApplication(
  source: SelectionRelease, parent: Int32, name: String, identifier: String
) throws -> String {
  guard mkdirat(parent, try checkedComponent(name), 0o700) == 0 else {
    throw InstallerFailure.rejected
  }
  do {
    let sourceRoot = try openAbsoluteDirectory(source.applicationPath)
    defer { closeFD(sourceRoot) }
    let destination = try openDirectory(at: parent, name)
    defer { closeFD(destination) }
    let entries = source.applicationFiles.map {
      Entry(path: $0.path, mode: $0.mode, size: $0.size, sha256: $0.sha256)
    }
    var counter = 0
    try copyPayload(
      source: sourceRoot, destination: destination, entries: entries, counter: &counter,
      failAfter: nil, sourceInstalled: true)
    try makeImmutable(destination)
    return try selectionApplicationDigest(
      parent: parent, name: name, files: source.applicationFiles, identifier: identifier,
      rootMode: 0o700)
  } catch {
    try? removeTree(parent: parent, name: name)
    throw error
  }
}
func selectionSealApplication(
  parent: Int32, name: String, files: [SelectionFile], identifier: String
) throws -> String {
  _ = try selectionApplicationDigest(
    parent: parent, name: name, files: files, identifier: identifier, rootMode: 0o700)
  let root = try openDirectory(at: parent, name)
  defer { closeFD(root) }
  guard fchmod(root, 0o555) == 0, fsync(root) == 0 else { throw InstallerFailure.rejected }
  return try selectionApplicationDigest(
    parent: parent, name: name, files: files, identifier: identifier)
}
func selectionUnsealApplication(
  parent: Int32, name: String, files: [SelectionFile], identifier: String
) throws -> String {
  _ = try selectionApplicationDigest(
    parent: parent, name: name, files: files, identifier: identifier)
  let root = try openDirectory(at: parent, name)
  defer { closeFD(root) }
  guard fchmod(root, 0o700) == 0, fsync(root) == 0 else { throw InstallerFailure.rejected }
  return try selectionApplicationDigest(
    parent: parent, name: name, files: files, identifier: identifier, rootMode: 0o700)
}
func directoryNames(_ fd: Int32, maximum: Int = maximumPayloadEntries) throws -> [String] {
  guard let stream = fdopendir(dup(fd)) else { throw InstallerFailure.rejected }
  defer { closedir(stream) }
  var names: [String] = []
  while true {
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw InstallerFailure.rejected }
      break
    }
    let name = withUnsafePointer(to: &item.pointee.d_name) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
    }
    if name != "." && name != ".." {
      names.append(name)
      guard names.count <= maximum else { throw InstallerFailure.rejected }
    }
  }
  return names.sorted()
}
func ensureDirectory(parent: Int32, name: String, mode: mode_t) throws -> Int32 {
  if mkdirat(parent, try checkedComponent(name), mode) != 0 && errno != EEXIST {
    throw InstallerFailure.rejected
  }
  let result = try openDirectory(at: parent, name)
  var info = stat()
  guard fstat(result, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o7777) == mode else {
    closeFD(result)
    throw InstallerFailure.rejected
  }
  return result
}
func removeTree(parent: Int32, name: String) throws {
  var info = stat()
  guard fstatat(parent, try checkedComponent(name), &info, AT_SYMLINK_NOFOLLOW) == 0 else {
    if errno == ENOENT { return }
    throw InstallerFailure.rejected
  }
  if (info.st_mode & S_IFMT) == S_IFDIR {
    let child = try openDirectory(at: parent, name)
    guard fchmod(child, 0o700) == 0 else {
      closeFD(child)
      throw InstallerFailure.rejected
    }
    for item in try directoryNames(child) { try removeTree(parent: child, name: item) }
    closeFD(child)
    guard unlinkat(parent, name, AT_REMOVEDIR) == 0 else { throw InstallerFailure.rejected }
  } else {
    guard (info.st_mode & S_IFMT) == S_IFREG, unlinkat(parent, name, 0) == 0 else {
      throw InstallerFailure.rejected
    }
  }
}
func productionServicesRoot() throws -> String {
  let home = try openAbsoluteDirectory(FileManager.default.homeDirectoryForCurrentUser.path)
  defer { closeFD(home) }
  try statSafeDirectory(home, privateMode: false)
  let library = try openDirectory(at: home, "Library")
  defer { closeFD(library) }
  try statSafeDirectory(library, privateMode: false)
  let support = try openDirectory(at: library, "Application Support")
  defer { closeFD(support) }
  try statSafeDirectory(support, privateMode: false)
  let ellie = try ensureDirectory(parent: support, name: "Ellie", mode: 0o700)
  defer { closeFD(ellie) }
  let services = try ensureDirectory(parent: ellie, name: "Services", mode: 0o700)
  defer { closeFD(services) }
  guard fsync(ellie) == 0, fsync(support) == 0 else { throw InstallerFailure.rejected }
  return try pathFromFD(services)
}
private func copyFile(
  source: Int32, destination: Int32, name: String, expected: Entry,
  counter: inout Int, failAfter: Int?, sourceInstalled: Bool = false
) throws {
  if let failAfter, counter == failAfter { throw InstallerFailure.rejected }
  counter += 1
  var sourceInfo = stat()
  guard fstat(source, &sourceInfo) == 0, (sourceInfo.st_mode & S_IFMT) == S_IFREG,
    sourceInfo.st_nlink == 1, sourceInfo.st_uid == getuid(), sourceInfo.st_size >= 0,
    UInt64(sourceInfo.st_size) == expected.size,
    (sourceInfo.st_mode & 0o7777)
      == (sourceInstalled ? (expected.mode == 0o755 ? 0o555 : 0o444) : mode_t(expected.mode))
  else { throw InstallerFailure.rejected }
  let targetMode: mode_t = expected.mode == 0o755 ? 0o555 : 0o444
  let output = openat(
    destination, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, targetMode)
  guard output >= 0 else { throw InstallerFailure.rejected }
  defer { closeFD(output) }
  _ = lseek(source, 0, SEEK_SET)
  var digest = SHA256()
  var total: UInt64 = 0
  var remaining = expected.size
  var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  while remaining > 0 {
    let count = buffer.withUnsafeMutableBytes {
      Darwin.read(source, $0.baseAddress!, min($0.count, Int(remaining)))
    }
    guard count > 0 else { throw InstallerFailure.rejected }
    var offset = 0
    while offset < count {
      let written = buffer.withUnsafeBytes { bytes in
        Darwin.write(output, bytes.baseAddress!.advanced(by: offset), count - offset)
      }
      guard written > 0 else { throw InstallerFailure.rejected }
      offset += written
    }
    digest.update(data: Data(buffer[0..<count]))
    total += UInt64(count)
    remaining -= UInt64(count)
  }
  let trailing = buffer.withUnsafeMutableBytes { Darwin.read(source, $0.baseAddress!, 1) }
  guard trailing == 0 else { throw InstallerFailure.rejected }
  guard fchmod(output, targetMode) == 0, fsync(output) == 0 else {
    throw InstallerFailure.rejected
  }
  let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
  guard total == expected.size, hash == expected.sha256 else { throw InstallerFailure.rejected }
}
func writeCapturedFile(
  destination: Int32, name: String, data: Data, mode: mode_t = 0o444,
  counter: inout Int, failAfter: Int?
) throws {
  if let failAfter, counter == failAfter { throw InstallerFailure.rejected }
  counter += 1
  let output = openat(
    destination, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
  guard output >= 0 else { throw InstallerFailure.rejected }
  defer { closeFD(output) }
  var offset = 0
  while offset < data.count {
    let count = data.withUnsafeBytes {
      Darwin.write(output, $0.baseAddress!.advanced(by: offset), data.count - offset)
    }
    guard count > 0 else { throw InstallerFailure.rejected }
    offset += count
  }
  guard fchmod(output, mode) == 0, fsync(output) == 0 else {
    throw InstallerFailure.rejected
  }
}
func copyPayload(
  source: Int32, destination: Int32, entries: [Entry], counter: inout Int, failAfter: Int?,
  sourceInstalled: Bool = false
) throws {
  for entry in entries {
    let parts = try components(entry.path)
    var sourceDir = dup(source)
    var destinationDir = dup(destination)
    defer {
      closeFD(sourceDir)
      closeFD(destinationDir)
    }
    for part in parts.dropLast() {
      let nextSource = try openDirectory(at: sourceDir, part)
      closeFD(sourceDir)
      sourceDir = nextSource
      let nextDestination = try ensureDirectory(parent: destinationDir, name: part, mode: 0o700)
      closeFD(destinationDir)
      destinationDir = nextDestination
    }
    let input = openat(sourceDir, parts.last!, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    guard input >= 0 else { throw InstallerFailure.rejected }
    defer { closeFD(input) }
    try copyFile(
      source: input, destination: destinationDir, name: parts.last!, expected: entry,
      counter: &counter, failAfter: failAfter, sourceInstalled: sourceInstalled)
  }
}
func makeImmutable(_ fd: Int32) throws {
  for name in try directoryNames(fd) {
    var info = stat()
    guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      throw InstallerFailure.rejected
    }
    if (info.st_mode & S_IFMT) == S_IFDIR {
      let child = try openDirectory(at: fd, name)
      try makeImmutable(child)
      guard fchmod(child, 0o555) == 0 else {
        closeFD(child)
        throw InstallerFailure.rejected
      }
      guard fsync(child) == 0 else {
        closeFD(child)
        throw InstallerFailure.rejected
      }
      closeFD(child)
    }
  }
  guard fsync(fd) == 0 else { throw InstallerFailure.rejected }
}
private func existingRelease(_ releases: Int32, _ releaseID: String) throws -> Bool {
  var info = stat()
  if fstatat(releases, try checkedComponent(releaseID), &info, AT_SYMLINK_NOFOLLOW) == 0 {
    guard (info.st_mode & S_IFMT) == S_IFDIR else { throw InstallerFailure.rejected }
    return true
  }
  guard errno == ENOENT else { throw InstallerFailure.rejected }
  return false
}
private func verifyExisting(_ releases: Int32, _ inspected: Inspected) throws {
  let existingPath = try pathFromFD(releases) + "/" + inspected.releaseID
  let existing = try inspect(existingPath, installed: true, allowPrivateStagingRoot: true)
  defer { closeFD(existing.root) }
  guard existing.releaseID == inspected.releaseID, existing.manifestData == inspected.manifestData
  else { throw InstallerFailure.rejected }
  var info = stat()
  guard fstat(existing.root, &info) == 0 else { throw InstallerFailure.rejected }
  if (info.st_mode & 0o7777) == 0o700, fchmod(existing.root, 0o555) != 0 {
    throw InstallerFailure.publicationUncertain
  }
  guard fsync(existing.root) == 0, fsync(releases) == 0 else {
    throw InstallerFailure.publicationUncertain
  }
}
private func stage(
  _ inspected: Inspected, servicesRoot: String, failAfter: Int?, competingRelease: Bool,
  failAfterRename: Bool, growSource: Bool, failCleanup: Bool
) throws {
  diagnosticCheckpoint("open-services-root")
  let support = try openAbsoluteDirectory(servicesRoot)
  defer { closeFD(support) }
  try statSafeDirectory(support, privateMode: true)
  let releases = try ensureDirectory(parent: support, name: "releases", mode: 0o700)
  defer { closeFD(releases) }
  guard fsync(support) == 0 else { throw diagnosticSyscallFailure("sync-services-root") }
  if try existingRelease(releases, inspected.releaseID) {
    try verifyExisting(releases, inspected)
    return
  }
  let stagingName = ".stage-" + UUID().uuidString.lowercased()
  guard mkdirat(releases, stagingName, 0o700) == 0 else {
    throw diagnosticSyscallFailure("create-private-stage")
  }
  var renamed = false
  do {
    let staging = try openDirectory(at: releases, stagingName)
    defer { closeFD(staging) }
    #if ELLIE_INSTALLER_TESTING
      if failCleanup {
        guard mkfifoat(staging, "cleanup-evidence", 0o600) == 0 else {
          throw InstallerFailure.rejected
        }
        throw InstallerFailure.rejected
      }
    #endif
    var count = 0
    diagnosticCheckpoint("copy-captured-metadata")
    try writeCapturedFile(
      destination: staging, name: "manifest.json", data: inspected.manifestData, counter: &count,
      failAfter: failAfter)
    try writeCapturedFile(
      destination: staging, name: "SOURCE.txt", data: inspected.sourceData, counter: &count,
      failAfter: failAfter)
    let sourcePayload = try openDirectory(at: inspected.root, "payload")
    defer { closeFD(sourcePayload) }
    #if ELLIE_INSTALLER_TESTING
      if growSource {
        let bin = try openDirectory(at: sourcePayload, "bin")
        defer { closeFD(bin) }
        let node = openat(bin, "node", O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC)
        guard node >= 0 else { throw InstallerFailure.rejected }
        defer { closeFD(node) }
        let byte: UInt8 = 120
        guard withUnsafePointer(to: byte, { Darwin.write(node, $0, 1) }) == 1 else {
          throw InstallerFailure.rejected
        }
      }
    #endif
    let destinationPayload = try ensureDirectory(parent: staging, name: "payload", mode: 0o700)
    defer { closeFD(destinationPayload) }
    diagnosticCheckpoint("copy-payload")
    try copyPayload(
      source: sourcePayload, destination: destinationPayload, entries: inspected.manifest.files,
      counter: &count, failAfter: failAfter)
    diagnosticCheckpoint("make-payload-immutable")
    try makeImmutable(destinationPayload)
    diagnosticCheckpoint("seal-private-stage", category: "filesystem-operation")
    guard fchmod(destinationPayload, 0o555) == 0, fsync(destinationPayload) == 0,
      fsync(staging) == 0
    else { throw diagnosticSyscallFailure("seal-private-stage") }
    diagnosticCheckpoint("verify-private-stage")
    let stagingPath = try pathFromFD(staging)
    let verified = try inspect(stagingPath, installed: true, allowPrivateStagingRoot: true)
    defer { closeFD(verified.root) }
    guard verified.releaseID == inspected.releaseID,
      verified.manifestData == inspected.manifestData
    else { throw InstallerFailure.rejected }
    #if ELLIE_INSTALLER_TESTING
      if competingRelease {
        guard mkdirat(releases, inspected.releaseID, 0o700) == 0 else {
          throw InstallerFailure.rejected
        }
      }
    #endif
    diagnosticCheckpoint("publish-exclusive", category: "filesystem-operation")
    if renameatx_np(releases, stagingName, releases, inspected.releaseID, UInt32(RENAME_EXCL)) != 0
    {
      guard errno == EEXIST else { throw diagnosticSyscallFailure("publish-exclusive") }
      try verifyExisting(releases, inspected)
      try removeTree(parent: releases, name: stagingName)
      return
    }
    renamed = true
    #if ELLIE_INSTALLER_TESTING
      if failAfterRename { throw InstallerFailure.publicationUncertain }
    #endif
    diagnosticCheckpoint("seal-published-release", category: "filesystem-operation")
    guard fchmod(staging, 0o555) == 0, fsync(staging) == 0, fsync(releases) == 0 else {
      throw InstallerFailure.publicationUncertain
    }
  } catch {
    if renamed { throw error }
    do { try removeTree(parent: releases, name: stagingName) } catch {
      throw InstallerFailure.cleanupIncomplete
    }
    throw error
  }
}

@main
private struct ServicePayloadInstaller {
  static func main() {
    var arguments = Array(CommandLine.arguments.dropFirst())
    #if ELLIE_POLICY_AUDIT_TESTING
      if runCompiledActivationPolicyAudit(arguments) { return }
    #endif
    if arguments.first == "inspect-authenticated-payload" {
      do { try runAuthenticatedPayloadInspection(arguments) } catch {
        failAuthenticatedPayloadInspection(error)
      }
    }
    if arguments.first == "capture-authenticated-payload"
      || arguments.first == "recover-authenticated-capture"
    {
      do { try runAuthenticatedCaptureCommand(arguments) } catch {
        failAuthenticatedCapture(error)
      }
    }
    if arguments.first == "inspect-authorization" {
      do { try runAuthorizationInspection(arguments) } catch { failAuthorizationInspection(error) }
    }
    #if ELLIE_AUTHORIZATION_TESTING
      if arguments.first == "test-authorization-policy" {
        do { try runAuthorizationPolicyTest(arguments) } catch { failAuthorizationInspection(error) }
      }
      if arguments.first == "test-authorization-resources" {
        do { try runAuthorizationResourcesTest(arguments) } catch { failAuthorizationInspection(error) }
      }
    #endif
    #if ELLIE_AUTHENTICATED_PAYLOAD_TESTING
      if arguments.first == "test-authenticated-macho" {
        do { try runAuthenticatedMachOParserTest(arguments) } catch {
          failAuthenticatedPayloadInspection(error)
        }
      }
    #endif
    #if ELLIE_ACTIVATION_POLICY_TESTING
      if arguments.first == "test-authenticated-activation-policy" {
        do { try runAuthenticatedActivationPolicyTest(arguments) } catch {
          failAuthenticatedPayloadInspection(error)
        }
      }
    #endif
    if arguments.first == "restore-legacy" || arguments.first == "recover-legacy-restore" {
      do { try runLegacyRestoreCommand(arguments) } catch { failLegacyRestoreCommand(error) }
    }
    if arguments.first == "adopt-migration" || arguments.first == "recover-migration-switch" {
      do { try runMigrationSwitchCommand(arguments) } catch { failSelectionCommand(error) }
    }
    if arguments.first == "prepare-migration" || arguments.first == "recover-migration" {
      do { try runMigrationCommand(arguments) } catch { failMigrationCommand(error) }
    }
    if arguments.first == "status" || arguments.first == "start" || arguments.first == "stop" {
      do {
        try runLifecycleCommand(arguments)
      } catch {
        failLifecycleCommand(error)
      }
    }
    if arguments.first == "select" || arguments.first == "recover" {
      do {
        try runSelectionCommand(arguments)
      } catch {
        failSelectionCommand(error)
      }
    }
    guard arguments.count >= 2 else { fail() }
    let command = arguments.removeFirst()
    let source = arguments.removeFirst()
    var destination: String?
    var failAfter: Int?
    var competingRelease = false
    var failAfterRename = false
    var growSource = false
    var failCleanup = false
    #if ELLIE_INSTALLER_TESTING
      while !arguments.isEmpty {
        let flag = arguments.removeFirst()
        guard !arguments.isEmpty else { fail() }
        if flag == "--test-services-root" {
          destination = arguments.removeFirst()
        } else if flag == "--test-fail-after" {
          failAfter = Int(arguments.removeFirst())
        } else if flag == "--test-create-competing-release" {
          competingRelease = arguments.removeFirst() == "true"
        } else if flag == "--test-fail-after-rename" {
          failAfterRename = arguments.removeFirst() == "true"
        } else if flag == "--test-grow-source" {
          growSource = arguments.removeFirst() == "true"
        } else if flag == "--test-fail-cleanup" {
          failCleanup = arguments.removeFirst() == "true"
        } else {
          fail()
        }
      }
    #else
      guard arguments.isEmpty else { fail() }
    #endif
    do {
      diagnosticCheckpoint("inspect-source")
      let inspected = try inspect(source)
      defer { closeFD(inspected.root) }
      if command == "inspect" {
        print(inspected.releaseID)
      } else if command == "stage" {
        try stage(
          inspected, servicesRoot: destination ?? productionServicesRoot(), failAfter: failAfter,
          competingRelease: competingRelease, failAfterRename: failAfterRename,
          growSource: growSource, failCleanup: failCleanup)
        print(inspected.releaseID)
      } else {
        throw InstallerFailure.rejected
      }
    } catch { fail(error) }
  }
}
