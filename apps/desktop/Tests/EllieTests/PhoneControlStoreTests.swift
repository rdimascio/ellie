import XCTest

@testable import Ellie

final class PhoneControlStoreTests: XCTestCase {
  func testWireModelsRejectUnknownFieldsScopeEscalationAndWrongOutcomes() throws {
    let grants = [
      NativeGrant(
        target: "mac-a", capabilities: ["app.open", "browser.read", "browser.control"])
    ]
    let valid = Data(
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":["browser.control","app.open","browser.read"]}]}"#
        .utf8)
    XCTAssertEqual(
      try decodePhoneControlNodes(valid, grants: grants),
      [
        PhoneControlNode(
          id: "mac-a", label: "Studio", online: true,
          capabilities: ["app.open", "browser.read", "browser.control"])
      ])
    XCTAssertEqual(
      try decodePhoneControlNodes(
        Data(
          #"{"nodes":[{"id":"browser-mac","label":"Browser","online":true,"capabilities":["browser.read"]}]}"#
            .utf8),
        grants: [NativeGrant(target: "browser-mac", capabilities: ["browser.read"])]),
      [
        PhoneControlNode(
          id: "browser-mac", label: "Browser", online: true, capabilities: ["browser.read"])
      ])
    XCTAssertThrowsError(
      try decodePhoneControlNodes(
        Data(
          #"{"nodes":[{"id":"browser-mac","label":"Browser","online":true,"capabilities":["browser.read","browser.control"]}]}"#
            .utf8),
        grants: [NativeGrant(target: "browser-mac", capabilities: ["browser.read"])]))
    for invalid in [
      #"{"nodes":[{"id":"mac-b","label":"Other","online":true,"capabilities":["app.open"]}]}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":["app.open"],"token":"secret"}]}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":["desktop.run"]}]}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":["app.open","app.open"]}]}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":["app.open","browser.read","browser.control","desktop.run"]}]}"#,
      #"{"nodes":[],"extra":true}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":1,"capabilities":["app.open"]}]}"#,
      #"{"nodes":[{"id":"mac-a","label":"Studio","online":true,"capabilities":[]},{"id":"mac-a","label":"Duplicate","online":true,"capabilities":[]}]}"#,
    ] {
      XCTAssertThrowsError(try decodePhoneControlNodes(Data(invalid.utf8), grants: grants))
    }
    XCTAssertEqual(
      try decodePhoneCommandOutcome(Data(#"{"outcome":"unknown"}"#.utf8), allowed: ["unknown"]),
      .unknown)
    XCTAssertThrowsError(
      try decodePhoneCommandOutcome(
        Data(#"{"outcome":"completed"}"#.utf8), allowed: ["unknown"]))
    XCTAssertThrowsError(
      try validatePhoneControlErrorEnvelope(Data(#"{"error":"fixed","detail":"raw"}"#.utf8)))
    XCTAssertThrowsError(try validatePhoneControlErrorEnvelope(Data(#"{"error":""}"#.utf8)))
  }

  @MainActor
  func testBrowserOnlyGrantNeverEnablesAppOpening() async {
    let browserOnly = PhoneControlNode(
      id: "browser-mac", label: "Browser Mac", online: true,
      capabilities: ["browser.read", "browser.control"])
    XCTAssertFalse(browserOnly.canOpenApps)
    let mixed = PhoneControlNode(
      id: "mixed-mac", label: "Mixed Mac", online: true,
      capabilities: ["app.open", "browser.read"])
    XCTAssertTrue(mixed.canOpenApps)

    let transport = PhoneControlFakeTransport(nodes: [browserOnly])
    let store = PhoneControlStore(credential: credential(), transport: transport)
    store.refresh()
    await eventually { store.phase == .ready }
    store.selectedNodeID = browserOnly.id
    XCTAssertFalse(store.canSend)
    store.send()
    let commandCount = await transport.commandCalls.count
    XCTAssertEqual(commandCount, 0)
  }

  func testCommandResponseOnlyTrustsCanonicalPredispatchErrors() throws {
    XCTAssertEqual(
      try decodePhoneCommandResponse(status: 200, data: Data(#"{"outcome":"completed"}"#.utf8)),
      .completed)
    XCTAssertEqual(
      try decodePhoneCommandResponse(status: 200, data: Data(#"{"outcome":"later"}"#.utf8)),
      .unknown)
    XCTAssertEqual(
      try decodePhoneCommandResponse(status: 502, data: Data(#"{"bad":true}"#.utf8)),
      .unknown)
    XCTAssertEqual(
      try decodePhoneCommandResponse(status: 418, data: Data(#"{"error":"unexpected"}"#.utf8)),
      .unknown)
    XCTAssertEqual(
      try decodePhoneCommandResponse(status: 401, data: Data(#"{"bad":true}"#.utf8)),
      .unknown)
    XCTAssertThrowsError(
      try decodePhoneCommandResponse(
        status: 401, data: Data(#"{"error":"Native session required."}"#.utf8))
    ) { XCTAssertEqual($0 as? PhoneControlFailure, .revoked) }
    XCTAssertThrowsError(
      try decodePhoneCommandResponse(
        status: 503, data: Data(#"{"error":"Phone controls are unavailable."}"#.utf8))
    ) { XCTAssertEqual($0 as? PhoneControlFailure, .unavailable) }
  }

  @MainActor
  func testInitializationDoesNothingAndRefreshIsOneShot() async {
    let transport = PhoneControlFakeTransport(nodesFailure: .unavailable)
    let store = PhoneControlStore(credential: credential(), transport: transport)
    let initialNodeCalls = await transport.nodeCalls
    let initialCommandCalls = await transport.commandCalls.count
    XCTAssertEqual(initialNodeCalls, 0)
    XCTAssertEqual(initialCommandCalls, 0)

    store.refresh()
    await eventually { if case .failed = store.phase { true } else { false } }
    let failedNodeCalls = await transport.nodeCalls
    XCTAssertEqual(failedNodeCalls, 1)
    try? await Task.sleep(for: .milliseconds(50))
    let settledNodeCalls = await transport.nodeCalls
    XCTAssertEqual(settledNodeCalls, 1)
  }

  @MainActor
  func testRefreshKeepsOnlyCurrentSelectionAndSendCapturesTargetAndApp() async {
    let transport = PhoneControlFakeTransport(nodes: [node("mac-a"), node("mac-b")])
    let store = PhoneControlStore(credential: credential(), transport: transport)
    store.refresh()
    await eventually { store.phase == .ready }
    store.selectedNodeID = "mac-b"
    store.selectedApp = .messages
    store.send()
    await eventually { if case .outcome = store.phase { true } else { false } }
    let commandCalls = await transport.commandCalls
    XCTAssertEqual(commandCalls, [.init(nodeID: "mac-b", app: .messages)])

    await transport.setNodes([node("mac-a")])
    store.refresh()
    await eventually { store.phase == .ready }
    XCTAssertNil(store.selectedNodeID)
    XCTAssertFalse(store.canSend)
  }

  @MainActor
  func testRevocationClearsInventoryAndBlocksCommands() async {
    let transport = PhoneControlFakeTransport(nodes: [node("mac-a")])
    let store = PhoneControlStore(credential: credential(), transport: transport)
    store.refresh()
    await eventually { store.phase == .ready }
    store.selectedNodeID = "mac-a"
    await transport.setNodesFailure(.revoked)
    store.refresh()
    await eventually { store.phase == .revoked }
    XCTAssertTrue(store.nodes.isEmpty)
    XCTAssertNil(store.selectedNodeID)
    store.send()
    let commandCount = await transport.commandCalls.count
    XCTAssertEqual(commandCount, 0)
  }

  @MainActor
  func testCancelledRefreshCannotPublishLateInventory() async {
    let transport = PhoneControlFakeTransport(nodes: [node("mac-a")], suspendNodes: true)
    let store = PhoneControlStore(credential: credential(), transport: transport)
    store.refresh()
    await eventually { await transport.nodeCalls == 1 }
    store.cancel()
    XCTAssertEqual(store.phase, .cancelling)
    await transport.finishNodes()
    await eventually { store.phase == .idle }
    XCTAssertTrue(store.nodes.isEmpty)
    XCTAssertEqual(store.phase, .idle)
  }

  @MainActor
  func testCancelledCommandKeepsOriginalUnknownOutcomeAndRejectsLateCompletion() async {
    let transport = PhoneControlFakeTransport(nodes: [node("mac-a")], suspendCommand: true)
    let store = PhoneControlStore(credential: credential(), transport: transport)
    store.refresh()
    await eventually { store.phase == .ready }
    store.selectedNodeID = "mac-a"
    store.selectedApp = .arc
    store.send()
    await eventually { await transport.commandCalls.count == 1 }
    store.selectedNodeID = nil
    store.selectedApp = .safari
    store.cancel()
    XCTAssertEqual(store.phase, .cancelling)
    await transport.finishCommand(.completed)
    await eventually { store.phase == .outcome(.unknown, nodeID: "mac-a", app: .arc) }
    XCTAssertEqual(store.phase, .outcome(.unknown, nodeID: "mac-a", app: .arc))
    let commandCount = await transport.commandCalls.count
    XCTAssertEqual(commandCount, 1)
  }

  private func credential() -> NativeEnrollmentCredential {
    let grants = [
      NativeGrant(target: "mac-a", capabilities: ["app.open"]),
      NativeGrant(target: "mac-b", capabilities: ["app.open"]),
    ]
    return NativeEnrollmentCredential(
      origin: URL(string: "https://127.0.0.1:8444")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: "phone", role: "native_phone_controller", label: "Phone", grants: grants,
        createdAt: 1, expiresAt: 2),
      token: String(repeating: "c", count: 64))
  }

  private func node(_ id: String, label: String? = nil) -> PhoneControlNode {
    PhoneControlNode(id: id, label: label ?? id, online: true, capabilities: ["app.open"])
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

private actor PhoneControlFakeTransport: PhoneControlTransporting {
  struct Command: Equatable {
    let nodeID: String
    let app: PhoneControlApp
  }
  var nodeCalls = 0
  var commandCalls: [Command] = []
  var nodesWaiting = false
  var commandWaiting = false
  private var currentNodes: [PhoneControlNode]
  private var nodesFailure: PhoneControlFailure?
  private let suspendNodes: Bool
  private let suspendCommand: Bool
  private var nodesContinuation: CheckedContinuation<Void, Never>?
  private var commandContinuation: CheckedContinuation<Void, Never>?
  private var commandOutcome: PhoneCommandOutcome = .completed

  init(
    nodes: [PhoneControlNode] = [], nodesFailure: PhoneControlFailure? = nil,
    suspendNodes: Bool = false, suspendCommand: Bool = false
  ) {
    currentNodes = nodes
    self.nodesFailure = nodesFailure
    self.suspendNodes = suspendNodes
    self.suspendCommand = suspendCommand
  }

  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    nodeCalls += 1
    if suspendNodes {
      nodesWaiting = true
      await withCheckedContinuation { nodesContinuation = $0 }
      nodesWaiting = false
    }
    if let nodesFailure { throw nodesFailure }
    return currentNodes
  }

  func open(
    _ app: PhoneControlApp, on nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> PhoneCommandOutcome {
    commandCalls.append(.init(nodeID: nodeID, app: app))
    if suspendCommand {
      commandWaiting = true
      await withCheckedContinuation { commandContinuation = $0 }
      commandWaiting = false
    }
    return commandOutcome
  }

  func setNodes(_ value: [PhoneControlNode]) { currentNodes = value }
  func setNodesFailure(_ value: PhoneControlFailure) { nodesFailure = value }
  func finishNodes() {
    nodesContinuation?.resume()
    nodesContinuation = nil
  }
  func finishCommand(_ outcome: PhoneCommandOutcome) {
    commandOutcome = outcome
    commandContinuation?.resume()
    commandContinuation = nil
  }
}
