#if DEBUG
import Darwin
import Combine
import Foundation
import SwiftUI

@MainActor
struct BrowserVoiceUITestFixtureView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var speech: SpeechTurnStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport
  @State private var backgroundCount = 0

  init(completeActions: Bool = false) {
    let credential = BrowserVoiceUITestFixture.credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport(completeActions: completeActions)
    _controls = StateObject(
      wrappedValue: PhoneControlStore(
        credential: credential, transport: BrowserVoiceUITestPhoneTransport()))
    _browser = StateObject(
      wrappedValue: BrowserPhoneControlStore(
        credential: credential, transport: browserTransport,
        uncertainty: BrowserVoiceUITestUncertaintyStore()))
    _speech = StateObject(
      wrappedValue: SpeechTurnStore(
        credential: credential, recorder: BrowserVoiceUITestRecorder(),
        transport: BrowserVoiceUITestSpeechTransport()))
    _browserTransport = StateObject(wrappedValue: browserTransport)
  }

  var body: some View {
    NavigationStack {
      SpeechTurnView(
        credential: BrowserVoiceUITestFixture.credential, controls: controls, browser: browser,
        speech: speech)
    }
    .overlay(alignment: .bottomTrailing) {
      VStack(alignment: .trailing, spacing: 2) {
        Text("Fixture backgrounds: \(backgroundCount)")
          .accessibilityIdentifier("browser-fixture-background-count")
        Text("Fixture mutations: \(browserTransport.mutationCount)")
          .accessibilityIdentifier("browser-fixture-mutation-count")
      }
      .font(.caption2)
      .padding(4)
    }
    .onAppear { controls.refresh() }
    .onChange(of: controls.nodes) { _, nodes in
      if controls.selectedNodeID == nil { controls.selectedNodeID = nodes.first?.id }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .background { backgroundCount += 1 }
    }
  }
}

@MainActor
struct BrowserTargetUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport

  private let credential: NativeEnrollmentCredential

  init(readOnly: Bool = false, unavailablePlayback: Bool = false) {
    let credential = readOnly
      ? BrowserVoiceUITestFixture.readOnlyCredential : BrowserVoiceUITestFixture.credential
    self.credential = credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport(
      siteOverride: unavailablePlayback
        ? BrowserPhoneSite(page: .watch, playback: .unavailable, currentTimeSeconds: nil) : nil)
    _controls = StateObject(
      wrappedValue: PhoneControlStore(
        credential: credential, transport: BrowserVoiceUITestPhoneTransport(readOnly: readOnly)))
    _browser = StateObject(
      wrappedValue: BrowserPhoneControlStore(
        credential: credential, transport: browserTransport,
        uncertainty: BrowserVoiceUITestUncertaintyStore()))
    _browserTransport = StateObject(wrappedValue: browserTransport)
  }

  var body: some View {
    NavigationStack {
      PhoneControlView(
        credential: credential, store: controls, browser: browser)
    }
    .overlay(alignment: .bottomTrailing) {
      VStack(alignment: .trailing) {
        Text("Fixture mutations: \(browserTransport.mutationCount)")
          .accessibilityIdentifier("browser-fixture-mutation-count")
        Text("Fixture reads: \(browserTransport.readNodeIDs.joined(separator: ","))")
          .accessibilityIdentifier("browser-fixture-read-history")
      }
      .font(.caption2)
      .padding(4)
    }
    .onAppear { controls.refresh() }
    .onChange(of: controls.nodes) { _, nodes in
      if controls.selectedNodeID == nil { controls.selectedNodeID = nodes.first?.id }
    }
  }
}

@MainActor
struct BrowserUnknownRelaunchUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport
  @State private var markerState = "absent"
  private let persistence: PrivateBrowserMutationUncertaintyStore

  init(identifier: String) {
    let credential = BrowserVoiceUITestFixture.credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let persistence = PrivateBrowserMutationUncertaintyStore(
      fileURL: BrowserUnknownRelaunchUITestStorage.fileURL(identifier: identifier))
    let browserTransport = BrowserVoiceUITestTransport(
      failNextRead: ProcessInfo.processInfo.arguments.contains(
        "--ellie-ui-browser-unknown-fail-read-once"))
    self.persistence = persistence
    _controls = StateObject(
      wrappedValue: PhoneControlStore(
        credential: credential, transport: BrowserVoiceUITestPhoneTransport()))
    _browser = StateObject(
      wrappedValue: BrowserPhoneControlStore(
        credential: credential, transport: browserTransport, uncertainty: persistence))
    _browserTransport = StateObject(wrappedValue: browserTransport)
  }

  var body: some View {
    NavigationStack {
      PhoneControlView(
        credential: BrowserVoiceUITestFixture.credential, store: controls, browser: browser)
    }
    .overlay(alignment: .bottomTrailing) {
      VStack(alignment: .trailing, spacing: 2) {
        Text("Fixture mutations: \(browserTransport.mutationCount)")
          .accessibilityIdentifier("browser-fixture-mutation-count")
        Text("Fixture marker: \(markerState)")
          .accessibilityIdentifier("browser-fixture-persisted-marker")
      }
      .font(.caption2)
      .padding(4)
    }
    .onAppear {
      updateMarkerState()
      controls.refresh()
    }
    .onChange(of: browserTransport.mutationCount) { _, _ in updateMarkerState() }
    .onChange(of: browser.phase) { _, _ in updateMarkerState() }
  }

  private func updateMarkerState() {
    guard let scope = try? browserMutationUncertaintyScope(
      credential: BrowserVoiceUITestFixture.credential,
      targetID: BrowserVoiceUITestFixture.nodeAID)
    else {
      markerState = "unavailable"
      return
    }
    do {
      let pending = try persistence.pendingToken(for: scope) != nil
      let fileExists = FileManager.default.fileExists(atPath: persistence.fileURL.path)
      markerState = pending && fileExists ? "present" : "absent"
    } catch {
      markerState = "unavailable"
    }
  }
}

@MainActor
struct BrowserUnknownRelaunchUITestCleanupView: View {
  let identifier: String
  @State private var status = "pending"

  var body: some View {
    Text("Fixture cleanup: \(status)")
      .accessibilityIdentifier("browser-fixture-cleanup")
      .onAppear {
        do {
          try BrowserUnknownRelaunchUITestStorage.remove(identifier: identifier)
          status = "complete"
        } catch {
          status = "failed"
        }
      }
  }
}

enum BrowserUnknownRelaunchUITestStorage {
  static func identifier(from arguments: [String], after flag: String) -> String? {
    guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
      return nil
    }
    let value = arguments[index + 1]
    guard UUID(uuidString: value)?.uuidString.lowercased() == value else { return nil }
    return value
  }

  static func fileURL(identifier: String) -> URL {
    directoryURL(identifier: identifier).appendingPathComponent("markers.json")
  }

  static func remove(identifier: String) throws {
    let directory = directoryURL(identifier: identifier)
    var info = stat()
    if lstat(directory.path, &info) != 0 {
      if errno == ENOENT { return }
      throw CocoaError(.fileReadUnknown)
    }
    guard (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(),
      info.st_mode & 0o077 == 0
    else { throw CocoaError(.fileWriteNoPermission) }
    try FileManager.default.removeItem(at: directory)
  }

  private static func directoryURL(identifier: String) -> URL {
    precondition(UUID(uuidString: identifier)?.uuidString.lowercased() == identifier)
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("EllieUITests", isDirectory: true)
      .appendingPathComponent("browser-unknown-\(identifier)", isDirectory: true)
  }
}

private enum BrowserVoiceUITestFixture {
  static let nodeAID = "ui-fixture-mac-a"
  static let nodeBID = "ui-fixture-mac-b"
  static let nodeID = nodeAID
  static let revision = String(repeating: "a", count: 64)
  static let credential = NativeEnrollmentCredential(
    origin: URL(string: "https://127.0.0.1:8444")!,
    certificateSha256: String(repeating: "b", count: 64),
    client: NativeClient(
      id: "ui-fixture-phone", role: "native_phone_controller", label: "UI fixture phone",
      grants: [
        NativeGrant(
          target: nodeAID, capabilities: ["browser.read", "browser.control"]),
        NativeGrant(
          target: nodeBID, capabilities: ["browser.read", "browser.control"]),
      ],
      createdAt: 1, expiresAt: 2),
    token: String(repeating: "c", count: 64))
  static let readOnlyCredential = NativeEnrollmentCredential(
    origin: credential.origin, certificateSha256: credential.certificateSha256,
    client: NativeClient(
      id: credential.client.id, role: credential.client.role, label: credential.client.label,
      grants: [NativeGrant(target: nodeAID, capabilities: ["browser.read"])],
      createdAt: 1, expiresAt: 2),
    token: credential.token)
}

@MainActor
private final class BrowserVoiceUITestUncertaintyStore: BrowserMutationUncertaintyPersisting {
  private var markers: [String: String] = [:]

  func pendingToken(for scope: String) throws -> String? {
    return markers[scope]
  }

  func recordIfClear(token: String, for scope: String) throws -> Bool {
    guard markers[scope] == nil else { return false }
    markers[scope] = token
    return true
  }

  func clear(
    token: String, for scope: String
  ) throws -> BrowserMutationUncertaintyClearResult {
    guard markers[scope] == token else { return .mismatch }
    markers.removeValue(forKey: scope)
    return .cleared
  }
}

private struct BrowserVoiceUITestPhoneTransport: PhoneControlTransporting {
  var readOnly = false

  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    if readOnly {
      return [PhoneControlNode(
        id: BrowserVoiceUITestFixture.nodeAID, label: "Fixture Mac A", online: true,
        capabilities: ["browser.read"])]
    }
    return [
      PhoneControlNode(
        id: BrowserVoiceUITestFixture.nodeAID, label: "Fixture Mac A", online: true,
        capabilities: ["browser.read", "browser.control"]),
      PhoneControlNode(
        id: BrowserVoiceUITestFixture.nodeBID, label: "Fixture Mac B", online: true,
        capabilities: ["browser.read", "browser.control"]),
    ]
  }

  func open(
    _ app: PhoneControlApp, on nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> PhoneCommandOutcome {
    throw PhoneControlFailure.rejected
  }
}

private actor BrowserVoiceUITestRecorder: SpeechRecording {
  func start() async throws {}
  func stop() async throws -> SpeechAudioArtifact {
    SpeechAudioArtifact(id: UUID(), url: URL(fileURLWithPath: "/dev/null"))
  }
  func cancel() async throws {}
  func dispose(_ artifact: SpeechAudioArtifact) async throws {}
}

private struct BrowserVoiceUITestSpeechTransport: SpeechTransporting {
  func availability(for credential: NativeEnrollmentCredential) async throws {}
  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String {
    "Search for public video"
  }
  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async {}
}

@MainActor
private final class BrowserVoiceUITestTransport: ObservableObject,
  BrowserPhoneControlTransporting
{
  @Published private(set) var mutationCount = 0
  @Published private(set) var readNodeIDs: [String] = []
  private var failNextRead: Bool
  private let completeActions: Bool
  private let siteOverride: BrowserPhoneSite?

  init(
    failNextRead: Bool = false, completeActions: Bool = false,
    siteOverride: BrowserPhoneSite? = nil
  ) {
    self.failNextRead = failNextRead
    self.completeActions = completeActions
    self.siteOverride = siteOverride
  }

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    switch action {
    case .status, .refresh:
      return .status(
        source: .webmcp, connected: true, revision: BrowserVoiceUITestFixture.revision)
    case .read:
      readNodeIDs.append(nodeID)
      if failNextRead {
        failNextRead = false
        throw PhoneControlFailure.unavailable
      }
      let isA = nodeID == BrowserVoiceUITestFixture.nodeAID
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: .webmcp, revision: BrowserVoiceUITestFixture.revision,
          title: isA ? "Mac A page" : "Mac B page", summary: "One observed public result",
          items: [
            BrowserPhoneItem(
              id: isA ? "public-video-a" : "public-video-b",
              label: isA ? "A result" : "B result", state: nil)
          ], site: siteOverride ?? (completeActions ? observedSite : nil)))
    case .search:
      mutationCount += 1
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .select:
      mutationCount += 1
      if !completeActions {
        do { try await Task.sleep(for: .seconds(30)) }
        catch { throw PhoneControlFailure.cancelled }
      }
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .scroll, .playback:
      mutationCount += 1
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    }
  }

  private var observedSite: BrowserPhoneSite {
    switch mutationCount {
    case 0:
      BrowserPhoneSite(page: .home, playback: .unavailable, currentTimeSeconds: nil)
    case 1:
      BrowserPhoneSite(page: .results, playback: .unavailable, currentTimeSeconds: nil)
    case 3:
      BrowserPhoneSite(page: .watch, playback: .playing, currentTimeSeconds: 1)
    default:
      BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 1)
    }
  }
}
#endif
