import Combine
import Darwin
import Foundation

struct HouseholdChoresDocument: Equatable, Sendable {
  let revision: Int64
  let value: ChoresState
}

struct PendingChoresDraft: Codable, Equatable, Sendable {
  let version: Int
  let origin: URL
  let certificateSha256: String
  let clientId: String
  let baseRevision: Int64
  let value: ChoresState

  init(credential: NativeEnrollmentCredential, baseRevision: Int64, value: ChoresState) {
    version = 1
    origin = credential.origin
    certificateSha256 = credential.certificateSha256
    clientId = credential.client.id
    self.baseRevision = baseRevision
    self.value = value
  }

  func validated() throws -> PendingChoresDraft {
    guard version == 1, origin.scheme == "https", origin.host != nil,
      origin.path.isEmpty || origin.path == "/", origin.query == nil, origin.fragment == nil,
      certificateSha256.count == 64,
      certificateSha256.allSatisfy({ $0.isASCII && ($0.isNumber || ("a"..."f").contains(String($0))) }),
      validNativeIdentifier(clientId),
      (0...9_007_199_254_740_990).contains(baseRevision)
    else { throw ChoresSyncFailure.invalidResponse }
    _ = try ChoresModel.encode(value)
    return self
  }
}

enum ChoresSyncSaveResult: Equatable, Sendable {
  case saved(HouseholdChoresDocument)
  case conflict(Int64)
}

enum ChoresSyncFailure: Error, Equatable, LocalizedError {
  case revoked, forbidden, unavailable, invalidResponse, unknownOutcome, cacheUnavailable

  var errorDescription: String? {
    switch self {
    case .revoked: "This iPhone’s coordinator session is no longer authorized."
    case .forbidden: "Household chore access is not allowed for this iPhone."
    case .unavailable: "The coordinator could not be reached."
    case .invalidResponse: "The coordinator returned an invalid chore response."
    case .unknownOutcome: "The change outcome is unknown. Check Result; Ellie will not send it again."
    case .cacheUnavailable: "The pending chore change could not be stored or cleared privately. Shared chores are blocked."
    }
  }
}

protocol HouseholdChoresTransporting: Sendable {
  func authority(_ credential: NativeEnrollmentCredential) async throws -> [HouseholdDashboardGrant]
  func read(_ credential: NativeEnrollmentCredential) async throws -> HouseholdChoresDocument
  func save(_ draft: PendingChoresDraft, credential: NativeEnrollmentCredential) async throws
    -> ChoresSyncSaveResult
}

protocol PendingChoresDraftPersisting: Sendable {
  func load() throws -> PendingChoresDraft?
  func save(_ draft: PendingChoresDraft) throws
  func clear() throws
}

func clearPendingChoresSync(
  persistence: PendingChoresDraftPersisting = PrivatePendingChoresDraftStore(),
  action: () -> Void
) throws {
  try persistence.clear()
  action()
}

struct PrivatePendingChoresDraftStore: PendingChoresDraftPersisting, @unchecked Sendable {
  static let maximumBytes = ChoresModel.maximumSerializedBytes + 2_048
  let fileURL: URL

  init(fileURL: URL? = nil) {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    self.fileURL = fileURL ?? base.appendingPathComponent("Ellie", isDirectory: true)
      .appendingPathComponent("chores-sync-pending-v1.json")
  }

  func load() throws -> PendingChoresDraft? {
    let directory = fileURL.deletingLastPathComponent()
    if try !privateDirectory(directory, allowMissing: true) { return nil }
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT { return nil }
      throw ChoresSyncFailure.cacheUnavailable
    }
    try requirePrivateFile(info)
    let descriptor = open(fileURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw ChoresSyncFailure.cacheUnavailable }
    defer { close(descriptor) }
    var actual = stat()
    guard fstat(descriptor, &actual) == 0, actual.st_dev == info.st_dev,
      actual.st_ino == info.st_ino else { throw ChoresSyncFailure.cacheUnavailable }
    try requirePrivateFile(actual)
    guard actual.st_size >= 0, actual.st_size <= Self.maximumBytes else {
      throw ChoresSyncFailure.cacheUnavailable
    }
    var data = Data(count: Int(actual.st_size))
    let count = data.withUnsafeMutableBytes { buffer -> Int in
      guard let base = buffer.baseAddress else { return 0 }
      var offset = 0
      while offset < buffer.count {
        let amount = Darwin.read(descriptor, base.advanced(by: offset), buffer.count - offset)
        if amount <= 0 { return -1 }
        offset += amount
      }
      return offset
    }
    guard count == data.count,
      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["version", "origin", "certificateSha256", "clientId", "baseRevision", "value"],
      let draft = try? JSONDecoder().decode(PendingChoresDraft.self, from: data)
    else { throw ChoresSyncFailure.cacheUnavailable }
    return try draft.validated()
  }

  func save(_ draft: PendingChoresDraft) throws {
    let checked = try draft.validated()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(checked)
    guard data.count <= Self.maximumBytes else { throw ChoresSyncFailure.cacheUnavailable }
    let directory = fileURL.deletingLastPathComponent()
    if try !privateDirectory(directory, allowMissing: true) {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    }
    _ = try privateDirectory(directory, allowMissing: false)
    let temporary = directory.appendingPathComponent(".chores-sync-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw ChoresSyncFailure.cacheUnavailable }
    var renamed = false
    defer {
      close(descriptor)
      if !renamed { unlink(temporary.path) }
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
      throw ChoresSyncFailure.cacheUnavailable
    }
    var existing = stat()
    if lstat(fileURL.path, &existing) == 0 { try requirePrivateFile(existing) }
    else if errno != ENOENT { throw ChoresSyncFailure.cacheUnavailable }
    guard rename(temporary.path, fileURL.path) == 0 else {
      throw ChoresSyncFailure.cacheUnavailable
    }
    renamed = true
    let directoryDescriptor = open(directory.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard directoryDescriptor >= 0 else { throw ChoresSyncFailure.cacheUnavailable }
    defer { close(directoryDescriptor) }
    guard fsync(directoryDescriptor) == 0 else { throw ChoresSyncFailure.cacheUnavailable }
  }

  func clear() throws {
    let directory = fileURL.deletingLastPathComponent()
    if try !privateDirectory(directory, allowMissing: true) { return }
    let descriptor = open(directory.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw ChoresSyncFailure.cacheUnavailable }
    defer { close(descriptor) }
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT { return }
      throw ChoresSyncFailure.cacheUnavailable
    }
    try requirePrivateFile(info)
    guard unlink(fileURL.path) == 0, fsync(descriptor) == 0 else {
      throw ChoresSyncFailure.cacheUnavailable
    }
  }

  private func privateDirectory(_ url: URL, allowMissing: Bool) throws -> Bool {
    var info = stat()
    if lstat(url.path, &info) != 0 {
      if allowMissing && errno == ENOENT { return false }
      throw ChoresSyncFailure.cacheUnavailable
    }
    guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
      (info.st_mode & 0o777) == 0o700
    else { throw ChoresSyncFailure.cacheUnavailable }
    return true
  }

  private func requirePrivateFile(_ info: stat) throws {
    guard (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
      (info.st_mode & 0o777) == 0o600
    else { throw ChoresSyncFailure.cacheUnavailable }
  }
}

@MainActor
final class HouseholdChoresSyncStore: ObservableObject {
  enum Phase: Equatable {
    case idle, loading, ready, prepared, saving, conflict(Int64), unknown
    case matchedCurrentCopy(Int64), orphanedPending, failed(String), revoked, privacyBlocked
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var grants: [HouseholdDashboardGrant] = []
  @Published private(set) var remote: HouseholdChoresDocument?
  @Published private(set) var draft: PendingChoresDraft?

  private let credential: NativeEnrollmentCredential
  private let transport: HouseholdChoresTransporting
  private let persistence: PendingChoresDraftPersisting
  private var task: Task<Void, Never>?
  private var generation = 0
  private var hasOrphanedPending = false

  init(
    credential: NativeEnrollmentCredential,
    transport: HouseholdChoresTransporting = HouseholdChoresTransport(),
    persistence: PendingChoresDraftPersisting = PrivatePendingChoresDraftStore()
  ) {
    self.credential = credential
    self.transport = transport
    self.persistence = persistence
    do {
      if let saved = try persistence.load() {
        if saved.clientId == credential.client.id && saved.origin == credential.origin
          && saved.certificateSha256 == credential.certificateSha256 {
          draft = saved
          phase = .unknown
        } else {
          hasOrphanedPending = true
          phase = .orphanedPending
        }
      }
    } catch { phase = .privacyBlocked }
  }

  var canRead: Bool { grants.contains { grant in
    grant.clientId == credential.client.id && grant.profile == .shared && grant.kind == "chores"
  } }
  var canWrite: Bool { grants.contains { grant in
    grant.clientId == credential.client.id && grant.profile == .shared && grant.kind == "chores"
      && grant.access == .write
  } }
  var canSave: Bool { task == nil && phase == .prepared && draft != nil && canWrite }
  var isBusy: Bool { phase == .loading || phase == .saving }

  func checkAccess() {
    guard task == nil, !hasOrphanedPending, phase != .privacyBlocked else { return }
    let prior = phase
    grants = []
    remote = nil
    launch(.loading, operation: { try await self.transport.authority(self.credential) },
      failurePhase: prior == .unknown ? .unknown : nil) { value in
      self.grants = value
      if !self.canRead {
        self.remote = nil
        self.draft = nil
        try self.persistence.clear()
        return .revoked
      }
      if prior == .unknown { return prior }
      if case .conflict = prior { return prior }
      if case .matchedCurrentCopy = prior { return prior }
      return prior == .prepared && self.canWrite ? .prepared : .ready
    }
  }

  func readServerCopy() {
    guard canRead, draft == nil, task == nil else { return }
    remote = nil
    launch(.loading, operation: { try await self.transport.read(self.credential) }) { value in
      self.remote = value
      return .ready
    }
  }

  func prepare(_ mutation: (inout ChoresState) throws -> Void) {
    guard task == nil, draft == nil, canWrite, let remote, phase != .privacyBlocked else { return }
    do {
      var value = remote.value
      try mutation(&value)
      let pending = try PendingChoresDraft(
        credential: credential, baseRevision: remote.revision, value: value).validated()
      try persistence.save(pending)
      draft = pending
      phase = .prepared
    } catch let failure as ChoresSyncFailure where failure == .cacheUnavailable {
      phase = .privacyBlocked
    } catch { phase = .failed("That chore change could not be prepared.") }
  }

  func prepareAdd(title: String, member: String, body: String, dueDay: ChoreDay) {
    prepare { $0.chores.append(Chore(id: UUID().uuidString.lowercased(), title: title,
      member: member, body: body, dueDay: dueDay)) }
  }
  func prepareEdit(id: String, title: String, member: String, body: String, dueDay: ChoreDay) {
    prepare { value in
      guard let index = value.chores.firstIndex(where: { $0.id == id }) else {
        throw ChoresModelError.unknownChore
      }
      value.chores[index].title = title
      value.chores[index].member = member
      value.chores[index].body = body
      value.chores[index].dueDay = dueDay
    }
  }
  func prepareCompletion(id: String, completed: Bool, now: Date = Date()) {
    prepare { value in
      guard let index = value.chores.firstIndex(where: { $0.id == id }) else {
        throw ChoresModelError.unknownChore
      }
      value.chores[index].completedDay = completed
        ? ChoreDay.from(now, timeZone: TimeZone(identifier: value.householdTimeZone)!) : nil
    }
  }
  func prepareDelete(id: String) {
    prepare { value in
      guard let index = value.chores.firstIndex(where: { $0.id == id }) else {
        throw ChoresModelError.unknownChore
      }
      value.chores.remove(at: index)
    }
  }

  func savePrepared() {
    guard canSave, let prepared = draft else { return }
    launch(.saving, operation: { try await self.transport.save(prepared, credential: self.credential) }) {
      result in
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

  func checkResult() {
    guard let pending = draft, task == nil else { return }
    launch(.loading, operation: { try await self.transport.read(self.credential) },
      failurePhase: .unknown) { value in
      guard self.draft == pending else { return .idle }
      self.remote = value
      let same = try ChoresModel.encode(value.value) == ChoresModel.encode(pending.value)
      return same && value.revision > pending.baseRevision
        ? .matchedCurrentCopy(value.revision) : .conflict(value.revision)
    }
  }

  func discardPending() {
    guard task == nil else { return }
    do {
      try persistence.clear()
      draft = nil
      hasOrphanedPending = false
      remote = nil
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

  @discardableResult func enterBackground() -> Task<Void, Never>? {
    let saving = phase == .saving
    generation += 1
    let cancelled = task
    cancelled?.cancel()
    task = nil
    if saving && draft != nil { phase = .unknown }
    else if phase == .loading { phase = draft == nil ? .idle : .unknown }
    return cancelled
  }
  @discardableResult func cancelCurrentRequest() -> Task<Void, Never>? { enterBackground() }
  func leaveView() { enterBackground() }

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
        if let failure = error as? ChoresSyncFailure,
          failure == .revoked || failure == .forbidden {
          grants = []
          remote = nil
          draft = nil
          do { try persistence.clear(); phase = .revoked }
          catch { phase = .privacyBlocked }
        } else if error as? ChoresSyncFailure == .cacheUnavailable {
          phase = .privacyBlocked
        } else if working == .saving {
          phase = .unknown
        } else if let failurePhase { phase = failurePhase }
        else { phase = .failed((error as? ChoresSyncFailure)?.localizedDescription
          ?? ChoresSyncFailure.unavailable.localizedDescription) }
      }
    }
  }
}
