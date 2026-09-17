import Combine
import CryptoKit
import Darwin
import Foundation

private enum BrowserMutationUncertaintyFailure: Error, Equatable, LocalizedError {
  case unavailable, unresolved, postCommitSyncUncertain
  var errorDescription: String? {
    switch self {
    case .unavailable:
      "Browser safety state is unavailable. Browser commands are blocked until it can be read."
    case .unresolved, .postCommitSyncUncertain:
      "A previous browser command may have run. Read the page before sending another command."
    }
  }
}

enum BrowserMutationUncertaintyClearResult: Equatable {
  case cleared, mismatch, clearedButSyncUncertain
}

/// Main-actor isolation serializes each in-app load/mutate/save sequence. This store does not
/// provide cross-process locking and is currently used only by the iPhone app process.
@MainActor
protocol BrowserMutationUncertaintyPersisting {
  func pendingToken(for scope: String) throws -> String?
  func recordIfClear(token: String, for scope: String) throws -> Bool
  func clear(token: String, for scope: String) throws -> BrowserMutationUncertaintyClearResult
}

@MainActor
struct PrivateBrowserMutationUncertaintyStore: BrowserMutationUncertaintyPersisting {
  static let maximumBytes = 8_192
  static let maximumMarkers = 64
  let fileURL: URL
  private let synchronizeDirectory: (URL) throws -> Void

  init(
    fileURL: URL? = nil,
    synchronizeDirectory: ((URL) throws -> Void)? = nil
  ) {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    self.fileURL =
      fileURL
      ?? base.appendingPathComponent("Ellie", isDirectory: true)
      .appendingPathComponent("browser-mutation-uncertainty-v1.json")
    self.synchronizeDirectory = synchronizeDirectory ?? Self.syncDirectory
  }

  func pendingToken(for scope: String) throws -> String? {
    guard Self.validScope(scope) else { throw BrowserMutationUncertaintyFailure.unavailable }
    return try load()[scope]
  }

  func recordIfClear(token: String, for scope: String) throws -> Bool {
    guard Self.validScope(scope), Self.validToken(token) else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    var markers = try load()
    guard markers[scope] == nil else { return false }
    guard markers.count < Self.maximumMarkers else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    markers[scope] = token
    do {
      try save(markers)
    } catch BrowserMutationUncertaintyFailure.postCommitSyncUncertain {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    return true
  }

  func clear(
    token: String, for scope: String
  ) throws -> BrowserMutationUncertaintyClearResult {
    guard Self.validScope(scope), Self.validToken(token) else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    var markers = try load()
    guard markers[scope] == token else { return .mismatch }
    markers.removeValue(forKey: scope)
    do {
      try save(markers)
      return .cleared
    } catch BrowserMutationUncertaintyFailure.postCommitSyncUncertain {
      return .clearedButSyncUncertain
    }
  }

  private func load() throws -> [String: String] {
    try checkExistingDirectory()
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT { return [:] }
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    try requirePrivateFile(info)
    let descriptor = open(fileURL.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw BrowserMutationUncertaintyFailure.unavailable }
    defer { close(descriptor) }
    var actual = stat()
    guard fstat(descriptor, &actual) == 0, actual.st_dev == info.st_dev,
      actual.st_ino == info.st_ino
    else { throw BrowserMutationUncertaintyFailure.unavailable }
    try requirePrivateFile(actual)
    guard actual.st_size > 0, actual.st_size <= Self.maximumBytes else {
      throw BrowserMutationUncertaintyFailure.unavailable
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
      Set(root.keys) == ["version", "markers"],
      let version = root["version"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(), version == NSNumber(value: 1),
      let markers = root["markers"] as? [String: String], markers.count <= Self.maximumMarkers,
      markers.allSatisfy({ Self.validScope($0.key) && Self.validToken($0.value) })
    else { throw BrowserMutationUncertaintyFailure.unavailable }
    return markers
  }

  private func save(_ markers: [String: String]) throws {
    guard markers.count <= Self.maximumMarkers,
      markers.allSatisfy({ Self.validScope($0.key) && Self.validToken($0.value) })
    else { throw BrowserMutationUncertaintyFailure.unavailable }
    let directory = fileURL.deletingLastPathComponent()
    try ensurePrivateDirectory(directory)
    if markers.isEmpty {
      try removeExistingFile(in: directory)
      return
    }
    let data = try JSONSerialization.data(
      withJSONObject: ["markers": markers, "version": 1], options: [.sortedKeys])
    guard data.count <= Self.maximumBytes else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    let temporary = directory.appendingPathComponent(
      ".browser-uncertainty-\(UUID().uuidString).tmp")
    let descriptor = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw BrowserMutationUncertaintyFailure.unavailable }
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
    guard wrote, fchmod(descriptor, 0o600) == 0, fsync(descriptor) == 0 else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    if FileManager.default.fileExists(atPath: fileURL.path) {
      var existing = stat()
      guard lstat(fileURL.path, &existing) == 0 else {
        throw BrowserMutationUncertaintyFailure.unavailable
      }
      try requirePrivateFile(existing)
    }
    guard rename(temporary.path, fileURL.path) == 0 else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    succeeded = true
    do {
      try synchronizeDirectory(directory)
    } catch {
      throw BrowserMutationUncertaintyFailure.postCommitSyncUncertain
    }
  }

  private func removeExistingFile(in directory: URL) throws {
    var info = stat()
    if lstat(fileURL.path, &info) != 0 {
      if errno == ENOENT {
        try synchronizeDirectory(directory)
        return
      }
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    try requirePrivateFile(info)
    guard unlink(fileURL.path) == 0 else { throw BrowserMutationUncertaintyFailure.unavailable }
    do {
      try synchronizeDirectory(directory)
    } catch {
      throw BrowserMutationUncertaintyFailure.postCommitSyncUncertain
    }
  }

  private func ensurePrivateDirectory(_ directory: URL) throws {
    var info = stat()
    if lstat(directory.path, &info) != 0 {
      guard errno == ENOENT else { throw BrowserMutationUncertaintyFailure.unavailable }
      try createMissingPrivateDirectories(endingAt: directory)
      guard lstat(directory.path, &info) == 0 else {
        throw BrowserMutationUncertaintyFailure.unavailable
      }
    }
    try requirePrivateDirectory(info)
  }

  private func createMissingPrivateDirectories(endingAt directory: URL) throws {
    var info = stat()
    if lstat(directory.path, &info) == 0 {
      guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid() else {
        throw BrowserMutationUncertaintyFailure.unavailable
      }
      return
    }
    guard errno == ENOENT else { throw BrowserMutationUncertaintyFailure.unavailable }
    let parent = directory.deletingLastPathComponent()
    guard parent.path != directory.path else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    try createMissingPrivateDirectories(endingAt: parent)
    guard mkdir(directory.path, 0o700) == 0 else {
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    do {
      guard lstat(directory.path, &info) == 0 else {
        throw BrowserMutationUncertaintyFailure.unavailable
      }
      try requirePrivateDirectory(info)
      try synchronizeDirectory(parent)
    } catch {
      _ = rmdir(directory.path)
      throw error
    }
  }

  private func checkExistingDirectory() throws {
    var info = stat()
    guard lstat(fileURL.deletingLastPathComponent().path, &info) == 0 else {
      if errno == ENOENT { return }
      throw BrowserMutationUncertaintyFailure.unavailable
    }
    try requirePrivateDirectory(info)
  }

  private static func syncDirectory(_ directory: URL) throws {
    let descriptor = open(directory.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw BrowserMutationUncertaintyFailure.unavailable }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
      info.st_uid == getuid(), fsync(descriptor) == 0
    else { throw BrowserMutationUncertaintyFailure.unavailable }
  }

  private func requirePrivateFile(_ value: stat) throws {
    guard (value.st_mode & S_IFMT) == S_IFREG, value.st_uid == getuid(), value.st_nlink == 1,
      (value.st_mode & 0o777) == 0o600
    else { throw BrowserMutationUncertaintyFailure.unavailable }
  }

  private func requirePrivateDirectory(_ value: stat) throws {
    guard (value.st_mode & S_IFMT) == S_IFDIR, value.st_uid == getuid(),
      (value.st_mode & 0o777) == 0o700
    else { throw BrowserMutationUncertaintyFailure.unavailable }
  }

  private static func validScope(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
  }

  private static func validToken(_ value: String) -> Bool {
    value.range(
      of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
      options: .regularExpression) != nil
  }
}

func browserMutationUncertaintyScope(
  credential: NativeEnrollmentCredential, targetID: String
) throws -> String {
  guard let origin = canonicalNativeOrigin(credential.origin.absoluteString),
    origin == credential.origin, validNativeIdentifier(credential.client.id),
    validNativeIdentifier(targetID),
    credential.certificateSha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
  else { throw BrowserMutationUncertaintyFailure.unavailable }
  let value = Data(
    "ellie-browser-uncertainty-v1\u{0}\(origin.absoluteString)\u{0}\(credential.certificateSha256)\u{0}\(credential.client.id)\u{0}\(targetID)"
      .utf8)
  return SHA256.hash(data: value).map { String(format: "%02x", $0) }.joined()
}

@MainActor
final class BrowserPhoneControlStore: ObservableObject {
  static let pendingCommandWarningMessage =
    "A previous browser command may have run. Its result is still unverified."

  enum Phase: Equatable {
    case idle, checking, reading, sending(String), cancelling
    case ready
    case outcome(String)
    case unknown(String)
    case failed(String)
    case revoked
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var page: BrowserPhonePage?
  @Published private(set) var hasPendingBrowserCommand = false
  @Published private(set) var pendingBrowserWarningError: String?
  private let credential: NativeEnrollmentCredential
  private let transport: BrowserPhoneControlTransporting
  private let uncertainty: BrowserMutationUncertaintyPersisting
  private let operationToken: @Sendable () -> String
  private var task: Task<Void, Never>?
  private var generation = 0
  private var dispatched = false
  private var activeTargetID: String?
  private var selectedTargetID: String?

  init(
    credential: NativeEnrollmentCredential,
    transport: BrowserPhoneControlTransporting = BrowserPhoneControlTransport(),
    uncertainty: BrowserMutationUncertaintyPersisting? = nil,
    operationToken: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
  ) {
    self.credential = credential
    self.transport = transport
    self.uncertainty = uncertainty ?? PrivateBrowserMutationUncertaintyStore()
    self.operationToken = operationToken
  }

  var isBusy: Bool { task != nil }

  var showsSeparatePendingBrowserWarning: Bool {
    guard hasPendingBrowserCommand else { return false }
    switch phase {
    case .unknown, .sending: return false
    default: break
    }
    return true
  }

  var showsPendingBrowserWarningError: Bool {
    pendingBrowserWarningError != nil && phase == .cancelling
  }

  func clearIfTargetChanged(to nodeID: String?) {
    guard selectedTargetID != nodeID else { return }
    selectedTargetID = nodeID
    page = nil
    hasPendingBrowserCommand = false
    pendingBrowserWarningError = nil
    if task != nil {
      if activeTargetID != nodeID, phase != .cancelling { invalidateActiveOperation() }
      updatePendingWarning(for: nodeID)
    } else {
      restoreUncertainty(for: nodeID)
    }
  }

  func canRefresh(on node: PhoneControlNode?) -> Bool {
    task == nil && node?.online == true && node?.capabilities.contains("browser.read") == true
  }

  func canPerform(_ intent: BrowserVoiceIntent, on node: PhoneControlNode?) -> Bool {
    guard task == nil, let node, node.online else { return false }
    if intent == .inspect || intent == .refresh {
      return node.capabilities.contains("browser.read")
    }
    guard node.capabilities.contains("browser.control"), let page, page.nodeID == node.id else {
      return false
    }
    guard Self.observedSiteAllows(intent, on: page) else { return false }
    switch intent {
    case .search(let query):
      return query == query.trimmingCharacters(in: .whitespacesAndNewlines)
        && !query.isEmpty && query.utf16.count <= 200 && query.utf8.count <= 512
        && !query.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    case .openResult(let index): return index > 0 && index <= page.items.count
    case .back: return false
    case .scroll, .play, .pause: return true
    case .inspect, .refresh: return false
    }
  }

  @discardableResult
  func refresh(on node: PhoneControlNode?) -> Bool {
    guard task == nil, let node, node.online, node.capabilities.contains("browser.read") else {
      if node != nil { phase = .failed("The selected Mac does not allow browser reading.") }
      return false
    }
    if selectedTargetID != node.id { clearIfTargetChanged(to: node.id) }
    page = nil
    phase = .checking
    launch(targetID: node.id, mayDispatch: false) {
      let scope = try browserMutationUncertaintyScope(
        credential: self.credential, targetID: node.id)
      let observedToken = try self.uncertainty.pendingToken(for: scope)
      self.hasPendingBrowserCommand = observedToken != nil
      self.pendingBrowserWarningError = nil
      let status = try await self.transport.execute(
        .refresh, nodeID: node.id, credential: self.credential)
      guard case .status(let source, true, let revision?) = status else {
        throw PhoneControlFailure.rejected
      }
      let read = try await self.transport.execute(
        .read(revision: revision), nodeID: node.id, credential: self.credential)
      guard case .page(let page) = read, page.nodeID == node.id, page.source == source,
        page.revision == revision
      else { throw PhoneControlFailure.invalidResponse }
      try Task.checkCancellation()
      if let observedToken {
        guard try self.uncertainty.clear(token: observedToken, for: scope) != .mismatch else {
          throw BrowserMutationUncertaintyFailure.unresolved
        }
      } else if try self.uncertainty.pendingToken(for: scope) != nil {
        self.hasPendingBrowserCommand = true
        throw BrowserMutationUncertaintyFailure.unresolved
      }
      self.hasPendingBrowserCommand = false
      return (.ready, page)
    }
    return true
  }

  @discardableResult
  func perform(_ intent: BrowserVoiceIntent, on node: PhoneControlNode?) -> Bool {
    guard task == nil, let node else { return false }
    if intent == .inspect || intent == .refresh { return refresh(on: node) }
    guard node.online, node.capabilities.contains("browser.control"), let page,
      page.nodeID == node.id
    else {
      phase = .failed("Read the current browser page on the selected Mac first.")
      return false
    }
    guard Self.observedSiteAllows(intent, on: page) else {
      phase = .failed("The observed page does not offer that browser command.")
      return false
    }
    let scope: String
    do {
      scope = try browserMutationUncertaintyScope(credential: credential, targetID: node.id)
      if try uncertainty.pendingToken(for: scope) != nil {
        self.page = nil
        hasPendingBrowserCommand = true
        pendingBrowserWarningError = nil
        phase = .unknown(
          "A previous browser command may have run. Read the page before sending another command.")
        return false
      }
      pendingBrowserWarningError = nil
    } catch {
      self.page = nil
      phase = .failed(BrowserMutationUncertaintyFailure.unavailable.localizedDescription)
      return false
    }
    let action: BrowserPhoneAction
    switch intent {
    case .scroll(let direction): action = .scroll(direction, revision: page.revision)
    case .search(let query):
      guard query == query.trimmingCharacters(in: .whitespacesAndNewlines),
        !query.isEmpty, query.utf16.count <= 200, query.utf8.count <= 512,
        !query.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
      else {
        phase = .failed("The search text is not valid.")
        return false
      }
      action = .search(query, revision: page.revision)
    case .openResult(let index):
      guard index > 0, index <= page.items.count else {
        phase = .failed("That result is not in the current page list.")
        return false
      }
      action = .select(page.items[index - 1].id, revision: page.revision)
    case .play, .pause: action = .playback(intent, revision: page.revision)
    case .back:
      phase = .failed("Back is not available for reviewed browser control yet.")
      return false
    case .inspect, .refresh: return false
    }
    let label = intent.displayLabel
    let token = operationToken()
    // The reviewed handles belong to the pre-command document. Hide them as soon as this
    // mutation is admitted; even a slow or lost response must not expose stale controls.
    self.page = nil
    phase = .sending(label)
    launch(targetID: node.id, mayDispatch: true) {
      guard try self.uncertainty.recordIfClear(token: token, for: scope) else {
        throw BrowserMutationUncertaintyFailure.unresolved
      }
      self.hasPendingBrowserCommand = true
      self.dispatched = true
      let response = try await self.transport.execute(
        action, nodeID: node.id, credential: self.credential)
      try Task.checkCancellation()
      guard case .command(let source, let status, let revision) = response,
        source == page.source, revision == page.revision
      else { throw PhoneControlFailure.invalidResponse }
      switch status {
      case .completed:
        guard try self.uncertainty.clear(token: token, for: scope) != .mismatch else {
          throw BrowserMutationUncertaintyFailure.unresolved
        }
        self.hasPendingBrowserCommand = false
        return (.outcome("\(label) completed."), nil)
      case .failed:
        guard try self.uncertainty.clear(token: token, for: scope) != .mismatch else {
          throw BrowserMutationUncertaintyFailure.unresolved
        }
        self.hasPendingBrowserCommand = false
        return (.failed("The browser reported that \(label.lowercased()) failed."), nil)
      case .unknown, .cancelled, .timedOut:
        return (
          .unknown(
            "The result is unknown. Read the page before sending another command."),
          nil
        )
      }
    }
    return true
  }

  func cancel() {
    guard task != nil else { return }
    page = nil
    invalidateActiveOperation()
  }

  private func invalidateActiveOperation() {
    generation += 1
    task?.cancel()
    phase = .cancelling
  }

  private func restoreUncertainty(for targetID: String?) {
    updatePendingWarning(for: targetID)
    if let pendingBrowserWarningError {
      phase = .failed(pendingBrowserWarningError)
    } else if hasPendingBrowserCommand {
      phase = .unknown(
        "A previous browser command may have run. Read the page before sending another command.")
    } else {
      phase = .idle
    }
  }

  private func updatePendingWarning(for targetID: String?) {
    guard let targetID else {
      hasPendingBrowserCommand = false
      pendingBrowserWarningError = nil
      return
    }
    do {
      let scope = try browserMutationUncertaintyScope(
        credential: credential, targetID: targetID)
      hasPendingBrowserCommand = try uncertainty.pendingToken(for: scope) != nil
      pendingBrowserWarningError = nil
    } catch {
      pendingBrowserWarningError = BrowserMutationUncertaintyFailure.unavailable.localizedDescription
    }
  }

  private func launch(
    targetID: String, mayDispatch: Bool,
    operation: @escaping @MainActor () async throws -> (Phase, BrowserPhonePage?)
  ) {
    generation += 1
    let expected = generation
    dispatched = false
    activeTargetID = targetID
    task = Task {
      defer {
        task = nil
        activeTargetID = nil
        if expected != generation {
          restoreUncertainty(for: selectedTargetID)
        }
        dispatched = false
      }
      do {
        try Task.checkCancellation()
        let result = try await operation()
        if expected == generation, activeTargetID == targetID {
          phase = result.0
          page = result.1
        }
      } catch {
        guard expected == generation else { return }
        page = nil
        if mayDispatch && dispatched {
          phase = .unknown("The result is unknown. Read the page before trying again.")
        } else if error as? BrowserMutationUncertaintyFailure == .unresolved {
          phase = .unknown(
            "A previous browser command may have run. Read the page before sending another command."
          )
        } else if error as? BrowserMutationUncertaintyFailure == .unavailable {
          phase = .failed(BrowserMutationUncertaintyFailure.unavailable.localizedDescription)
        } else if error as? PhoneControlFailure == .revoked {
          phase = .revoked
        } else if error is CancellationError || error as? PhoneControlFailure == .cancelled {
          phase = .idle
        } else {
          phase = .failed(
            (error as? PhoneControlFailure)?.localizedDescription
              ?? PhoneControlFailure.unavailable.localizedDescription)
        }
      }
    }
  }

  private static func observedSiteAllows(_ intent: BrowserVoiceIntent, on page: BrowserPhonePage)
    -> Bool
  {
    guard let site = page.site else { return true }
    guard site.page != .login, site.page != .unsupported else { return false }
    switch intent {
    case .play: return site.page == .watch && site.playback == .paused
    case .pause: return site.page == .watch && site.playback == .playing
    case .inspect, .refresh, .search, .scroll, .openResult, .back: return true
    }
  }
}
