import Combine
import Darwin
import Foundation

enum HouseholdProfile: String, Codable, CaseIterable, Identifiable, Sendable {
  case shared, `private`
  var id: String { rawValue }
  var title: String { self == .shared ? "Shared household" : "This iPhone private" }
}

enum HouseholdAccess: String, Codable, Sendable { case read, write }

struct HouseholdDashboardGrant: Codable, Equatable, Sendable {
  let clientId: String
  let profile: HouseholdProfile
  let kind: String
  let access: HouseholdAccess
}

struct HouseholdDashboardDocument: Equatable, Sendable {
  let profile: HouseholdProfile
  let revision: Int64
  let value: DashboardState
}

struct PendingDashboardDraft: Codable, Equatable, Sendable {
  let version: Int
  let origin: URL
  let certificateSha256: String
  let clientId: String
  let profile: HouseholdProfile
  let baseRevision: Int64
  let value: DashboardState

  init(
    origin: URL, certificateSha256: String, clientId: String, profile: HouseholdProfile,
    baseRevision: Int64, value: DashboardState
  ) {
    version = 1
    self.origin = origin
    self.certificateSha256 = certificateSha256
    self.clientId = clientId
    self.profile = profile
    self.baseRevision = baseRevision
    self.value = value
  }

  func validated() throws -> PendingDashboardDraft {
    guard version == 1, origin.scheme == "https", origin.host != nil,
      origin.path.isEmpty || origin.path == "/", origin.query == nil, origin.fragment == nil,
      certificateSha256.count == 64,
      certificateSha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }),
      validNativeIdentifier(clientId), baseRevision >= 0,
      baseRevision <= 9_007_199_254_740_991
    else { throw DashboardSyncFailure.invalidResponse }
    try DashboardModel.validate(value)
    _ = try DashboardModel.encode(value)
    return self
  }
}

enum DashboardSyncSaveResult: Equatable, Sendable {
  case saved(HouseholdDashboardDocument)
  case conflict(Int64)
}

enum DashboardSyncFailure: Error, Equatable, LocalizedError {
  case revoked, forbidden, unavailable, invalidResponse, unknownOutcome, cacheUnavailable
  var errorDescription: String? {
    switch self {
    case .revoked: "This iPhone’s coordinator session is no longer authorized."
    case .forbidden: "Dashboard access is no longer allowed for this profile."
    case .unavailable: "The coordinator could not be reached."
    case .invalidResponse: "The coordinator returned an invalid dashboard response."
    case .unknownOutcome: "The save outcome is unknown. Use Check Save Result; Ellie will not repeat it."
    case .cacheUnavailable: "The pending sync copy could not be stored or cleared privately. Sync is blocked."
    }
  }
}

protocol HouseholdDashboardTransporting: Sendable {
  func authority(_ credential: NativeEnrollmentCredential) async throws -> [HouseholdDashboardGrant]
  func read(_ profile: HouseholdProfile, credential: NativeEnrollmentCredential) async throws
    -> HouseholdDashboardDocument
  func save(_ draft: PendingDashboardDraft, credential: NativeEnrollmentCredential) async throws
    -> DashboardSyncSaveResult
}

protocol PendingDashboardDraftPersisting: Sendable {
  func load() throws -> PendingDashboardDraft?
  func save(_ draft: PendingDashboardDraft) throws
  func clear() throws
}

func clearPendingDashboardSync(
  persistence: PendingDashboardDraftPersisting = PrivatePendingDashboardDraftStore(),
  action: () -> Void
) throws {
  try persistence.clear()
  action()
}

struct PrivatePendingDashboardDraftStore: PendingDashboardDraftPersisting, @unchecked Sendable {
  static let maximumBytes = DashboardModel.maximumSerializedBytes + 2_048
  let fileURL: URL

  init(fileURL: URL? = nil) {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    self.fileURL = fileURL ?? base.appendingPathComponent("Ellie", isDirectory: true)
      .appendingPathComponent("dashboard-sync-pending-v1.json")
  }

  func load() throws -> PendingDashboardDraft? {
    try checkExistingDirectory()
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT { return nil }
      throw DashboardSyncFailure.cacheUnavailable
    }
    try requirePrivateFile(info)
    let descriptor = open(fileURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw DashboardSyncFailure.cacheUnavailable }
    defer { close(descriptor) }
    var actual = stat()
    guard fstat(descriptor, &actual) == 0, actual.st_dev == info.st_dev, actual.st_ino == info.st_ino
    else { throw DashboardSyncFailure.cacheUnavailable }
    try requirePrivateFile(actual)
    guard actual.st_size >= 0, actual.st_size <= Self.maximumBytes else {
      throw DashboardSyncFailure.cacheUnavailable
    }
    var data = Data(count: Int(actual.st_size))
    let count = data.withUnsafeMutableBytes { buffer -> Int in
      guard let base = buffer.baseAddress else { return 0 }
      var offset = 0
      while offset < buffer.count {
        let amount = Darwin.read(descriptor, base.advanced(by: offset), buffer.count - offset)
        if amount <= 0 { return amount == 0 ? offset : -1 }
        offset += amount
      }
      return offset
    }
    guard count == data.count,
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == [
        "version", "origin", "certificateSha256", "clientId", "profile", "baseRevision", "value",
      ],
      let draft = try? JSONDecoder().decode(PendingDashboardDraft.self, from: data)
    else { throw DashboardSyncFailure.cacheUnavailable }
    return try draft.validated()
  }

  func save(_ draft: PendingDashboardDraft) throws {
    let checked = try draft.validated()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(checked)
    guard data.count <= Self.maximumBytes else { throw DashboardSyncFailure.cacheUnavailable }
    let directory = fileURL.deletingLastPathComponent()
    var directoryInfo = stat()
    if lstat(directory.path, &directoryInfo) != 0 {
      guard errno == ENOENT else { throw DashboardSyncFailure.cacheUnavailable }
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      guard lstat(directory.path, &directoryInfo) == 0 else {
        throw DashboardSyncFailure.cacheUnavailable
      }
    }
    try requirePrivateDirectory(directoryInfo)
    let temporary = directory.appendingPathComponent(".dashboard-sync-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw DashboardSyncFailure.cacheUnavailable }
    var succeeded = false
    defer {
      close(descriptor)
      if !succeeded { unlink(temporary.path) }
    }
    let wrote = data.withUnsafeBytes { buffer -> Bool in
      guard let base = buffer.baseAddress else { return true }
      var offset = 0
      while offset < buffer.count {
        let amount = Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
        if amount <= 0 { return false }
        offset += amount
      }
      return true
    }
    guard wrote, fsync(descriptor) == 0, fchmod(descriptor, 0o600) == 0 else {
      throw DashboardSyncFailure.cacheUnavailable
    }
    if FileManager.default.fileExists(atPath: fileURL.path) {
      var existing = stat()
      guard lstat(fileURL.path, &existing) == 0 else { throw DashboardSyncFailure.cacheUnavailable }
      try requirePrivateFile(existing)
    }
    guard rename(temporary.path, fileURL.path) == 0 else {
      throw DashboardSyncFailure.cacheUnavailable
    }
    succeeded = true
    let directoryDescriptor = open(directory.path, O_RDONLY | O_NOFOLLOW)
    guard directoryDescriptor >= 0 else { throw DashboardSyncFailure.cacheUnavailable }
    defer { close(directoryDescriptor) }
    guard fsync(directoryDescriptor) == 0 else { throw DashboardSyncFailure.cacheUnavailable }
  }

  func clear() throws {
    let directory = fileURL.deletingLastPathComponent()
    var directoryInfo = stat()
    if lstat(directory.path, &directoryInfo) == 0 { try requirePrivateDirectory(directoryInfo) }
    else if errno == ENOENT { return }
    else { throw DashboardSyncFailure.cacheUnavailable }
    let directoryDescriptor = open(directory.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard directoryDescriptor >= 0 else { throw DashboardSyncFailure.cacheUnavailable }
    defer { close(directoryDescriptor) }
    var actualDirectory = stat()
    guard fstat(directoryDescriptor, &actualDirectory) == 0,
      actualDirectory.st_dev == directoryInfo.st_dev,
      actualDirectory.st_ino == directoryInfo.st_ino
    else { throw DashboardSyncFailure.cacheUnavailable }
    try requirePrivateDirectory(actualDirectory)
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT {
        guard fsync(directoryDescriptor) == 0 else {
          throw DashboardSyncFailure.cacheUnavailable
        }
        return
      }
      throw DashboardSyncFailure.cacheUnavailable
    }
    try requirePrivateFile(info)
    guard unlink(fileURL.path) == 0, fsync(directoryDescriptor) == 0 else {
      throw DashboardSyncFailure.cacheUnavailable
    }
  }

  private func requirePrivateFile(_ value: stat) throws {
    guard (value.st_mode & S_IFMT) == S_IFREG, value.st_uid == getuid(), value.st_nlink == 1,
      (value.st_mode & 0o777) == 0o600
    else { throw DashboardSyncFailure.cacheUnavailable }
  }

  private func requirePrivateDirectory(_ value: stat) throws {
    guard (value.st_mode & S_IFMT) == S_IFDIR, value.st_uid == getuid(),
      (value.st_mode & 0o777) == 0o700
    else { throw DashboardSyncFailure.cacheUnavailable }
  }

  private func checkExistingDirectory() throws {
    var info = stat()
    guard lstat(fileURL.deletingLastPathComponent().path, &info) == 0 else {
      if errno == ENOENT { return }
      throw DashboardSyncFailure.cacheUnavailable
    }
    try requirePrivateDirectory(info)
  }
}

@MainActor
final class DashboardSyncStore: ObservableObject {
  enum Phase: Equatable {
    case idle, loading, ready, prepared, saving, conflict(Int64), unknown
    case matchedCurrentCopy(Int64), orphanedPending, failed(String), revoked, privacyBlocked
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var grants: [HouseholdDashboardGrant] = []
  @Published private(set) var remote: HouseholdDashboardDocument?
  @Published private(set) var draft: PendingDashboardDraft?
  @Published var profile: HouseholdProfile = .shared

  private let credential: NativeEnrollmentCredential
  private let transport: HouseholdDashboardTransporting
  private let persistence: PendingDashboardDraftPersisting
  private var task: Task<Void, Never>?
  private var generation = 0
  private var hasOrphanedPending = false

  init(
    credential: NativeEnrollmentCredential,
    transport: HouseholdDashboardTransporting = HouseholdDashboardTransport(),
    persistence: PendingDashboardDraftPersisting = PrivatePendingDashboardDraftStore()
  ) {
    self.credential = credential
    self.transport = transport
    self.persistence = persistence
    do {
      if let saved = try persistence.load() {
        if saved.clientId == credential.client.id && saved.origin == credential.origin
          && saved.certificateSha256 == credential.certificateSha256
        {
          draft = saved
          profile = saved.profile
          phase = .unknown
        } else {
          hasOrphanedPending = true
          phase = .orphanedPending
        }
      }
    } catch { phase = .privacyBlocked }
  }

  var allowedProfiles: [HouseholdProfile] {
    HouseholdProfile.allCases.filter { candidate in
      grants.contains { $0.clientId == credential.client.id && $0.profile == candidate && $0.kind == "dashboards" }
    }
  }
  var canSave: Bool {
    guard task == nil, phase == .prepared, let draft else { return false }
    return grants.contains { $0.clientId == credential.client.id && $0.profile == draft.profile && $0.kind == "dashboards" && $0.access == .write }
  }

  func checkAccess() {
    guard !hasOrphanedPending else { return }
    let priorPhase = phase
    launch(
      .loading, operation: { try await self.transport.authority(self.credential) },
      failurePhase: priorPhase == .unknown ? .unknown : nil
    ) { value in
      if let draft = self.draft,
        !value.contains(where: {
          $0.clientId == self.credential.client.id && $0.profile == draft.profile
            && $0.kind == "dashboards"
        })
      {
        self.revoke(.forbidden)
        return self.phase
      }
      self.grants = value
      self.remote = nil
      let profiles = self.allowedProfiles
      if !profiles.contains(self.profile), let first = profiles.first { self.profile = first }
      return priorPhase == .unknown ? .unknown : .ready
    }
  }
  func select(_ value: HouseholdProfile) {
    guard task == nil, phase != .privacyBlocked else { return }
    generation += 1
    profile = value
    remote = nil
  }
  func readServerCopy() {
    guard task == nil, phase != .privacyBlocked else { return }
    let selected = profile
    // A previous server copy is not evidence for this explicit read. Remove it
    // before requesting a fresh revision so a failed read cannot be imported.
    remote = nil
    launch(
      .loading,
      operation: { try await self.transport.read(selected, credential: self.credential) }
    ) { value in
      guard value.profile == self.profile else { return .idle }
      self.remote = value
      return .ready
    }
  }
  func prepare(_ value: DashboardState) {
    guard task == nil, draft == nil, phase != .privacyBlocked, !hasOrphanedPending else {
      return
    }
    do {
      let prepared = try PendingDashboardDraft(
        origin: credential.origin, certificateSha256: credential.certificateSha256,
        clientId: credential.client.id, profile: profile,
        baseRevision: remote?.profile == profile ? remote!.revision : 0, value: value
      ).validated()
      try persistence.save(prepared)
      draft = prepared
      phase = .prepared
    } catch { phase = .privacyBlocked }
  }
  func savePrepared() {
    guard canSave, let prepared = draft else { return }
    launch(
      .saving,
      operation: { try await self.transport.save(prepared, credential: self.credential) }
    ) { result in
      switch result {
      case .conflict(let revision): return .conflict(revision)
      case .saved(let value):
        try self.persistence.clear()
        self.draft = nil
        self.remote = value
        return .ready
      }
    }
  }
  func checkSaveResult() {
    guard draft != nil else { return }
    guard let prepared = draft else { return }
    launch(
      .loading,
      operation: { try await self.transport.read(prepared.profile, credential: self.credential) },
      failurePhase: .unknown
    ) { value in
      guard self.draft == prepared else { return .idle }
      self.remote = value
      let same = try DashboardModel.encode(value.value) == DashboardModel.encode(prepared.value)
      return same && value.revision > prepared.baseRevision
        ? .matchedCurrentCopy(value.revision) : .conflict(value.revision)
    }
  }
  func useCurrentRevisionForDraft() {
    guard task == nil, let old = draft, let remote, old.profile == remote.profile else { return }
    do {
      let revised = PendingDashboardDraft(
        origin: old.origin, certificateSha256: old.certificateSha256,
        clientId: old.clientId, profile: old.profile, baseRevision: remote.revision, value: old.value)
      try persistence.save(revised)
      draft = revised
      phase = .prepared
    } catch { phase = .privacyBlocked }
  }
  func discardDraft() {
    cancel()
    do { try persistence.clear(); draft = nil; phase = .idle } catch { phase = .privacyBlocked }
  }
  func discardOrphanedPending() {
    guard task == nil, hasOrphanedPending else { return }
    do {
      try persistence.clear()
      hasOrphanedPending = false
      phase = .idle
    } catch { phase = .privacyBlocked }
  }
  func retryPrivacyCleanup() {
    guard task == nil else { return }
    do {
      try persistence.clear()
      draft = nil
      hasOrphanedPending = false
      remote = nil
      grants = []
      phase = .idle
    } catch { phase = .privacyBlocked }
  }
  @discardableResult
  func enterBackground() -> Task<Void, Never>? {
    let saving = phase == .saving
    generation += 1
    let cancelled = task
    cancelled?.cancel()
    task = nil
    if saving, draft != nil { phase = .unknown }
    else if phase == .loading { phase = .idle }
    return cancelled
  }
  func leaveView() { enterBackground() }

  func cancel() { enterBackground() }

  private func launch<Value>(
    _ working: Phase,
    operation: @escaping @MainActor () async throws -> Value,
    failurePhase: Phase? = nil,
    apply: @escaping @MainActor (Value) throws -> Phase
  ) {
    guard task == nil, phase != .privacyBlocked else { return }
    generation += 1
    let expected = generation
    phase = working
    task = Task {
      defer { if expected == generation { task = nil } }
      do {
        let value = try await operation()
        if expected == generation { phase = try apply(value) }
      } catch {
        guard expected == generation else { return }
        if let failure = error as? DashboardSyncFailure,
          failure == .revoked || failure == .forbidden
        { revoke(failure) }
        else if error as? DashboardSyncFailure == .cacheUnavailable { phase = .privacyBlocked }
        else if working == .saving && error as? DashboardSyncFailure == .unknownOutcome { phase = .unknown }
        else if let failurePhase { phase = failurePhase }
        else { phase = .failed((error as? DashboardSyncFailure)?.localizedDescription ?? DashboardSyncFailure.unavailable.localizedDescription) }
      }
    }
  }
  private func revoke(_ failure: DashboardSyncFailure) {
    grants = []
    remote = nil
    draft = nil
    do { try persistence.clear(); phase = .revoked } catch { phase = .privacyBlocked }
  }
}
