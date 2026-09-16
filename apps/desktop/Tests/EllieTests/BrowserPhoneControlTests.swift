import XCTest

@testable import Ellie

final class BrowserPhoneControlTests: XCTestCase {
  func testCanonicalStatusReadAndCommandResultsDecode() throws {
    let revision = String(repeating: "a", count: 64)
    let status = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser tab connected.","browser":{"source":"webmcp","operation":"status","status":"connected","revision":"\#(revision)","origin":"https://example.test"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(status, nodeID: "mac"),
      .status(source: .webmcp, connected: true, revision: revision))
    let read = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser view read.","browser":{"source":"webmcp","operation":"read","status":"completed","revision":"\#(revision)","view":{"title":"News","summary":"Top stories","items":[{"id":"item-1","label":"First"}]}}}}"#.utf8)
    guard case .page(let page) = try decodeBrowserPhoneResponse(read, nodeID: "mac") else {
      return XCTFail("Expected page")
    }
    XCTAssertEqual(page.items.map(\.id), ["item-1"])
    let unknown = Data(
      #"{"outcome":"unknown","result":{"ok":false,"message":"Unverified.","browser":{"source":"webmcp","operation":"command","status":"unknown","revision":"\#(revision)"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(unknown, nodeID: "mac"),
      .command(source: .webmcp, status: .unknown, revision: revision))
    XCTAssertThrowsError(
      try decodeBrowserPhoneResponse(
        Data(String(decoding: read, as: UTF8.self).replacingOccurrences(of: "item-1", with: "item 1").utf8),
        nodeID: "mac"))
    XCTAssertThrowsError(
      try decodeBrowserPhoneResponse(
        Data(String(decoding: read, as: UTF8.self).replacingOccurrences(of: #""title":"News""#, with: #""title":1"#).utf8),
        nodeID: "mac"))
  }

  func testCanonicalAccessibilityResultsDecodeWithoutWeakeningTheClosedSourceSet() throws {
    let revision = String(repeating: "b", count: 64)
    let status = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser tab connected.","browser":{"source":"accessibility","operation":"status","status":"connected","revision":"\#(revision)","origin":"https://example.test"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(status, nodeID: "mac"),
      .status(source: .accessibility, connected: true, revision: revision))
    let read = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser view read.","browser":{"source":"accessibility","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[{"id":"ax-1","label":"Play"}]}}}}"#.utf8)
    guard case .page(let page) = try decodeBrowserPhoneResponse(read, nodeID: "mac") else {
      return XCTFail("Expected accessibility page")
    }
    XCTAssertEqual(page.source, .accessibility)
    XCTAssertEqual(page.revision, revision)
    XCTAssertEqual(page.items, [BrowserPhoneItem(id: "ax-1", label: "Play", state: nil)])
    let unknown = Data(
      #"{"outcome":"unknown","result":{"ok":false,"message":"Browser action was dispatched without independent effect confirmation.","browser":{"source":"accessibility","operation":"command","status":"unknown","revision":"\#(revision)"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(unknown, nodeID: "mac"),
      .command(source: .accessibility, status: .unknown, revision: revision))

    let unsupportedSource = Data(
      String(decoding: status, as: UTF8.self)
        .replacingOccurrences(of: #""source":"accessibility""#, with: #""source":"dom""#).utf8)
    XCTAssertThrowsError(try decodeBrowserPhoneResponse(unsupportedSource, nodeID: "mac"))
  }

  @MainActor
  func testStoreBindsOpaqueSelectionToFreshNodeAndNeverReplaysCancellation() async {
    let transport = BrowserPhoneFakeTransport()
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: persistence)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    let refreshActions = await transport.actions
    XCTAssertEqual(
      Array(refreshActions.prefix(2)),
      [.refresh, .read(revision: String(repeating: "a", count: 64))])
    XCTAssertEqual(store.page?.items.first?.id, "opaque-1")
    store.perform(.openResult(index: 1), on: node)
    await eventually { await transport.actions.count == 3 }
    store.cancel()
    await transport.finishCommand()
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let scope = try? browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertNotNil(scope.flatMap { persistence.pendingTokenValue(for: $0) })
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testDelayedReadCannotRepublishAfterTargetChange() async {
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { await transport.actions.count == 2 }
    store.clearIfTargetChanged(to: "other-mac")
    await transport.finishRead()
    await eventually { store.phase == .idle }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 2)
  }

  @MainActor
  func testPostDispatchTransportFailureIsUnknownAndInvalidatesPage() async {
    let transport = BrowserPhoneFakeTransport(commandError: true)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    store.perform(.scroll(.down), on: node)
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testReviewedSearchSelectionAndPlaybackRequireExplicitReadsWithoutReplay() async {
    let transport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let search = BrowserVoiceIntent.search(query: "public video")

    XCTAssertFalse(store.canPerform(search, on: node))
    XCTAssertFalse(store.perform(search, on: node))
    let initialActionCount = await transport.actions.count
    XCTAssertEqual(initialActionCount, 0)

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.canPerform(search, on: node))
    XCTAssertTrue(store.perform(search, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let searchActionCount = await transport.actions.count
    XCTAssertEqual(searchActionCount, 3)

    XCTAssertFalse(store.perform(.openResult(index: 1), on: node))
    let rejectedSelectionActionCount = await transport.actions.count
    XCTAssertEqual(rejectedSelectionActionCount, 3)
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.openResult(index: 1), on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertFalse(store.canPerform(.play, on: node))

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.play, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertFalse(store.canPerform(.pause, on: node))

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.pause, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }

    let actions = await transport.actions
    XCTAssertEqual(actions.count, 12)
    XCTAssertEqual(
      actions.filter {
        switch $0 {
        case .search, .select, .playback: return true
        default: return false
        }
      }.count, 4)
  }

  @MainActor
  func testEmptyObservedResultListRejectsSelectionWithoutCrashingOrDispatching() async {
    let transport = BrowserPhoneFakeTransport(items: [])
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertFalse(store.canPerform(.openResult(index: 1), on: node))
    XCTAssertFalse(store.perform(.openResult(index: 1), on: node))
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 2)
  }

  @MainActor
  func testAccessibilityPagePreservesSourceAndUnknownCommandInvalidatesIt() async {
    let transport = BrowserPhoneFakeTransport(source: .accessibility, commandStatus: .unknown)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    XCTAssertEqual(store.page?.source, .accessibility)
    store.perform(.scroll(.down), on: node)
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testUncertaintySurvivesStoreRecreationAndVerifiedReadResolvesOnlyObservedMarker()
    async throws
  {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let firstTransport = BrowserPhoneFakeTransport()
    let first = BrowserPhoneControlStore(
      credential: credential(), transport: firstTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000001" })
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    first.clearIfTargetChanged(to: node.id)
    XCTAssertTrue(first.refresh(on: node))
    await eventually { first.phase == .ready }
    XCTAssertTrue(first.perform(.openResult(index: 1), on: node))
    await eventually { await firstTransport.actions.count == 3 }

    let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000001")

    let secondTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let second = BrowserPhoneControlStore(
      credential: credential(), transport: secondTransport, uncertainty: persistence)
    XCTAssertEqual(second.phase, .idle)
    second.clearIfTargetChanged(to: node.id)
    guard case .unknown = second.phase else { return XCTFail("Expected restored uncertainty") }
    XCTAssertNil(second.page)
    XCTAssertFalse(second.canPerform(.play, on: node))
    let secondInitialActions = await secondTransport.actions.count
    XCTAssertEqual(secondInitialActions, 0)

    XCTAssertTrue(second.refresh(on: node))
    await eventually { second.phase == .ready }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
    let secondReadActions = await secondTransport.actions.count
    XCTAssertEqual(secondReadActions, 2)

    await firstTransport.finishCommand()
    await eventually { if case .unknown = first.phase { true } else { false } }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
    let firstActions = await firstTransport.actions.count
    XCTAssertEqual(firstActions, 3)
  }

  @MainActor
  func testUncertaintyIsScopedToEnrollmentAndTargetAndFailedReadRetainsIt() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let firstCredential = credential()
    let markedScope = try browserMutationUncertaintyScope(
      credential: firstCredential, targetID: "mac-a")
    XCTAssertTrue(
      try persistence.recordIfClear(
        token: "00000000-0000-4000-8000-000000000002", for: markedScope))

    let otherTargetTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let otherTarget = BrowserPhoneControlStore(
      credential: firstCredential, transport: otherTargetTransport, uncertainty: persistence)
    let nodeB = PhoneControlNode(
      id: "mac-b", label: "Other", online: true,
      capabilities: ["browser.read", "browser.control"])
    otherTarget.clearIfTargetChanged(to: nodeB.id)
    XCTAssertEqual(otherTarget.phase, .idle)
    XCTAssertTrue(otherTarget.refresh(on: nodeB))
    await eventually { otherTarget.phase == .ready }
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let otherCredential = credential(clientID: "other-phone")
    let otherEnrollment = BrowserPhoneControlStore(
      credential: otherCredential,
      transport: BrowserPhoneFakeTransport(commandStatus: .completed), uncertainty: persistence)
    otherEnrollment.clearIfTargetChanged(to: "mac-a")
    XCTAssertEqual(otherEnrollment.phase, .idle)
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let otherOrigin = BrowserPhoneControlStore(
      credential: credential(origin: "https://127.0.0.1:9444"),
      transport: BrowserPhoneFakeTransport(commandStatus: .completed), uncertainty: persistence)
    otherOrigin.clearIfTargetChanged(to: "mac-a")
    XCTAssertEqual(otherOrigin.phase, .idle)
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let failingTransport = BrowserPhoneFakeTransport(readError: true)
    let restored = BrowserPhoneControlStore(
      credential: firstCredential, transport: failingTransport, uncertainty: persistence)
    let nodeA = PhoneControlNode(
      id: "mac-a", label: "Marked", online: true,
      capabilities: ["browser.read", "browser.control"])
    restored.clearIfTargetChanged(to: nodeA.id)
    guard case .unknown = restored.phase else { return XCTFail("Expected target warning") }
    restored.clearIfTargetChanged(to: nodeA.id)
    guard case .unknown = restored.phase else { return XCTFail("Warning was reset") }
    XCTAssertTrue(restored.refresh(on: nodeA))
    await eventually { if case .failed = restored.phase { true } else { false } }
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))
    XCTAssertNil(restored.page)
  }

  @MainActor
  func testPersistenceFailuresBlockDispatchAndUnknownOutcomesRetainMarker() async throws {
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])

    let unreadable = BrowserPhoneFakeUncertaintyStore()
    unreadable.failReads = true
    let blockedTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let blocked = BrowserPhoneControlStore(
      credential: credential(), transport: blockedTransport, uncertainty: unreadable)
    blocked.clearIfTargetChanged(to: node.id)
    guard case .failed = blocked.phase else { return XCTFail("Expected storage failure") }
    let blockedActions = await blockedTransport.actions.count
    XCTAssertEqual(blockedActions, 0)

    let unwritable = BrowserPhoneFakeUncertaintyStore()
    let writeTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let writeBlocked = BrowserPhoneControlStore(
      credential: credential(), transport: writeTransport, uncertainty: unwritable)
    XCTAssertTrue(writeBlocked.refresh(on: node))
    await eventually { writeBlocked.phase == .ready }
    unwritable.failRecords = true
    XCTAssertTrue(writeBlocked.perform(.scroll(.down), on: node))
    await eventually { if case .failed = writeBlocked.phase { true } else { false } }
    let writeActions = await writeTransport.actions.count
    XCTAssertEqual(writeActions, 2)

    for (status, commandError) in [
      (BrowserPhoneCommandStatus.unknown, false), (.cancelled, false), (.timedOut, false),
      (.completed, true),
    ] {
      let persistence = BrowserPhoneFakeUncertaintyStore()
      let transport = BrowserPhoneFakeTransport(
        commandError: commandError, commandStatus: status)
      let store = BrowserPhoneControlStore(
        credential: credential(), transport: transport, uncertainty: persistence)
      XCTAssertTrue(store.refresh(on: node))
      await eventually { store.phase == .ready }
      XCTAssertTrue(store.perform(.scroll(.down), on: node))
      await eventually { if case .unknown = store.phase { true } else { false } }
      let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
      XCTAssertNotNil(persistence.pendingTokenValue(for: scope))
      XCTAssertNil(store.page)
      let actions = await transport.actions.count
      XCTAssertEqual(actions, 3)
    }

    let uncleared = BrowserPhoneFakeUncertaintyStore()
    let definitiveTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let definitive = BrowserPhoneControlStore(
      credential: credential(), transport: definitiveTransport, uncertainty: uncleared)
    XCTAssertTrue(definitive.refresh(on: node))
    await eventually { definitive.phase == .ready }
    uncleared.failClears = true
    XCTAssertTrue(definitive.perform(.scroll(.down), on: node))
    await eventually { if case .unknown = definitive.phase { true } else { false } }
    let definitiveScope = try browserMutationUncertaintyScope(
      credential: credential(), targetID: node.id)
    XCTAssertNotNil(uncleared.pendingTokenValue(for: definitiveScope))
  }

  @MainActor
  func testLateCompletionCannotClearAReplacementOperationToken() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let firstTransport = BrowserPhoneFakeTransport()
    let first = BrowserPhoneControlStore(
      credential: credential(), transport: firstTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000003" })
    XCTAssertTrue(first.refresh(on: node))
    await eventually { first.phase == .ready }
    XCTAssertTrue(first.perform(.scroll(.down), on: node))
    await eventually { await firstTransport.actions.count == 3 }

    let secondTransport = BrowserPhoneFakeTransport()
    let second = BrowserPhoneControlStore(
      credential: credential(), transport: secondTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000004" })
    second.clearIfTargetChanged(to: node.id)
    guard case .unknown = second.phase else { return XCTFail("Expected first marker") }
    XCTAssertTrue(second.refresh(on: node))
    await eventually { second.phase == .ready }
    XCTAssertTrue(second.perform(.scroll(.down), on: node))
    await eventually { await secondTransport.actions.count == 3 }
    let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000004")

    await firstTransport.finishCommand()
    await eventually { if case .unknown = first.phase { true } else { false } }
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000004")
    await secondTransport.finishCommand()
    await eventually { if case .outcome = second.phase { true } else { false } }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
  }

  func testPrivateUncertaintyFileIsStrictScopedAndCompareAndClear() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-browser-uncertainty-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("markers.json")
    let first = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    let second = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    let scope = String(repeating: "a", count: 64)
    let token = "00000000-0000-4000-8000-000000000005"
    XCTAssertTrue(try first.recordIfClear(token: token, for: scope))
    XCTAssertEqual(try second.pendingToken(for: scope), token)
    XCTAssertFalse(
      try second.clear(
        token: "00000000-0000-4000-8000-000000000006", for: scope))
    XCTAssertEqual(try first.pendingToken(for: scope), token)
    XCTAssertTrue(try second.clear(token: token, for: scope))
    XCTAssertNil(try first.pendingToken(for: scope))

    try Data(#"{"version":1,"markers":{"bad":"value"}}"#.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    XCTAssertThrowsError(try first.pendingToken(for: scope))
  }

  private func credential(
    clientID: String = "phone", origin: String = "https://127.0.0.1:8444"
  ) -> NativeEnrollmentCredential {
    let grants = [
      NativeGrant(target: "mac", capabilities: ["browser.read", "browser.control"])
    ]
    return NativeEnrollmentCredential(
      origin: URL(string: origin)!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: clientID, role: "native_phone_controller", label: "Phone", grants: grants,
        createdAt: 1, expiresAt: 2), token: String(repeating: "c", count: 64))
  }

  @MainActor private func eventually(_ condition: @escaping @MainActor () async -> Bool) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out")
  }
}

private actor BrowserPhoneFakeTransport: BrowserPhoneControlTransporting {
  var actions: [BrowserPhoneAction] = []
  private let delayRead: Bool
  private let readError: Bool
  private let commandError: Bool
  private let source: BrowserPhoneSource
  private let commandStatus: BrowserPhoneCommandStatus?
  private let items: [BrowserPhoneItem]
  private var commandContinuation: CheckedContinuation<Void, Never>?
  private var readContinuation: CheckedContinuation<Void, Never>?
  init(
    delayRead: Bool = false, readError: Bool = false, commandError: Bool = false,
    source: BrowserPhoneSource = .webmcp, commandStatus: BrowserPhoneCommandStatus? = nil,
    items: [BrowserPhoneItem] = [BrowserPhoneItem(id: "opaque-1", label: "First", state: nil)]
  ) {
    self.delayRead = delayRead
    self.readError = readError
    self.commandError = commandError
    self.source = source
    self.commandStatus = commandStatus
    self.items = items
  }
  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    actions.append(action)
    let revision = String(repeating: "a", count: 64)
    switch action {
    case .status, .refresh: return .status(source: source, connected: true, revision: revision)
    case .read:
      if delayRead { await withCheckedContinuation { readContinuation = $0 } }
      if readError { throw PhoneControlFailure.unavailable }
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: source, revision: revision, title: "Page", summary: nil,
          items: items))
    default:
      if commandError { throw PhoneControlFailure.unavailable }
      if let commandStatus {
        return .command(source: source, status: commandStatus, revision: revision)
      }
      await withCheckedContinuation { commandContinuation = $0 }
      return .command(source: source, status: .completed, revision: revision)
    }
  }
  func finishCommand() {
    commandContinuation?.resume()
    commandContinuation = nil
  }
  func finishRead() {
    readContinuation?.resume()
    readContinuation = nil
  }
}

private final class BrowserPhoneFakeUncertaintyStore: BrowserMutationUncertaintyPersisting,
  @unchecked Sendable
{
  private let lock = NSLock()
  private var markers: [String: String] = [:]
  var failReads = false
  var failRecords = false
  var failClears = false

  func pendingToken(for scope: String) throws -> String? {
    lock.lock()
    defer { lock.unlock() }
    if failReads { throw FixtureUncertaintyError.unavailable }
    return markers[scope]
  }

  func recordIfClear(token: String, for scope: String) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if failRecords { throw FixtureUncertaintyError.unavailable }
    guard markers[scope] == nil else { return false }
    markers[scope] = token
    return true
  }

  func clear(token: String, for scope: String) throws -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if failClears { throw FixtureUncertaintyError.unavailable }
    guard markers[scope] == token else { return false }
    markers.removeValue(forKey: scope)
    return true
  }

  func pendingTokenValue(for scope: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return markers[scope]
  }
}

private enum FixtureUncertaintyError: Error { case unavailable }
