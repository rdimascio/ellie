import Foundation
import XCTest
@testable import Ellie

@MainActor
final class DashboardSyncTests: XCTestCase {
  func testPrivatePendingDraftRoundTripsWithPrivatePermissions() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieDashboardSyncTests-\(UUID().uuidString)", isDirectory: true)
    let file = directory.appendingPathComponent("pending.json")
    defer { try? FileManager.default.removeItem(at: directory) }
    let persistence = PrivatePendingDashboardDraftStore(fileURL: file)
    let draft = PendingDashboardDraft(
      origin: credential().origin, certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 2,
      value: DashboardModel.initialState)

    try persistence.save(draft)

    XCTAssertEqual(try persistence.load(), draft)
    let directoryMode = try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
    let fileMode = try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
    XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)
    XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
    try persistence.clear()
    XCTAssertNil(try persistence.load())
  }

  func testPrivatePendingDraftRejectsSymlinkWithoutTouchingTarget() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieDashboardSyncLinkTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let target = directory.appendingPathComponent("target")
    let link = directory.appendingPathComponent("pending.json")
    try Data("sentinel".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    let persistence = PrivatePendingDashboardDraftStore(fileURL: link)

    XCTAssertThrowsError(try persistence.load())
    XCTAssertThrowsError(try persistence.clear())
    XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "sentinel")
  }

  func testNoRequestBeforeExplicitActionAndDraftPersistsBeforeSingleSave() async throws {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)
    XCTAssertEqual(transport.calls, [])

    transport.grants = [grant(.shared, .write)]
    store.checkAccess()
    await settle(store)
    store.prepare(DashboardModel.initialState)
    XCTAssertEqual(persistence.saved?.baseRevision, 0)
    transport.saveResult = .conflict(4)
    store.savePrepared()
    await settle(store)

    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
    XCTAssertEqual(store.phase, .conflict(4))
    XCTAssertNotNil(store.draft)
  }

  func testPersistenceFailureSendsNoPut() {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.failSave = true
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    store.prepare(DashboardModel.initialState)

    XCTAssertEqual(store.phase, .privacyBlocked)
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testRecoveryMatchIsQualifiedAndDoesNotClearDraftOrReplay() async {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.saved = PendingDashboardDraft(
      origin: credential().origin, certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 2,
      value: DashboardModel.initialState)
    transport.document = HouseholdDashboardDocument(
      profile: .shared, revision: 3, value: DashboardModel.initialState)
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    store.checkSaveResult()
    await settle(store)

    XCTAssertEqual(store.phase, .matchedCurrentCopy(3))
    XCTAssertNotNil(store.draft)
    XCTAssertEqual(transport.calls, ["read"])
  }

  func testForbiddenClearsSyncDataAndFailedCleanupBlocks() async {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.saved = PendingDashboardDraft(
      origin: credential().origin, certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 0,
      value: DashboardModel.initialState)
    persistence.failClear = true
    transport.readFailure = .forbidden
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    store.readServerCopy()
    await settle(store)

    XCTAssertEqual(store.phase, .privacyBlocked)
    XCTAssertNil(store.draft)
    XCTAssertNil(store.remote)
  }

  func testAnotherEnrollmentCannotRecoverPendingDraft() {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.saved = PendingDashboardDraft(
      origin: URL(string: "https://other.local:8444")!,
      certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 2,
      value: DashboardModel.initialState)

    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    XCTAssertNil(store.draft)
    XCTAssertNotNil(persistence.saved)
    XCTAssertEqual(store.phase, .orphanedPending)
    XCTAssertEqual(transport.calls, [])

    store.checkAccess()
    XCTAssertEqual(transport.calls, [])
    store.discardOrphanedPending()
    XCTAssertNil(persistence.saved)
    XCTAssertEqual(store.phase, .idle)
  }

  func testUnknownDraftCannotBeSentAgainAfterAccessRefreshOrRecoveryFailure() async {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    transport.grants = [grant(.shared, .write)]
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.prepare(DashboardModel.initialState)
    transport.saveFailure = .unknownOutcome
    store.savePrepared()
    await settle(store)
    XCTAssertEqual(store.phase, .unknown)
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)

    store.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
    transport.authorityFailure = .unavailable
    store.checkAccess()
    await settle(store)
    XCTAssertEqual(store.phase, .unknown)
    store.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)

    transport.readFailure = .invalidResponse
    store.checkSaveResult()
    await settle(store)
    XCTAssertEqual(store.phase, .unknown)
    store.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
  }

  func testRestoredUnknownDraftRemainsGetOnlyAfterAccessRefresh() async {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.saved = PendingDashboardDraft(
      origin: credential().origin, certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 2,
      value: DashboardModel.initialState)
    transport.grants = [grant(.shared, .write)]
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    store.checkAccess()
    await settle(store)

    XCTAssertEqual(store.phase, .unknown)
    store.savePrepared()
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testConfirmedGrantRemovalClearsCancelledSaveWithoutChangingLocalDashboards() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieDashboardRevocationTests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let localFile = directory.appendingPathComponent("local.json")
    let pendingFile = directory.appendingPathComponent("pending.json")
    let dashboards = DashboardStore(fileURL: localFile)
    dashboards.createDashboard(name: "Shared layout")
    guard let dashboardID = dashboards.selectedID else {
      XCTFail("The local dashboard was not created.")
      return
    }
    dashboards.renameDashboard(id: dashboardID, name: "Family layout")
    dashboards.addWidget(kind: .note)
    guard let widget = dashboards.selectedDashboard?.widgets.first else {
      XCTFail("The local widget was not created.")
      return
    }
    dashboards.updateWidget(id: widget.id, title: "Family note", size: .wide,
      config: ["text": "Keep this local edit"])
    dashboards.addWidget(kind: .clock)
    dashboards.moveWidget(id: widget.id, offset: 1)
    XCTAssertNil(dashboards.error)
    let localValue = dashboards.state

    let transport = SyncTransport()
    let saveGate = SyncReadGate()
    transport.saveGate = saveGate
    transport.saveFailure = .revoked
    transport.grants = [grant(.shared, .write)]
    let persistence = PrivatePendingDashboardDraftStore(fileURL: pendingFile)
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.prepare(localValue)
    XCTAssertEqual(try persistence.load()?.value, localValue)
    store.savePrepared()
    guard await saveGate.waitUntilStarted() else {
      let cancelled = store.enterBackground()
      await saveGate.release()
      await cancelled?.value
      XCTFail("The save did not enter the transport before the bounded deadline.")
      return
    }

    let cancelled = store.enterBackground()
    XCTAssertEqual(store.phase, .unknown)
    transport.grants = []
    store.checkAccess()
    await settle(store)
    XCTAssertEqual(store.phase, .revoked)
    XCTAssertNil(store.draft)
    XCTAssertNil(try persistence.load())

    await saveGate.release()
    await cancelled?.value
    XCTAssertEqual(store.phase, .revoked)
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
    store.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
    XCTAssertEqual(DashboardStore(fileURL: localFile).state, localValue)
    let restored = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)
    XCTAssertNil(restored.draft)
    XCTAssertEqual(restored.phase, .idle)
  }

  func testOfflineAccessKeepsUnknownDraftAndFailedConfirmedRevocationBlocksSync() async {
    let transport = SyncTransport()
    let persistence = SyncPersistence()
    persistence.saved = PendingDashboardDraft(
      origin: credential().origin, certificateSha256: credential().certificateSha256,
      clientId: "client-a", profile: .shared, baseRevision: 2,
      value: DashboardModel.initialState)
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: persistence)

    transport.authorityFailure = .unavailable
    store.checkAccess()
    await settle(store)
    XCTAssertEqual(store.phase, .unknown)
    XCTAssertNotNil(persistence.saved)

    transport.authorityFailure = nil
    transport.grants = []
    persistence.failClear = true
    store.checkAccess()
    await settle(store)
    XCTAssertEqual(store.phase, .privacyBlocked)
    XCTAssertNotNil(persistence.saved)
    store.savePrepared()
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testCleanupFailureDoesNotRunCredentialAction() {
    let persistence = SyncPersistence()
    persistence.failClear = true
    var actionCount = 0

    XCTAssertThrowsError(
      try clearPendingDashboardSync(persistence: persistence) { actionCount += 1 })
    XCTAssertEqual(actionCount, 0)
  }

  func testBackgroundRejectsLateReadWithoutReplacingServerCopy() async {
    let transport = SyncTransport()
    let readGate = SyncReadGate()
    transport.readGate = readGate
    transport.document = HouseholdDashboardDocument(
      profile: .shared, revision: 8, value: DashboardModel.initialState)
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: SyncPersistence())

    store.readServerCopy()
    let started = await readGate.waitUntilStarted()
    guard started else {
      let cancelled = store.enterBackground()
      await readGate.release()
      await cancelled?.value
      XCTFail("The read did not enter the transport before the bounded deadline.")
      return
    }
    let cancelled = store.enterBackground()
    await readGate.release()
    await cancelled?.value

    XCTAssertNil(store.remote)
    XCTAssertEqual(store.phase, .idle)
    XCTAssertEqual(transport.calls, ["read"])
  }

  func testFailedFreshReadRemovesStaleServerCopyBeforeItCanReplaceLocalDashboards() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieDashboardStaleImportTests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let localFile = directory.appendingPathComponent("local.json")
    let dashboards = DashboardStore(fileURL: localFile)
    dashboards.renameDashboard(id: "home", name: "Keep local")
    let localState = dashboards.state
    let transport = SyncTransport()
    transport.document = HouseholdDashboardDocument(
      profile: .shared, revision: 4,
      value: DashboardState(dashboards: [Dashboard(id: "remote", name: "Old server copy", widgets: [])]))
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: SyncPersistence())
    store.readServerCopy()
    await settle(store)
    XCTAssertEqual(store.remote?.revision, 4)

    transport.readFailure = .unavailable
    store.readServerCopy()
    XCTAssertNil(store.remote, "starting a fresh read must immediately withdraw the old import source")
    await settle(store)

    if let importable = store.remote {
      dashboards.importData(try DashboardModel.encode(importable.value))
    }

    XCTAssertNil(store.remote, "a failed refresh must not republish the stale server copy")
    XCTAssertEqual(store.phase, .failed(DashboardSyncFailure.unavailable.localizedDescription))
    XCTAssertEqual(dashboards.state, localState)
    XCTAssertEqual(DashboardStore(fileURL: localFile).state, localState)
    XCTAssertEqual(transport.calls, ["read", "read"])
  }

  func testCancelledOldReadCannotReplaceNewerRead() async {
    let transport = SyncTransport()
    let oldRead = SyncReadGate()
    let newerRead = SyncReadGate()
    transport.readDocuments = [
      (oldRead, HouseholdDashboardDocument(
        profile: .shared, revision: 3, value: DashboardModel.initialState)),
      (newerRead, HouseholdDashboardDocument(
        profile: .shared, revision: 9,
        value: DashboardState(dashboards: []))),
    ]
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: SyncPersistence())

    store.readServerCopy()
    let oldStarted = await oldRead.waitUntilStarted()
    guard oldStarted else {
      let cancelled = store.enterBackground()
      await oldRead.release()
      await cancelled?.value
      XCTFail("The old read did not enter the transport before the bounded deadline.")
      return
    }
    let cancelled = store.enterBackground()
    store.readServerCopy()
    let newerStarted = await newerRead.waitUntilStarted()
    guard newerStarted else {
      let newerCancelled = store.enterBackground()
      await newerRead.release()
      await oldRead.release()
      await newerCancelled?.value
      await cancelled?.value
      XCTFail("The newer read did not enter the transport before the bounded deadline.")
      return
    }
    await newerRead.release()
    let newerApplied = await waitForRemoteRevision(9, store: store)
    guard newerApplied else {
      let newerCancelled = store.enterBackground()
      await newerRead.release()
      await oldRead.release()
      await newerCancelled?.value
      await cancelled?.value
      XCTFail("The newer read did not apply before the bounded deadline.")
      return
    }
    await oldRead.release()
    await cancelled?.value

    XCTAssertEqual(store.remote?.revision, 9)
    XCTAssertEqual(store.remote?.value, DashboardState(dashboards: []))
    XCTAssertEqual(transport.calls, ["read", "read"])
  }

  private func waitForRemoteRevision(_ revision: Int64, store: DashboardSyncStore) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    while store.remote?.revision != revision && clock.now < deadline {
      try? await Task.sleep(for: .milliseconds(5))
    }
    return store.remote?.revision == revision
  }

  private func settle(_ store: DashboardSyncStore) async {
    for _ in 0..<100 where store.phase == .loading || store.phase == .saving {
      await Task.yield()
    }
    await Task.yield()
    await Task.yield()
  }
}

private final class SyncPersistence: PendingDashboardDraftPersisting, @unchecked Sendable {
  var saved: PendingDashboardDraft?
  var failSave = false
  var failClear = false
  func load() throws -> PendingDashboardDraft? { saved }
  func save(_ draft: PendingDashboardDraft) throws {
    if failSave { throw DashboardSyncFailure.cacheUnavailable }
    saved = draft
  }
  func clear() throws {
    if failClear { throw DashboardSyncFailure.cacheUnavailable }
    saved = nil
  }
}

private final class SyncTransport: HouseholdDashboardTransporting, @unchecked Sendable {
  var calls: [String] = []
  var grants: [HouseholdDashboardGrant] = []
  var document = HouseholdDashboardDocument(
    profile: .shared, revision: 0, value: DashboardState(dashboards: []))
  var saveResult: DashboardSyncSaveResult?
  var saveFailure: DashboardSyncFailure?
  var authorityFailure: DashboardSyncFailure?
  var readFailure: DashboardSyncFailure?
  var readDelayNanoseconds: UInt64 = 0
  var readDocuments: [(SyncReadGate, HouseholdDashboardDocument)] = []
  var readGate: SyncReadGate?
  var saveGate: SyncReadGate?
  func authority(_ credential: NativeEnrollmentCredential) async throws
    -> [HouseholdDashboardGrant]
  {
    calls.append("authority")
    if let authorityFailure { throw authorityFailure }
    return grants
  }
  func read(_ profile: HouseholdProfile, credential: NativeEnrollmentCredential) async throws
    -> HouseholdDashboardDocument
  {
    calls.append("read")
    if let readGate { await readGate.waitForRelease() }
    if !readDocuments.isEmpty {
      let next = readDocuments.removeFirst()
      await next.0.waitForRelease()
      return next.1
    }
    if readDelayNanoseconds > 0 { try? await Task.sleep(nanoseconds: readDelayNanoseconds) }
    if let readFailure { throw readFailure }
    return document
  }
  func save(_ draft: PendingDashboardDraft, credential: NativeEnrollmentCredential) async throws
    -> DashboardSyncSaveResult
  {
    calls.append("save")
    if let saveGate { await saveGate.waitForRelease() }
    if let saveFailure { throw saveFailure }
    return saveResult ?? .saved(document)
  }
}

private actor SyncReadGate {
  private var didStart = false
  private var isReleased = false
  private var releaseWaiter: CheckedContinuation<Void, Never>?

  func waitForRelease() async {
    didStart = true
    guard !isReleased else { return }
    await withCheckedContinuation { releaseWaiter = $0 }
  }

  func waitUntilStarted() async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    while !didStart && clock.now < deadline {
      try? await Task.sleep(for: .milliseconds(5))
    }
    return didStart
  }

  func release() {
    isReleased = true
    releaseWaiter?.resume()
    releaseWaiter = nil
  }
}

private func credential() -> NativeEnrollmentCredential {
  NativeEnrollmentCredential(
    origin: URL(string: "https://ellie.local:8444")!, certificateSha256: String(repeating: "a", count: 64),
    client: NativeClient(
      id: "client-a", role: "native_phone_controller", label: "Phone", grants: [],
      createdAt: 1, expiresAt: 7_776_000_001), token: String(repeating: "b", count: 64))
}

private func grant(_ profile: HouseholdProfile, _ access: HouseholdAccess) -> HouseholdDashboardGrant {
  HouseholdDashboardGrant(clientId: "client-a", profile: profile, kind: "dashboards", access: access)
}
