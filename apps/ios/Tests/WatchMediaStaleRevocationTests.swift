import XCTest

@testable import Ellie

final class WatchMediaStaleRevocationTests: XCTestCase {
  @MainActor
  func testOldRevocationCannotDisableNewTargetOrReplayPlayback() async {
    let firstNode = node(id: "mac-a", label: "Studio A")
    let secondNode = node(id: "mac-b", label: "Studio B")
    let inventory = WatchStaleInventory(node: firstNode)
    let browser = WatchStaleBrowserTransport()
    let controller = WatchMediaPhoneController(
      inventory: inventory, browserTransport: browser,
      makeBrowser: { credential in
        BrowserPhoneControlStore(
          credential: credential, transport: browser, uncertainty: WatchStaleUncertainty())
      })

    XCTAssertTrue(controller.enable(credential: credential(target: firstNode.id), node: firstNode))
    let firstRead = await controller.handle(WatchMediaRequest.make(.read))
    guard let firstPage = firstRead.observation else { return XCTFail("Missing first observation") }

    await inventory.holdNextRequest()
    let oldPlay = WatchMediaRequest.make(
      .play, target: firstPage.target, epoch: firstPage.epoch, revision: firstPage.revision)
    let pending = Task { await controller.handle(oldPlay) }
    guard await eventually({ await inventory.hasHeldRequest() }) else {
      pending.cancel()
      return XCTFail("Expected held Watch inventory request")
    }

    await inventory.replace(secondNode)
    XCTAssertTrue(
      controller.enable(credential: credential(target: secondNode.id), node: secondNode))
    await inventory.releaseHeldRequestAsRevoked()

    let oldReply = await pending.value
    XCTAssertEqual(oldReply.state, .stale)
    XCTAssertEqual(controller.enabledTargetID, secondNode.id,
                   "A late failure from an old activation must not disable the new target")
    let countAfterOldReply = await browser.playCount
    XCTAssertEqual(countAfterOldReply, 0)

    let secondRead = await controller.handle(WatchMediaRequest.make(.read))
    XCTAssertEqual(secondRead.state, .observed)
    XCTAssertEqual(secondRead.observation?.target, secondNode.id)

    let replay = await controller.handle(oldPlay)
    XCTAssertEqual(replay.state, .stale)
    let finalCount = await browser.playCount
    XCTAssertEqual(finalCount, 0,
                   "The old playback request must not dispatch after a fresh target read")
  }

  private func node(id: String, label: String) -> PhoneControlNode {
    PhoneControlNode(
      id: id, label: label, online: true,
      capabilities: ["browser.read", "browser.control"])
  }

  private func credential(target: String) -> NativeEnrollmentCredential {
    NativeEnrollmentCredential(
      origin: URL(string: "https://example.test")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: "phone", role: "phone", label: "iPhone",
        grants: [NativeGrant(
          target: target, capabilities: ["browser.read", "browser.control"])],
        createdAt: 1, expiresAt: WatchMediaWire.now() + 60_000),
      token: String(repeating: target == "mac-a" ? "b" : "c", count: 64))
  }

  private func eventually(_ check: @escaping () async -> Bool) async -> Bool {
    for _ in 0..<100 {
      if await check() { return true }
      try? await Task.sleep(for: .milliseconds(20))
    }
    return false
  }
}

private actor WatchStaleInventory: PhoneControlTransporting {
  private var node: PhoneControlNode
  private var shouldHold = false
  private var held: CheckedContinuation<[PhoneControlNode], Error>?

  init(node: PhoneControlNode) { self.node = node }

  func replace(_ value: PhoneControlNode) { node = value }
  func holdNextRequest() { shouldHold = true }
  func hasHeldRequest() -> Bool { held != nil }
  func releaseHeldRequestAsRevoked() {
    held?.resume(throwing: PhoneControlFailure.revoked)
    held = nil
  }

  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    if shouldHold {
      shouldHold = false
      return try await withCheckedThrowingContinuation { held = $0 }
    }
    return [node]
  }

  func open(
    _ app: PhoneControlApp, on nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> PhoneCommandOutcome {
    .unknown
  }
}

private actor WatchStaleBrowserTransport: BrowserPhoneControlTransporting {
  private(set) var playCount = 0

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    switch action {
    case .refresh:
      return .status(source: .accessibility, connected: true, revision: "rev")
    case .read:
      return .page(BrowserPhonePage(
        nodeID: nodeID, source: .accessibility, revision: "rev", title: "Observed film",
        summary: nil, items: [],
        site: BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 1)))
    case .playback(.play, _):
      playCount += 1
      return .command(source: .accessibility, status: .unknown, revision: "rev")
    default:
      throw PhoneControlFailure.rejected
    }
  }
}

@MainActor
private final class WatchStaleUncertainty: BrowserMutationUncertaintyPersisting {
  private var tokens: [String: String] = [:]

  func pendingToken(for scope: String) throws -> String? { tokens[scope] }
  func recordIfClear(token: String, for scope: String) throws -> Bool {
    guard tokens[scope] == nil else { return false }
    tokens[scope] = token
    return true
  }
  func clear(token: String, for scope: String) throws -> BrowserMutationUncertaintyClearResult {
    guard tokens[scope] == token else { return .mismatch }
    tokens.removeValue(forKey: scope)
    return .cleared
  }
}
