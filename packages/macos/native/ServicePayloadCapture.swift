import Darwin
import Foundation

private let captureError =
  "Ellie could not capture this authenticated service candidate; existing candidates were preserved."
private let captureBusyError =
  "Ellie authenticated candidate capture is busy; no candidate data was changed."
private let captureRecoveryError =
  "Ellie authenticated candidate capture requires recovery; retained evidence was preserved."
private let captureCleanupError =
  "Ellie authenticated candidate capture cleanup was incomplete; retained evidence was preserved."
private let captureStagePattern = "\\.capture-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
private let captureMaximumNamespaceBytes: UInt64 = 8 * 1024 * 1024 * 1024
private let captureMaximumDescendants = 65_536

#if ELLIE_INSTALLER_TESTING
  private var captureDiagnostic = "argument-validation"
  private var captureHoldLockMilliseconds = 0
  private var captureMutateRelease = false
  private var captureMutateAuthorization = false
  private func captureCheckpoint(_ value: String) { captureDiagnostic = value }
#else
  private func captureCheckpoint(_ value: String) {}
#endif

struct CapturedAuthenticatedCandidate {
  let candidateID: String
  let releaseID: String
  let authorizationRecordSHA256: String
  let envelopePolicyDigest: String
  let manifestSHA256: String
  let payloadPolicyDigest: String
  let sourceSHA256: String
}

private struct NamespaceUsage {
  var top = 0
  var stages = 0
  var published = 0
  var descendants = 0
  var bytes: UInt64 = 0
}

private func captureFileInfo(_ parent: Int32, _ name: String) throws -> stat {
  var info = stat()
  guard fstatat(parent, try checkedComponent(name), &info, AT_SYMLINK_NOFOLLOW) == 0,
    (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
    info.st_size >= 0
  else { throw CaptureFailure.rejected }
  return info
}

private func checkedAdd(_ lhs: UInt64, _ rhs: UInt64, maximum: UInt64) throws -> UInt64 {
  let (sum, overflow) = lhs.addingReportingOverflow(rhs)
  guard !overflow, sum <= maximum else { throw CaptureFailure.rejected }
  return sum
}

private func captureAbsolutePath(_ value: String) -> Bool {
  guard value.hasPrefix("/"), value.utf8.count <= 4096, !value.utf8.contains(0) else {
    return false
  }
  let parts = value.split(separator: "/", omittingEmptySubsequences: false)
  return parts.first == "" && parts.count > 1
    && parts.dropFirst().allSatisfy({
      !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.count <= 255
    })
}

private func constructionMode(_ mode: mode_t, requested: mode_t, executable: Bool) -> Bool {
  mode & ~requested == 0 && mode & 0o400 != 0 && (!executable || mode & 0o100 != 0)
}

private func constructionDirectoryMode(_ mode: mode_t) -> Bool {
  mode == 0o555 || (mode & ~mode_t(0o700) == 0 && mode & 0o500 == 0o500)
}

private func validateAuthorizationPrefix(_ root: Int32, published: Bool) throws {
  let allowed: [String: Set<String>] = [
    "": ["Contents"],
    "Contents": ["Info.plist", "MacOS", "Resources", "_CodeSignature"],
    "Contents/MacOS": ["EllieServiceAuthorization"],
    "Contents/Resources": ["SOURCE.txt", "authorization.json", "manifest.json"],
    "Contents/_CodeSignature": ["CodeResources"],
  ]
  let limits: [String: Int64] = [
    "Contents/Info.plist": 64 * 1024,
    "Contents/MacOS/EllieServiceAuthorization": 16 * 1024 * 1024,
    "Contents/Resources/manifest.json": 4 * 1024 * 1024,
    "Contents/Resources/SOURCE.txt": 16 * 1024,
    "Contents/Resources/authorization.json": 4 * 1024,
    "Contents/_CodeSignature/CodeResources": 1024 * 1024,
  ]
  func walk(_ fd: Int32, _ path: String) throws {
    guard let names = allowed[path], Set(try directoryNames(fd, maximum: 7)).isSubset(of: names)
    else { throw CaptureFailure.rejected }
    for name in try directoryNames(fd, maximum: 7) {
      var info = stat()
      guard fstatat(fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
        throw CaptureFailure.rejected
      }
      let childPath = path.isEmpty ? name : path + "/" + name
      if allowed[childPath] != nil {
        guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
          published
            ? (info.st_mode & 0o7777) == 0o555
            : constructionDirectoryMode(info.st_mode & 0o7777)
        else { throw CaptureFailure.rejected }
        let child = try openDirectory(at: fd, name); defer { closeFD(child) }
        try walk(child, childPath)
      } else {
        guard let limit = limits[childPath], info.st_size >= 0, info.st_size <= limit else {
          throw CaptureFailure.rejected
        }
        guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
          published
            ? (info.st_mode & 0o7777) == (childPath == "Contents/MacOS/EllieServiceAuthorization" ? 0o555 : 0o444)
            : constructionMode(
              info.st_mode & 0o7777,
              requested: childPath == "Contents/MacOS/EllieServiceAuthorization" ? 0o555 : 0o444,
              executable: childPath == "Contents/MacOS/EllieServiceAuthorization")
        else { throw CaptureFailure.rejected }
      }
    }
  }
  try walk(root, "")
}

private func validateCapturePrefix(_ root: Int32, published: Bool) throws {
  let names = try directoryNames(root, maximum: 4)
  let allowed: Set<String> = ["release", "authorization", "binding.json"]
  guard Set(names).isSubset(of: allowed), !published || Set(names) == allowed else {
    throw CaptureFailure.rejected
  }
  if names.contains("binding.json") {
    guard names.contains("release"), names.contains("authorization") else {
      throw CaptureFailure.rejected
    }
    let bindingInfo = try captureFileInfo(root, "binding.json")
    guard bindingInfo.st_size <= 4 * 1024,
      published
        ? (bindingInfo.st_mode & 0o7777) == 0o444
        : constructionMode(bindingInfo.st_mode & 0o7777, requested: 0o444, executable: false)
    else { throw CaptureFailure.rejected }
  }
  if names.contains("release") {
    let release = try openDirectory(at: root, "release"); defer { closeFD(release) }
    let releaseNames = Set(try directoryNames(release, maximum: 4))
    guard releaseNames.isSubset(of: ["manifest.json", "SOURCE.txt", "payload"]),
      !names.contains("binding.json") || releaseNames == ["manifest.json", "SOURCE.txt", "payload"]
    else { throw CaptureFailure.rejected }
    for metadata in releaseNames.intersection(["manifest.json", "SOURCE.txt"]) {
      let info = try captureFileInfo(release, metadata)
      guard info.st_size <= (metadata == "manifest.json" ? maximumManifestBytes : maximumSourceBytes),
        published
          ? (info.st_mode & 0o7777) == 0o444
          : constructionMode(info.st_mode & 0o7777, requested: 0o444, executable: false)
      else { throw CaptureFailure.rejected }
    }
    if releaseNames.contains("payload") {
      let payload = try captureDirectory(
        release, "payload", modes: published ? [0o555] : [0o500, 0o555, 0o700])
      closeFD(payload)
    }
  }
  if names.contains("authorization") {
    let authorization = try openDirectory(at: root, "authorization"); defer { closeFD(authorization) }
    let authorizationNames = try directoryNames(authorization, maximum: 2)
    guard Set(authorizationNames).isSubset(of: ["Ellie Service Authorization.app"]) else {
      throw CaptureFailure.rejected
    }
    if authorizationNames == ["Ellie Service Authorization.app"] {
      let app = try openDirectory(at: authorization, authorizationNames[0]); defer { closeFD(app) }
      try validateAuthorizationPrefix(app, published: published)
    }
  }
}

private func scanTree(_ fd: Int32, depth: Int, published: Bool, usage: inout NamespaceUsage) throws {
  guard depth <= maximumPayloadDepth + 6 else { throw CaptureFailure.rejected }
  for name in try directoryNames(fd, maximum: captureMaximumDescendants + 1) {
    usage.descendants += 1
    guard usage.descendants <= captureMaximumDescendants else { throw CaptureFailure.rejected }
    var info = stat()
    guard fstatat(fd, try checkedComponent(name), &info, AT_SYMLINK_NOFOLLOW) == 0,
      info.st_uid == getuid()
    else { throw CaptureFailure.rejected }
    if (info.st_mode & S_IFMT) == S_IFDIR {
      guard published
        ? (info.st_mode & 0o7777) == 0o555
        : constructionDirectoryMode(info.st_mode & 0o7777)
      else {
        throw CaptureFailure.rejected
      }
      let child = try openDirectory(at: fd, name)
      defer { closeFD(child) }
      try scanTree(child, depth: depth + 1, published: published, usage: &usage)
    } else {
      guard (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
        published
          ? [0o444, 0o555].contains(Int(info.st_mode & 0o7777))
          : (constructionMode(info.st_mode & 0o7777, requested: 0o444, executable: false)
            || constructionMode(info.st_mode & 0o7777, requested: 0o555, executable: true)),
        info.st_size >= 0
      else { throw CaptureFailure.rejected }
      usage.bytes = try checkedAdd(
        usage.bytes, UInt64(info.st_size), maximum: captureMaximumNamespaceBytes)
    }
  }
}

private func scanNamespace(_ namespace: Int32) throws -> NamespaceUsage {
  var usage = NamespaceUsage()
  for name in try directoryNames(namespace, maximum: 162) {
    usage.top += 1
    if name == ".capture.lock" {
      captureCheckpoint("scan-lock")
      let info = try captureFileInfo(namespace, name)
      guard (info.st_mode & 0o7777) == 0o600 else { throw CaptureFailure.rejected }
      captureCheckpoint("scan-lock-complete")
      continue
    }
    if exactMatch(name, captureStagePattern, maximum: 45) { usage.stages += 1 }
    else if exactMatch(name, captureDigestPattern, maximum: 64) { usage.published += 1 }
    else { throw CaptureFailure.rejected }
    let child = try captureDirectory(namespace, name, modes: [0o555, 0o700])
    defer { closeFD(child) }
    let published = exactMatch(name, captureDigestPattern, maximum: 64)
    try validateCapturePrefix(child, published: published)
    usage.descendants += 1
    try scanTree(child, depth: 0, published: published, usage: &usage)
    if published {
      let bindingData = try readFile(at: child, "binding.json", mode: 0o444, maximum: 4 * 1024)
      let candidateBinding = try decodeBinding(bindingData)
      let verified = try verifyCapturedCandidate(
        namespace: namespace, name: name, teamID: candidateBinding.publisherTeamID,
        expected: candidateBinding, allowPrivateRoot: true)
      closeFD(verified.root)
      guard verified.candidateID == name else { throw CaptureFailure.rejected }
    }
  }
  guard usage.top <= 161, usage.stages <= 32, usage.published <= 128 else {
    throw CaptureFailure.rejected
  }
  return usage
}

private func ensureCaptureDirectory(parent: Int32, name: String, mode: mode_t) throws -> Int32 {
  var info = stat()
  let existed = fstatat(parent, try checkedComponent(name), &info, AT_SYMLINK_NOFOLLOW) == 0
  if !existed {
    guard errno == ENOENT, mkdirat(parent, name, mode) == 0 else { throw CaptureFailure.rejected }
  }
  let child = try captureDirectory(parent, name, modes: [mode])
  if !existed, (fsync(child) != 0 || fsync(parent) != 0) {
    closeFD(child); throw CaptureFailure.rejected
  }
  return child
}

private func productionCaptureServicesRoot(create: Bool) throws -> String {
  let home = try openAbsoluteDirectory(FileManager.default.homeDirectoryForCurrentUser.path)
  defer { closeFD(home) }
  try statSafeDirectory(home, privateMode: false)
  let library = try openDirectory(at: home, "Library"); defer { closeFD(library) }
  try statSafeDirectory(library, privateMode: false)
  let support = try openDirectory(at: library, "Application Support"); defer { closeFD(support) }
  try statSafeDirectory(support, privateMode: false)
  let ellie: Int32
  if create { ellie = try ensureCaptureDirectory(parent: support, name: "Ellie", mode: 0o700) }
  else { ellie = try captureDirectory(support, "Ellie", modes: [0o700]) }
  defer { closeFD(ellie) }
  let services: Int32
  if create { services = try ensureCaptureDirectory(parent: ellie, name: "Services", mode: 0o700) }
  else { services = try captureDirectory(ellie, "Services", modes: [0o700]) }
  defer { closeFD(services) }
  return try pathFromFD(services)
}

private func openNamespace(servicesRoot: String, create: Bool) throws -> (Int32, Int32) {
  let services = try openAbsoluteDirectory(servicesRoot)
  do { try statSafeDirectory(services, privateMode: true) } catch { closeFD(services); throw error }
  let namespace: Int32
  if create {
    namespace = try ensureCaptureDirectory(
      parent: services, name: "authenticated-candidates", mode: 0o700)
  } else {
    namespace = try captureDirectory(services, "authenticated-candidates", modes: [0o700])
  }
  guard !create || (fsync(namespace) == 0 && fsync(services) == 0) else {
    closeFD(namespace); closeFD(services); throw CaptureFailure.rejected
  }
  return (services, namespace)
}

private func removeProvenStage(namespace: Int32, name: String, expected: CaptureIdentity) throws {
  let current: Int32
  do { current = try captureDirectory(namespace, name, modes: [0o700]) }
  catch { throw CaptureFailure.cleanupIncomplete }
  defer { closeFD(current) }
  guard sameIdentity(try captureIdentity(current), expected) else {
    throw CaptureFailure.cleanupIncomplete
  }
  do { try validateCapturePrefix(current, published: false) }
  catch { throw CaptureFailure.cleanupIncomplete }
  var count = 0
  do {
    try removeBoundedCaptureTree(
      parent: namespace, name: name, depth: 0, count: &count, expected: expected)
  }
  catch { throw CaptureFailure.cleanupIncomplete }
}

private func removeBoundedCaptureTree(
  parent: Int32, name: String, depth: Int, count: inout Int,
  expected: CaptureIdentity? = nil
) throws {
  guard depth <= maximumPayloadDepth + 6 else { throw CaptureFailure.cleanupIncomplete }
  count += 1
  guard count <= captureMaximumDescendants else { throw CaptureFailure.cleanupIncomplete }
  var info = stat()
  guard fstatat(parent, try checkedComponent(name), &info, AT_SYMLINK_NOFOLLOW) == 0,
    info.st_uid == getuid()
  else { throw CaptureFailure.cleanupIncomplete }
  if (info.st_mode & S_IFMT) == S_IFDIR {
    let child = try openDirectory(at: parent, name)
    defer { closeFD(child) }
    let identity = try captureIdentity(child)
    guard identity.owner == getuid(), info.st_dev == identity.device,
      info.st_ino == identity.inode,
      expected == nil || sameIdentity(identity, expected!)
    else {
      throw CaptureFailure.cleanupIncomplete
    }
    guard fchmod(child, 0o700) == 0 else { throw CaptureFailure.cleanupIncomplete }
    for childName in try directoryNames(child, maximum: captureMaximumDescendants) {
      try removeBoundedCaptureTree(
        parent: child, name: childName, depth: depth + 1, count: &count)
    }
    let rebound = try captureIdentity(child)
    var named = stat()
    guard sameIdentity(identity, rebound),
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
      named.st_dev == identity.device, named.st_ino == identity.inode,
      named.st_uid == identity.owner
    else { throw CaptureFailure.cleanupIncomplete }
    guard unlinkat(parent, name, AT_REMOVEDIR) == 0 else {
      throw CaptureFailure.cleanupIncomplete
    }
  } else {
    let file = openat(parent, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    guard file >= 0 else { throw CaptureFailure.cleanupIncomplete }
    defer { closeFD(file) }
    let identity = try captureIdentity(file)
    var opened = stat()
    var named = stat()
    guard fstat(file, &opened) == 0, (opened.st_mode & S_IFMT) == S_IFREG,
      opened.st_uid == getuid(), opened.st_nlink == 1,
      info.st_dev == identity.device, info.st_ino == identity.inode,
      opened.st_dev == identity.device, opened.st_ino == identity.inode,
      fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
      named.st_dev == identity.device, named.st_ino == identity.inode,
      unlinkat(parent, name, 0) == 0
    else { throw CaptureFailure.cleanupIncomplete }
  }
}

private func lockNamespace(_ namespace: Int32) throws -> Int32 {
  let lock = openat(namespace, ".capture.lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard lock >= 0 else { throw CaptureFailure.rejected }
  var info = stat()
  guard fstat(lock, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(),
    info.st_nlink == 1, (info.st_mode & 0o7777) == 0o600
  else { closeFD(lock); throw CaptureFailure.rejected }
  guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
    closeFD(lock); throw errno == EWOULDBLOCK ? CaptureFailure.busy : CaptureFailure.rejected
  }
  #if ELLIE_INSTALLER_TESTING
    if captureHoldLockMilliseconds > 0 {
      usleep(useconds_t(captureHoldLockMilliseconds * 1_000))
    }
  #endif
  return lock
}

private func makeDirectories(root: Int32, path: String) throws -> Int32 {
  var current = dup(root)
  guard current >= 0 else { throw CaptureFailure.rejected }
  do {
    for part in try components(path) {
      let next = try ensureDirectory(parent: current, name: part, mode: 0o700)
      closeFD(current); current = next
    }
    return current
  } catch { closeFD(current); throw error }
}

private func writePath(root: Int32, path: String, data: Data, mode: mode_t, counter: inout Int)
  throws
{
  let parts = try components(path)
  let parent = try makeDirectories(root: root, path: parts.dropLast().joined(separator: "/"))
  defer { closeFD(parent) }
  try writeCapturedFile(
    destination: parent, name: parts.last!, data: data, mode: mode, counter: &counter,
    failAfter: nil)
}

private func candidateResult(_ binding: CaptureBinding, id: String) -> CapturedAuthenticatedCandidate {
  CapturedAuthenticatedCandidate(
    candidateID: id, releaseID: binding.releaseID,
    authorizationRecordSHA256: binding.authorizationRecordSHA256,
    envelopePolicyDigest: binding.envelopePolicyDigest, manifestSHA256: binding.manifestSHA256,
    payloadPolicyDigest: binding.payloadPolicyDigest, sourceSHA256: binding.sourceSHA256)
}

private func capture(
  releasePath: String, authorizationPath: String, teamID: String, servicesRoot: String?,
  fault: String?
) throws -> CapturedAuthenticatedCandidate {
  func trigger(_ point: String) {
    #if ELLIE_INSTALLER_TESTING
      if fault == point { _exit(86) }
    #else
      _ = point
    #endif
  }
  captureCheckpoint("external-inspection")
  let inspected = try verifyAuthenticatedPayload(
    releasePath: releasePath, authorizationPath: authorizationPath, publisherTeamID: teamID,
    testAllowAdHoc: captureAllowsAdHoc)
  #if ELLIE_INSTALLER_TESTING
    if captureMutateRelease {
      let root = try openAbsoluteDirectory(releasePath); defer { closeFD(root) }
      let payload = try openDirectory(at: root, "payload"); defer { closeFD(payload) }
      let bin = try openDirectory(at: payload, "bin"); defer { closeFD(bin) }
      let fd = openat(bin, "node", O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { throw CaptureFailure.rejected }
      defer { closeFD(fd) }
      var byte: UInt8 = 0
      guard write(fd, &byte, 1) == 1 else { throw CaptureFailure.rejected }
    }
    if captureMutateAuthorization {
      let app = try openAbsoluteDirectory(authorizationPath); defer { closeFD(app) }
      let contents = try openDirectory(at: app, "Contents"); defer { closeFD(contents) }
      let resources = try openDirectory(at: contents, "Resources"); defer { closeFD(resources) }
      let fd = openat(resources, "authorization.json", O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { throw CaptureFailure.rejected }
      defer { closeFD(fd) }
      var byte: UInt8 = 0x20
      guard write(fd, &byte, 1) == 1 else { throw CaptureFailure.rejected }
    }
  #endif
  captureCheckpoint("authorization-snapshot")
  let authorizationSnapshot = try authorizationCaptureFiles(authorizationPath)
  guard authorizationSnapshot.device == inspected.envelope.authorizationDevice,
    authorizationSnapshot.inode == inspected.envelope.authorizationInode
  else { throw CaptureFailure.rejected }
  let authorizationFiles = authorizationSnapshot.files
  let intended = binding(from: inspected, teamID: teamID)
  let intendedData = try canonicalBinding(intended)
  let candidateID = captureHash(intendedData)
  let resolvedServicesRoot = try servicesRoot ?? productionCaptureServicesRoot(create: true)
  captureCheckpoint("open-namespace")
  let (services, namespace) = try openNamespace(servicesRoot: resolvedServicesRoot, create: true)
  defer { closeFD(namespace); closeFD(services) }
  captureCheckpoint("lock-namespace")
  let lock = try lockNamespace(namespace); defer { closeFD(lock) }
  captureCheckpoint("scan-namespace")
  let usage = try scanNamespace(namespace)
  var existingInfo = stat()
  if fstatat(namespace, candidateID, &existingInfo, AT_SYMLINK_NOFOLLOW) == 0 {
    let verified = try verifyCapturedCandidate(
      namespace: namespace, name: candidateID, teamID: teamID, expected: intended,
      allowPrivateRoot: false)
    defer { closeFD(verified.root) }
    guard verified.candidateID == candidateID else { throw CaptureFailure.recoveryRequired }
    try rebindCandidateChain(
      servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
      candidateName: candidateID, heldCandidate: verified.root)
    return candidateResult(verified.binding, id: verified.candidateID)
  }
  guard errno == ENOENT, usage.stages < 32, usage.published < 128, usage.top + 1 <= 161
  else { throw CaptureFailure.rejected }
  captureCheckpoint("project-stage")
  var projected: UInt64 = UInt64(inspected.envelope.manifestData.count + inspected.envelope.sourceData.count + 4096)
  for entry in inspected.inventory.entries {
    projected = try checkedAdd(projected, entry.size, maximum: captureMaximumNamespaceBytes)
  }
  for item in authorizationFiles {
    projected = try checkedAdd(projected, UInt64(item.data.count), maximum: captureMaximumNamespaceBytes)
  }
  _ = try checkedAdd(usage.bytes, projected, maximum: captureMaximumNamespaceBytes)
  var implied = Set<String>()
  for entry in inspected.inventory.entries {
    var parts = entry.path.split(separator: "/").map(String.init); parts.removeLast()
    while !parts.isEmpty { implied.insert(parts.joined(separator: "/")); parts.removeLast() }
  }
  let projectedEntries = inspected.inventory.entries.count + implied.count + 18
  guard usage.descendants <= captureMaximumDescendants - projectedEntries else {
    throw CaptureFailure.rejected
  }
  captureCheckpoint("create-stage")
  let stageName = ".capture-" + UUID().uuidString.lowercased()
  guard mkdirat(namespace, stageName, 0o700) == 0 else { throw CaptureFailure.rejected }
  trigger("after-stage-creation")
  var renamed = false
  var stageIdentity: CaptureIdentity?
  do {
    let stage = try captureDirectory(namespace, stageName, modes: [0o700]); defer { closeFD(stage) }
    stageIdentity = try captureIdentity(stage)
    captureCheckpoint("copy-release")
    let release = try ensureDirectory(parent: stage, name: "release", mode: 0o700)
    defer { closeFD(release) }
    var counter = 0
    try writeCapturedFile(destination: release, name: "manifest.json", data: inspected.envelope.manifestData, counter: &counter, failAfter: nil)
    try writeCapturedFile(destination: release, name: "SOURCE.txt", data: inspected.envelope.sourceData, counter: &counter, failAfter: nil)
    let sourceRoot = try openAbsoluteDirectory(releasePath); defer { closeFD(sourceRoot) }
    let sourcePayload = try openDirectory(at: sourceRoot, "payload"); defer { closeFD(sourcePayload) }
    let destinationPayload = try ensureDirectory(parent: release, name: "payload", mode: 0o700)
    defer { closeFD(destinationPayload) }
    try copyPayload(source: sourcePayload, destination: destinationPayload, entries: inspected.inventory.entries, counter: &counter, failAfter: nil)
    let authorization = try ensureDirectory(parent: stage, name: "authorization", mode: 0o700)
    defer { closeFD(authorization) }
    let app = try ensureDirectory(parent: authorization, name: "Ellie Service Authorization.app", mode: 0o700)
    defer { closeFD(app) }
    captureCheckpoint("copy-authorization")
    for item in authorizationFiles {
      try writePath(root: app, path: item.path, data: item.data, mode: item.executable ? 0o555 : 0o444, counter: &counter)
    }
    captureCheckpoint("seal-children")
    try makeImmutable(destinationPayload); try makeImmutable(release); try makeImmutable(app)
    guard fchmod(destinationPayload, 0o555) == 0, fchmod(release, 0o555) == 0,
      fchmod(app, 0o555) == 0, fchmod(authorization, 0o555) == 0
    else { throw CaptureFailure.rejected }
    trigger("after-child-sealing")
    captureCheckpoint("verify-captured-pair")
    _ = try verifyAuthenticatedManifestEnvelope(
      releasePath: try pathFromFD(release), authorizationPath: try pathFromFD(app),
      publisherTeamID: teamID, testAllowAdHoc: captureAllowsAdHoc)
    captureCheckpoint("verify-captured-payload")
    _ = try verifyCapturedAuthenticatedPayload(
      releasePath: try pathFromFD(release), authorizationPath: try pathFromFD(app),
      publisherTeamID: teamID, testAllowAdHoc: captureAllowsAdHoc)
    captureCheckpoint("write-binding")
    try writeCapturedFile(destination: stage, name: "binding.json", data: intendedData, counter: &counter, failAfter: nil)
    trigger("after-binding-fsync")
    guard fsync(stage) == 0, fsync(namespace) == 0 else { throw CaptureFailure.rejected }
    try rebindAuthenticatedPayloadSource(inspected, path: releasePath)
    try rebindAuthorizationSource(inspected.envelope, path: authorizationPath)
    captureCheckpoint("verify-stage")
    let checked = try verifyCapturedCandidate(namespace: namespace, name: stageName, teamID: teamID, expected: intended, allowPrivateRoot: true)
    defer { closeFD(checked.root) }
    guard checked.candidateID == candidateID, checked.binding == intended else { throw CaptureFailure.recoveryRequired }
    try rebindCandidateChain(
      servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
      candidateName: stageName, heldCandidate: checked.root, candidateModes: [0o700])
    trigger("before-rename")
    if renameatx_np(namespace, stageName, namespace, candidateID, UInt32(RENAME_EXCL)) != 0 {
      guard errno == EEXIST else { throw CaptureFailure.rejected }
      let existing = try verifyCapturedCandidate(namespace: namespace, name: candidateID, teamID: teamID, expected: intended, allowPrivateRoot: true)
      defer { closeFD(existing.root) }
      guard existing.candidateID == candidateID else { throw CaptureFailure.recoveryRequired }
      let repeatedStage = try verifyCapturedCandidate(
        namespace: namespace, name: stageName, teamID: teamID, expected: intended,
        allowPrivateRoot: true)
      guard repeatedStage.candidateID == candidateID,
        sameIdentity(repeatedStage.rootIdentity, stageIdentity!)
      else { closeFD(repeatedStage.root); throw CaptureFailure.cleanupIncomplete }
      closeFD(repeatedStage.root)
      guard let stageIdentity else { throw CaptureFailure.cleanupIncomplete }
      try removeProvenStage(namespace: namespace, name: stageName, expected: stageIdentity)
      if fchmod(existing.root, 0o555) != 0 { throw CaptureFailure.recoveryRequired }
      guard fsync(existing.root) == 0, fsync(namespace) == 0 else { throw CaptureFailure.recoveryRequired }
      try rebindCandidateChain(
        servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
        candidateName: candidateID, heldCandidate: existing.root)
      return candidateResult(intended, id: candidateID)
    }
    renamed = true
    trigger("after-rename")
    guard fchmod(stage, 0o555) == 0, fsync(stage) == 0, fsync(namespace) == 0 else {
      throw CaptureFailure.recoveryRequired
    }
    trigger("after-root-seal")
    let final = try verifyCapturedCandidate(namespace: namespace, name: candidateID, teamID: teamID, expected: intended, allowPrivateRoot: false)
    defer { closeFD(final.root) }
    guard final.candidateID == candidateID else { throw CaptureFailure.recoveryRequired }
    try rebindCandidateChain(
      servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
      candidateName: candidateID, heldCandidate: final.root)
    trigger("after-final-namespace-fsync")
    return candidateResult(intended, id: candidateID)
  } catch {
    if renamed { throw error }
    guard let stageIdentity else { throw CaptureFailure.cleanupIncomplete }
    do { try removeProvenStage(namespace: namespace, name: stageName, expected: stageIdentity) }
    catch { throw CaptureFailure.cleanupIncomplete }
    throw error
  }
}

private func recover(target: String, teamID: String, servicesRoot: String?)
  throws -> CapturedAuthenticatedCandidate
{
  let resolvedServicesRoot = try servicesRoot ?? productionCaptureServicesRoot(create: false)
  let (services, namespace) = try openNamespace(servicesRoot: resolvedServicesRoot, create: false)
  defer { closeFD(namespace); closeFD(services) }
  let lock = try lockNamespace(namespace); defer { closeFD(lock) }
  _ = try scanNamespace(namespace)
  let verified = try verifyCapturedCandidate(namespace: namespace, name: target, teamID: teamID, allowPrivateRoot: true)
  defer { closeFD(verified.root) }
  let targetIdentity = verified.rootIdentity
  try rebindCandidateChain(
    servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
    candidateName: target, heldCandidate: verified.root, candidateModes: [0o555, 0o700])
  if exactMatch(target, captureStagePattern, maximum: 45) {
    var info = stat()
    if fstatat(namespace, verified.candidateID, &info, AT_SYMLINK_NOFOLLOW) == 0 {
      let existing = try verifyCapturedCandidate(namespace: namespace, name: verified.candidateID, teamID: teamID, expected: verified.binding, allowPrivateRoot: true)
      defer { closeFD(existing.root) }
      guard existing.candidateID == verified.candidateID else { throw CaptureFailure.recoveryRequired }
      let repeated = try verifyCapturedCandidate(
        namespace: namespace, name: target, teamID: teamID, expected: verified.binding,
        allowPrivateRoot: true)
      guard repeated.candidateID == verified.candidateID,
        sameIdentity(repeated.rootIdentity, targetIdentity)
      else { closeFD(repeated.root); throw CaptureFailure.cleanupIncomplete }
      closeFD(repeated.root)
      try removeProvenStage(namespace: namespace, name: target, expected: targetIdentity)
      if fchmod(existing.root, 0o555) != 0 { throw CaptureFailure.recoveryRequired }
    } else {
      guard errno == ENOENT,
        renameatx_np(namespace, target, namespace, verified.candidateID, UInt32(RENAME_EXCL)) == 0
      else { throw CaptureFailure.recoveryRequired }
      guard fchmod(verified.root, 0o555) == 0 else { throw CaptureFailure.recoveryRequired }
    }
  } else {
    guard target == verified.candidateID else { throw CaptureFailure.recoveryRequired }
    guard fchmod(verified.root, 0o555) == 0 else { throw CaptureFailure.recoveryRequired }
  }
  let publishedRoot = try captureDirectory(namespace, verified.candidateID, modes: [0o555])
  defer { closeFD(publishedRoot) }
  guard fsync(publishedRoot) == 0, fsync(namespace) == 0 else {
    throw CaptureFailure.recoveryRequired
  }
  let final = try verifyCapturedCandidate(namespace: namespace, name: verified.candidateID, teamID: teamID, expected: verified.binding, allowPrivateRoot: false)
  defer { closeFD(final.root) }
  guard final.candidateID == verified.candidateID else { throw CaptureFailure.recoveryRequired }
  try rebindCandidateChain(
    servicesRoot: resolvedServicesRoot, heldServices: services, heldNamespace: namespace,
    candidateName: verified.candidateID, heldCandidate: final.root)
  return candidateResult(verified.binding, id: verified.candidateID)
}

func runAuthenticatedCaptureCommand(_ arguments: [String]) throws -> Never {
  var values = arguments
  var servicesRoot: String?
  var fault: String?
  #if ELLIE_INSTALLER_TESTING
    if values.count >= 2, values[values.count - 2] == "--test-services-root" {
      servicesRoot = values.last; values.removeLast(2)
    }
    if values.count >= 2, values[values.count - 2] == "--test-capture-fault" {
      fault = values.last; values.removeLast(2)
      guard [
        "after-stage-creation", "after-child-sealing", "after-binding-fsync", "before-rename",
        "after-rename", "after-root-seal", "after-final-namespace-fsync",
      ].contains(fault!) else { throw CaptureFailure.rejected }
    }
    if values.count >= 2, values[values.count - 2] == "--test-hold-capture-lock-ms",
      let milliseconds = Int(values.last!), (1...5_000).contains(milliseconds)
    {
      captureHoldLockMilliseconds = milliseconds
      values.removeLast(2)
    }
    if values.last == "--test-mutate-release-after-inspection" {
      captureMutateRelease = true; values.removeLast()
    }
    if values.last == "--test-mutate-authorization-after-inspection" {
      captureMutateAuthorization = true; values.removeLast()
    }
  #endif
  let teamID: String
  let result: CapturedAuthenticatedCandidate
  if values.first == "capture-authenticated-payload" {
    guard values.count == 5, values[3] == "--publisher-team-id",
      values[1].hasPrefix("/"), values[2].hasPrefix("/"),
      exactMatch(values[4], "[A-Z0-9]{10}", maximum: 10),
      captureAbsolutePath(values[1]), captureAbsolutePath(values[2])
    else { throw CaptureFailure.rejected }
    teamID = values[4]
    result = try capture(
      releasePath: values[1], authorizationPath: values[2], teamID: teamID,
      servicesRoot: servicesRoot, fault: fault)
  } else {
    guard values.count == 4, values[0] == "recover-authenticated-capture",
      values[2] == "--publisher-team-id", exactMatch(values[3], "[A-Z0-9]{10}", maximum: 10),
      exactMatch(values[1], captureStagePattern, maximum: 45)
        || exactMatch(values[1], captureDigestPattern, maximum: 64)
    else { throw CaptureFailure.rejected }
    teamID = values[3]
    result = try recover(target: values[1], teamID: teamID, servicesRoot: servicesRoot)
  }
  print("Authenticated candidate \(result.candidateID) (\(result.releaseID)) was captured but remains unselected and cannot run.")
  exit(0)
}

func failAuthenticatedCapture(_ error: Error) -> Never {
  let message: String
  switch error as? CaptureFailure {
  case .busy: message = captureBusyError
  case .recoveryRequired: message = captureRecoveryError
  case .cleanupIncomplete: message = captureCleanupError
  default: message = captureError
  }
  FileHandle.standardError.write(Data((message + "\n").utf8))
  #if ELLIE_INSTALLER_TESTING
    FileHandle.standardError.write(Data("Ellie capture test diagnostic: category=\(captureDiagnostic)\n".utf8))
  #endif
  exit(1)
}
