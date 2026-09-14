import CryptoKit
import Darwin
import Foundation
import Security

private enum MigrationFailure: Error { case rejected, stale, loaded, recoveryRequired, unavailable }
private enum MigrationRole: String, Codable, CaseIterable {
  case coordinator, node
  var app: String { self == .coordinator ? "Ellie Coordinator.app" : "Ellie Node.app" }
  var label: String { "org.ellie.assistant.\(rawValue)" }
  var identifier: String { label + ".app" }
  var plist: String { label + ".plist" }
}
private struct LegacyRuntime: Codable {
  let node: String
  let entrypoint: String
  let role: String
}
private struct LegacyBuild: Codable {
  let managedBy: String
  let role: String
  let digest: String
}
private struct MigrationEntry: Codable, Equatable {
  let path: String
  let mode: Int
  let size: UInt64
  let sha256: String
}
private struct MigrationBinding: Codable {
  let role: String
  let checkout: String
  let node: String
  let nodeSHA256: String
  let entrypointSHA256: String
  let buildDigest: String
  let directoryModes: [String: Int]
}
private struct MigrationManifest: Codable {
  let version: Int
  let roles: [String]
  let bindings: [MigrationBinding]
  let files: [MigrationEntry]
}
private struct MigrationIntent: Codable {
  let version: Int
  let transactionID: String
  let snapshotID: String
  let stageName: String
  let roles: [String]
  let manifestSHA256: String
}
private let migrationError =
  "Ellie legacy service migration preparation failed; existing services were preserved."
private let migrationStale =
  "The legacy service no longer matches its recorded checkout build; it was preserved."
private let migrationLoaded =
  "Both legacy service labels must be unloaded before migration preparation."
private let migrationRecovery =
  "Legacy migration preparation requires explicit recovery; retained evidence was preserved."
private let migrationUnavailable =
  "Ellie could not verify that both legacy service labels are unloaded."
private let migrationMaxFile: UInt64 = 128 * 1024 * 1024
private let migrationMaxTotal: UInt64 = 512 * 1024 * 1024
private let migrationMaxEntries = 64
private func migrationFail(_ error: Error) -> Never {
  let message: String
  switch error as? MigrationFailure {
  case .stale: message = migrationStale
  case .loaded: message = migrationLoaded
  case .recoveryRequired: message = migrationRecovery
  case .unavailable: message = migrationUnavailable
  default: message = migrationError
  }
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
private func migrationHash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func migrationHex(_ value: String) -> Bool {
  value.utf8.count == 64
    && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
private func migrationCanonicalPath(_ value: String) -> Bool {
  value.hasPrefix("/") && value != "/"
    && value.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy {
      !$0.isEmpty && $0 != "." && $0 != ".."
    }
}
private func migrationCanonical<T: Encodable>(_ value: T) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return try encoder.encode(value) + Data("\n".utf8)
}
private func migrationRead(_ parent: Int32, _ name: String, mode: mode_t, max: UInt64) throws -> (
  Data, stat
) {
  let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  guard fd >= 0 else { throw MigrationFailure.rejected }
  defer { close(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
    info.st_nlink == 1, mode == 0 ? (info.st_mode & 0o022) == 0 : (info.st_mode & 0o7777) == mode,
    info.st_size >= 0,
    UInt64(info.st_size) <= max
  else { throw MigrationFailure.rejected }
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 65_536)
  while true {
    let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
    if count == 0 { break }
    guard count > 0, UInt64(data.count + count) <= max else { throw MigrationFailure.rejected }
    data.append(buffer, count: count)
  }
  var final = stat()
  guard fstat(fd, &final) == 0, final.st_dev == info.st_dev, final.st_ino == info.st_ino,
    final.st_size == info.st_size, final.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec,
    final.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec
  else { throw MigrationFailure.rejected }
  return (data, info)
}
private func migrationNames(_ fd: Int32, max: Int = migrationMaxEntries) throws -> [String] {
  let fresh = openat(fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
  guard fresh >= 0, let stream = fdopendir(fresh) else {
    if fresh >= 0 { close(fresh) }
    throw MigrationFailure.rejected
  }
  defer { closedir(stream) }
  var result: [String] = []
  while true {
    errno = 0
    guard let item = readdir(stream) else {
      guard errno == 0 else { throw MigrationFailure.rejected }
      break
    }
    let name = withUnsafePointer(to: &item.pointee.d_name) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) { String(cString: $0) }
    }
    if name != "." && name != ".." {
      result.append(name)
      guard result.count <= max else { throw MigrationFailure.rejected }
    }
  }
  return result.sorted()
}
private func migrationInfo(_ parent: Int32, _ name: String) throws -> stat? {
  var value = stat()
  if fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return value }
  if errno == ENOENT { return nil }
  throw MigrationFailure.rejected
}
private struct MigrationDirectoryIdentity {
  let device: dev_t
  let inode: ino_t
}
private func migrationIdentity(_ fd: Int32) throws -> MigrationDirectoryIdentity {
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
    throw MigrationFailure.recoveryRequired
  }
  return MigrationDirectoryIdentity(device: info.st_dev, inode: info.st_ino)
}
private func migrationSame(_ fd: Int32, _ expected: MigrationDirectoryIdentity) throws {
  let current = try migrationIdentity(fd)
  guard current.device == expected.device, current.inode == expected.inode else {
    throw MigrationFailure.recoveryRequired
  }
}
private func revalidateMigrationChain(
  homePath: String, expected: [MigrationDirectoryIdentity]
) throws {
  let home = try selectionOpenDirectory(homePath, privateMode: false)
  defer { close(home) }
  let library = try selectionOpenOwnedDirectory(parent: home, name: "Library")
  defer { close(library) }
  let support = try selectionOpenOwnedDirectory(parent: library, name: "Application Support")
  defer { close(support) }
  let ellie = try selectionOpenOwnedDirectory(parent: support, name: "Ellie")
  defer { close(ellie) }
  let services = try selectionOpenOwnedDirectory(parent: ellie, name: "Services")
  defer { close(services) }
  let migrations = try selectionOpenOwnedDirectory(parent: services, name: "migrations")
  defer { close(migrations) }
  var actual = [home, library, support, ellie, services, migrations]
  var additional: [Int32] = []
  if expected.count == 8 {
    let applications = try selectionOpenOwnedDirectory(parent: home, name: "Applications")
    let agents = try selectionOpenOwnedDirectory(parent: library, name: "LaunchAgents")
    additional = [applications, agents]
    actual.append(contentsOf: additional)
  }
  defer { additional.forEach { close($0) } }
  guard actual.count == expected.count else { throw MigrationFailure.recoveryRequired }
  for (fd, identity) in zip(actual, expected) { try migrationSame(fd, identity) }
}
private func legacyInfo(_ role: MigrationRole) -> Data {
  Data(
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>\(role.identifier)</string>
    <key>CFBundleName</key><string>\(role == .node ? "Ellie Node" : "Ellie Coordinator")</string>
    <key>CFBundleDisplayName</key><string>\(role == .node ? "Ellie Node" : "Ellie Coordinator")</string>
    <key>CFBundleExecutable</key><string>EllieService</string>
    <key>CFBundleIconFile</key><string>Ellie</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>0.1.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    </dict></plist>

    """.utf8)
}
private func xml(_ value: String) throws -> String {
  guard !value.utf8.contains(0),
    !value.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) })
  else { throw MigrationFailure.rejected }
  return value.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(
    of: "<", with: "&lt;"
  ).replacingOccurrences(of: ">", with: "&gt;").replacingOccurrences(of: "\"", with: "&quot;")
    .replacingOccurrences(of: "'", with: "&apos;")
}
private func legacyPlist(_ role: MigrationRole, home: String, checkout: String, node: String) throws
  -> Data
{
  let str: (String) throws -> String = { "<string>\(try xml($0))</string>" }
  let name = role == .node ? "Interactive" : "Standard"
  return Data(
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <!-- Managed by Ellie service install; version 1. -->
    <plist version="1.0"><dict>
    <key>Label</key>\(try str(role.label))
    <key>ProgramArguments</key><array>\(try str(home + "/Applications/" + role.app + "/Contents/MacOS/EllieService"))\(try str("--launch-agent"))</array>
    <key>AssociatedBundleIdentifiers</key><array>\(try str(role.identifier))</array>
    <key>WorkingDirectory</key>\(try str(checkout))
    <key>EnvironmentVariables</key><dict><key>HOME</key>\(try str(home))<key>PATH</key>\(try str((node as NSString).deletingLastPathComponent + ":/usr/bin:/bin:/usr/sbin:/sbin"))</dict>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>ProcessType</key><string>\(name)</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>AbandonProcessGroup</key><false/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>ExitTimeOut</key><integer>15</integer>
    <key>Umask</key><integer>63</integer>
    <key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
    <key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>/dev/null</string>
    <key>StandardErrorPath</key><string>/dev/null</string>
    </dict></plist>

    """.utf8)
}
private func exactObject<T: Decodable>(_ type: T.Type, data: Data, keys: Set<String>) throws -> T {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == keys
  else { throw MigrationFailure.rejected }
  return try JSONDecoder().decode(type, from: data)
}
private func migrationRun(
  _ executable: String, _ arguments: [String], timeout: UInt64 = 2_000_000_000
) throws -> Int32 {
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else { throw MigrationFailure.unavailable }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
    posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0,
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0
  else { throw MigrationFailure.unavailable }
  var argv = ([executable] + arguments).map { strdup($0) } + [nil]
  defer { argv.forEach { pointer in if let pointer { free(pointer) } } }
  var pid: pid_t = 0
  guard posix_spawn(&pid, executable, &actions, nil, &argv, environ) == 0 else {
    throw MigrationFailure.unavailable
  }
  let deadline = DispatchTime.now().uptimeNanoseconds + timeout
  var status: Int32 = 0
  func reapAfterSignal(_ signal: Int32) {
    _ = kill(pid, signal)
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
  }
  while DispatchTime.now().uptimeNanoseconds < deadline {
    let value = waitpid(pid, &status, WNOHANG)
    if value == pid { return (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1 }
    if value < 0 && errno != EINTR {
      if errno != ECHILD { reapAfterSignal(SIGKILL) }
      throw MigrationFailure.unavailable
    }
    usleep(10_000)
  }
  _ = kill(pid, SIGTERM)
  let grace = DispatchTime.now().uptimeNanoseconds + 100_000_000
  while DispatchTime.now().uptimeNanoseconds < grace {
    let value = waitpid(pid, &status, WNOHANG)
    if value == pid || (value < 0 && errno == ECHILD) { throw MigrationFailure.unavailable }
    if value < 0 && errno != EINTR {
      reapAfterSignal(SIGKILL)
      throw MigrationFailure.unavailable
    }
    usleep(5_000)
  }
  reapAfterSignal(SIGKILL)
  throw MigrationFailure.unavailable
}
private func bothUnloaded(_ launchctl: String) throws {
  let domain = "gui/\(getuid())"
  guard try migrationRun(launchctl, ["print", domain]) == 0 else {
    throw MigrationFailure.unavailable
  }
  for role in MigrationRole.allCases {
    let code = try migrationRun(launchctl, ["print", domain + "/" + role.label])
    guard code == 113 else {
      if code == 0 { throw MigrationFailure.loaded }
      throw MigrationFailure.unavailable
    }
  }
}
private func flexibleRead(path: String, maximum: UInt64) throws -> (Data, stat) {
  let parent = try selectionOpenDirectory(
    (path as NSString).deletingLastPathComponent, privateMode: false)
  defer { close(parent) }
  let name = (path as NSString).lastPathComponent
  let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  guard fd >= 0 else { throw MigrationFailure.rejected }
  defer { close(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
    info.st_nlink == 1,
    (info.st_mode & 0o022) == 0, info.st_size >= 0, UInt64(info.st_size) <= maximum
  else { throw MigrationFailure.rejected }
  var result = Data()
  var buffer = [UInt8](repeating: 0, count: 65_536)
  while true {
    let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress!, $0.count) }
    if count == 0 { break }
    guard count > 0, UInt64(result.count + count) <= maximum else {
      throw MigrationFailure.rejected
    }
    result.append(buffer, count: count)
  }
  var final = stat()
  guard fstat(fd, &final) == 0, final.st_dev == info.st_dev, final.st_ino == info.st_ino,
    final.st_size == info.st_size, final.st_mtimespec.tv_sec == info.st_mtimespec.tv_sec,
    final.st_mtimespec.tv_nsec == info.st_mtimespec.tv_nsec
  else { throw MigrationFailure.rejected }
  return (result, info)
}
private struct LegacyRoleSnapshot {
  let role: MigrationRole
  let binding: MigrationBinding
  let entries: [MigrationEntry]
  let bytes: [String: Data]
}
private func legacySnapshot(role: MigrationRole, home: String, applications: Int32, agents: Int32)
  throws -> LegacyRoleSnapshot
{
  let app = try selectionOpenOwnedDirectory(parent: applications, name: role.app)
  defer { close(app) }
  var appInfo = stat()
  guard fstat(app, &appInfo) == 0, (appInfo.st_mode & 0o7777) == 0o700 else {
    throw MigrationFailure.rejected
  }
  guard try migrationNames(app) == ["Contents"] else { throw MigrationFailure.rejected }
  let contents = try selectionOpenOwnedDirectory(parent: app, name: "Contents")
  defer { close(contents) }
  guard try migrationNames(contents) == ["Info.plist", "MacOS", "Resources", "_CodeSignature"]
  else { throw MigrationFailure.rejected }
  let macos = try selectionOpenOwnedDirectory(parent: contents, name: "MacOS")
  defer { close(macos) }
  let resources = try selectionOpenOwnedDirectory(parent: contents, name: "Resources")
  defer { close(resources) }
  let signatures = try selectionOpenOwnedDirectory(parent: contents, name: "_CodeSignature")
  defer { close(signatures) }
  var directoryModes: [String: Int] = ["application": Int(appInfo.st_mode & 0o7777)]
  for (directory, path) in [
    (contents, "application/Contents"), (macos, "application/Contents/MacOS"),
    (resources, "application/Contents/Resources"),
    (signatures, "application/Contents/_CodeSignature"),
  ] {
    var info = stat()
    guard fstat(directory, &info) == 0, (info.st_mode & 0o022) == 0 else {
      throw MigrationFailure.rejected
    }
    directoryModes[path] = Int(info.st_mode & 0o7777)
  }
  guard try migrationNames(macos) == ["EllieService"],
    try migrationNames(resources) == ["Ellie.icns", "ellie-build.json", "runtime.json"],
    try migrationNames(signatures) == ["CodeResources"]
  else { throw MigrationFailure.rejected }
  let expected: [(Int32, String, String, mode_t, UInt64)] = [
    (contents, "Info.plist", "Contents/Info.plist", 0o600, 64 * 1024),
    (macos, "EllieService", "Contents/MacOS/EllieService", 0o700, migrationMaxFile),
    (resources, "Ellie.icns", "Contents/Resources/Ellie.icns", 0, 16 * 1024 * 1024),
    (resources, "ellie-build.json", "Contents/Resources/ellie-build.json", 0o600, 4096),
    (resources, "runtime.json", "Contents/Resources/runtime.json", 0o600, 4096),
    (signatures, "CodeResources", "Contents/_CodeSignature/CodeResources", 0, 1024 * 1024),
  ]
  var entries: [MigrationEntry] = []
  var bytes: [String: Data] = [:]
  var total: UInt64 = 0
  for item in expected {
    let (data, info) = try migrationRead(item.0, item.1, mode: item.3, max: item.4)
    guard total <= migrationMaxTotal - UInt64(data.count) else { throw MigrationFailure.rejected }
    total += UInt64(data.count)
    entries.append(
      MigrationEntry(
        path: "roles/\(role.rawValue)/application/\(item.2)", mode: Int(info.st_mode & 0o7777),
        size: UInt64(data.count), sha256: migrationHash(data)))
    bytes[item.2] = data
  }
  let plist = try migrationRead(agents, role.plist, mode: 0o600, max: 64 * 1024).0
  guard total <= migrationMaxTotal - UInt64(plist.count) else { throw MigrationFailure.rejected }
  entries.append(
    MigrationEntry(
      path: "roles/\(role.rawValue)/launch-agent.plist", mode: 0o600, size: UInt64(plist.count),
      sha256: migrationHash(plist)))
  bytes["launch-agent.plist"] = plist
  let runtimeData = bytes["Contents/Resources/runtime.json"]!
  let runtime = try exactObject(
    LegacyRuntime.self, data: runtimeData, keys: ["node", "entrypoint", "role"])
  guard runtime.role == role.rawValue, runtime.node.hasPrefix("/"),
    migrationCanonicalPath(runtime.node), migrationCanonicalPath(runtime.entrypoint),
    runtime.entrypoint.hasSuffix("/apps/cli/src/main.ts")
  else { throw MigrationFailure.rejected }
  let checkout = String(runtime.entrypoint.dropLast("/apps/cli/src/main.ts".count))
  let entrypointData = try flexibleRead(path: runtime.entrypoint, maximum: migrationMaxFile).0
  guard !checkout.isEmpty, !entrypointData.isEmpty
  else { throw MigrationFailure.stale }
  let info = legacyInfo(role)
  guard bytes["Contents/Info.plist"] == info,
    plist == (try legacyPlist(role, home: home, checkout: checkout, node: runtime.node))
  else { throw MigrationFailure.rejected }
  let buildData = bytes["Contents/Resources/ellie-build.json"]!
  let build = try exactObject(
    LegacyBuild.self, data: buildData, keys: ["managedBy", "role", "digest"])
  guard build.managedBy == "ellie-service-v1", build.role == role.rawValue,
    build.digest.utf8.count == 64,
    build.digest.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) })
  else { throw MigrationFailure.rejected }
  let source = try flexibleRead(
    path: checkout + "/packages/macos/native/EllieService.swift", maximum: 4 * 1024 * 1024
  ).0
  let icon = try flexibleRead(
    path: checkout + "/packages/macos/assets/Ellie.png", maximum: 16 * 1024 * 1024
  ).0
  var digest = SHA256()
  digest.update(data: source)
  digest.update(data: icon)
  digest.update(data: runtimeData)
  digest.update(data: info)
  guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == build.digest else {
    throw MigrationFailure.stale
  }
  let (nodeData, _) = try flexibleRead(path: runtime.node, maximum: migrationMaxFile)
  try selectionValidateSignature(path: try selectionPathFromFD(app), identifier: role.identifier)
  return LegacyRoleSnapshot(
    role: role,
    binding: MigrationBinding(
      role: role.rawValue, checkout: checkout, node: runtime.node,
      nodeSHA256: migrationHash(nodeData), entrypointSHA256: migrationHash(entrypointData),
      buildDigest: build.digest, directoryModes: directoryModes), entries: entries,
    bytes: bytes)
}
private func createDirectory(_ parent: Int32, _ name: String, mode: mode_t = 0o700) throws -> Int32
{
  guard mkdirat(parent, name, mode) == 0 else { throw MigrationFailure.rejected }
  return try selectionOpenChildDirectory(parent: parent, name: name)
}
private func writeSnapshotFile(_ parent: Int32, _ name: String, data: Data) throws {
  let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard fd >= 0 else { throw MigrationFailure.rejected }
  defer { close(fd) }
  var offset = 0
  while offset < data.count {
    let count = data.withUnsafeBytes {
      write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset)
    }
    guard count > 0 else { throw MigrationFailure.rejected }
    offset += count
  }
  guard fchmod(fd, 0o444) == 0, fsync(fd) == 0 else { throw MigrationFailure.rejected }
}
private func buildSnapshot(stage: Int32, snapshots: [LegacyRoleSnapshot], manifestData: Data) throws
{
  let roles = try createDirectory(stage, "roles")
  defer { close(roles) }
  try writeSnapshotFile(stage, "manifest.json", data: manifestData)
  for snapshot in snapshots {
    let role = try createDirectory(roles, snapshot.role.rawValue)
    defer { close(role) }
    let application = try createDirectory(role, "application")
    defer { close(application) }
    let contents = try createDirectory(application, "Contents")
    defer { close(contents) }
    let macos = try createDirectory(contents, "MacOS")
    defer { close(macos) }
    let resources = try createDirectory(contents, "Resources")
    defer { close(resources) }
    let signature = try createDirectory(contents, "_CodeSignature")
    defer { close(signature) }
    for (path, data) in snapshot.bytes where path != "launch-agent.plist" {
      let destination: (Int32, String)
      if path.hasPrefix("Contents/MacOS/") {
        destination = (macos, (path as NSString).lastPathComponent)
      } else if path.hasPrefix("Contents/Resources/") {
        destination = (resources, (path as NSString).lastPathComponent)
      } else if path.hasPrefix("Contents/_CodeSignature/") {
        destination = (signature, (path as NSString).lastPathComponent)
      } else {
        destination = (contents, (path as NSString).lastPathComponent)
      }
      try writeSnapshotFile(destination.0, destination.1, data: data)
    }
    try writeSnapshotFile(role, "launch-agent.plist", data: snapshot.bytes["launch-agent.plist"]!)
  }
}
private func intentData(_ intent: MigrationIntent) throws -> Data { try migrationCanonical(intent) }
private func writeIntent(_ services: Int32, _ intent: MigrationIntent) throws {
  let data = try intentData(intent)
  let temporary = ".migration-intent-\(intent.transactionID)"
  var fd = openat(
    services, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard fd >= 0 else { throw MigrationFailure.rejected }
  do {
    var offset = 0
    while offset < data.count {
      let count = data.withUnsafeBytes {
        write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset)
      }
      guard count > 0 else { throw MigrationFailure.rejected }
      offset += count
    }
    guard fchmod(fd, 0o600) == 0, fsync(fd) == 0 else { throw MigrationFailure.rejected }
    close(fd)
    fd = -1
    guard
      renameatx_np(services, temporary, services, "migration-preparation.json", UInt32(RENAME_EXCL))
        == 0, fsync(services) == 0
    else { throw MigrationFailure.rejected }
  } catch {
    if fd >= 0 { close(fd) }
    unlinkat(services, temporary, 0)
    throw error
  }
}
private func openMigrationHome(_ homePath: String) throws -> (Int32, Int32, Int32, Int32, Int32) {
  let home = try selectionOpenDirectory(homePath, privateMode: false)
  do {
    let library = try selectionOpenOwnedDirectory(parent: home, name: "Library")
    let support = try selectionOpenOwnedDirectory(parent: library, name: "Application Support")
    let ellie = try selectionEnsureOwnedDirectory(parent: support, name: "Ellie")
    let services = try selectionEnsureOwnedDirectory(parent: ellie, name: "Services")
    return (home, library, ellie, services, support)
  } catch {
    close(home)
    throw error
  }
}
private func migrationLock(_ services: Int32) throws -> Int32 {
  if try migrationInfo(services, "selection.lock") == nil {
    let created = openat(
      services, "selection.lock", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard created >= 0, fchmod(created, 0o600) == 0, fsync(created) == 0, fsync(services) == 0
    else {
      if created >= 0 { close(created) }
      throw MigrationFailure.rejected
    }
    close(created)
  }
  let fd = openat(services, "selection.lock", O_RDWR | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
  var info = stat()
  guard fd >= 0, fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
    info.st_nlink == 1, (info.st_mode & 0o7777) == 0o600
  else {
    if fd >= 0 { close(fd) }
    throw MigrationFailure.recoveryRequired
  }
  guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
    close(fd)
    throw MigrationFailure.recoveryRequired
  }
  return fd
}
private func migrationDirectory(_ services: Int32) throws -> Int32 {
  if try migrationInfo(services, "migrations") == nil {
    guard mkdirat(services, "migrations", 0o700) == 0, fsync(services) == 0 else {
      throw MigrationFailure.rejected
    }
  }
  let directory = try selectionOpenChildDirectory(parent: services, name: "migrations")
  var info = stat()
  guard fstat(directory, &info) == 0, info.st_uid == getuid(), info.st_nlink >= 2,
    (info.st_mode & 0o7777) == 0o700
  else {
    close(directory)
    throw MigrationFailure.rejected
  }
  return directory
}
private func parseIntent(_ data: Data) throws -> MigrationIntent {
  let value = try exactObject(
    MigrationIntent.self, data: data,
    keys: ["version", "transactionID", "snapshotID", "stageName", "roles", "manifestSHA256"])
  guard value.version == 1,
    UUID(uuidString: value.transactionID)?.uuidString.lowercased() == value.transactionID,
    value.stageName == ".migration-stage-" + value.transactionID,
    value.snapshotID == "legacy-v1-" + value.manifestSHA256, value.roles == value.roles.sorted(),
    !value.roles.isEmpty, Set(value.roles).count == value.roles.count,
    value.roles.allSatisfy({ MigrationRole(rawValue: $0) != nil }),
    migrationHex(value.manifestSHA256)
  else { throw MigrationFailure.recoveryRequired }
  return value
}
private func decodedMigrationManifest(_ data: Data, intent: MigrationIntent) throws
  -> MigrationManifest
{
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let bindings = object["bindings"] as? [[String: Any]],
    let files = object["files"] as? [[String: Any]],
    bindings.allSatisfy({
      Set($0.keys) == [
        "role", "checkout", "node", "nodeSHA256", "entrypointSHA256", "buildDigest",
        "directoryModes",
      ]
    }),
    files.allSatisfy({ Set($0.keys) == ["path", "mode", "size", "sha256"] })
  else { throw MigrationFailure.recoveryRequired }
  let value = try exactObject(
    MigrationManifest.self, data: data, keys: ["version", "roles", "bindings", "files"])
  var total: UInt64 = 0
  for entry in value.files {
    guard entry.size <= migrationMaxFile else { throw MigrationFailure.recoveryRequired }
    guard total <= migrationMaxTotal - entry.size else { throw MigrationFailure.recoveryRequired }
    total += entry.size
  }
  guard value.version == 1, value.roles == intent.roles,
    migrationHash(data) == intent.manifestSHA256,
    !value.files.isEmpty, value.files.count <= migrationMaxEntries,
    value.files.map(\.path) == value.files.map(\.path).sorted(),
    Set(value.files.map(\.path)).count == value.files.count,
    value.bindings.map(\.role) == value.roles,
    value.bindings.allSatisfy({ binding in
      migrationCanonicalPath(binding.checkout) && migrationCanonicalPath(binding.node)
        && migrationHex(binding.nodeSHA256) && migrationHex(binding.entrypointSHA256)
        && migrationHex(binding.buildDigest)
        && Set(binding.directoryModes.keys)
          == Set([
            "application", "application/Contents", "application/Contents/MacOS",
            "application/Contents/Resources", "application/Contents/_CodeSignature",
          ])
        && binding.directoryModes.values.allSatisfy({
          $0 > 0 && $0 <= 0o777 && ($0 & 0o022) == 0
        })
    }),
    value.files.allSatisfy({ entry in
      !entry.path.hasPrefix("/")
        && !entry.path.split(separator: "/", omittingEmptySubsequences: false)
          .contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })
        && migrationHex(entry.sha256) && entry.mode > 0
        && entry.mode <= 0o777 && (entry.mode & 0o022) == 0
    }),
    Set(value.files.map(\.path))
      == Set(
        value.roles.flatMap { role in
          [
            "roles/\(role)/application/Contents/Info.plist",
            "roles/\(role)/application/Contents/MacOS/EllieService",
            "roles/\(role)/application/Contents/Resources/Ellie.icns",
            "roles/\(role)/application/Contents/Resources/ellie-build.json",
            "roles/\(role)/application/Contents/Resources/runtime.json",
            "roles/\(role)/application/Contents/_CodeSignature/CodeResources",
            "roles/\(role)/launch-agent.plist",
          ]
        })
  else { throw MigrationFailure.recoveryRequired }
  return value
}
private func verifySnapshotTree(
  root: Int32, intent: MigrationIntent, partial: Bool, final: Bool
) throws {
  let rootNames = try migrationNames(root)
  if !rootNames.contains("manifest.json") {
    guard partial, rootNames.isEmpty else { throw MigrationFailure.recoveryRequired }
    return
  }
  let manifestData = try migrationRead(root, "manifest.json", mode: 0o444, max: 1024 * 1024).0
  let manifest = try decodedMigrationManifest(manifestData, intent: intent)
  let expected = Dictionary(uniqueKeysWithValues: manifest.files.map { ($0.path, $0) })
  var allowedDirectories = Set<String>(["roles"])
  for entry in manifest.files {
    var pieces = entry.path.split(separator: "/").map(String.init)
    pieces.removeLast()
    while !pieces.isEmpty {
      allowedDirectories.insert(pieces.joined(separator: "/"))
      pieces.removeLast()
    }
  }
  var found = Set<String>()
  var count = 0
  func walk(_ directory: Int32, _ prefix: String) throws {
    let names = try migrationNames(directory)
    for name in names {
      count += 1
      guard count <= migrationMaxEntries * 2 else { throw MigrationFailure.recoveryRequired }
      let path = prefix.isEmpty ? name : prefix + "/" + name
      if prefix.isEmpty && name == "manifest.json" { continue }
      guard let info = try migrationInfo(directory, name) else {
        throw MigrationFailure.recoveryRequired
      }
      if (info.st_mode & S_IFMT) == S_IFDIR {
        guard allowedDirectories.contains(path), info.st_uid == getuid(),
          final ? (info.st_mode & 0o7777) == 0o555 : [0o700, 0o555].contains(info.st_mode & 0o7777)
        else { throw MigrationFailure.recoveryRequired }
        let child = try selectionOpenChildDirectory(parent: directory, name: name)
        defer { close(child) }
        try walk(child, path)
      } else {
        guard let entry = expected[path], found.insert(path).inserted else {
          throw MigrationFailure.recoveryRequired
        }
        let data = try migrationRead(directory, name, mode: 0o444, max: migrationMaxFile).0
        guard UInt64(data.count) == entry.size, migrationHash(data) == entry.sha256 else {
          throw MigrationFailure.recoveryRequired
        }
      }
    }
  }
  try walk(root, "")
  if !partial { guard found == Set(expected.keys) else { throw MigrationFailure.recoveryRequired } }
}
private func sealSnapshotDirectories(_ directory: Int32) throws {
  for name in try migrationNames(directory) {
    guard let info = try migrationInfo(directory, name) else {
      throw MigrationFailure.recoveryRequired
    }
    if (info.st_mode & S_IFMT) == S_IFDIR {
      let child = try selectionOpenChildDirectory(parent: directory, name: name)
      defer { close(child) }
      try sealSnapshotDirectories(child)
      guard fchmod(child, 0o555) == 0, fsync(child) == 0 else {
        throw MigrationFailure.recoveryRequired
      }
    }
  }
  guard fsync(directory) == 0 else { throw MigrationFailure.recoveryRequired }
}
private func recoverMigration(migrations: Int32, beforeCommit: () throws -> Void) throws {
  guard let intentInfo = try migrationInfo(migrations, "migration-preparation.json") else { return }
  guard (intentInfo.st_mode & S_IFMT) == S_IFREG else { throw MigrationFailure.recoveryRequired }
  let data = try migrationRead(
    migrations, "migration-preparation.json", mode: 0o600, max: 32 * 1024
  )
  .0
  let intent = try parseIntent(data)
  if let final = try migrationInfo(migrations, intent.snapshotID) {
    guard (final.st_mode & S_IFMT) == S_IFDIR,
      [0o700, 0o555].contains(final.st_mode & 0o7777)
    else {
      throw MigrationFailure.recoveryRequired
    }
    let root = try selectionOpenChildDirectory(parent: migrations, name: intent.snapshotID)
    defer { close(root) }
    if (final.st_mode & 0o7777) == 0o700 {
      try verifySnapshotTree(root: root, intent: intent, partial: false, final: false)
      guard fchmod(root, 0o555) == 0, fsync(root) == 0, fsync(migrations) == 0 else {
        throw MigrationFailure.recoveryRequired
      }
    }
    try verifySnapshotTree(root: root, intent: intent, partial: false, final: true)
    guard try migrationInfo(migrations, intent.stageName) == nil else {
      throw MigrationFailure.recoveryRequired
    }
    try beforeCommit()
    guard unlinkat(migrations, "migration-preparation.json", 0) == 0, fsync(migrations) == 0 else {
      throw MigrationFailure.recoveryRequired
    }
    return
  }
  if try migrationInfo(migrations, intent.stageName) != nil {
    let stage = try selectionOpenChildDirectory(parent: migrations, name: intent.stageName)
    defer { close(stage) }
    try verifySnapshotTree(root: stage, intent: intent, partial: true, final: false)
    try selectionRemoveTree(parent: migrations, name: intent.stageName)
  }
  try beforeCommit()
  guard unlinkat(migrations, "migration-preparation.json", 0) == 0, fsync(migrations) == 0 else {
    throw MigrationFailure.recoveryRequired
  }
}
func runMigrationCommand(_ input: [String]) throws -> Never {
  var args = input
  let command = args.removeFirst()
  var home = FileManager.default.homeDirectoryForCurrentUser.path
  var launchctl = "/bin/launchctl"
  var testFault: String?
  var testSwapAfterRename = false
  #if ELLIE_INSTALLER_TESTING
    if let i = args.firstIndex(of: "--test-home-root"), i + 1 < args.count {
      home = args[i + 1]
      args.removeSubrange(i...i + 1)
    }
    if let i = args.firstIndex(of: "--test-launchctl"), i + 1 < args.count {
      launchctl = args[i + 1]
      args.removeSubrange(i...i + 1)
    }
    if let i = args.firstIndex(of: "--test-migration-fault"), i + 1 < args.count {
      testFault = args[i + 1]
      args.removeSubrange(i...i + 1)
    }
    if let i = args.firstIndex(of: "--test-migration-swap-after-rename") {
      testSwapAfterRename = true
      args.remove(at: i)
    }
  #endif
  func fault(_ name: String) throws {
    #if ELLIE_INSTALLER_TESTING
      if testFault == name { throw MigrationFailure.recoveryRequired }
    #endif
  }
  let roles: [MigrationRole]
  if command == "prepare-migration" {
    guard args.count == 2, args[0] == "--roles" else { throw MigrationFailure.rejected }
    switch args[1] {
    case "coordinator": roles = [.coordinator]
    case "node": roles = [.node]
    case "coordinator,node": roles = [.coordinator, .node]
    default: throw MigrationFailure.rejected
    }
  } else {
    guard command == "recover-migration", args.isEmpty else { throw MigrationFailure.rejected }
    roles = []
  }
  let (homeFD, library, ellie, services, support) = try openMigrationHome(home)
  defer {
    close(homeFD)
    close(library)
    close(ellie)
    close(services)
    close(support)
  }
  let lock = try migrationLock(services)
  defer {
    flock(lock, LOCK_UN)
    close(lock)
  }
  if command == "recover-migration" {
    try bothUnloaded(launchctl)
    guard try migrationInfo(services, "migrations") != nil else { exit(0) }
    let migrations = try migrationDirectory(services)
    defer { close(migrations) }
    let identities = try [homeFD, library, support, ellie, services, migrations].map(
      migrationIdentity)
    try recoverMigration(migrations: migrations) {
      try revalidateMigrationChain(homePath: home, expected: identities)
    }
    exit(0)
  }
  guard try migrationInfo(services, "selection-journal.json") == nil
  else { throw MigrationFailure.recoveryRequired }
  if let receipts = try migrationInfo(services, "receipts") {
    _ = receipts
    throw MigrationFailure.rejected
  }
  let migrations = try migrationDirectory(services)
  defer { close(migrations) }
  guard try migrationInfo(migrations, "migration-preparation.json") == nil else {
    throw MigrationFailure.recoveryRequired
  }
  try bothUnloaded(launchctl)
  let applications = try selectionOpenOwnedDirectory(parent: homeFD, name: "Applications")
  defer { close(applications) }
  let agents = try selectionOpenOwnedDirectory(parent: library, name: "LaunchAgents")
  defer { close(agents) }
  let directoryIdentities = try [
    homeFD, library, support, ellie, services, migrations, applications, agents,
  ].map(migrationIdentity)
  for role in MigrationRole.allCases {
    let appExists = try migrationInfo(applications, role.app) != nil
    let plistExists = try migrationInfo(agents, role.plist) != nil
    guard appExists == plistExists, !roles.contains(role) || appExists else {
      throw MigrationFailure.rejected
    }
  }
  let snapshots = try roles.map {
    return try legacySnapshot(role: $0, home: home, applications: applications, agents: agents)
  }
  let entries = snapshots.flatMap(\.entries).sorted { $0.path < $1.path }
  guard entries.count <= migrationMaxEntries else { throw MigrationFailure.rejected }
  let manifest = MigrationManifest(
    version: 1, roles: roles.map(\.rawValue), bindings: snapshots.map(\.binding), files: entries)
  let manifestData = try migrationCanonical(manifest)
  let manifestHash = migrationHash(manifestData)
  let snapshotID = "legacy-v1-" + manifestHash
  if let existing = try migrationInfo(migrations, snapshotID) {
    guard (existing.st_mode & S_IFMT) == S_IFDIR, (existing.st_mode & 0o7777) == 0o555 else {
      throw MigrationFailure.rejected
    }
    let syntheticIntent = MigrationIntent(
      version: 1, transactionID: UUID().uuidString.lowercased(), snapshotID: snapshotID,
      stageName: ".unused", roles: roles.map(\.rawValue), manifestSHA256: manifestHash)
    let final = try selectionOpenChildDirectory(parent: migrations, name: snapshotID)
    defer { close(final) }
    try verifySnapshotTree(root: final, intent: syntheticIntent, partial: false, final: true)
    try revalidateMigrationChain(homePath: home, expected: directoryIdentities)
    FileHandle.standardOutput.write(Data((snapshotID + "\n").utf8))
    exit(0)
  }
  let transaction = UUID().uuidString.lowercased()
  let stageName = ".migration-stage-" + transaction
  let intent = MigrationIntent(
    version: 1, transactionID: transaction, snapshotID: snapshotID, stageName: stageName,
    roles: roles.map(\.rawValue), manifestSHA256: manifestHash)
  try writeIntent(migrations, intent)
  try fault("after-intent")
  do {
    let stage = try createDirectory(migrations, stageName)
    defer { close(stage) }
    try buildSnapshot(stage: stage, snapshots: snapshots, manifestData: manifestData)
    try verifySnapshotTree(root: stage, intent: intent, partial: false, final: false)
    try fault("after-copy")
    try sealSnapshotDirectories(stage)
    try bothUnloaded(launchctl)
    try revalidateMigrationChain(homePath: home, expected: directoryIdentities)
    let finalSnapshots = try roles.map {
      try legacySnapshot(role: $0, home: home, applications: applications, agents: agents)
    }
    let finalManifest = MigrationManifest(
      version: 1, roles: roles.map(\.rawValue), bindings: finalSnapshots.map(\.binding),
      files: finalSnapshots.flatMap(\.entries).sorted { $0.path < $1.path })
    guard try migrationCanonical(finalManifest) == manifestData else {
      throw MigrationFailure.recoveryRequired
    }
    guard fsync(stage) == 0,
      renameatx_np(migrations, stageName, migrations, snapshotID, UInt32(RENAME_EXCL)) == 0
    else { throw MigrationFailure.recoveryRequired }
    #if ELLIE_INSTALLER_TESTING
      if testSwapAfterRename {
        let servicesPath = home + "/Library/Application Support/Ellie/Services"
        let detached = servicesPath + ".migration-test-detached"
        guard rename(servicesPath, detached) == 0, mkdir(servicesPath, 0o700) == 0,
          mkdir(servicesPath + "/migrations", 0o700) == 0
        else { throw MigrationFailure.recoveryRequired }
      }
    #endif
    try fault("after-rename")
    let final = try selectionOpenChildDirectory(parent: migrations, name: snapshotID)
    defer { close(final) }
    guard fchmod(final, 0o555) == 0, fsync(final) == 0, fsync(migrations) == 0 else {
      throw MigrationFailure.recoveryRequired
    }
    try verifySnapshotTree(root: final, intent: intent, partial: false, final: true)
    try revalidateMigrationChain(homePath: home, expected: directoryIdentities)
    guard unlinkat(migrations, "migration-preparation.json", 0) == 0, fsync(migrations) == 0
    else { throw MigrationFailure.recoveryRequired }
    FileHandle.standardOutput.write(Data((snapshotID + "\n").utf8))
    exit(0)
  } catch { throw MigrationFailure.recoveryRequired }
}
func failMigrationCommand(_ error: Error) -> Never { migrationFail(error) }
