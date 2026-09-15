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
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    XCTAssertEqual(store.page?.items.first?.id, "opaque-1")
    store.perform(.openResult(index: 1), on: node)
    await eventually { await transport.actions.count == 3 }
    store.cancel()
    await transport.finishCommand()
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testDelayedReadCannotRepublishAfterTargetChange() async {
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
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
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
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
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
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
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
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
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport)
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

  private func credential() -> NativeEnrollmentCredential {
    let grants = [
      NativeGrant(target: "mac", capabilities: ["browser.read", "browser.control"])
    ]
    return NativeEnrollmentCredential(
      origin: URL(string: "https://127.0.0.1:8444")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: "phone", role: "native_phone_controller", label: "Phone", grants: grants,
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
  private let commandError: Bool
  private let source: BrowserPhoneSource
  private let commandStatus: BrowserPhoneCommandStatus?
  private let items: [BrowserPhoneItem]
  private var commandContinuation: CheckedContinuation<Void, Never>?
  private var readContinuation: CheckedContinuation<Void, Never>?
  init(
    delayRead: Bool = false, commandError: Bool = false,
    source: BrowserPhoneSource = .webmcp, commandStatus: BrowserPhoneCommandStatus? = nil,
    items: [BrowserPhoneItem] = [BrowserPhoneItem(id: "opaque-1", label: "First", state: nil)]
  ) {
    self.delayRead = delayRead
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
    case .status: return .status(source: source, connected: true, revision: revision)
    case .read:
      if delayRead { await withCheckedContinuation { readContinuation = $0 } }
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: source, revision: revision, title: "Page", summary: nil,
          items: items))
    default:
      if commandError { throw PhoneControlFailure.unavailable }
      if let commandStatus { return .command(source: source, status: commandStatus, revision: revision) }
      await withCheckedContinuation { commandContinuation = $0 }
      return .command(source: source, status: .completed, revision: revision)
    }
  }
  func finishCommand() { commandContinuation?.resume(); commandContinuation = nil }
  func finishRead() { readContinuation?.resume(); readContinuation = nil }
}
