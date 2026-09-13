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
    transport.readDelayNanoseconds = 20_000_000
    transport.document = HouseholdDashboardDocument(
      profile: .shared, revision: 8, value: DashboardModel.initialState)
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: SyncPersistence())

    store.readServerCopy()
    await waitUntil { transport.calls == ["read"] }
    store.enterBackground()
    try? await Task.sleep(nanoseconds: 40_000_000)

    XCTAssertNil(store.remote)
    XCTAssertEqual(store.phase, .idle)
    XCTAssertEqual(transport.calls, ["read"])
  }

  func testCancelledOldReadCannotReplaceNewerRead() async {
    let transport = SyncTransport()
    transport.readDocuments = [
      (40_000_000, HouseholdDashboardDocument(
        profile: .shared, revision: 3, value: DashboardModel.initialState)),
      (0, HouseholdDashboardDocument(
        profile: .shared, revision: 9,
        value: DashboardState(dashboards: []))),
    ]
    let store = DashboardSyncStore(
      credential: credential(), transport: transport, persistence: SyncPersistence())

    store.readServerCopy()
    await Task.yield()
    store.enterBackground()
    store.readServerCopy()
    await settle(store)
    try? await Task.sleep(nanoseconds: 60_000_000)

    XCTAssertEqual(store.remote?.revision, 9)
    XCTAssertEqual(store.remote?.value, DashboardState(dashboards: []))
  }

  private func settle(_ store: DashboardSyncStore) async {
    for _ in 0..<100 where store.phase == .loading || store.phase == .saving {
      await Task.yield()
    }
    await Task.yield()
    await Task.yield()
  }

  private func waitUntil(_ condition: @escaping () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
      if condition() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
    XCTFail("Timed out waiting for the synthetic dashboard request")
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
  var readDocuments: [(UInt64, HouseholdDashboardDocument)] = []
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
    if !readDocuments.isEmpty {
      let next = readDocuments.removeFirst()
      if next.0 > 0 { try? await Task.sleep(nanoseconds: next.0) }
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
    if let saveFailure { throw saveFailure }
    return saveResult ?? .saved(document)
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
