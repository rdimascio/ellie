#if DEBUG
import Foundation
import SwiftUI

/// Only the inventory and browser result are synthetic. The installed iPhone and Watch apps
/// still exchange the production WatchMediaRequest/Reply through their real WCSession delegates.
@MainActor
private final class WatchPairedUITestFixture {
  static let shared = WatchPairedUITestFixture()

  let target: PhoneControlNode
  let credential: NativeEnrollmentCredential
  let controller: WatchMediaPhoneController
  let validRun: Bool

  private init() {
    let arguments = ProcessInfo.processInfo.arguments
    let marker = arguments.firstIndex(of: "--ellie-ui-watch-paired-fixture")
    let runID = marker.flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil }
    validRun = runID.flatMap(UUID.init(uuidString:)) != nil
    let targetB = arguments.contains("--ellie-ui-watch-target-b")
    target = PhoneControlNode(
      id: targetB ? "watch-fixture-mac-b" : "watch-fixture-mac-a",
      label: targetB ? "Fixture Mac B" : "Fixture Mac A", online: true,
      capabilities: ["browser.read", "browser.control"])
    credential = NativeEnrollmentCredential(
      origin: URL(string: "https://127.0.0.1:8444")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: "watch-fixture-phone", role: "phone", label: "Watch fixture iPhone",
        grants: [
          NativeGrant(target: "watch-fixture-mac-a", capabilities: ["browser.read", "browser.control"]),
          NativeGrant(target: "watch-fixture-mac-b", capabilities: ["browser.read", "browser.control"]),
        ], createdAt: 1, expiresAt: WatchMediaWire.now() + 3_600_000),
      token: String(repeating: "b", count: 64))
    let inventory = WatchPairedFixtureInventory()
    let transport = WatchPairedFixtureBrowserTransport(runID: validRun ? runID! : "invalid")
    let uncertainty = WatchPairedFixtureUncertainty()
    controller = WatchMediaPhoneController(
      inventory: inventory, browserTransport: transport,
      makeBrowser: { credential in
        BrowserPhoneControlStore(
          credential: credential, transport: transport, uncertainty: uncertainty)
      })
  }
}

struct WatchPairedUITestFixtureView: View {
  @ObservedObject private var bridge = WatchMediaPhoneBridge.shared
  private let fixture = WatchPairedUITestFixture.shared
  @State private var installed = false

  var body: some View {
    VStack(spacing: 12) {
      Text("Paired Watch test").font(.headline)
      Text(fixture.target.label).accessibilityIdentifier("watch-fixture-target")
      Text(bridge.enabledTargetID == fixture.target.id ? "Watch target enabled" : "Waiting for paired Watch")
        .accessibilityIdentifier("watch-fixture-authority")
    }
    .padding()
    .task { configure() }
    .onChange(of: bridge.available) { _, available in
      if available { configure() }
    }
  }

  private func configure() {
    guard fixture.validRun else { return }
    if !installed {
      bridge.installPairedTestController(fixture.controller)
      installed = true
    }
    if bridge.available && bridge.enabledTargetID != fixture.target.id {
      _ = bridge.enable(credential: fixture.credential, node: fixture.target)
    }
  }
}

private actor WatchPairedFixtureInventory: PhoneControlTransporting {
  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    [
      PhoneControlNode(id: "watch-fixture-mac-a", label: "Fixture Mac A", online: true,
                       capabilities: ["browser.read", "browser.control"]),
      PhoneControlNode(id: "watch-fixture-mac-b", label: "Fixture Mac B", online: true,
                       capabilities: ["browser.read", "browser.control"]),
    ]
  }

  func open(_ app: PhoneControlApp, on nodeID: String,
            credential: NativeEnrollmentCredential) async throws -> PhoneCommandOutcome {
    throw PhoneControlFailure.rejected
  }
}

private actor WatchPairedFixtureBrowserTransport: BrowserPhoneControlTransporting {
  private let logURL: URL

  init(runID: String) {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    logURL = support.appendingPathComponent("Ellie/WatchPaired/\(runID).jsonl")
  }

  func execute(_ action: BrowserPhoneAction, nodeID: String,
               credential: NativeEnrollmentCredential) async throws -> BrowserPhoneResponse {
    let revision = nodeID == "watch-fixture-mac-a" ? "fixture-revision-a" : "fixture-revision-b"
    switch action {
    case .refresh:
      try record("refresh", target: nodeID)
      return .status(source: .accessibility, connected: true, revision: revision)
    case .read:
      try record("read", target: nodeID)
      return .page(BrowserPhonePage(
        nodeID: nodeID, source: .accessibility, revision: revision,
        title: nodeID == "watch-fixture-mac-a" ? "Fixture film A" : "Fixture film B",
        summary: nil, items: [],
        site: BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 4)))
    case .playback(.play, _):
      try record("play", target: nodeID)
      return .command(source: .accessibility, status: .unknown, revision: revision)
    case .playback(.pause, _):
      try record("pause", target: nodeID)
      return .command(source: .accessibility, status: .unknown, revision: revision)
    default:
      throw PhoneControlFailure.rejected
    }
  }

  private func record(_ operation: String, target: String) throws {
    try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(),
                                            withIntermediateDirectories: true)
    let event = ["operation": operation, "target": target]
    var data = FileManager.default.fileExists(atPath: logURL.path)
      ? try Data(contentsOf: logURL) : Data()
    guard data.count < 8_192 else { throw PhoneControlFailure.unavailable }
    data.append(try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]))
    data.append(0x0a)
    try data.write(to: logURL, options: .atomic)
  }
}

@MainActor
private final class WatchPairedFixtureUncertainty: BrowserMutationUncertaintyPersisting {
  private var markers = [String: String]()
  func pendingToken(for scope: String) throws -> String? { markers[scope] }
  func recordIfClear(token: String, for scope: String) throws -> Bool {
    guard markers[scope] == nil else { return false }
    markers[scope] = token
    return true
  }
  func clear(token: String, for scope: String) throws -> BrowserMutationUncertaintyClearResult {
    guard markers[scope] == token else { return .mismatch }
    markers.removeValue(forKey: scope)
    return .cleared
  }
}
#endif
