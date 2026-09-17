#if DEBUG
import Foundation
import SwiftUI
import UIKit
import WatchConnectivity

/// Fixed, payload-free evidence for the opt-in paired Simulator runner. It is never enabled by
/// the normal app and does not change Watch authority or transport behavior.
@MainActor
enum WatchPairedUITestReadiness {
  private struct Snapshot: Encodable {
    let version = 1
    let activation: String
    let paired: Bool
    let watchAppInstalled: Bool
    let reachable: Bool
    let enabledTarget: String
    let foreground: Bool
    let recordedAtMilliseconds: Int64
  }

  static func record(session: WCSession, enabledTargetID: String?) {
    let arguments = ProcessInfo.processInfo.arguments
    guard let marker = arguments.firstIndex(of: "--ellie-ui-watch-paired-fixture"),
          arguments.indices.contains(marker + 1),
          UUID(uuidString: arguments[marker + 1]) != nil else { return }
    let activation: String
    switch session.activationState {
    case .activated: activation = "activated"
    case .inactive: activation = "inactive"
    case .notActivated: activation = "not_activated"
    @unknown default: activation = "unknown"
    }
    let snapshot = Snapshot(
      activation: activation, paired: session.isPaired,
      watchAppInstalled: session.isWatchAppInstalled, reachable: session.isReachable,
      enabledTarget: enabledTargetID ?? "",
      foreground: UIApplication.shared.applicationState == .active,
      recordedAtMilliseconds: Int64(Date().timeIntervalSince1970 * 1_000))
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let directory = support.appendingPathComponent("Ellie/WatchPaired")
    let file = directory.appendingPathComponent("\(arguments[marker + 1]).readiness.json")
    do {
      let data = try JSONEncoder().encode(snapshot)
      guard data.count <= 512 else { return }
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try data.write(to: file, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    } catch {
      // The runner fails its readiness prerequisite rather than treating missing evidence as ready.
    }
  }
}

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
  @Environment(\.scenePhase) private var scenePhase
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
    .onChange(of: scenePhase) { _, _ in bridge.recordPairedFixtureReadiness() }
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
    bridge.recordPairedFixtureReadiness()
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
