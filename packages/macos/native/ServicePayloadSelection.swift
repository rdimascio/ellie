import CryptoKit
import Darwin
import Foundation
import Security

private enum SelectionFailure: Error {
  case rejected, recoveryRequired, loaded, launchctlUnavailable
}
private let selectionError = "Ellie service selection failed; existing services were preserved."

private enum SelectedRole: String, Codable, CaseIterable {
  case coordinator, node
  var appName: String { self == .coordinator ? "Ellie Coordinator.app" : "Ellie Node.app" }
  var identifier: String { "org.ellie.assistant.\(rawValue).app" }
  var label: String { "org.ellie.assistant.\(rawValue)" }
  var plistName: String { label + ".plist" }
}
private struct RoleReceipt: Codable, Equatable {
  let releaseID: String
  let appSHA256: String
  let plistSHA256: String
}
private struct Receipt: Codable, Equatable {
  let version: Int
  var coordinator: RoleReceipt?
  var node: RoleReceipt?
  private enum CodingKeys: String, CodingKey { case version, coordinator, node }
  init(version: Int, coordinator: RoleReceipt?, node: RoleReceipt?) {
    self.version = version
    self.coordinator = coordinator
    self.node = node
  }
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    version = try values.decode(Int.self, forKey: .version)
    coordinator = try values.decodeIfPresent(RoleReceipt.self, forKey: .coordinator)
    node = try values.decodeIfPresent(RoleReceipt.self, forKey: .node)
  }
  func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(version, forKey: .version)
    if let coordinator {
      try values.encode(coordinator, forKey: .coordinator)
    } else {
      try values.encodeNil(forKey: .coordinator)
    }
    if let node {
      try values.encode(node, forKey: .node)
    } else {
      try values.encodeNil(forKey: .node)
    }
  }
  subscript(role: SelectedRole) -> RoleReceipt? {
    get { role == .coordinator ? coordinator : node }
    set { if role == .coordinator { coordinator = newValue } else { node = newValue } }
  }
}
private struct Journal: Codable {
  let version: Int
  let transactionID: String
  let roles: [SelectedRole]
  let oldReceipt: Data
  let newReceipt: Data
}
private struct SelectionPaths {
  let home: String
  let services: String
  let applications: String
  let agents: String
  var receipts: String { services + "/receipts" }
  var receipt: String { receipts + "/installed.json" }
  var journal: String { services + "/selection-journal.json" }
  var receiptName: String { "installed.json" }
  var journalName: String { "selection-journal.json" }
  func app(_ role: SelectedRole) -> String { applications + "/" + role.appName }
  func plist(_ role: SelectedRole) -> String { agents + "/" + role.plistName }
  func stagedApp(_ role: SelectedRole, _ id: String) -> String {
    applications + "/.ellie-stage-\(id)-\(role.rawValue).app"
  }
  func backupApp(_ role: SelectedRole, _ id: String) -> String {
    applications + "/.ellie-backup-\(id)-\(role.rawValue).app"
  }
  func stagedPlist(_ role: SelectedRole, _ id: String) -> String {
    agents + "/.ellie-stage-\(id)-\(role.rawValue).plist"
  }
  func backupPlist(_ role: SelectedRole, _ id: String) -> String {
    agents + "/.ellie-backup-\(id)-\(role.rawValue).plist"
  }
}
private struct SelectionDirectories {
  let services: Int32
  let receipts: Int32
  let applications: Int32
  let agents: Int32
  func closeAll() {
    close(services)
    close(receipts)
    close(applications)
    close(agents)
  }
}

func failSelectionCommand(_ error: Error) -> Never {
  let message: String
  switch error as? SelectionFailure {
  case .recoveryRequired:
    message =
      "Ellie service selection requires recovery; retained transaction evidence was preserved."
  case .loaded:
    message = "Ellie service selection requires every selected role to be unloaded."
  case .launchctlUnavailable:
    message = "Ellie could not verify that every selected service is unloaded."
  default: message = selectionError
  }
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}
private func exact(_ value: String, _ pattern: String, count: Int) -> Bool {
  guard value.utf8.count <= count, let regex = try? NSRegularExpression(pattern: pattern) else {
    return false
  }
  let range = NSRange(value.startIndex..<value.endIndex, in: value)
  return regex.firstMatch(in: value, range: range)?.range == range
}
private func hash(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
private func applicationManifestDigest(_ files: [SelectionFile]) -> String {
  var digest = SHA256()
  for file in files.sorted(by: { $0.path < $1.path }) {
    digest.update(data: Data("\(file.path)\u{0}\(file.sha256)\n".utf8))
  }
  return digest.finalize().map { String(format: "%02x", $0) }.joined()
}
private func canonical<T: Encodable>(_ value: T) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return try encoder.encode(value) + Data("\n".utf8)
}
private func readPrivateAt(
  _ parent: Int32, _ name: String, maximum: Int, missing: Bool = false
) throws -> Data? {
  let fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  if fd < 0 {
    if missing && errno == ENOENT { return nil }
    throw SelectionFailure.rejected
  }
  defer { close(fd) }
  var info = stat()
  guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
    info.st_nlink == 1, (info.st_mode & 0o7777) == 0o600, info.st_size >= 0,
    info.st_size <= maximum
  else { throw SelectionFailure.recoveryRequired }
  var data = Data(count: Int(info.st_size))
  let length = data.count
  var offset = 0
  while offset < length {
    let count = data.withUnsafeMutableBytes {
      read(fd, $0.baseAddress!.advanced(by: offset), length - offset)
    }
    guard count > 0 else { throw SelectionFailure.recoveryRequired }
    offset += count
  }
  var byte: UInt8 = 0
  guard withUnsafeMutablePointer(to: &byte, { read(fd, $0, 1) }) == 0 else {
    throw SelectionFailure.recoveryRequired
  }
  return data
}
private func entry(_ parent: Int32, _ name: String) throws -> stat? {
  var info = stat()
  if fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW) == 0 { return info }
  if errno == ENOENT { return nil }
  throw SelectionFailure.recoveryRequired
}
private func sync(_ fd: Int32) throws {
  guard fsync(fd) == 0 else { throw SelectionFailure.recoveryRequired }
}
private func renameExclusive(
  from sourceParent: Int32, _ source: String, to targetParent: Int32, _ target: String
) throws {
  guard renameatx_np(sourceParent, source, targetParent, target, UInt32(RENAME_EXCL)) == 0 else {
    throw SelectionFailure.recoveryRequired
  }
  try sync(sourceParent)
  if sourceParent != targetParent { try sync(targetParent) }
}
private func writePrivateAt(
  _ parent: Int32, name: String, data: Data, replace: Bool, transaction: String
) throws {
  let temporary = ".ellie-write-\(transaction)"
  let fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard fd >= 0 else { throw SelectionFailure.recoveryRequired }
  var keep = true
  defer {
    close(fd)
    if keep { unlinkat(parent, temporary, 0) }
  }
  var offset = 0
  while offset < data.count {
    let count = data.withUnsafeBytes {
      write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset)
    }
    guard count > 0 else { throw SelectionFailure.recoveryRequired }
    offset += count
  }
  guard fchmod(fd, 0o600) == 0, fsync(fd) == 0 else {
    throw SelectionFailure.recoveryRequired
  }
  if replace {
    guard let old = try entry(parent, name), (old.st_mode & S_IFMT) == S_IFREG,
      old.st_uid == getuid(), old.st_nlink == 1, (old.st_mode & 0o7777) == 0o600,
      renameat(parent, temporary, parent, name) == 0
    else { throw SelectionFailure.recoveryRequired }
  } else {
    guard renameatx_np(parent, temporary, parent, name, UInt32(RENAME_EXCL)) == 0 else {
      throw SelectionFailure.recoveryRequired
    }
  }
  keep = false
  try sync(parent)
}
private func writeJournalAt(
  _ parent: Int32, name: String, data: Data, beforeSync: () -> Void, afterSync: () -> Void
) throws {
  let fd = openat(parent, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard fd >= 0 else { throw SelectionFailure.recoveryRequired }
  defer { close(fd) }
  var offset = 0
  while offset < data.count {
    let count = data.withUnsafeBytes {
      write(fd, $0.baseAddress!.advanced(by: offset), data.count - offset)
    }
    guard count > 0 else { throw SelectionFailure.recoveryRequired }
    offset += count
  }
  guard fchmod(fd, 0o600) == 0 else { throw SelectionFailure.recoveryRequired }
  beforeSync()
  guard fsync(fd) == 0 else { throw SelectionFailure.recoveryRequired }
  afterSync()
  try sync(parent)
}
private func plistData(role: SelectedRole, release: SelectionRelease, app: String, home: String)
  -> Data
{
  func xml(_ value: String) -> String {
    value.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&apos;")
  }
  let executable = xml(app + "/Contents/MacOS/EllieService")
  let escapedHome = xml(home)
  let nodeDirectory = xml(release.rootPath + "/payload/bin")
  return Data(
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <!-- Managed by ellie-native-service-v1 -->
    <plist version="1.0"><dict>
    <key>Label</key><string>\(role.label)</string>
    <key>ProgramArguments</key><array><string>\(executable)</string><string>--launch-agent</string></array>
    <key>AssociatedBundleIdentifiers</key><array><string>\(role.identifier)</string></array>
    <key>WorkingDirectory</key><string>\(xml(release.rootPath))</string>
    <key>EnvironmentVariables</key><dict><key>HOME</key><string>\(escapedHome)</string><key>PATH</key><string>\(nodeDirectory):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>LimitLoadToSessionType</key><string>Aqua</string>
    <key>ProcessType</key><string>\(role == .node ? "Interactive" : "Standard")</string>
    <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
    <key>AbandonProcessGroup</key><false/><key>ThrottleInterval</key><integer>30</integer>
    <key>ExitTimeOut</key><integer>15</integer><key>Umask</key><integer>63</integer>
    <key>SoftResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
    <key>HardResourceLimits</key><dict><key>Core</key><integer>0</integer></dict>
    <key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
    </dict></plist>
    """.utf8)
}

private func roleLoaded(_ role: SelectedRole, testLoaded: Set<SelectedRole>) throws -> Bool {
  #if ELLIE_INSTALLER_TESTING
    return testLoaded.contains(role)
  #else
    func query(_ target: String) throws -> Int32 {
      var actions: posix_spawn_file_actions_t?
      posix_spawn_file_actions_init(&actions)
      defer { posix_spawn_file_actions_destroy(&actions) }
      posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0)
      posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0)
      var values = [strdup("/bin/launchctl"), strdup("print"), strdup(target), nil]
      defer { values.compactMap { $0 }.forEach { free($0) } }
      var pid: pid_t = 0
      guard posix_spawn(&pid, "/bin/launchctl", &actions, nil, &values, environ) == 0 else {
        throw SelectionFailure.launchctlUnavailable
      }
      let deadline = DispatchTime.now() + .seconds(2)
      var status: Int32 = 0
      while waitpid(pid, &status, WNOHANG) == 0 {
        if DispatchTime.now() >= deadline {
          kill(pid, SIGKILL)
          _ = waitpid(pid, &status, 0)
          throw SelectionFailure.launchctlUnavailable
        }
        usleep(10_000)
      }
      guard (status & 0x7f) == 0 else { throw SelectionFailure.launchctlUnavailable }
      let result = (status >> 8) & 0xff
      return result
    }
    let domain = "gui/\(getuid())"
    guard try query(domain) == 0 else { throw SelectionFailure.launchctlUnavailable }
    let result = try query(domain + "/" + role.label)
    if result == 0 { return true }
    if result == 113 { return false }
    throw SelectionFailure.launchctlUnavailable
  #endif
}

private func selectionPaths(testHome: String?) throws -> SelectionPaths {
  let home = testHome ?? FileManager.default.homeDirectoryForCurrentUser.path
  guard home.hasPrefix("/") else { throw SelectionFailure.rejected }
  return SelectionPaths(
    home: home, services: home + "/Library/Application Support/Ellie/Services",
    applications: home + "/Applications", agents: home + "/Library/LaunchAgents")
}
private func openSelectionDirectories(_ paths: SelectionPaths) throws -> SelectionDirectories {
  let home = try selectionOpenDirectory(paths.home, privateMode: false)
  defer { close(home) }
  let library = try selectionOpenOwnedDirectory(parent: home, name: "Library")
  defer { close(library) }
  let support = try selectionOpenOwnedDirectory(parent: library, name: "Application Support")
  defer { close(support) }
  let ellie = try selectionOpenOwnedDirectory(parent: support, name: "Ellie")
  defer { close(ellie) }
  let services = try selectionOpenOwnedDirectory(parent: ellie, name: "Services")
  var info = stat()
  guard fstat(services, &info) == 0, info.st_uid == getuid(), (info.st_mode & 0o7777) == 0o700
  else {
    close(services)
    throw SelectionFailure.rejected
  }
  let applications = try selectionEnsureOwnedDirectory(parent: home, name: "Applications")
  let agents: Int32
  do {
    agents = try selectionEnsureOwnedDirectory(parent: library, name: "LaunchAgents")
  } catch {
    close(services)
    close(applications)
    throw error
  }
  let receipts: Int32
  do {
    receipts = try selectionEnsureDirectory(parent: services, name: "receipts", mode: 0o700)
  } catch {
    close(services)
    close(applications)
    close(agents)
    throw error
  }
  return SelectionDirectories(
    services: services, receipts: receipts, applications: applications, agents: agents)
}
private func decodedReceipt(_ data: Data?) throws -> Receipt {
  guard let data else { return Receipt(version: 1, coordinator: nil, node: nil) }
  let value = try JSONDecoder().decode(Receipt.self, from: data)
  guard value.version == 1 else { throw SelectionFailure.recoveryRequired }
  for role in SelectedRole.allCases {
    if let record = value[role] {
      guard exact(record.releaseID, "[A-Za-z0-9._-]+", count: 128),
        exact(record.appSHA256, "[a-f0-9]{64}", count: 64),
        exact(record.plistSHA256, "[a-f0-9]{64}", count: 64)
      else { throw SelectionFailure.recoveryRequired }
    }
  }
  guard try canonical(value) == data else { throw SelectionFailure.recoveryRequired }
  return value
}
private enum SelectionAsset { case application, plist }
private func validateAsset(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  record: RoleReceipt, asset: SelectionAsset, name: String, applicationRootMode: mode_t = 0o555
) throws {
  let release = try verifiedSelectionRelease(
    servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
  switch asset {
  case .application:
    let value = try selectionApplicationDigest(
      parent: directories.applications, name: name, files: release.applicationFiles,
      identifier: role.identifier, rootMode: applicationRootMode)
    guard value == record.appSHA256 else { throw SelectionFailure.recoveryRequired }
  case .plist:
    let expected = plistData(role: role, release: release, app: paths.app(role), home: paths.home)
    guard
      let bytes = try readPrivateAt(directories.agents, name, maximum: 32 * 1024),
      bytes == expected, hash(bytes) == record.plistSHA256
    else { throw SelectionFailure.recoveryRequired }
  }
}
private func unsealApplication(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  record: RoleReceipt, name: String
) throws {
  let release = try verifiedSelectionRelease(
    servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
  let value = try selectionUnsealApplication(
    parent: directories.applications, name: name, files: release.applicationFiles,
    identifier: role.identifier)
  guard value == record.appSHA256 else { throw SelectionFailure.recoveryRequired }
  try sync(directories.applications)
}
private func sealApplication(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  record: RoleReceipt, name: String
) throws {
  let release = try verifiedSelectionRelease(
    servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
  let value = try selectionSealApplication(
    parent: directories.applications, name: name, files: release.applicationFiles,
    identifier: role.identifier)
  guard value == record.appSHA256 else { throw SelectionFailure.recoveryRequired }
  try sync(directories.applications)
}
private func applicationMode(_ parent: Int32, _ name: String) throws -> mode_t? {
  guard let value = try entry(parent, name) else { return nil }
  guard (value.st_mode & S_IFMT) == S_IFDIR, value.st_uid == getuid() else {
    throw SelectionFailure.recoveryRequired
  }
  return value.st_mode & 0o7777
}
private func validateSelection(
  paths: SelectionPaths, directories: SelectionDirectories, receipt: Receipt
) throws {
  for role in SelectedRole.allCases {
    if let record = receipt[role] {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record,
        asset: .application, name: role.appName)
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record, asset: .plist,
        name: role.plistName)
    } else {
      guard try entry(directories.applications, role.appName) == nil,
        try entry(directories.agents, role.plistName) == nil
      else { throw SelectionFailure.rejected }
    }
  }
}
private func validateRole(
  paths: SelectionPaths, directories: SelectionDirectories, receipt: Receipt, role: SelectedRole
) throws {
  if let record = receipt[role] {
    try validateAsset(
      paths: paths, directories: directories, role: role, record: record,
      asset: .application, name: role.appName)
    try validateAsset(
      paths: paths, directories: directories, role: role, record: record, asset: .plist,
      name: role.plistName)
  } else {
    guard try entry(directories.applications, role.appName) == nil,
      try entry(directories.agents, role.plistName) == nil
    else { throw SelectionFailure.recoveryRequired }
  }
}
private func removeAsset(parent: Int32, name: String) throws {
  do { try selectionRemoveTree(parent: parent, name: name) } catch {
    throw SelectionFailure.recoveryRequired
  }
}
private func recoverAsset(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  asset: SelectionAsset, old: RoleReceipt?, new: RoleReceipt, committed: Bool,
  transaction: String
) throws {
  let parent = asset == .application ? directories.applications : directories.agents
  let target = asset == .application ? role.appName : role.plistName
  let staged =
    asset == .application
    ? (paths.stagedApp(role, transaction) as NSString).lastPathComponent
    : (paths.stagedPlist(role, transaction) as NSString).lastPathComponent
  let backup =
    asset == .application
    ? (paths.backupApp(role, transaction) as NSString).lastPathComponent
    : (paths.backupPlist(role, transaction) as NSString).lastPathComponent
  if committed {
    if try entry(parent, target) == nil {
      guard try entry(parent, staged) != nil else { throw SelectionFailure.recoveryRequired }
      try validateAsset(
        paths: paths, directories: directories, role: role, record: new, asset: asset,
        name: staged, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try renameExclusive(from: parent, staged, to: parent, target)
    }
    if asset == .application, try applicationMode(parent, target) == 0o700 {
      try sealApplication(
        paths: paths, directories: directories, role: role, record: new, name: target)
    }
    try validateAsset(
      paths: paths, directories: directories, role: role, record: new, asset: asset,
      name: target)
    if try entry(parent, backup) != nil {
      guard let old else { throw SelectionFailure.recoveryRequired }
      try validateAsset(
        paths: paths, directories: directories, role: role, record: old, asset: asset,
        name: backup, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try removeAsset(parent: parent, name: backup)
    }
    if try entry(parent, staged) != nil {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: new, asset: asset,
        name: staged, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try removeAsset(parent: parent, name: staged)
    }
  } else if let old {
    if try entry(parent, backup) != nil {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: old, asset: asset,
        name: backup, applicationRootMode: asset == .application ? 0o700 : 0o555)
      if try entry(parent, target) != nil {
        let targetMode = asset == .application ? try applicationMode(parent, target) : 0o555
        guard asset != .application || targetMode == 0o700 || targetMode == 0o555 else {
          throw SelectionFailure.recoveryRequired
        }
        try validateAsset(
          paths: paths, directories: directories, role: role, record: new, asset: asset,
          name: target, applicationRootMode: targetMode ?? 0o555)
        try removeAsset(parent: parent, name: target)
      }
      try renameExclusive(from: parent, backup, to: parent, target)
      if asset == .application {
        try sealApplication(
          paths: paths, directories: directories, role: role, record: old, name: target)
      }
    } else {
      let targetMode = asset == .application ? try applicationMode(parent, target) : 0o555
      guard asset != .application || targetMode == 0o700 || targetMode == 0o555 else {
        throw SelectionFailure.recoveryRequired
      }
      try validateAsset(
        paths: paths, directories: directories, role: role, record: old, asset: asset,
        name: target, applicationRootMode: targetMode ?? 0o555)
      if asset == .application, targetMode == 0o700 {
        try sealApplication(
          paths: paths, directories: directories, role: role, record: old, name: target)
      }
    }
    if try entry(parent, staged) != nil {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: new, asset: asset,
        name: staged, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try removeAsset(parent: parent, name: staged)
    }
  } else {
    if try entry(parent, target) != nil {
      let targetMode = asset == .application ? try applicationMode(parent, target) : 0o555
      guard asset != .application || targetMode == 0o700 || targetMode == 0o555 else {
        throw SelectionFailure.recoveryRequired
      }
      try validateAsset(
        paths: paths, directories: directories, role: role, record: new, asset: asset,
        name: target, applicationRootMode: targetMode ?? 0o555)
      try removeAsset(parent: parent, name: target)
    }
    if try entry(parent, staged) != nil {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: new, asset: asset,
        name: staged, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try removeAsset(parent: parent, name: staged)
    }
    guard try entry(parent, backup) == nil else { throw SelectionFailure.recoveryRequired }
  }
  try sync(parent)
}

private func recover(
  paths: SelectionPaths, directories: SelectionDirectories, testLoaded: Set<SelectedRole>
) throws {
  guard
    let journalData = try readPrivateAt(
      directories.services, paths.journalName, maximum: 64 * 1024, missing: true)
  else {
    return
  }
  let journal = try JSONDecoder().decode(Journal.self, from: journalData)
  let transaction = UUID(uuidString: journal.transactionID)
  guard journal.version == 1, transaction?.uuidString.lowercased() == journal.transactionID,
    !journal.roles.isEmpty, journal.roles == SelectedRole.allCases.filter(journal.roles.contains),
    Set(journal.roles).count == journal.roles.count, try canonical(journal) == journalData
  else { throw SelectionFailure.recoveryRequired }
  let old = try decodedReceipt(journal.oldReceipt)
  let new = try decodedReceipt(journal.newReceipt)
  for role in SelectedRole.allCases {
    if journal.roles.contains(role) {
      guard new[role] != nil else { throw SelectionFailure.recoveryRequired }
    } else {
      guard old[role] == new[role] else { throw SelectionFailure.recoveryRequired }
      try validateRole(paths: paths, directories: directories, receipt: old, role: role)
    }
  }
  for role in journal.roles where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  let receipt =
    try
    (readPrivateAt(directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
    ?? canonical(Receipt(version: 1, coordinator: nil, node: nil)))
  let committed: Bool
  if receipt == journal.newReceipt {
    committed = true
  } else if receipt == journal.oldReceipt {
    committed = false
  } else {
    throw SelectionFailure.recoveryRequired
  }
  for role in journal.roles {
    guard let newRecord = new[role] else { throw SelectionFailure.recoveryRequired }
    try recoverAsset(
      paths: paths, directories: directories, role: role, asset: .application, old: old[role],
      new: newRecord, committed: committed, transaction: journal.transactionID)
    try recoverAsset(
      paths: paths, directories: directories, role: role, asset: .plist, old: old[role],
      new: newRecord, committed: committed, transaction: journal.transactionID)
  }
  do {
    try validateSelection(paths: paths, directories: directories, receipt: committed ? new : old)
  } catch {
    throw SelectionFailure.recoveryRequired
  }
  guard unlinkat(directories.services, paths.journalName, 0) == 0 else {
    throw SelectionFailure.recoveryRequired
  }
  try sync(directories.services)
}

func runSelectionCommand(_ input: [String]) throws -> Never {
  var args = input
  let command = args.removeFirst()
  var testHome: String?
  var testLoaded = Set<SelectedRole>()
  var testLoadAfterPreflight = false
  var testFault: String?
  var testHoldLockMilliseconds = 0
  var testFailAfterJournal = false
  var testRejectAt: String?
  #if ELLIE_INSTALLER_TESTING
    if let index = args.firstIndex(of: "--test-home-root"), index + 1 < args.count {
      testHome = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-loaded"), index + 1 < args.count {
      testLoaded = Set(
        args[index + 1].split(separator: ",").compactMap { SelectedRole(rawValue: String($0)) })
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-fault"), index + 1 < args.count {
      testFault = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-load-after-preflight") {
      testLoadAfterPreflight = true
      args.remove(at: index)
    }
    if let index = args.firstIndex(of: "--test-hold-lock-ms"), index + 1 < args.count,
      let value = Int(args[index + 1]), (1...5_000).contains(value)
    {
      testHoldLockMilliseconds = value
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-fail-after-journal") {
      testFailAfterJournal = true
      args.remove(at: index)
    }
    if let index = args.firstIndex(of: "--test-reject-at"), index + 1 < args.count {
      testRejectAt = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
  #endif
  func fault(_ point: String) {
    #if ELLIE_INSTALLER_TESTING
      if testFault == point { _exit(86) }
    #endif
  }
  func reject(_ point: String) throws {
    #if ELLIE_INSTALLER_TESTING
      if testRejectAt == point { throw SelectionFailure.rejected }
    #endif
  }
  let releaseID: String?
  let roles: [SelectedRole]
  if command == "recover" {
    guard args.isEmpty else { throw SelectionFailure.rejected }
    releaseID = nil
    roles = []
  } else {
    guard command == "select", args.count == 3, args[1] == "--roles",
      exact(args[0], "[A-Za-z0-9._-]+", count: 128)
    else { throw SelectionFailure.rejected }
    releaseID = args[0]
    switch args[2] {
    case "coordinator": roles = [.coordinator]
    case "node": roles = [.node]
    case "coordinator,node": roles = [.coordinator, .node]
    default: throw SelectionFailure.rejected
    }
  }
  let paths = try selectionPaths(testHome: testHome)
  let directories = try openSelectionDirectories(paths)
  defer { directories.closeAll() }
  var lock = openat(
    directories.services, "selection.lock",
    O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
  if lock < 0 && errno == EEXIST {
    lock = openat(directories.services, "selection.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC)
  }
  var lockInfo = stat()
  guard lock >= 0, fstat(lock, &lockInfo) == 0, (lockInfo.st_mode & S_IFMT) == S_IFREG,
    lockInfo.st_uid == getuid(), lockInfo.st_nlink == 1, (lockInfo.st_mode & 0o7777) == 0o600,
    flock(lock, LOCK_EX | LOCK_NB) == 0
  else {
    if lock >= 0 { close(lock) }
    throw SelectionFailure.recoveryRequired
  }
  defer {
    flock(lock, LOCK_UN)
    close(lock)
  }
  #if ELLIE_INSTALLER_TESTING
    if testHoldLockMilliseconds > 0 {
      let ready = openat(
        directories.services, ".test-selection-lock-ready",
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard ready >= 0, fchmod(ready, 0o600) == 0, fsync(ready) == 0 else {
        if ready >= 0 { close(ready) }
        throw SelectionFailure.recoveryRequired
      }
      close(ready)
      try sync(directories.services)
      defer { unlinkat(directories.services, ".test-selection-lock-ready", 0) }
      usleep(useconds_t(testHoldLockMilliseconds * 1_000))
    }
  #endif
  try recover(paths: paths, directories: directories, testLoaded: testLoaded)
  if command == "recover" {
    print("Selection recovery complete.")
    exit(0)
  }
  guard let releaseID else { throw SelectionFailure.rejected }
  for role in roles where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  let oldData =
    try
    (readPrivateAt(directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
    ?? canonical(Receipt(version: 1, coordinator: nil, node: nil)))
  let old = try decodedReceipt(oldData)
  try validateSelection(paths: paths, directories: directories, receipt: old)
  var next = old
  let transaction = UUID().uuidString.lowercased()
  var releases: [SelectedRole: SelectionRelease] = [:]
  for role in roles {
    let release = try verifiedSelectionRelease(
      servicesRoot: paths.services, releaseID: releaseID, role: role.rawValue)
    releases[role] = release
    let plist = plistData(role: role, release: release, app: paths.app(role), home: paths.home)
    let appHash = applicationManifestDigest(release.applicationFiles)
    next[role] = RoleReceipt(releaseID: release.id, appSHA256: appHash, plistSHA256: hash(plist))
  }
  let nextData = try canonical(next)
  if oldData == nextData {
    print("Selection already matches the requested release.")
    exit(0)
  }
  let journal = Journal(
    version: 1, transactionID: transaction, roles: roles, oldReceipt: oldData,
    newReceipt: nextData)
  try writeJournalAt(
    directories.services, name: paths.journalName, data: try canonical(journal),
    beforeSync: { fault("before-journal-fsync") },
    afterSync: { fault("after-journal-fsync") })
  fault("after-journal")
  do {
    if testFailAfterJournal { throw SelectionFailure.rejected }
    for role in roles {
      guard let release = releases[role] else { throw SelectionFailure.rejected }
      let stagedApp = (paths.stagedApp(role, transaction) as NSString).lastPathComponent
      let stagedPlist = (paths.stagedPlist(role, transaction) as NSString).lastPathComponent
      _ = try selectionCopyApplication(
        source: release, parent: directories.applications, name: stagedApp,
        identifier: role.identifier)
      fault("after-app-\(role.rawValue)")
      let plist = plistData(role: role, release: release, app: paths.app(role), home: paths.home)
      try writePrivateAt(
        directories.agents, name: stagedPlist, data: plist, replace: false,
        transaction: transaction + "-" + role.rawValue)
      fault("after-plist-\(role.rawValue)")
    }
    for role in roles {
      if testLoadAfterPreflight { throw SelectionFailure.loaded }
      if try roleLoaded(role, testLoaded: testLoaded) { throw SelectionFailure.loaded }
    }
    for role in roles {
      let stagedApp = (paths.stagedApp(role, transaction) as NSString).lastPathComponent
      let backupApp = (paths.backupApp(role, transaction) as NSString).lastPathComponent
      let stagedPlist = (paths.stagedPlist(role, transaction) as NSString).lastPathComponent
      let backupPlist = (paths.backupPlist(role, transaction) as NSString).lastPathComponent
      if try entry(directories.applications, role.appName) != nil {
        guard let oldRecord = old[role] else { throw SelectionFailure.recoveryRequired }
        try unsealApplication(
          paths: paths, directories: directories, role: role, record: oldRecord,
          name: role.appName)
        try reject("after-old-app-unseal-\(role.rawValue)")
        fault("after-old-app-unseal-\(role.rawValue)")
        try renameExclusive(
          from: directories.applications, role.appName, to: directories.applications, backupApp)
        fault("after-old-app-backup-\(role.rawValue)")
      }
      try renameExclusive(
        from: directories.applications, stagedApp, to: directories.applications, role.appName)
      guard let selectedRecord = next[role] else { throw SelectionFailure.recoveryRequired }
      try sealApplication(
        paths: paths, directories: directories, role: role, record: selectedRecord,
        name: role.appName)
      try reject("after-app-seal-\(role.rawValue)")
      fault("after-app-move-\(role.rawValue)")
      if try entry(directories.agents, role.plistName) != nil {
        try renameExclusive(
          from: directories.agents, role.plistName, to: directories.agents, backupPlist)
      }
      try renameExclusive(
        from: directories.agents, stagedPlist, to: directories.agents, role.plistName)
      fault("after-plist-move-\(role.rawValue)")
    }
    try writePrivateAt(
      directories.receipts, name: paths.receiptName, data: nextData,
      replace: try entry(directories.receipts, paths.receiptName) != nil,
      transaction: transaction)
    fault("after-receipt")
    try reject("after-receipt")
    try recover(paths: paths, directories: directories, testLoaded: testLoaded)
    print(
      "Selected \(roles.map(\.rawValue).joined(separator: ",")) at \(releaseID); selected managed LaunchAgents remain unloaded."
    )
    exit(0)
  } catch let error {
    if case .loaded = error as? SelectionFailure { throw error }
    throw SelectionFailure.recoveryRequired
  }
}
