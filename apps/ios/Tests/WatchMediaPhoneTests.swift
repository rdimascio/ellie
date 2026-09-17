import XCTest

@testable import Ellie

final class WatchMediaPhoneTests: XCTestCase {
  func testWireRequiresLiveExactRequestsAndEvidenceBoundReplies() {
    let now: Int64 = 1_000_000
    let read = WatchMediaRequest.make(.read, now: now)
    XCTAssertNotNil(WatchMediaRequest.decode(read.message, now: now))
    XCTAssertNil(WatchMediaRequest.decode(read.message, now: now + 10_000))
    var extra = read.message
    extra["playback"] = "play"
    XCTAssertNil(WatchMediaRequest.decode(extra, now: now))
    var boolVersion = read.message
    boolVersion["version"] = true
    XCTAssertNil(WatchMediaRequest.decode(boolVersion, now: now))
    var fractionalVersion = read.message
    fractionalVersion["version"] = 1.5
    XCTAssertNil(WatchMediaRequest.decode(fractionalVersion, now: now))
    var hugeExpiry = read.message
    hugeExpiry["expiresAt"] = UInt64.max
    XCTAssertNil(WatchMediaRequest.decode(hugeExpiry, now: now))
    var invalidMutation = WatchMediaRequest.make(.pause, target: "mac", epoch: read.id,
                                                  revision: "rev", now: now).message
    invalidMutation["revision"] = "old revision"
    XCTAssertNil(WatchMediaRequest.decode(invalidMutation, now: now))

    let reply = WatchMediaReply(id: read.id, state: .observed,
      observation: WatchMediaObservation(target: "mac", targetLabel: "Studio",
        epoch: read.id, revision: "rev", title: "Observed title", playback: "paused"))
    XCTAssertNotNil(WatchMediaReply.decode(reply.message, expectedID: read.id))
    XCTAssertNil(WatchMediaReply.decode(reply.message, expectedID: UUID().uuidString.lowercased()))
    var invented = reply.message
    invented["token"] = "not-allowed"
    XCTAssertNil(WatchMediaReply.decode(invented, expectedID: read.id))
  }

  @MainActor
  func testExplicitReadThenOneRevisionBoundMutationNeedsFreshObservation() async {
    let node = PhoneControlNode(id: "mac", label: "Studio", online: true,
                                capabilities: ["browser.read", "browser.control"])
    let inventory = WatchTestInventory(node: node)
    let browser = WatchTestBrowserTransport()
    let controller = WatchMediaPhoneController(inventory: inventory, browserTransport: browser,
      makeBrowser: { credential in
        BrowserPhoneControlStore(credential: credential, transport: browser,
          uncertainty: WatchTestUncertainty())
      })
    XCTAssertTrue(controller.enable(credential: credential(), node: node))
    let read = WatchMediaRequest.make(.read)
    let observed = await controller.handle(read)
    XCTAssertEqual(observed.state, .observed)
    XCTAssertEqual(observed.observation?.title, "Observed film")
    XCTAssertEqual(observed.observation?.playback, "paused")
    guard let page = observed.observation else { return XCTFail("Missing observation") }
    let play = WatchMediaRequest.make(.play, target: page.target, epoch: page.epoch,
                                      revision: page.revision)
    let firstPlay = await controller.handle(play)
    XCTAssertEqual(firstPlay.state, .unknown)
    await eventually { await browser.playCount == 1 }
    let duplicate = await controller.handle(play)
    XCTAssertNotEqual(duplicate.state, .unknown,
                      "The same Watch request must not dispatch twice")
    let stale = WatchMediaRequest.make(.play, target: page.target, epoch: page.epoch,
                                       revision: page.revision)
    let staleResult = await controller.handle(stale)
    XCTAssertEqual(staleResult.state, .stale)
    let firstCount = await browser.playCount
    XCTAssertEqual(firstCount, 1)
    controller.disable()
    XCTAssertTrue(controller.enable(credential: credential(), node: node))
    let afterReenable = await controller.handle(stale)
    XCTAssertEqual(afterReenable.state, .stale,
                   "A previous phone activation cannot regain authority")
    let finalCount = await browser.playCount
    XCTAssertEqual(finalCount, 1)
  }

  @MainActor
  func testTargetAndGrantChangeBlockBeforeBrowserDispatch() async {
    let node = PhoneControlNode(id: "mac", label: "Studio", online: true,
                                capabilities: ["browser.read", "browser.control"])
    let inventory = WatchTestInventory(node: node)
    let browser = WatchTestBrowserTransport()
    let controller = WatchMediaPhoneController(inventory: inventory, browserTransport: browser,
      makeBrowser: { credential in
        BrowserPhoneControlStore(credential: credential, transport: browser,
          uncertainty: WatchTestUncertainty())
      })
    XCTAssertTrue(controller.enable(credential: credential(), node: node))
    let read = WatchMediaRequest.make(.read)
    let observed = await controller.handle(read)
    guard let page = observed.observation else { return XCTFail("Missing observation") }
    await inventory.replace(PhoneControlNode(id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read"]))
    let play = WatchMediaRequest.make(.play, target: page.target, epoch: page.epoch,
                                      revision: page.revision)
    let blocked = await controller.handle(play)
    XCTAssertEqual(blocked.state, .blocked)
    let count = await browser.playCount
    XCTAssertEqual(count, 0)
    let unavailableNode = PhoneControlNode(id: "other", label: "Other", online: false,
      capabilities: ["browser.read", "browser.control"])
    XCTAssertFalse(controller.enable(credential: credential(), node: unavailableNode))
    XCTAssertNil(controller.enabledTargetID)
    controller.retainOnly(nil)
    let afterRevocation = await controller.handle(WatchMediaRequest.make(.read))
    XCTAssertEqual(afterRevocation.state, .blocked)
  }

  private func credential() -> NativeEnrollmentCredential {
    NativeEnrollmentCredential(origin: URL(string: "https://example.test")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(id: "phone", role: "phone", label: "iPhone",
        grants: [NativeGrant(target: "mac", capabilities: ["browser.read", "browser.control"])],
        createdAt: 1, expiresAt: Int64(Date().timeIntervalSince1970 * 1_000) + 60_000),
      token: String(repeating: "b", count: 64))
  }

  private func eventually(_ check: @escaping () async -> Bool) async {
    for _ in 0..<100 {
      if await check() { return }
      try? await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Expected browser dispatch did not settle")
  }
}

private actor WatchTestInventory: PhoneControlTransporting {
  private var node: PhoneControlNode
  init(node: PhoneControlNode) { self.node = node }
  func replace(_ value: PhoneControlNode) { node = value }
  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] { [node] }
  func open(_ app: PhoneControlApp, on nodeID: String,
            credential: NativeEnrollmentCredential) async throws -> PhoneCommandOutcome { .unknown }
}

private actor WatchTestBrowserTransport: BrowserPhoneControlTransporting {
  private(set) var playCount = 0
  func execute(_ action: BrowserPhoneAction, nodeID: String,
               credential: NativeEnrollmentCredential) async throws -> BrowserPhoneResponse {
    switch action {
    case .refresh: return .status(source: .accessibility, connected: true, revision: "rev")
    case .read: return .page(BrowserPhonePage(nodeID: nodeID, source: .accessibility,
      revision: "rev", title: "Observed film", summary: nil, items: [],
      site: BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 4)))
    case .playback(.play, _):
      playCount += 1
      return .command(source: .accessibility, status: .unknown, revision: "rev")
    default: throw PhoneControlFailure.rejected
    }
  }
}

@MainActor
private final class WatchTestUncertainty: BrowserMutationUncertaintyPersisting {
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
