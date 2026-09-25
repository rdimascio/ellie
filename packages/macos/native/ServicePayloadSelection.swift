import CryptoKit
import Darwin
import Foundation
import Security

private enum SelectionFailure: Error {
  case rejected, recoveryRequired, loaded, launchctlUnavailable
}
private enum SelectionPreflightStatus: String, Codable {
  case ready, loaded, busy
  case recoveryRequired = "recovery_required"
  case destinationConflict = "destination_conflict"
  case candidateInvalid = "candidate_invalid"
  case unavailable
}
private struct SelectionPreflightReport: Codable {
  let version: Int
  let command: String
  let releaseID: String
  let roles: [String]
  let ready: Bool
  let status: SelectionPreflightStatus
  let role: String?
  let reason: String?
  let details: [String]?
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

struct LifecycleSelectedRole {
  let role: String
  let releaseID: String
  let label: String
  let plistPath: String
  let executablePath: String
}
struct LifecycleSelectionBusy: Error {}

struct LifecycleSelectionRecovery: Error {
  let role: String
  let reason: String
  let details: [String]
}

private func lifecycleSelectionRecovery(
  role: String, reason: String, details: [String], diagnostics: Bool
) -> Error {
  diagnostics
    ? LifecycleSelectionRecovery(role: role, reason: reason, details: details)
    : SelectionFailure.recoveryRequired
}

func withLifecycleSelection<T>(
  role roleName: String, testHome: String?, exclusive: Bool, diagnostics: Bool = false,
  _ action: (LifecycleSelectedRole?, () throws -> Void) throws -> T
) throws -> T {
  guard let role = SelectedRole(rawValue: roleName) else { throw SelectionFailure.rejected }
  let paths = try selectionPaths(testHome: testHome)
  let home = try selectionOpenDirectory(paths.home, privateMode: false)
  defer { close(home) }
  func unselected(_ library: Int32?) throws -> T {
    if let applications = try selectionOpenOwnedDirectoryIfPresent(
      parent: home, name: "Applications")
    {
      defer { close(applications) }
      for candidate in SelectedRole.allCases where try entry(applications, candidate.appName) != nil
      {
        throw lifecycleSelectionRecovery(
          role: candidate.rawValue, reason: "topology_mismatch",
          details: ["unexpected_application"], diagnostics: diagnostics)
      }
    }
    if let library,
      let agents = try selectionOpenOwnedDirectoryIfPresent(parent: library, name: "LaunchAgents")
    {
      defer { close(agents) }
      for candidate in SelectedRole.allCases where try entry(agents, candidate.plistName) != nil {
        throw lifecycleSelectionRecovery(
          role: candidate.rawValue, reason: "topology_mismatch",
          details: ["unexpected_plist"], diagnostics: diagnostics)
      }
    }
    return try action(nil, { throw SelectionFailure.recoveryRequired })
  }
  guard let library = try selectionOpenOwnedDirectoryIfPresent(parent: home, name: "Library") else {
    return try unselected(nil)
  }
  defer { close(library) }
  guard
    let support = try selectionOpenOwnedDirectoryIfPresent(
      parent: library, name: "Application Support")
  else { return try unselected(library) }
  defer { close(support) }
  guard let ellie = try selectionOpenOwnedDirectoryIfPresent(parent: support, name: "Ellie") else {
    return try unselected(library)
  }
  defer { close(ellie) }
  guard let services = try selectionOpenOwnedDirectoryIfPresent(parent: ellie, name: "Services")
  else {
    return try unselected(library)
  }
  defer { close(services) }
  var servicesInfo = stat()
  guard fstat(services, &servicesInfo) == 0, (servicesInfo.st_mode & 0o7777) == 0o700 else {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "topology_mismatch", details: ["services_directory"],
      diagnostics: diagnostics)
  }
  if try migrationSwitchPending(services) { throw MigrationSwitchPendingFailure() }
  let lockInfo = try entry(services, "selection.lock")
  let receiptsInfo = try entry(services, "receipts")
  if lockInfo == nil && receiptsInfo == nil {
    guard try entry(services, paths.journalName) == nil else {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "journal_pending", details: ["selection"],
        diagnostics: diagnostics)
    }
    return try unselected(library)
  }
  guard lockInfo != nil, receiptsInfo != nil else {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["selection_layout"],
      diagnostics: diagnostics)
  }
  let receipts = try selectionOpenOwnedDirectory(parent: services, name: "receipts")
  defer { close(receipts) }
  var receiptsMode = stat()
  guard fstat(receipts, &receiptsMode) == 0, (receiptsMode.st_mode & 0o7777) == 0o700,
    try entry(receipts, paths.receiptName) != nil
  else {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["receipt_layout"],
      diagnostics: diagnostics)
  }
  let applications = try selectionOpenOwnedDirectory(parent: home, name: "Applications")
  defer { close(applications) }
  let agents = try selectionOpenOwnedDirectory(parent: library, name: "LaunchAgents")
  defer { close(agents) }
  let directories = SelectionDirectories(
    services: services, receipts: receipts, applications: applications, agents: agents)
  let lock = openat(
    services, "selection.lock",
    (exclusive ? O_RDWR : O_RDONLY) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
  var verifiedLock = stat()
  guard lock >= 0, fstat(lock, &verifiedLock) == 0, (verifiedLock.st_mode & S_IFMT) == S_IFREG,
    verifiedLock.st_uid == getuid(), verifiedLock.st_nlink == 1,
    (verifiedLock.st_mode & 0o7777) == 0o600
  else {
    if lock >= 0 { close(lock) }
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["selection_lock"],
      diagnostics: diagnostics)
  }
  if flock(lock, exclusive ? LOCK_EX | LOCK_NB : LOCK_SH | LOCK_NB) != 0 {
    close(lock)
    if errno == EWOULDBLOCK { throw LifecycleSelectionBusy() }
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["selection_lock"],
      diagnostics: diagnostics)
  }
  defer {
    flock(lock, LOCK_UN)
    close(lock)
  }
  if try migrationSwitchPending(services) { throw MigrationSwitchPendingFailure() }
  guard try entry(services, paths.journalName) == nil else {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "journal_pending", details: ["selection"],
      diagnostics: diagnostics)
  }
  guard let receiptData = try readPrivateAt(
    receipts, paths.receiptName, maximum: 32 * 1024)
  else {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["missing"],
      diagnostics: diagnostics)
  }
  let receipt: Receipt
  do { receipt = try decodedReceipt(receiptData) } catch {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "receipt_mismatch", details: ["encoding_or_value"],
      diagnostics: diagnostics)
  }
  try validateSelection(
    paths: paths, directories: directories, receipt: receipt, diagnostics: diagnostics)
  func sameDirectory(_ first: Int32, _ second: Int32) throws {
    var left = stat()
    var right = stat()
    guard fstat(first, &left) == 0, fstat(second, &right) == 0, left.st_dev == right.st_dev,
      left.st_ino == right.st_ino
    else { throw SelectionFailure.recoveryRequired }
  }
  let revalidate = {
    if try migrationSwitchPending(services) { throw MigrationSwitchPendingFailure() }
    let freshHome = try selectionOpenDirectory(paths.home, privateMode: false)
    defer { close(freshHome) }
    try sameDirectory(home, freshHome)
    let freshLibrary = try selectionOpenOwnedDirectory(parent: freshHome, name: "Library")
    defer { close(freshLibrary) }
    try sameDirectory(library, freshLibrary)
    let freshSupport = try selectionOpenOwnedDirectory(
      parent: freshLibrary, name: "Application Support")
    defer { close(freshSupport) }
    try sameDirectory(support, freshSupport)
    let freshEllie = try selectionOpenOwnedDirectory(parent: freshSupport, name: "Ellie")
    defer { close(freshEllie) }
    try sameDirectory(ellie, freshEllie)
    let freshServices = try selectionOpenOwnedDirectory(parent: freshEllie, name: "Services")
    defer { close(freshServices) }
    try sameDirectory(services, freshServices)
    let freshReceipts = try selectionOpenOwnedDirectory(parent: freshServices, name: "receipts")
    defer { close(freshReceipts) }
    try sameDirectory(receipts, freshReceipts)
    let freshApplications = try selectionOpenOwnedDirectory(parent: freshHome, name: "Applications")
    defer { close(freshApplications) }
    try sameDirectory(applications, freshApplications)
    let freshAgents = try selectionOpenOwnedDirectory(parent: freshLibrary, name: "LaunchAgents")
    defer { close(freshAgents) }
    try sameDirectory(agents, freshAgents)
    guard try entry(freshServices, paths.journalName) == nil,
      let current = try readPrivateAt(freshReceipts, paths.receiptName, maximum: 32 * 1024),
      current == receiptData
    else { throw SelectionFailure.recoveryRequired }
    let freshDirectories = SelectionDirectories(
      services: freshServices, receipts: freshReceipts, applications: freshApplications,
      agents: freshAgents)
    try validateSelection(paths: paths, directories: freshDirectories, receipt: receipt)
  }
  let selected = receipt[role].map {
    LifecycleSelectedRole(
      role: role.rawValue, releaseID: $0.releaseID, label: role.label,
      plistPath: paths.plist(role), executablePath: paths.app(role) + "/Contents/MacOS/EllieService"
    )
  }
  return try action(selected, revalidate)
}

func failSelectionCommand(_ error: Error) -> Never {
  if error is MigrationSwitchPendingFailure {
    FileHandle.standardError.write(Data((migrationSwitchRecovery + "\n").utf8))
    exit(1)
  }
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

private func revalidateSelectionDirectoriesReadOnly(
  _ paths: SelectionPaths, _ directories: SelectionDirectories
) throws {
  func same(_ first: Int32, _ second: Int32) throws {
    var left = stat()
    var right = stat()
    guard fstat(first, &left) == 0, fstat(second, &right) == 0, left.st_dev == right.st_dev,
      left.st_ino == right.st_ino
    else { throw MigrationSwitchPendingFailure() }
  }
  let home = try selectionOpenDirectory(paths.home, privateMode: false)
  defer { close(home) }
  let library = try selectionOpenOwnedDirectory(parent: home, name: "Library")
  defer { close(library) }
  let support = try selectionOpenOwnedDirectory(parent: library, name: "Application Support")
  defer { close(support) }
  let ellie = try selectionOpenOwnedDirectory(parent: support, name: "Ellie")
  defer { close(ellie) }
  let services = try selectionOpenOwnedDirectory(parent: ellie, name: "Services")
  defer { close(services) }
  let receipts = try selectionOpenOwnedDirectory(parent: services, name: "receipts")
  defer { close(receipts) }
  let applications = try selectionOpenOwnedDirectory(parent: home, name: "Applications")
  defer { close(applications) }
  let agents = try selectionOpenOwnedDirectory(parent: library, name: "LaunchAgents")
  defer { close(agents) }
  try same(directories.services, services)
  try same(directories.receipts, receipts)
  try same(directories.applications, applications)
  try same(directories.agents, agents)
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
  record: RoleReceipt, asset: SelectionAsset, name: String, applicationRootMode: mode_t = 0o555,
  diagnostics: Bool = false
) throws {
  let release: SelectionRelease
  do {
    release = try verifiedSelectionRelease(
      servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
  } catch {
    throw lifecycleSelectionRecovery(
      role: role.rawValue, reason: "release_mismatch", details: ["selected_release"],
      diagnostics: diagnostics)
  }
  switch asset {
  case .application:
    if diagnostics {
      let details = selectionApplicationDiagnostics(
        parent: directories.applications, name: name, files: release.applicationFiles,
        identifier: role.identifier, rootMode: applicationRootMode).map(\.rawValue)
      if !details.isEmpty {
        throw lifecycleSelectionRecovery(
          role: role.rawValue, reason: "application_mismatch", details: details,
          diagnostics: true)
      }
    }
    let value: String
    do {
      value = try selectionApplicationDigest(
        parent: directories.applications, name: name, files: release.applicationFiles,
        identifier: role.identifier, rootMode: applicationRootMode)
    } catch {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "application_mismatch", details: ["unclassified"],
        diagnostics: diagnostics)
    }
    guard value == record.appSHA256 else {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "receipt_mismatch", details: ["application_digest"],
        diagnostics: diagnostics)
    }
  case .plist:
    let expected = plistData(role: role, release: release, app: paths.app(role), home: paths.home)
    let bytes: Data
    do {
      guard let value = try readPrivateAt(directories.agents, name, maximum: 32 * 1024) else {
        throw SelectionFailure.recoveryRequired
      }
      bytes = value
    } catch {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "plist_mismatch", details: ["metadata_or_topology"],
        diagnostics: diagnostics)
    }
    guard bytes == expected else {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "plist_mismatch", details: ["content"],
        diagnostics: diagnostics)
    }
    guard hash(bytes) == record.plistSHA256 else {
      throw lifecycleSelectionRecovery(
        role: role.rawValue, reason: "receipt_mismatch", details: ["plist_digest"],
        diagnostics: diagnostics)
    }
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
  paths: SelectionPaths, directories: SelectionDirectories, receipt: Receipt,
  diagnostics: Bool = false
) throws {
  for role in SelectedRole.allCases {
    if let record = receipt[role] {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record,
        asset: .application, name: role.appName, diagnostics: diagnostics)
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record, asset: .plist,
        name: role.plistName, diagnostics: diagnostics)
    } else {
      guard try entry(directories.applications, role.appName) == nil,
        try entry(directories.agents, role.plistName) == nil
      else {
        throw lifecycleSelectionRecovery(
          role: role.rawValue, reason: "topology_mismatch",
          details: ["unselected_role_asset"], diagnostics: diagnostics)
      }
    }
  }
}

private func selectionPreflightReport(
  releaseID: String, roles: [SelectedRole], testHome: String?, testLoaded: Set<SelectedRole>,
  testUnavailable: Bool, testBeforeFinal: String?
) -> SelectionPreflightReport {
  func report(
    _ status: SelectionPreflightStatus, recovery: LifecycleSelectionRecovery? = nil
  ) -> SelectionPreflightReport {
    SelectionPreflightReport(
      version: 1, command: "preflight-select", releaseID: releaseID,
      roles: roles.map(\.rawValue), ready: status == .ready, status: status,
      role: recovery?.role, reason: recovery?.reason, details: recovery?.details)
  }
  func recovery(
    role: SelectedRole? = nil, reason: String, details: [String]
  ) -> SelectionPreflightReport {
    report(
      .recoveryRequired,
      recovery: LifecycleSelectionRecovery(
        role: (role ?? roles[0]).rawValue, reason: reason, details: details))
  }
  func migrationPreparationPending(_ services: Int32) throws -> Bool {
    guard
      let migrations = try selectionOpenOwnedDirectoryIfPresent(
        parent: services, name: "migrations")
    else { return false }
    defer { close(migrations) }
    return try entry(migrations, "migration-preparation.json") != nil
  }
  do {
    let paths = try selectionPaths(testHome: testHome)
    let home = try selectionOpenDirectory(paths.home, privateMode: false)
    defer { close(home) }
    guard let library = try selectionOpenOwnedDirectoryIfPresent(parent: home, name: "Library")
    else { return report(.candidateInvalid) }
    defer { close(library) }
    guard
      let support = try selectionOpenOwnedDirectoryIfPresent(
        parent: library, name: "Application Support")
    else { return report(.candidateInvalid) }
    defer { close(support) }
    guard let ellie = try selectionOpenOwnedDirectoryIfPresent(parent: support, name: "Ellie")
    else { return report(.candidateInvalid) }
    defer { close(ellie) }
    guard let services = try selectionOpenOwnedDirectoryIfPresent(parent: ellie, name: "Services")
    else { return report(.candidateInvalid) }
    defer { close(services) }
    var servicesInfo = stat()
    guard fstat(services, &servicesInfo) == 0, (servicesInfo.st_mode & 0o7777) == 0o700 else {
      return recovery(reason: "topology_mismatch", details: ["services_directory"])
    }

    if try migrationSwitchPending(services) {
      return recovery(reason: "journal_pending", details: ["migration"])
    }
    if try entry(services, paths.journalName) != nil {
      return recovery(reason: "journal_pending", details: ["selection"])
    }
    if try migrationPreparationPending(services) {
      return recovery(reason: "journal_pending", details: ["migration"])
    }

    let lockInfo = try entry(services, "selection.lock")
    let receiptsInfo = try entry(services, "receipts")
    guard (lockInfo == nil) == (receiptsInfo == nil) else {
      return recovery(reason: "receipt_mismatch", details: ["selection_layout"])
    }
    var lock: Int32 = -1
    if lockInfo != nil {
      lock = openat(
        services, "selection.lock", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
      var verified = stat()
      guard lock >= 0, fstat(lock, &verified) == 0, (verified.st_mode & S_IFMT) == S_IFREG,
        verified.st_uid == getuid(), verified.st_nlink == 1,
        (verified.st_mode & 0o7777) == 0o600
      else {
        if lock >= 0 { close(lock) }
        return recovery(reason: "receipt_mismatch", details: ["selection_lock"])
      }
      if flock(lock, LOCK_SH | LOCK_NB) != 0 {
        let lockError = errno
        close(lock)
        lock = -1
        return lockError == EWOULDBLOCK
          ? report(.busy)
          : recovery(reason: "receipt_mismatch", details: ["selection_lock"])
      }
    }
    defer {
      if lock >= 0 {
        flock(lock, LOCK_UN)
        close(lock)
      }
    }

    if try migrationSwitchPending(services) {
      return recovery(reason: "journal_pending", details: ["migration"])
    }
    if try entry(services, paths.journalName) != nil {
      return recovery(reason: "journal_pending", details: ["selection"])
    }
    if try migrationPreparationPending(services) {
      return recovery(reason: "journal_pending", details: ["migration"])
    }

    // Candidate verification is deliberately the existing development-v1 policy.
    do {
      for role in roles {
        _ = try verifiedSelectionRelease(
          servicesRoot: paths.services, releaseID: releaseID, role: role.rawValue)
      }
    } catch { return report(.candidateInvalid) }

    let receipts = try selectionOpenOwnedDirectoryIfPresent(parent: services, name: "receipts")
    defer { if let receipts { close(receipts) } }
    guard (lock >= 0) == (receipts != nil) else {
      return recovery(reason: "receipt_mismatch", details: ["selection_layout"])
    }
    if let receipts {
      var info = stat()
      guard fstat(receipts, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
        info.st_uid == getuid(), (info.st_mode & 0o7777) == 0o700
      else { return recovery(reason: "receipt_mismatch", details: ["receipt_layout"]) }
    }
    let applications = try selectionOpenOwnedDirectoryIfPresent(parent: home, name: "Applications")
    defer { if let applications { close(applications) } }
    let agents = try selectionOpenOwnedDirectoryIfPresent(parent: library, name: "LaunchAgents")
    defer { if let agents { close(agents) } }
    let receiptData = try receipts.flatMap {
      try readPrivateAt($0, paths.receiptName, maximum: 32 * 1024, missing: true)
    }
    let receipt: Receipt
    do { receipt = try decodedReceipt(receiptData) } catch {
      return recovery(reason: "receipt_mismatch", details: ["encoding_or_value"])
    }
    for role in SelectedRole.allCases {
      if let record = receipt[role] {
        guard let applications, let agents else {
          return recovery(
            role: role, reason: "topology_mismatch", details: ["selected_role_assets"])
        }
        let directories = SelectionDirectories(
          services: services, receipts: receipts!, applications: applications, agents: agents)
        do {
          try validateAsset(
            paths: paths, directories: directories, role: role, record: record,
            asset: .application, name: role.appName, diagnostics: true)
          try validateAsset(
            paths: paths, directories: directories, role: role, record: record,
            asset: .plist, name: role.plistName, diagnostics: true)
        } catch let error as LifecycleSelectionRecovery {
          return report(.recoveryRequired, recovery: error)
        } catch {
          return recovery(role: role, reason: "selection_mismatch", details: ["unclassified"])
        }
      } else {
        if let applications, try entry(applications, role.appName) != nil {
          return report(.destinationConflict)
        }
        if let agents, try entry(agents, role.plistName) != nil {
          return report(.destinationConflict)
        }
      }
    }
    for role in roles {
      if testUnavailable { return report(.unavailable) }
      if try roleLoaded(role, testLoaded: testLoaded) { return report(.loaded) }
    }

    #if ELLIE_INSTALLER_TESTING
      if let testBeforeFinal {
        let target: Int32
        switch testBeforeFinal {
        case "services-mode": target = services
        case "receipts-mode":
          guard let receipts else {
            return recovery(reason: "receipt_mismatch", details: ["receipt_layout"])
          }
          target = receipts
        case "lock-mode":
          guard lock >= 0 else {
            return recovery(reason: "receipt_mismatch", details: ["selection_lock"])
          }
          target = lock
        default: return recovery(reason: "selection_mismatch", details: ["unclassified"])
        }
        guard fchmod(target, 0o755) == 0 else {
          return recovery(reason: "selection_mismatch", details: ["unclassified"])
        }
      }
    #endif

    // This remains advisory, but do not report ready from descriptors that have already been
    // detached from their canonical names while the bounded launchctl observations ran.
    func sameDirectory(_ held: Int32, _ fresh: Int32) throws {
      var first = stat()
      var second = stat()
      guard fstat(held, &first) == 0, fstat(fresh, &second) == 0,
        first.st_dev == second.st_dev, first.st_ino == second.st_ino
      else {
        throw LifecycleSelectionRecovery(
          role: roles[0].rawValue, reason: "selection_mismatch", details: ["snapshot_changed"])
      }
    }
    let freshHome = try selectionOpenDirectory(paths.home, privateMode: false)
    defer { close(freshHome) }
    try sameDirectory(home, freshHome)
    let freshLibrary = try selectionOpenOwnedDirectory(parent: freshHome, name: "Library")
    defer { close(freshLibrary) }
    try sameDirectory(library, freshLibrary)
    let freshSupport = try selectionOpenOwnedDirectory(
      parent: freshLibrary, name: "Application Support")
    defer { close(freshSupport) }
    try sameDirectory(support, freshSupport)
    let freshEllie = try selectionOpenOwnedDirectory(parent: freshSupport, name: "Ellie")
    defer { close(freshEllie) }
    try sameDirectory(ellie, freshEllie)
    let freshServices = try selectionOpenOwnedDirectory(parent: freshEllie, name: "Services")
    defer { close(freshServices) }
    try sameDirectory(services, freshServices)
    var finalServicesInfo = stat()
    guard fstat(freshServices, &finalServicesInfo) == 0,
      (finalServicesInfo.st_mode & S_IFMT) == S_IFDIR, finalServicesInfo.st_uid == getuid(),
      (finalServicesInfo.st_mode & 0o7777) == 0o700
    else { return recovery(reason: "topology_mismatch", details: ["services_directory"]) }
    guard try entry(freshServices, paths.journalName) == nil else {
      return recovery(reason: "journal_pending", details: ["selection"])
    }
    guard try migrationSwitchPending(freshServices) == false else {
      return recovery(reason: "journal_pending", details: ["migration"])
    }
    if try migrationPreparationPending(freshServices) {
      return recovery(reason: "journal_pending", details: ["migration"])
    }
    if lock >= 0 {
      var heldLock = stat()
      guard fstat(lock, &heldLock) == 0, let namedLock = try entry(freshServices, "selection.lock"),
        (heldLock.st_mode & S_IFMT) == S_IFREG, heldLock.st_uid == getuid(),
        heldLock.st_nlink == 1, (heldLock.st_mode & 0o7777) == 0o600,
        heldLock.st_dev == namedLock.st_dev, heldLock.st_ino == namedLock.st_ino,
        heldLock.st_uid == namedLock.st_uid, heldLock.st_nlink == namedLock.st_nlink,
        heldLock.st_mode == namedLock.st_mode, heldLock.st_size == namedLock.st_size,
        heldLock.st_mtimespec.tv_sec == namedLock.st_mtimespec.tv_sec,
        heldLock.st_mtimespec.tv_nsec == namedLock.st_mtimespec.tv_nsec,
        heldLock.st_ctimespec.tv_sec == namedLock.st_ctimespec.tv_sec,
        heldLock.st_ctimespec.tv_nsec == namedLock.st_ctimespec.tv_nsec
      else { return recovery(reason: "receipt_mismatch", details: ["selection_lock"]) }
    } else if let appearedLock = try entry(freshServices, "selection.lock") {
      guard (appearedLock.st_mode & S_IFMT) == S_IFREG, appearedLock.st_uid == getuid(),
        appearedLock.st_nlink == 1, (appearedLock.st_mode & 0o7777) == 0o600
      else { return recovery(reason: "receipt_mismatch", details: ["selection_lock"]) }
      return report(.busy)
    }
    let freshReceipts = try selectionOpenOwnedDirectoryIfPresent(
      parent: freshServices, name: "receipts")
    defer { if let freshReceipts { close(freshReceipts) } }
    if let freshReceipts {
      var info = stat()
      guard fstat(freshReceipts, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
        info.st_uid == getuid(), (info.st_mode & 0o7777) == 0o700
      else { return recovery(reason: "receipt_mismatch", details: ["receipt_layout"]) }
    }
    let freshApplications = try selectionOpenOwnedDirectoryIfPresent(
      parent: freshHome, name: "Applications")
    defer { if let freshApplications { close(freshApplications) } }
    let freshAgents = try selectionOpenOwnedDirectoryIfPresent(
      parent: freshLibrary, name: "LaunchAgents")
    defer { if let freshAgents { close(freshAgents) } }
    if let receipts, let freshReceipts {
      try sameDirectory(receipts, freshReceipts)
    } else if (receipts == nil) != (freshReceipts == nil) {
      return recovery(reason: "receipt_mismatch", details: ["selection_layout"])
    }
    if let applications, let freshApplications {
      try sameDirectory(applications, freshApplications)
    } else if (applications == nil) != (freshApplications == nil) {
      return report(.destinationConflict)
    }
    if let agents, let freshAgents {
      try sameDirectory(agents, freshAgents)
    } else if (agents == nil) != (freshAgents == nil) {
      return report(.destinationConflict)
    }
    let freshReceiptData = try freshReceipts.flatMap {
      try readPrivateAt($0, paths.receiptName, maximum: 32 * 1024, missing: true)
    }
    guard freshReceiptData == receiptData else {
      return recovery(reason: "receipt_mismatch", details: ["snapshot_changed"])
    }
    for role in roles {
      do {
        _ = try verifiedSelectionRelease(
          servicesRoot: paths.services, releaseID: releaseID, role: role.rawValue)
      } catch { return report(.candidateInvalid) }
    }
    for role in SelectedRole.allCases {
      if let record = receipt[role] {
        guard let freshApplications, let freshAgents, let freshReceipts else {
          return recovery(
            role: role, reason: "topology_mismatch", details: ["selected_role_assets"])
        }
        let fresh = SelectionDirectories(
          services: freshServices, receipts: freshReceipts, applications: freshApplications,
          agents: freshAgents)
        do {
          try validateAsset(
            paths: paths, directories: fresh, role: role, record: record,
            asset: .application, name: role.appName, diagnostics: true)
          try validateAsset(
            paths: paths, directories: fresh, role: role, record: record, asset: .plist,
            name: role.plistName, diagnostics: true)
        } catch let error as LifecycleSelectionRecovery {
          return report(.recoveryRequired, recovery: error)
        } catch {
          return recovery(role: role, reason: "selection_mismatch", details: ["unclassified"])
        }
      } else {
        if let freshApplications, try entry(freshApplications, role.appName) != nil {
          return report(.destinationConflict)
        }
        if let freshAgents, try entry(freshAgents, role.plistName) != nil {
          return report(.destinationConflict)
        }
      }
    }
    return report(.ready)
  } catch is LifecycleSelectionBusy {
    return report(.busy)
  } catch let error as LifecycleSelectionRecovery {
    return report(.recoveryRequired, recovery: error)
  } catch let error as SelectionFailure {
    if case .launchctlUnavailable = error { return report(.unavailable) }
    return recovery(reason: "selection_mismatch", details: ["unclassified"])
  } catch {
    return recovery(reason: "selection_mismatch", details: ["unclassified"])
  }
}

func runSelectionPreflightCommand(_ input: [String]) -> Never {
  var args = input
  guard args.first == "preflight-select" else { failSelectionCommand(SelectionFailure.rejected) }
  args.removeFirst()
  var testHome: String?
  var testLoaded = Set<SelectedRole>()
  var testUnavailable = false
  var testBeforeFinal: String?
  #if ELLIE_INSTALLER_TESTING
    if let index = args.firstIndex(of: "--test-home-root"), index + 1 < args.count {
      testHome = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-loaded"), index + 1 < args.count {
      let values = args[index + 1].split(separator: ",").map(String.init)
      guard !values.isEmpty, values.allSatisfy({ SelectedRole(rawValue: $0) != nil }) else {
        failSelectionCommand(SelectionFailure.rejected)
      }
      testLoaded = Set(values.compactMap(SelectedRole.init(rawValue:)))
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-preflight-launchctl-unavailable") {
      testUnavailable = true
      args.remove(at: index)
    }
    if let index = args.firstIndex(of: "--test-preflight-before-final"), index + 1 < args.count {
      let value = args[index + 1]
      guard ["services-mode", "receipts-mode", "lock-mode"].contains(value) else {
        failSelectionCommand(SelectionFailure.rejected)
      }
      testBeforeFinal = value
      args.removeSubrange(index...index + 1)
    }
  #endif
  guard args.count == 3, args[1] == "--roles",
    exact(args[0], "[A-Za-z0-9._-]+", count: 128)
  else { failSelectionCommand(SelectionFailure.rejected) }
  let roles: [SelectedRole]
  switch args[2] {
  case "coordinator": roles = [.coordinator]
  case "node": roles = [.node]
  case "coordinator,node": roles = [.coordinator, .node]
  default: failSelectionCommand(SelectionFailure.rejected)
  }
  let value = selectionPreflightReport(
    releaseID: args[0], roles: roles, testHome: testHome, testLoaded: testLoaded,
    testUnavailable: testUnavailable, testBeforeFinal: testBeforeFinal)
  guard let data = try? canonical(value) else { failSelectionCommand(SelectionFailure.rejected) }
  FileHandle.standardOutput.write(data)
  exit(value.ready ? 0 : 1)
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
private func recoverRemovedAsset(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  asset: SelectionAsset, old: RoleReceipt, committed: Bool, transaction: String
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
  guard try entry(parent, staged) == nil else { throw SelectionFailure.recoveryRequired }
  if committed {
    guard try entry(parent, target) == nil else { throw SelectionFailure.recoveryRequired }
    if try entry(parent, backup) != nil {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: old, asset: asset,
        name: backup, applicationRootMode: asset == .application ? 0o700 : 0o555)
      try removeAsset(parent: parent, name: backup)
    }
  } else if try entry(parent, backup) != nil {
    guard try entry(parent, target) == nil else { throw SelectionFailure.recoveryRequired }
    try validateAsset(
      paths: paths, directories: directories, role: role, record: old, asset: asset,
      name: backup, applicationRootMode: asset == .application ? 0o700 : 0o555)
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
  try sync(parent)
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
      guard old[role] != nil || new[role] != nil else {
        throw SelectionFailure.recoveryRequired
      }
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
    for asset in [SelectionAsset.application, .plist] {
      if let newRecord = new[role] {
        try recoverAsset(
          paths: paths, directories: directories, role: role, asset: asset, old: old[role],
          new: newRecord, committed: committed, transaction: journal.transactionID)
      } else if let oldRecord = old[role] {
        try recoverRemovedAsset(
          paths: paths, directories: directories, role: role, asset: asset, old: oldRecord,
          committed: committed, transaction: journal.transactionID)
      }
    }
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

private struct MigrationSwitchJournal: Codable {
  let version: Int
  let transactionID: String
  let snapshotID: String
  let manifestSHA256: String
  let releaseID: String
  let roles: [SelectedRole]
  let temporaryPaths: [String]
  let newReceipt: Data
}
private struct CompletedMigrationSwitch: Codable {
  let version: Int
  let outcome: String
  let journal: MigrationSwitchJournal
}

private func decodedMigrationSwitchJournal(_ data: Data) throws -> MigrationSwitchJournal {
  let value = try JSONDecoder().decode(MigrationSwitchJournal.self, from: data)
  let expectedTemporaryPaths =
    value.roles.map {
      "LaunchAgents/.ellie-write-\(value.transactionID)-migration-\($0.rawValue)"
    } + ["receipts/.ellie-write-\(value.transactionID)-migration-receipt"]
  guard value.version == 1,
    UUID(uuidString: value.transactionID)?.uuidString.lowercased() == value.transactionID,
    exact(value.snapshotID, "legacy-v1-[a-f0-9]{64}", count: 74),
    exact(value.manifestSHA256, "[a-f0-9]{64}", count: 64),
    exact(value.releaseID, "[A-Za-z0-9._-]+", count: 128),
    value.snapshotID == "legacy-v1-" + value.manifestSHA256,
    !value.roles.isEmpty, value.roles.count <= SelectedRole.allCases.count,
    value.roles == SelectedRole.allCases.filter(value.roles.contains),
    value.temporaryPaths == expectedTemporaryPaths,
    try canonical(value) == data
  else { throw MigrationSwitchPendingFailure() }
  let receipt = try decodedReceipt(value.newReceipt)
  for role in SelectedRole.allCases {
    guard (receipt[role] != nil) == value.roles.contains(role),
      receipt[role] == nil || receipt[role]?.releaseID == value.releaseID
    else { throw MigrationSwitchPendingFailure() }
  }
  return value
}

private func switchBackupApp(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-migration-backup-\(transaction)-\(role.rawValue).app"
}
private func switchBackupPlist(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-migration-backup-\(transaction)-\(role.rawValue).plist"
}
private func switchStagedApp(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-migration-stage-\(transaction)-\(role.rawValue).app"
}
private func switchStagedPlist(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-migration-stage-\(transaction)-\(role.rawValue).plist"
}
private func switchEvidence(_ kind: String, _ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-migration-evidence-\(transaction)-\(kind)-\(role.rawValue)"
}

private func removeVerifiedSelectionAsset(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  record: RoleReceipt, asset: SelectionAsset, name: String, rootMode: mode_t = 0o555
) throws {
  try validateAsset(
    paths: paths, directories: directories, role: role, record: record, asset: asset,
    name: name, applicationRootMode: rootMode)
  if asset == .application {
    try selectionRemoveTree(parent: directories.applications, name: name)
  } else {
    guard unlinkat(directories.agents, name, 0) == 0 else { throw MigrationSwitchPendingFailure() }
  }
}

private func validatePrivatePrefix(
  _ parent: Int32, _ name: String, expected: Data
) throws {
  guard let data = try readPrivateAt(parent, name, maximum: expected.count),
    data.count <= expected.count, data == expected.prefix(data.count)
  else { throw MigrationSwitchPendingFailure() }
}

private func validatePrivatePrefixIfPresent(
  _ parent: Int32, _ name: String, expected: Data
) throws {
  if try entry(parent, name) != nil { try validatePrivatePrefix(parent, name, expected: expected) }
}

private func finalizePrivatePrefix(
  _ parent: Int32, source: String, target: String, expected: Data
) throws {
  let fd = openat(parent, source, O_RDWR | O_NOFOLLOW | O_CLOEXEC)
  guard fd >= 0 else { throw MigrationSwitchPendingFailure() }
  defer { close(fd) }
  var before = stat()
  guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
    before.st_uid == getuid(), before.st_nlink == 1, (before.st_mode & 0o7777) == 0o600,
    before.st_size >= 0, before.st_size <= expected.count
  else { throw MigrationSwitchPendingFailure() }
  var prefix = Data(count: Int(before.st_size))
  let prefixLength = prefix.count
  var offset = 0
  while offset < prefixLength {
    let count = prefix.withUnsafeMutableBytes {
      read(fd, $0.baseAddress!.advanced(by: offset), prefixLength - offset)
    }
    guard count > 0 else { throw MigrationSwitchPendingFailure() }
    offset += count
  }
  guard prefix == expected.prefix(prefix.count), lseek(fd, 0, SEEK_END) == before.st_size else {
    throw MigrationSwitchPendingFailure()
  }
  while offset < expected.count {
    let count = expected.withUnsafeBytes {
      write(fd, $0.baseAddress!.advanced(by: offset), expected.count - offset)
    }
    guard count > 0 else { throw MigrationSwitchPendingFailure() }
    offset += count
  }
  var after = stat()
  guard fstat(fd, &after) == 0, after.st_dev == before.st_dev, after.st_ino == before.st_ino,
    after.st_uid == before.st_uid, after.st_nlink == before.st_nlink,
    after.st_size == expected.count, (after.st_mode & 0o7777) == 0o600, fsync(fd) == 0
  else { throw MigrationSwitchPendingFailure() }
  try renameExclusive(from: parent, source, to: parent, target)
}

private func preservePartialApplication(
  release: SelectionRelease, parent: Int32, source: String, evidence: String,
  afterUnseal: () -> Void = {}
) throws {
  if try entry(parent, source) != nil {
    guard try entry(parent, evidence) == nil else { throw MigrationSwitchPendingFailure() }
    do {
      try selectionUnsealPartialApplication(source: release, parent: parent, name: source)
    } catch { throw MigrationSwitchPendingFailure() }
    afterUnseal()
    try renameExclusive(from: parent, source, to: parent, evidence)
  } else if try entry(parent, evidence) != nil {
    do {
      try selectionValidatePartialApplication(source: release, parent: parent, name: evidence)
    } catch { throw MigrationSwitchPendingFailure() }
  }
}

private func validatePartialApplicationIfPresent(
  release: SelectionRelease, parent: Int32, name: String
) throws {
  guard try entry(parent, name) != nil else { return }
  do { try selectionValidatePartialApplication(source: release, parent: parent, name: name) } catch
  { throw MigrationSwitchPendingFailure() }
}

private func preservePrivatePrefix(
  parent: Int32, source: String, evidence: String, expected: Data
) throws {
  if try entry(parent, source) != nil {
    guard try entry(parent, evidence) == nil else { throw MigrationSwitchPendingFailure() }
    try validatePrivatePrefix(parent, source, expected: expected)
    try renameExclusive(from: parent, source, to: parent, evidence)
  } else if try entry(parent, evidence) != nil {
    try validatePrivatePrefix(parent, evidence, expected: expected)
  }
}

private func validatePhasedApplication(
  paths: SelectionPaths, directories: SelectionDirectories, role: SelectedRole,
  record: RoleReceipt, name: String
) throws {
  guard let mode = try applicationMode(directories.applications, name),
    mode == 0o700 || mode == 0o555
  else { throw MigrationSwitchPendingFailure() }
  try validateAsset(
    paths: paths, directories: directories, role: role, record: record, asset: .application,
    name: name, applicationRootMode: mode)
}

private func recoverMigrationSwitch(
  paths: SelectionPaths, directories: SelectionDirectories, journal: MigrationSwitchJournal,
  evidence: MigrationLegacyEvidence, testLoaded: Set<SelectedRole>,
  beforeMutation: () throws -> Void = {}, fault: (String) -> Void = { _ in }
) throws {
  func requireUnloaded() throws {
    for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
      throw SelectionFailure.loaded
    }
  }
  try requireUnloaded()
  guard try entry(directories.services, paths.journalName) == nil else {
    throw MigrationSwitchPendingFailure()
  }
  if let migrations = try entry(directories.services, "migrations") {
    guard (migrations.st_mode & S_IFMT) == S_IFDIR else { throw MigrationSwitchPendingFailure() }
    let fd = try selectionOpenOwnedDirectory(parent: directories.services, name: "migrations")
    defer { close(fd) }
    guard try entry(fd, "migration-preparation.json") == nil else {
      throw MigrationSwitchPendingFailure()
    }
  }
  let receiptData = try readPrivateAt(
    directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
  let committed: Bool
  if receiptData == nil {
    committed = false
  } else if receiptData == journal.newReceipt {
    committed = true
  } else {
    throw MigrationSwitchPendingFailure()
  }
  let receipt = try decodedReceipt(journal.newReceipt)
  for role in journal.roles {
    guard let legacy = evidence.roleEvidence[role.rawValue], let record = receipt[role] else {
      throw MigrationSwitchPendingFailure()
    }
    let backupApp = switchBackupApp(role, journal.transactionID)
    let backupPlist = switchBackupPlist(role, journal.transactionID)
    let stagedApp = switchStagedApp(role, journal.transactionID)
    let stagedPlist = switchStagedPlist(role, journal.transactionID)
    if committed {
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record, asset: .application,
        name: role.appName)
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record, asset: .plist,
        name: role.plistName)
      if try entry(directories.applications, stagedApp) != nil {
        let release = try verifiedSelectionRelease(
          servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
        do {
          try selectionValidatePartialApplication(
            source: release, parent: directories.applications, name: stagedApp)
        } catch { throw MigrationSwitchPendingFailure() }
      }
      if try entry(directories.agents, stagedPlist) != nil {
        try validateAsset(
          paths: paths, directories: directories, role: role, record: record, asset: .plist,
          name: stagedPlist)
      }
      if try entry(directories.applications, backupApp) != nil {
        try migrationValidateLegacyApplication(
          legacy, applications: directories.applications, applicationName: backupApp)
      }
      if try entry(directories.agents, backupPlist) != nil {
        try migrationValidateLegacyPlist(legacy, agents: directories.agents, plistName: backupPlist)
      }
    } else {
      let hasBackupApp = try entry(directories.applications, backupApp) != nil
      let hasBackupPlist = try entry(directories.agents, backupPlist) != nil
      if hasBackupApp {
        try migrationValidateLegacyApplication(
          legacy, applications: directories.applications, applicationName: backupApp)
        if try entry(directories.applications, role.appName) != nil {
          try validatePhasedApplication(
            paths: paths, directories: directories, role: role, record: record, name: role.appName)
        }
      } else {
        try migrationValidateLegacyApplication(
          legacy, applications: directories.applications, applicationName: role.appName)
      }
      if hasBackupPlist {
        try migrationValidateLegacyPlist(legacy, agents: directories.agents, plistName: backupPlist)
        if try entry(directories.agents, role.plistName) != nil {
          try validateAsset(
            paths: paths, directories: directories, role: role, record: record, asset: .plist,
            name: role.plistName)
        }
      } else {
        try migrationValidateLegacyPlist(
          legacy, agents: directories.agents, plistName: role.plistName)
      }
      if try entry(directories.applications, stagedApp) != nil {
        let release = try verifiedSelectionRelease(
          servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
        do {
          try selectionValidatePartialApplication(
            source: release, parent: directories.applications, name: stagedApp)
        } catch { throw MigrationSwitchPendingFailure() }
      }
      if try entry(directories.agents, stagedPlist) != nil {
        try validateAsset(
          paths: paths, directories: directories, role: role, record: record, asset: .plist,
          name: stagedPlist)
      }
    }
  }
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  try beforeMutation()
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  try requireUnloaded()
  if committed {
    try validateSelection(paths: paths, directories: directories, receipt: receipt)
  } else {
    for role in journal.roles {
      guard let record = receipt[role], let legacy = evidence.roleEvidence[role.rawValue] else {
        throw MigrationSwitchPendingFailure()
      }
      let release = try verifiedSelectionRelease(
        servicesRoot: paths.services, releaseID: record.releaseID, role: role.rawValue)
      let backupApp = switchBackupApp(role, journal.transactionID)
      let backupPlist = switchBackupPlist(role, journal.transactionID)
      let stagedApp = switchStagedApp(role, journal.transactionID)
      let stagedPlist = switchStagedPlist(role, journal.transactionID)
      try validatePartialApplicationIfPresent(
        release: release, parent: directories.applications,
        name: switchEvidence("abandoned-target.app", role, journal.transactionID))
      try validatePrivatePrefixIfPresent(
        directories.agents, switchEvidence("abandoned-target.plist", role, journal.transactionID),
        expected: plistData(role: role, release: release, app: paths.app(role), home: paths.home))
      if try entry(directories.applications, backupApp) != nil {
        try preservePartialApplication(
          release: release, parent: directories.applications, source: role.appName,
          evidence: switchEvidence("abandoned-target.app", role, journal.transactionID),
          afterUnseal: { fault("recovery-after-unseal-target-\(role.rawValue)") })
        fault("recovery-after-evidence-app-\(role.rawValue)")
        try renameExclusive(
          from: directories.applications, backupApp, to: directories.applications, role.appName)
        fault("recovery-after-restore-app-\(role.rawValue)")
      }
      if try entry(directories.agents, backupPlist) != nil {
        try preservePrivatePrefix(
          parent: directories.agents, source: role.plistName,
          evidence: switchEvidence("abandoned-target.plist", role, journal.transactionID),
          expected: plistData(role: role, release: release, app: paths.app(role), home: paths.home))
        fault("recovery-after-evidence-plist-\(role.rawValue)")
        try renameExclusive(
          from: directories.agents, backupPlist, to: directories.agents, role.plistName)
        fault("recovery-after-restore-plist-\(role.rawValue)")
      }
      try preservePartialApplication(
        release: release, parent: directories.applications, source: stagedApp,
        evidence: switchEvidence("abandoned-stage.app", role, journal.transactionID),
        afterUnseal: { fault("recovery-after-unseal-stage-\(role.rawValue)") })
      fault("recovery-after-stage-app-\(role.rawValue)")
      try preservePrivatePrefix(
        parent: directories.agents, source: stagedPlist,
        evidence: switchEvidence("abandoned-stage.plist", role, journal.transactionID),
        expected: plistData(role: role, release: release, app: paths.app(role), home: paths.home))
      fault("recovery-after-stage-plist-\(role.rawValue)")
      try preservePrivatePrefix(
        parent: directories.agents,
        source: ".ellie-write-\(journal.transactionID)-migration-\(role.rawValue)",
        evidence: switchEvidence("partial-write.plist", role, journal.transactionID),
        expected: plistData(role: role, release: release, app: paths.app(role), home: paths.home))
      try migrationValidateLegacyRole(
        legacy, applications: directories.applications, agents: directories.agents,
        applicationName: role.appName, plistName: role.plistName)
    }
    try preservePrivatePrefix(
      parent: directories.receipts,
      source: ".ellie-write-\(journal.transactionID)-migration-receipt",
      evidence: ".ellie-migration-evidence-\(journal.transactionID)-partial-write-receipt",
      expected: journal.newReceipt)
  }
  try sync(directories.applications)
  try sync(directories.agents)
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  try requireUnloaded()
  let completed = try canonical(
    CompletedMigrationSwitch(
      version: 1, outcome: committed ? "committed" : "restored-legacy", journal: journal))
  let completedName = ".migration-switch-evidence-\(journal.transactionID).json"
  let completedTemporary = ".ellie-write-\(journal.transactionID)-completed-switch"
  let partialCompleted = ".migration-switch-evidence-\(journal.transactionID)-partial-completed"
  fault("recovery-before-completed")
  try validatePrivatePrefixIfPresent(directories.services, partialCompleted, expected: completed)
  if let existing = try readPrivateAt(
    directories.services, completedName, maximum: 96 * 1024, missing: true)
  {
    guard existing == completed, try entry(directories.services, completedTemporary) == nil
    else { throw MigrationSwitchPendingFailure() }
  } else if try entry(directories.services, completedTemporary) != nil {
    try finalizePrivatePrefix(
      directories.services, source: completedTemporary, target: completedName,
      expected: completed)
  } else {
    try writePrivateAt(
      directories.services, name: completedName, data: completed, replace: false,
      transaction: journal.transactionID + "-completed-switch")
  }
  fault("recovery-after-completed")
  guard unlinkat(directories.services, "migration-switch-journal.json", 0) == 0 else {
    throw MigrationSwitchPendingFailure()
  }
  try sync(directories.services)
}

func runMigrationSwitchCommand(_ input: [String]) throws -> Never {
  var args = input
  let command = args.removeFirst()
  var testHome: String?
  var testLoaded = Set<SelectedRole>()
  var testFault: String?
  var testLoadAfterPreflight = false
  var testReplaceServices = false
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
    if let index = args.firstIndex(of: "--test-switch-fault"), index + 1 < args.count {
      testFault = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-switch-load-after-preflight") {
      testLoadAfterPreflight = true
      args.remove(at: index)
    }
    if let index = args.firstIndex(of: "--test-switch-replace-services") {
      testReplaceServices = true
      args.remove(at: index)
    }
  #endif
  func fault(_ point: String) {
    #if ELLIE_INSTALLER_TESTING
      if testFault == point { _exit(87) }
    #endif
  }
  let requestedRoles: [SelectedRole]
  if command == "recover-migration-switch" {
    guard args.isEmpty else { throw MigrationSwitchPendingFailure() }
    requestedRoles = []
  } else {
    guard command == "adopt-migration", args.count == 4, args[2] == "--roles",
      exact(args[0], "legacy-v1-[a-f0-9]{64}", count: 74),
      exact(args[1], "[A-Za-z0-9._-]+", count: 128)
    else { throw MigrationSwitchPendingFailure() }
    switch args[3] {
    case "coordinator": requestedRoles = [.coordinator]
    case "node": requestedRoles = [.node]
    case "coordinator,node": requestedRoles = [.coordinator, .node]
    default: throw MigrationSwitchPendingFailure()
    }
  }
  let paths = try selectionPaths(testHome: testHome)
  func replaceServices() throws {
    #if ELLIE_INSTALLER_TESTING
      guard testReplaceServices else { return }
      let detached = paths.services + ".test-detached"
      guard rename(paths.services, detached) == 0, mkdir(paths.services, 0o700) == 0 else {
        throw MigrationSwitchPendingFailure()
      }
    #endif
  }
  let directories = try openSelectionDirectories(paths)
  defer { directories.closeAll() }
  var lock = openat(
    directories.services, "selection.lock", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    0o600)
  if lock < 0 && errno == EEXIST {
    lock = openat(directories.services, "selection.lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC)
  }
  var lockInfo = stat()
  guard lock >= 0, fstat(lock, &lockInfo) == 0, (lockInfo.st_mode & S_IFMT) == S_IFREG,
    lockInfo.st_uid == getuid(), lockInfo.st_nlink == 1, (lockInfo.st_mode & 0o7777) == 0o600,
    flock(lock, LOCK_EX | LOCK_NB) == 0
  else {
    if lock >= 0 { close(lock) }
    throw MigrationSwitchPendingFailure()
  }
  defer {
    flock(lock, LOCK_UN)
    close(lock)
  }
  let journalData = try readPrivateAt(
    directories.services, "migration-switch-journal.json", maximum: 64 * 1024, missing: true)
  if command == "recover-migration-switch" {
    guard args.isEmpty, let journalData else {
      if args.isEmpty { exit(0) }
      throw MigrationSwitchPendingFailure()
    }
    let journal = try decodedMigrationSwitchJournal(journalData)
    let evidence = try migrationLegacyEvidence(
      services: directories.services, snapshotID: journal.snapshotID,
      requiredRoles: journal.roles.map(\.rawValue))
    try recoverMigrationSwitch(
      paths: paths, directories: directories, journal: journal, evidence: evidence,
      testLoaded: testLoaded, beforeMutation: replaceServices, fault: fault)
    print("Legacy migration switch recovery complete; managed LaunchAgents remain unloaded.")
    exit(0)
  }
  guard journalData == nil,
    try readPrivateAt(directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
      == nil
  else { throw MigrationSwitchPendingFailure() }
  guard try entry(directories.services, paths.journalName) == nil else {
    throw MigrationSwitchPendingFailure()
  }
  if try entry(directories.services, "migrations") != nil {
    let migrations = try selectionOpenOwnedDirectory(
      parent: directories.services, name: "migrations")
    defer { close(migrations) }
    guard try entry(migrations, "migration-preparation.json") == nil else {
      throw MigrationSwitchPendingFailure()
    }
  }
  var installedRoles: [SelectedRole] = []
  for role in SelectedRole.allCases {
    let app = try entry(directories.applications, role.appName) != nil
    let plist = try entry(directories.agents, role.plistName) != nil
    guard app == plist else { throw MigrationSwitchPendingFailure() }
    if app { installedRoles.append(role) }
  }
  guard !installedRoles.isEmpty, installedRoles == requestedRoles else {
    throw MigrationSwitchPendingFailure()
  }
  let roles = requestedRoles
  for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  let evidence = try migrationLegacyEvidence(
    services: directories.services, snapshotID: args[0], requiredRoles: roles.map(\.rawValue))
  for role in roles {
    guard let legacy = evidence.roleEvidence[role.rawValue] else {
      throw MigrationSwitchPendingFailure()
    }
    try migrationValidateLegacyRole(
      legacy, applications: directories.applications, agents: directories.agents,
      applicationName: role.appName, plistName: role.plistName)
  }
  var next = Receipt(version: 1, coordinator: nil, node: nil)
  var releases: [SelectedRole: SelectionRelease] = [:]
  for role in roles {
    let release = try verifiedSelectionRelease(
      servicesRoot: paths.services, releaseID: args[1], role: role.rawValue)
    releases[role] = release
    let plist = plistData(role: role, release: release, app: paths.app(role), home: paths.home)
    next[role] = RoleReceipt(
      releaseID: release.id, appSHA256: applicationManifestDigest(release.applicationFiles),
      plistSHA256: hash(plist))
  }
  let nextData = try canonical(next)
  let transaction = UUID().uuidString.lowercased()
  let journal = MigrationSwitchJournal(
    version: 1, transactionID: transaction, snapshotID: evidence.snapshotID,
    manifestSHA256: evidence.manifestSHA256, releaseID: args[1], roles: roles,
    temporaryPaths: roles.map {
      "LaunchAgents/.ellie-write-\(transaction)-migration-\($0.rawValue)"
    } + ["receipts/.ellie-write-\(transaction)-migration-receipt"],
    newReceipt: nextData)
  try writePrivateAt(
    directories.services, name: "migration-switch-journal.json", data: try canonical(journal),
    replace: false, transaction: transaction + "-migration-switch-journal")
  fault("after-journal")
  do {
    for role in roles {
      guard let release = releases[role] else { throw MigrationSwitchPendingFailure() }
      let stagedApp = switchStagedApp(role, transaction)
      let stagedPlist = switchStagedPlist(role, transaction)
      _ = try selectionCopyApplication(
        source: release, parent: directories.applications, name: stagedApp,
        identifier: role.identifier)
      try writePrivateAt(
        directories.agents, name: stagedPlist,
        data: plistData(role: role, release: release, app: paths.app(role), home: paths.home),
        replace: false, transaction: transaction + "-migration-" + role.rawValue)
    }
    fault("after-staging")
    if testLoadAfterPreflight { throw SelectionFailure.loaded }
    for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
      throw SelectionFailure.loaded
    }
    try revalidateSelectionDirectoriesReadOnly(paths, directories)
    for role in roles {
      try renameExclusive(
        from: directories.applications, role.appName, to: directories.applications,
        switchBackupApp(role, transaction))
      fault("after-app-backup-\(role.rawValue)")
      try renameExclusive(
        from: directories.applications, switchStagedApp(role, transaction),
        to: directories.applications, role.appName)
      fault("after-app-move-\(role.rawValue)")
      guard let record = next[role] else { throw MigrationSwitchPendingFailure() }
      try sealApplication(
        paths: paths, directories: directories, role: role, record: record, name: role.appName)
      fault("after-app-seal-\(role.rawValue)")
      try renameExclusive(
        from: directories.agents, role.plistName, to: directories.agents,
        switchBackupPlist(role, transaction))
      try renameExclusive(
        from: directories.agents, switchStagedPlist(role, transaction),
        to: directories.agents, role.plistName)
      fault("after-role-\(role.rawValue)")
    }
    try revalidateSelectionDirectoriesReadOnly(paths, directories)
    try replaceServices()
    try revalidateSelectionDirectoriesReadOnly(paths, directories)
    for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
      throw SelectionFailure.loaded
    }
    try writePrivateAt(
      directories.receipts, name: paths.receiptName, data: nextData, replace: false,
      transaction: transaction + "-migration-receipt")
    fault("after-receipt")
    try recoverMigrationSwitch(
      paths: paths, directories: directories, journal: journal, evidence: evidence,
      testLoaded: testLoaded, fault: fault)
    print(
      "Adopted packaged \(roles.map(\.rawValue).joined(separator: ",")) from legacy snapshot; managed LaunchAgents remain unloaded."
    )
    exit(0)
  } catch {
    throw MigrationSwitchPendingFailure()
  }
}

private let legacyRestoreError =
  "Legacy file restoration requires explicit recover-legacy-restore; retained evidence was preserved."

private struct LegacyRestoreJournal: Codable {
  let version: Int
  let direction: String
  let transactionID: String
  let adoptionTransactionID: String
  let snapshotID: String
  let manifestSHA256: String
  let roles: [SelectedRole]
  let packagedReceipt: Data
  let completedAdoption: Data
}

private struct CompletedLegacyRestore: Codable {
  let version: Int
  let outcome: String
  let runtimeCompatibility: String
  let journal: LegacyRestoreJournal
}

private func legacyRestorePackagedApp(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-legacy-restore-\(transaction)-packaged-\(role.rawValue).app"
}
private func legacyRestorePackagedPlist(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-legacy-restore-\(transaction)-packaged-\(role.rawValue).plist"
}
private func legacyRestoreStagedApp(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-legacy-restore-\(transaction)-stage-\(role.rawValue).app"
}
private func legacyRestoreStagedPlist(_ role: SelectedRole, _ transaction: String) -> String {
  ".ellie-legacy-restore-\(transaction)-stage-\(role.rawValue).plist"
}

private func decodedCompletedAdoption(_ data: Data, transaction: String) throws
  -> CompletedMigrationSwitch
{
  let value = try JSONDecoder().decode(CompletedMigrationSwitch.self, from: data)
  guard value.version == 1, value.outcome == "committed",
    value.journal.transactionID == transaction, try canonical(value) == data
  else { throw MigrationSwitchPendingFailure() }
  _ = try decodedMigrationSwitchJournal(try canonical(value.journal))
  return value
}

private func decodedLegacyRestoreJournal(_ data: Data) throws -> LegacyRestoreJournal {
  let value = try JSONDecoder().decode(LegacyRestoreJournal.self, from: data)
  guard value.version == 1, value.direction == "packaged-to-legacy",
    UUID(uuidString: value.transactionID)?.uuidString.lowercased() == value.transactionID,
    UUID(uuidString: value.adoptionTransactionID)?.uuidString.lowercased()
      == value.adoptionTransactionID,
    value.roles == SelectedRole.allCases.filter(value.roles.contains), !value.roles.isEmpty,
    Set(value.roles).count == value.roles.count, try canonical(value) == data
  else { throw MigrationSwitchPendingFailure() }
  let completed = try decodedCompletedAdoption(
    value.completedAdoption, transaction: value.adoptionTransactionID)
  guard completed.journal.snapshotID == value.snapshotID,
    completed.journal.manifestSHA256 == value.manifestSHA256,
    completed.journal.roles == value.roles, completed.journal.newReceipt == value.packagedReceipt
  else { throw MigrationSwitchPendingFailure() }
  return value
}

private func recoverLegacyRestore(
  paths: SelectionPaths, directories: SelectionDirectories, journal: LegacyRestoreJournal,
  evidence: MigrationLegacyEvidence, testLoaded: Set<SelectedRole>,
  fault: (String) -> Void = { _ in }
) throws -> String {
  func requireUnloaded() throws {
    for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
      throw SelectionFailure.loaded
    }
  }
  try requireUnloaded()
  guard try entry(directories.services, paths.journalName) == nil,
    try entry(directories.services, "migration-switch-journal.json") == nil
  else { throw MigrationSwitchPendingFailure() }
  if let migrations = try entry(directories.services, "migrations") {
    guard (migrations.st_mode & S_IFMT) == S_IFDIR else { throw MigrationSwitchPendingFailure() }
    let fd = try selectionOpenOwnedDirectory(parent: directories.services, name: "migrations")
    defer { close(fd) }
    guard try entry(fd, "migration-preparation.json") == nil else {
      throw MigrationSwitchPendingFailure()
    }
  }
  let current = try readPrivateAt(
    directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
  let committed: Bool
  if current == journal.packagedReceipt {
    committed = false
  } else if current == nil {
    committed = true
  } else {
    throw MigrationSwitchPendingFailure()
  }
  let packaged = try decodedReceipt(journal.packagedReceipt)
  guard evidence.snapshotID == journal.snapshotID,
    evidence.manifestSHA256 == journal.manifestSHA256,
    evidence.roles == journal.roles.map(\.rawValue)
  else { throw MigrationSwitchPendingFailure() }
  for role in journal.roles {
    guard let legacy = evidence.roleEvidence[role.rawValue], let record = packaged[role] else {
      throw MigrationSwitchPendingFailure()
    }
    let packagedApp = legacyRestorePackagedApp(role, journal.transactionID)
    let packagedPlist = legacyRestorePackagedPlist(role, journal.transactionID)
    let stagedApp = legacyRestoreStagedApp(role, journal.transactionID)
    let stagedPlist = legacyRestoreStagedPlist(role, journal.transactionID)
    try migrationValidateLegacyApplication(
      legacy, applications: directories.applications,
      applicationName: switchBackupApp(role, journal.adoptionTransactionID))
    try migrationValidateLegacyPlist(
      legacy, agents: directories.agents,
      plistName: switchBackupPlist(role, journal.adoptionTransactionID))
    let retainedLegacyApp =
      ".ellie-legacy-restore-\(journal.transactionID)-legacy-\(role.rawValue).app"
    let retainedLegacyPlist =
      ".ellie-legacy-restore-\(journal.transactionID)-legacy-\(role.rawValue).plist"
    let retainedStageApp =
      ".ellie-legacy-restore-\(journal.transactionID)-partial-stage-\(role.rawValue).app"
    let retainedStagePlist =
      ".ellie-legacy-restore-\(journal.transactionID)-partial-stage-\(role.rawValue).plist"
    if try entry(directories.applications, retainedLegacyApp) != nil {
      try migrationValidatePhasedLegacyApplication(
        legacy, applications: directories.applications, applicationName: retainedLegacyApp)
    }
    if try entry(directories.applications, retainedStageApp) != nil {
      try migrationValidatePartialLegacyApplication(
        legacy, applications: directories.applications, applicationName: retainedStageApp)
    }
    if try entry(directories.agents, retainedLegacyPlist) != nil {
      try migrationValidateLegacyPlist(
        legacy, agents: directories.agents, plistName: retainedLegacyPlist)
    }
    if try entry(directories.agents, retainedStagePlist) != nil {
      try migrationValidatePartialLegacyPlist(
        legacy, agents: directories.agents, plistName: retainedStagePlist)
    }
    if committed {
      try migrationValidatePhasedLegacyApplication(
        legacy, applications: directories.applications, applicationName: role.appName)
      try migrationValidateLegacyPlist(
        legacy, agents: directories.agents, plistName: role.plistName)
      try validatePhasedApplication(
        paths: paths, directories: directories, role: role, record: record, name: packagedApp)
      try validateAsset(
        paths: paths, directories: directories, role: role, record: record, asset: .plist,
        name: packagedPlist)
    } else {
      let appEvidence = try entry(directories.applications, packagedApp) != nil
      let plistEvidence = try entry(directories.agents, packagedPlist) != nil
      if appEvidence {
        try validatePhasedApplication(
          paths: paths, directories: directories, role: role, record: record, name: packagedApp)
        if try entry(directories.applications, role.appName) != nil {
          try migrationValidatePhasedLegacyApplication(
            legacy, applications: directories.applications, applicationName: role.appName)
        } else {
          try migrationValidateLegacyApplication(
            legacy, applications: directories.applications,
            applicationName: switchBackupApp(role, journal.adoptionTransactionID))
        }
      } else {
        try validatePhasedApplication(
          paths: paths, directories: directories, role: role, record: record, name: role.appName)
      }
      if plistEvidence {
        try validateAsset(
          paths: paths, directories: directories, role: role, record: record, asset: .plist,
          name: packagedPlist)
        if try entry(directories.agents, role.plistName) != nil {
          try migrationValidateLegacyPlist(
            legacy, agents: directories.agents, plistName: role.plistName)
        } else {
          try migrationValidateLegacyPlist(
            legacy, agents: directories.agents,
            plistName: switchBackupPlist(role, journal.adoptionTransactionID))
        }
      } else {
        try validateAsset(
          paths: paths, directories: directories, role: role, record: record, asset: .plist,
          name: role.plistName)
      }
      if try entry(directories.applications, stagedApp) != nil {
        try migrationValidatePartialLegacyApplication(
          legacy, applications: directories.applications, applicationName: stagedApp)
      }
      if try entry(directories.agents, stagedPlist) != nil {
        try migrationValidatePartialLegacyPlist(
          legacy, agents: directories.agents, plistName: stagedPlist)
      }
    }
  }
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  try requireUnloaded()
  if !committed {
    for role in journal.roles {
      guard let record = packaged[role], let legacy = evidence.roleEvidence[role.rawValue] else {
        throw MigrationSwitchPendingFailure()
      }
      let packagedApp = legacyRestorePackagedApp(role, journal.transactionID)
      let packagedPlist = legacyRestorePackagedPlist(role, journal.transactionID)
      let stagedApp = legacyRestoreStagedApp(role, journal.transactionID)
      let stagedPlist = legacyRestoreStagedPlist(role, journal.transactionID)
      if try entry(directories.applications, packagedApp) != nil {
        let legacyEvidence =
          ".ellie-legacy-restore-\(journal.transactionID)-legacy-\(role.rawValue).app"
        if try entry(directories.applications, role.appName) != nil,
          try entry(directories.applications, legacyEvidence) == nil
        {
          try migrationUnsealLegacyApplication(
            legacy, applications: directories.applications, applicationName: role.appName)
          fault("recovery-after-legacy-app-unseal-\(role.rawValue)")
          try renameExclusive(
            from: directories.applications, role.appName, to: directories.applications,
            legacyEvidence)
          fault("recovery-after-legacy-app-evidence-\(role.rawValue)")
        }
        try renameExclusive(
          from: directories.applications, packagedApp, to: directories.applications, role.appName)
        fault("recovery-before-packaged-app-seal-\(role.rawValue)")
        try sealApplication(
          paths: paths, directories: directories, role: role, record: record,
          name: role.appName)
        fault("recovery-after-packaged-app-seal-\(role.rawValue)")
      } else if try applicationMode(directories.applications, role.appName) == 0o700 {
        fault("recovery-before-packaged-app-seal-\(role.rawValue)")
        try sealApplication(
          paths: paths, directories: directories, role: role, record: record,
          name: role.appName)
        fault("recovery-after-packaged-app-seal-\(role.rawValue)")
      }
      if try entry(directories.agents, packagedPlist) != nil {
        let legacyEvidence =
          ".ellie-legacy-restore-\(journal.transactionID)-legacy-\(role.rawValue).plist"
        if try entry(directories.agents, role.plistName) != nil,
          try entry(directories.agents, legacyEvidence) == nil
        {
          try renameExclusive(
            from: directories.agents, role.plistName, to: directories.agents, legacyEvidence)
        }
        try renameExclusive(
          from: directories.agents, packagedPlist, to: directories.agents, role.plistName)
      }
      if try entry(directories.applications, stagedApp) != nil {
        let evidenceName =
          ".ellie-legacy-restore-\(journal.transactionID)-partial-stage-\(role.rawValue).app"
        guard try entry(directories.applications, evidenceName) == nil else {
          throw MigrationSwitchPendingFailure()
        }
        try renameExclusive(
          from: directories.applications, stagedApp, to: directories.applications, evidenceName)
      }
      if try entry(directories.agents, stagedPlist) != nil {
        let evidenceName =
          ".ellie-legacy-restore-\(journal.transactionID)-partial-stage-\(role.rawValue).plist"
        guard try entry(directories.agents, evidenceName) == nil else {
          throw MigrationSwitchPendingFailure()
        }
        try renameExclusive(
          from: directories.agents, stagedPlist, to: directories.agents, evidenceName)
      }
    }
    try validateSelection(paths: paths, directories: directories, receipt: packaged)
  } else {
    for role in journal.roles {
      guard let legacy = evidence.roleEvidence[role.rawValue] else {
        throw MigrationSwitchPendingFailure()
      }
      try migrationSealLegacyApplication(
        legacy, applications: directories.applications, applicationName: role.appName)
      fault("recovery-after-legacy-app-seal-\(role.rawValue)")
    }
  }
  try sync(directories.applications)
  try sync(directories.agents)
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  try requireUnloaded()
  let completed = try canonical(
    CompletedLegacyRestore(
      version: 1, outcome: committed ? "restored-legacy" : "restored-packaged",
      runtimeCompatibility: "unverified", journal: journal))
  let completedName = ".legacy-restore-evidence-\(journal.transactionID).json"
  let completedTemporary =
    ".ellie-write-\(journal.transactionID)-legacy-restore-completed"
  if let existing = try readPrivateAt(
    directories.services, completedName, maximum: 160 * 1024, missing: true)
  {
    guard existing == completed, try entry(directories.services, completedTemporary) == nil else {
      throw MigrationSwitchPendingFailure()
    }
  } else if try entry(directories.services, completedTemporary) != nil {
    try finalizePrivatePrefix(
      directories.services, source: completedTemporary, target: completedName,
      expected: completed)
  } else {
    try writePrivateAt(
      directories.services, name: completedName, data: completed, replace: false,
      transaction: journal.transactionID + "-legacy-restore-completed")
  }
  fault("after-completed")
  guard unlinkat(directories.services, "legacy-restore-journal.json", 0) == 0 else {
    throw MigrationSwitchPendingFailure()
  }
  try sync(directories.services)
  return committed ? "restored-legacy" : "restored-packaged"
}

func runLegacyRestoreCommand(_ input: [String]) throws -> Never {
  var args = input
  let command = args.removeFirst()
  var testHome: String?
  var testLoaded = Set<SelectedRole>()
  var testFault: String?
  var testTruncateRole: SelectedRole?
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
    if let index = args.firstIndex(of: "--test-legacy-restore-fault"), index + 1 < args.count {
      testFault = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-legacy-truncate"), index + 1 < args.count {
      testTruncateRole = SelectedRole(rawValue: args[index + 1])
      args.removeSubrange(index...index + 1)
    }
  #endif
  func fault(_ point: String) {
    #if ELLIE_INSTALLER_TESTING
      if point == testFault { _exit(89) }
    #endif
  }
  let roles: [SelectedRole]
  let adoptionTransaction: String?
  if command == "recover-legacy-restore" {
    guard args.isEmpty else { throw MigrationSwitchPendingFailure() }
    roles = []
    adoptionTransaction = nil
  } else {
    guard command == "restore-legacy", args.count == 3, args[1] == "--roles",
      UUID(uuidString: args[0])?.uuidString.lowercased() == args[0]
    else { throw MigrationSwitchPendingFailure() }
    adoptionTransaction = args[0]
    switch args[2] {
    case "coordinator": roles = [.coordinator]
    case "node": roles = [.node]
    case "coordinator,node": roles = [.coordinator, .node]
    default: throw MigrationSwitchPendingFailure()
    }
  }
  let paths = try selectionPaths(testHome: testHome)
  let directories = try openSelectionDirectories(paths)
  defer { directories.closeAll() }
  let lock = openat(
    directories.services, "selection.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
  var lockInfo = stat()
  guard lock >= 0, fstat(lock, &lockInfo) == 0, (lockInfo.st_mode & S_IFMT) == S_IFREG,
    lockInfo.st_uid == getuid(), lockInfo.st_nlink == 1, (lockInfo.st_mode & 0o7777) == 0o600,
    flock(lock, LOCK_EX | LOCK_NB) == 0
  else {
    if lock >= 0 { close(lock) }
    throw MigrationSwitchPendingFailure()
  }
  defer {
    flock(lock, LOCK_UN)
    close(lock)
  }
  let active = try readPrivateAt(
    directories.services, "legacy-restore-journal.json", maximum: 128 * 1024, missing: true)
  if command == "recover-legacy-restore" {
    guard let active else { exit(0) }
    let journal = try decodedLegacyRestoreJournal(active)
    let evidence = try migrationLegacyEvidence(
      services: directories.services, snapshotID: journal.snapshotID,
      requiredRoles: journal.roles.map(\.rawValue))
    let outcome = try recoverLegacyRestore(
      paths: paths, directories: directories, journal: journal, evidence: evidence,
      testLoaded: testLoaded, fault: fault)
    print(
      "Legacy restore recovery outcome \(outcome); managed LaunchAgents remain unloaded; runtime compatibility is unverified."
    )
    exit(0)
  }
  guard active == nil, try entry(directories.services, paths.journalName) == nil,
    try entry(directories.services, "migration-switch-journal.json") == nil,
    let adoptionTransaction
  else { throw MigrationSwitchPendingFailure() }
  if let migrationsInfo = try entry(directories.services, "migrations") {
    guard (migrationsInfo.st_mode & S_IFMT) == S_IFDIR else {
      throw MigrationSwitchPendingFailure()
    }
    let migrations = try selectionOpenOwnedDirectory(
      parent: directories.services, name: "migrations")
    defer { close(migrations) }
    guard try entry(migrations, "migration-preparation.json") == nil else {
      throw MigrationSwitchPendingFailure()
    }
  }
  let completedName = ".migration-switch-evidence-\(adoptionTransaction).json"
  guard
    let completedData = try readPrivateAt(
      directories.services, completedName, maximum: 96 * 1024)
  else { throw MigrationSwitchPendingFailure() }
  let completed = try decodedCompletedAdoption(completedData, transaction: adoptionTransaction)
  guard completed.journal.roles == roles else { throw MigrationSwitchPendingFailure() }
  guard
    let current = try readPrivateAt(
      directories.receipts, paths.receiptName, maximum: 32 * 1024)
  else { throw MigrationSwitchPendingFailure() }
  guard current == completed.journal.newReceipt else { throw MigrationSwitchPendingFailure() }
  let packaged = try decodedReceipt(current)
  try validateSelection(paths: paths, directories: directories, receipt: packaged)
  let evidence = try migrationLegacyEvidence(
    services: directories.services, snapshotID: completed.journal.snapshotID,
    requiredRoles: roles.map(\.rawValue))
  guard evidence.manifestSHA256 == completed.journal.manifestSHA256 else {
    throw MigrationSwitchPendingFailure()
  }
  for role in roles {
    guard let legacy = evidence.roleEvidence[role.rawValue] else {
      throw MigrationSwitchPendingFailure()
    }
    try migrationValidateLegacyRole(
      legacy, applications: directories.applications, agents: directories.agents,
      applicationName: switchBackupApp(role, adoptionTransaction),
      plistName: switchBackupPlist(role, adoptionTransaction))
  }
  for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  let transaction = UUID().uuidString.lowercased()
  let journal = LegacyRestoreJournal(
    version: 1, direction: "packaged-to-legacy", transactionID: transaction,
    adoptionTransactionID: adoptionTransaction, snapshotID: completed.journal.snapshotID,
    manifestSHA256: completed.journal.manifestSHA256, roles: roles,
    packagedReceipt: current, completedAdoption: completedData)
  try writePrivateAt(
    directories.services, name: "legacy-restore-journal.json", data: try canonical(journal),
    replace: false, transaction: transaction + "-legacy-restore-journal")
  fault("after-journal")
  for role in roles {
    guard let legacy = evidence.roleEvidence[role.rawValue] else {
      throw MigrationSwitchPendingFailure()
    }
    try migrationStageLegacyRole(
      legacy, applications: directories.applications, agents: directories.agents,
      applicationName: legacyRestoreStagedApp(role, transaction),
      plistName: legacyRestoreStagedPlist(role, transaction),
      truncatePath: testTruncateRole == role ? "application/Contents/Info.plist" : nil)
  }
  fault("after-staging")
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  for role in roles {
    guard let record = packaged[role], let legacy = evidence.roleEvidence[role.rawValue] else {
      throw MigrationSwitchPendingFailure()
    }
    try unsealApplication(
      paths: paths, directories: directories, role: role, record: record, name: role.appName)
    fault("after-packaged-app-unseal-\(role.rawValue)")
    try renameExclusive(
      from: directories.applications, role.appName, to: directories.applications,
      legacyRestorePackagedApp(role, transaction))
    fault("after-packaged-app-\(role.rawValue)")
    try renameExclusive(
      from: directories.applications, legacyRestoreStagedApp(role, transaction),
      to: directories.applications, role.appName)
    fault("after-legacy-app-publish-\(role.rawValue)")
    try migrationSealLegacyApplication(
      legacy, applications: directories.applications, applicationName: role.appName)
    fault("after-legacy-app-seal-\(role.rawValue)")
    try renameExclusive(
      from: directories.agents, role.plistName, to: directories.agents,
      legacyRestorePackagedPlist(role, transaction))
    try renameExclusive(
      from: directories.agents, legacyRestoreStagedPlist(role, transaction),
      to: directories.agents, role.plistName)
    try migrationValidateLegacyPlist(
      legacy, agents: directories.agents, plistName: role.plistName)
    fault("after-role-\(role.rawValue)")
  }
  try revalidateSelectionDirectoriesReadOnly(paths, directories)
  for role in SelectedRole.allCases where try roleLoaded(role, testLoaded: testLoaded) {
    throw SelectionFailure.loaded
  }
  guard unlinkat(directories.receipts, paths.receiptName, 0) == 0 else {
    throw MigrationSwitchPendingFailure()
  }
  try sync(directories.receipts)
  fault("after-receipt")
  let outcome = try recoverLegacyRestore(
    paths: paths, directories: directories, journal: journal, evidence: evidence,
    testLoaded: testLoaded, fault: fault)
  print(
    "Legacy restore outcome \(outcome) for \(roles.map(\.rawValue).joined(separator: ",")); managed LaunchAgents remain unloaded; runtime compatibility is unverified."
  )
  exit(0)
}

func failLegacyRestoreCommand(_ error: Error) -> Never {
  FileHandle.standardError.write(Data((legacyRestoreError + "\n").utf8))
  exit(1)
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
  } else if command == "unselect" {
    guard args.count == 1, let role = SelectedRole(rawValue: args[0]) else {
      throw SelectionFailure.rejected
    }
    releaseID = nil
    roles = [role]
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
  if try migrationSwitchPending(directories.services) { throw MigrationSwitchPendingFailure() }
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
  if command == "unselect" {
    guard let role = roles.first else { throw SelectionFailure.rejected }
    if try roleLoaded(role, testLoaded: testLoaded) { throw SelectionFailure.loaded }
    let oldData =
      try
      (readPrivateAt(directories.receipts, paths.receiptName, maximum: 32 * 1024, missing: true)
      ?? canonical(Receipt(version: 1, coordinator: nil, node: nil)))
    let old = try decodedReceipt(oldData)
    try validateSelection(paths: paths, directories: directories, receipt: old)
    guard let oldRecord = old[role] else { throw SelectionFailure.rejected }
    var next = old
    next[role] = nil
    let transaction = UUID().uuidString.lowercased()
    let nextData = try canonical(next)
    let journal = Journal(
      version: 1, transactionID: transaction, roles: [role], oldReceipt: oldData,
      newReceipt: nextData)
    try writeJournalAt(
      directories.services, name: paths.journalName, data: try canonical(journal),
      beforeSync: { fault("before-journal-fsync") },
      afterSync: { fault("after-journal-fsync") })
    fault("after-journal")
    do {
      if testFailAfterJournal { throw SelectionFailure.rejected }
      if testLoadAfterPreflight { throw SelectionFailure.loaded }
      if try roleLoaded(role, testLoaded: testLoaded) { throw SelectionFailure.loaded }
      try unsealApplication(
        paths: paths, directories: directories, role: role, record: oldRecord,
        name: role.appName)
      fault("after-old-app-unseal-\(role.rawValue)")
      let backupApp = (paths.backupApp(role, transaction) as NSString).lastPathComponent
      let backupPlist = (paths.backupPlist(role, transaction) as NSString).lastPathComponent
      try renameExclusive(
        from: directories.applications, role.appName, to: directories.applications, backupApp)
      fault("after-old-app-backup-\(role.rawValue)")
      try renameExclusive(
        from: directories.agents, role.plistName, to: directories.agents, backupPlist)
      fault("after-old-plist-backup-\(role.rawValue)")
      try writePrivateAt(
        directories.receipts, name: paths.receiptName, data: nextData,
        replace: true, transaction: transaction)
      fault("after-receipt")
      try recover(paths: paths, directories: directories, testLoaded: testLoaded)
      print("Unselected \(role.rawValue); its managed LaunchAgent remains unloaded.")
      exit(0)
    } catch let error {
      if case .loaded = error as? SelectionFailure { throw error }
      throw SelectionFailure.recoveryRequired
    }
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
