import Foundation
import XCTest
@testable import Ellie

@MainActor
final class HouseholdChoresSyncTests: XCTestCase {
  func testExplicitGrantReadPrepareAndSingleConditionalSave() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    XCTAssertEqual(transport.calls, [])
    store.readServerCopy()
    XCTAssertEqual(transport.calls, [])

    transport.grants = [choreGrant(.write)]
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    let due = try ChoreDay("2026-09-18")
    store.prepareAdd(title: "Take bins out", member: "Alex", body: "", dueDay: due)
    XCTAssertEqual(store.phase, .prepared)
    XCTAssertEqual(persistence.saved?.baseRevision, 0)
    XCTAssertEqual(transport.calls, ["authority", "read"])
    let prepared = try XCTUnwrap(store.draft)
    transport.saveResult = .saved(HouseholdChoresDocument(revision: 1, value: prepared.value))
    store.savePrepared()
    await settle(store)

    XCTAssertEqual(transport.calls, ["authority", "read", "save"])
    XCTAssertEqual(transport.saved?.baseRevision, 0)
    XCTAssertEqual(store.remote?.revision, 1)
    XCTAssertNil(persistence.saved)
    XCTAssertNil(store.draft)
  }

  func testReadGrantCannotPrepareOrSend() async throws {
    let transport = ChoresFixtureTransport()
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: ChoresFixturePersistence())
    transport.grants = [choreGrant(.read)]
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "No write", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    store.savePrepared()
    XCTAssertNil(store.draft)
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testFailedAccessRefreshCannotReuseStaleGrantOrServerCopy() async throws {
    let transport = ChoresFixtureTransport()
    transport.grants = [choreGrant(.write)]
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: ChoresFixturePersistence())
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    XCTAssertTrue(store.canWrite)
    XCTAssertNotNil(store.remote)
    transport.authorityFailure = .unavailable
    store.checkAccess()
    await settle(store)
    XCTAssertFalse(store.canWrite)
    XCTAssertNil(store.remote)
    store.prepareAdd(title: "No stale grant", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    XCTAssertNil(store.draft)
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testUnknownWriteRestoresAsReadOnlyAcrossRelaunch() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    transport.grants = [choreGrant(.write)]
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "Dishwasher", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    transport.saveFailure = .unknownOutcome
    store.savePrepared()
    await settle(store)
    XCTAssertEqual(store.phase, .unknown)
    XCTAssertNotNil(persistence.saved)

    let restored = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    XCTAssertEqual(restored.phase, .unknown)
    restored.savePrepared()
    restored.checkAccess()
    await settle(restored)
    restored.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
    transport.readFailure = .unavailable
    restored.checkResult()
    await settle(restored)
    XCTAssertEqual(restored.phase, .unknown)
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
  }

  func testPreparingCannotDispatchWhenPrivateMarkerCannotBeSaved() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    persistence.failSave = true
    transport.grants = [choreGrant(.write)]
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "Dishwasher", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    XCTAssertEqual(store.phase, .privacyBlocked)
    store.savePrepared()
    XCTAssertFalse(transport.calls.contains("save"))
  }

  func testDeniedWriteClearsConnectedCopyAndPendingMarker() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    transport.grants = [choreGrant(.write)]
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "Dishwasher", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    transport.saveFailure = .forbidden
    store.savePrepared()
    await settle(store)
    XCTAssertEqual(store.phase, .revoked)
    XCTAssertNil(store.remote)
    XCTAssertNil(store.draft)
    XCTAssertNil(persistence.saved)
    XCTAssertFalse(store.canWrite)
  }

  func testConflictAndReadOnlyResultRequireExplicitDiscardAndFreshRead() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    transport.grants = [choreGrant(.write)]
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "Vacuum", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    transport.saveResult = .conflict(2)
    store.savePrepared()
    await settle(store)
    XCTAssertEqual(store.phase, .conflict(2))
    XCTAssertNotNil(store.draft)
    store.savePrepared()
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)

    transport.document = HouseholdChoresDocument(revision: 2, value: choreState())
    store.checkResult()
    await settle(store)
    XCTAssertEqual(store.phase, .conflict(2))
    store.discardPending()
    XCTAssertNil(store.remote)
    XCTAssertNil(store.draft)
    store.prepareAdd(title: "No stale base", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    XCTAssertNil(store.draft)
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
  }

  func testCancellationWhileSavePendingRetainsMarkerAndIgnoresLateSuccess() async throws {
    let transport = ChoresFixtureTransport()
    let persistence = ChoresFixturePersistence()
    let gate = ChoresSaveGate()
    transport.grants = [choreGrant(.write)]
    transport.saveGate = gate
    let store = HouseholdChoresSyncStore(
      credential: choreCredential(), transport: transport, persistence: persistence)
    store.checkAccess()
    await settle(store)
    store.readServerCopy()
    await settle(store)
    store.prepareAdd(title: "Laundry", member: "Alex", body: "", dueDay: try ChoreDay("2026-09-18"))
    transport.saveResult = .saved(HouseholdChoresDocument(revision: 1, value: try XCTUnwrap(store.draft).value))
    store.savePrepared()
    let started = await gate.waitUntilStarted()
    XCTAssertTrue(started)
    let cancelled = store.enterBackground()
    XCTAssertEqual(store.phase, .unknown)
    await gate.release()
    await cancelled?.value
    XCTAssertEqual(store.phase, .unknown)
    XCTAssertNotNil(persistence.saved)
    XCTAssertEqual(transport.calls.filter { $0 == "save" }.count, 1)
  }

  func testPendingFileRoundTripAndSymlinkPreservation() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieChoreSync-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("pending.json")
    let persistence = PrivatePendingChoresDraftStore(fileURL: file)
    let pending = PendingChoresDraft(
      credential: choreCredential(), baseRevision: 4, value: choreState())
    try persistence.save(pending)
    XCTAssertEqual(try persistence.load(), pending)
    let directoryMode = try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
    let fileMode = try XCTUnwrap(
      FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)
    XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)
    XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
    try persistence.clear()
    XCTAssertNil(try persistence.load())

    let target = directory.appendingPathComponent("target")
    try Data("sentinel".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(at: file, withDestinationURL: target)
    XCTAssertThrowsError(try persistence.load())
    XCTAssertThrowsError(try persistence.clear())
    XCTAssertEqual(try String(contentsOf: target, encoding: .utf8), "sentinel")
  }

  func testDifferentEnrollmentCannotReadOrSendPriorPendingChange() throws {
    let persistence = ChoresFixturePersistence()
    persistence.saved = PendingChoresDraft(
      credential: choreCredential(), baseRevision: 3, value: choreState())
    let different = NativeEnrollmentCredential(
      origin: URL(string: "https://other.local:8444")!,
      certificateSha256: String(repeating: "c", count: 64),
      client: NativeClient(id: "client-b", role: "native_phone_controller", label: "Other",
        grants: [], createdAt: 1, expiresAt: 7_776_000_001),
      token: String(repeating: "d", count: 64))
    let transport = ChoresFixtureTransport()
    let store = HouseholdChoresSyncStore(
      credential: different, transport: transport, persistence: persistence)
    XCTAssertEqual(store.phase, .orphanedPending)
    XCTAssertNil(store.draft)
    store.checkAccess()
    store.savePrepared()
    XCTAssertEqual(transport.calls, [])
    XCTAssertNotNil(persistence.saved)
  }

  func testFailedPendingCleanupBlocksCredentialAction() {
    let persistence = ChoresFixturePersistence()
    persistence.failClear = true
    var actions = 0
    XCTAssertThrowsError(try clearPendingChoresSync(persistence: persistence) { actions += 1 })
    XCTAssertEqual(actions, 0)
  }

  private func settle(_ store: HouseholdChoresSyncStore) async {
    for _ in 0..<100 where store.isBusy { await Task.yield() }
    await Task.yield()
    await Task.yield()
  }
}

private final class ChoresFixturePersistence: PendingChoresDraftPersisting, @unchecked Sendable {
  var saved: PendingChoresDraft?
  var failSave = false
  var failClear = false
  func load() throws -> PendingChoresDraft? { saved }
  func save(_ draft: PendingChoresDraft) throws {
    if failSave { throw ChoresSyncFailure.cacheUnavailable }
    saved = draft
  }
  func clear() throws {
    if failClear { throw ChoresSyncFailure.cacheUnavailable }
    saved = nil
  }
}

private final class ChoresFixtureTransport: HouseholdChoresTransporting, @unchecked Sendable {
  var calls: [String] = []
  var grants: [HouseholdDashboardGrant] = []
  var document = HouseholdChoresDocument(revision: 0, value: choreState())
  var saveResult: ChoresSyncSaveResult?
  var saveFailure: ChoresSyncFailure?
  var readFailure: ChoresSyncFailure?
  var authorityFailure: ChoresSyncFailure?
  var saveGate: ChoresSaveGate?
  var saved: PendingChoresDraft?
  func authority(_ credential: NativeEnrollmentCredential) async throws -> [HouseholdDashboardGrant] {
    calls.append("authority")
    if let authorityFailure { throw authorityFailure }
    return grants
  }
  func read(_ credential: NativeEnrollmentCredential) async throws -> HouseholdChoresDocument {
    calls.append("read")
    if let readFailure { throw readFailure }
    return document
  }
  func save(_ draft: PendingChoresDraft, credential: NativeEnrollmentCredential) async throws
    -> ChoresSyncSaveResult {
    calls.append("save")
    saved = draft
    if let saveGate { await saveGate.waitForRelease() }
    if let saveFailure { throw saveFailure }
    return saveResult ?? .conflict(draft.baseRevision + 1)
  }
}

private actor ChoresSaveGate {
  private var started = false
  private var released = false
  private var waiter: CheckedContinuation<Void, Never>?
  func waitForRelease() async {
    started = true
    guard !released else { return }
    await withCheckedContinuation { waiter = $0 }
  }
  func waitUntilStarted() async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .seconds(2))
    while !started && clock.now < deadline { try? await Task.sleep(for: .milliseconds(5)) }
    return started
  }
  func release() {
    released = true
    waiter?.resume()
    waiter = nil
  }
}

private func choreCredential() -> NativeEnrollmentCredential {
  NativeEnrollmentCredential(
    origin: URL(string: "https://ellie.local:8444")!,
    certificateSha256: String(repeating: "a", count: 64),
    client: NativeClient(
      id: "client-a", role: "native_phone_controller", label: "Phone", grants: [],
      createdAt: 1, expiresAt: 7_776_000_001), token: String(repeating: "b", count: 64))
}

private func choreGrant(_ access: HouseholdAccess) -> HouseholdDashboardGrant {
  HouseholdDashboardGrant(clientId: "client-a", profile: .shared, kind: "chores", access: access)
}

private func choreState() -> ChoresState {
  ChoresState(householdTimeZone: "UTC", chores: [])
}
