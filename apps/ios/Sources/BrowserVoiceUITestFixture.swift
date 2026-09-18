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
  @StateObject private var lifeReview: IOSQuietVoiceStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport
  @State private var backgroundCount = 0
  private let youtubeSearch: Bool

  init(completeActions: Bool = false, netflixRows: Bool = false, netflixSearch: Bool = false,
       youtubeSearch: Bool = false) {
    self.youtubeSearch = youtubeSearch
    let credential = BrowserVoiceUITestFixture.credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport(
      completeActions: completeActions,
      source: netflixRows || netflixSearch || youtubeSearch || completeActions
        ? .companion : .webmcp,
      siteOverride: netflixRows ? BrowserVoiceUITestFixture.netflixRowsSite : nil,
      netflixSearch: netflixSearch, youtubeSearch: youtubeSearch)
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
        transport: BrowserVoiceUITestSpeechTransport(
          transcript: netflixRows ? "Scroll right"
            : youtubeSearch ? "Search for public" : "Search for public video")))
    _browserTransport = StateObject(wrappedValue: browserTransport)
    _lifeReview = StateObject(wrappedValue: IOSQuietVoiceStore(
      credential: credential, client: BrowserVoiceUITestLifeClient(),
      journal: BrowserVoiceUITestUncertaintyStore()))
  }

  var body: some View {
    NavigationStack {
      SpeechTurnView(
        credential: BrowserVoiceUITestFixture.credential, controls: controls, browser: browser,
        speech: speech, lifeReview: lifeReview)
    }
    .overlay(alignment: .bottomTrailing) {
      VStack(alignment: .trailing, spacing: 2) {
        Text("Fixture backgrounds: \(backgroundCount)")
          .accessibilityIdentifier("browser-fixture-background-count")
        Text("Fixture mutations: \(browserTransport.mutationCount)")
          .accessibilityIdentifier("browser-fixture-mutation-count")
        if youtubeSearch {
          Text("Fixture actions: \(browserTransport.actionHistory.joined(separator: ","))")
            .accessibilityIdentifier("browser-fixture-action-history")
          Text("Synthetic audio and selected YouTube page")
            .accessibilityIdentifier("browser-fixture-synthetic-label")
        }
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

/// DEBUG-only composition fixture. The runner installs an ephemeral, private credential into
/// this app's own container; the stores below still use the production HTTPS transports.
struct BrowserComposedUITestFixture: Decodable {
  let credential: NativeEnrollmentCredential
  let target: String

  static func load(identifier: String) -> Self? {
    guard UUID(uuidString: identifier)?.uuidString.lowercased() == identifier else { return nil }
    let directory = directoryURL(identifier: identifier)
    let file = directory.appendingPathComponent("credential.json")
    var dirInfo = stat()
    var fileInfo = stat()
    guard lstat(directory.path, &dirInfo) == 0,
      (dirInfo.st_mode & S_IFMT) == S_IFDIR, dirInfo.st_uid == getuid(),
      dirInfo.st_mode & 0o077 == 0,
      lstat(file.path, &fileInfo) == 0,
      (fileInfo.st_mode & S_IFMT) == S_IFREG, fileInfo.st_uid == getuid(),
      fileInfo.st_mode & 0o077 == 0, fileInfo.st_nlink == 1,
      (1...8_192).contains(fileInfo.st_size),
      let data = try? Data(contentsOf: file), data.count == Int(fileInfo.st_size),
      let fixture = try? JSONDecoder().decode(Self.self, from: data),
      fixture.credential.origin.host == "127.0.0.1",
      canonicalNativeOrigin(fixture.credential.origin.absoluteString) == fixture.credential.origin,
      isNativeHexToken(fixture.credential.certificateSha256),
      isNativeHexToken(fixture.credential.token),
      fixture.credential.client.role == "native_phone_controller",
      fixture.credential.client.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000),
      (try? validateNativeGrants(fixture.credential.client.grants)) != nil,
      fixture.credential.client.grants.contains(where: {
        $0.target == fixture.target && $0.capabilities.contains("browser.read")
          && $0.capabilities.contains("browser.control")
      })
    else { return nil }
    return fixture
  }

  static func directoryURL(identifier: String) -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("EllieUITests", isDirectory: true)
      .appendingPathComponent("browser-composed-\(identifier)", isDirectory: true)
  }
}

@MainActor
struct BrowserComposedUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var speech: SpeechTurnStore
  @StateObject private var lifeReview: IOSQuietVoiceStore
  private let credential: NativeEnrollmentCredential
  private let target: String

  init(fixture: BrowserComposedUITestFixture, identifier: String) {
    credential = fixture.credential
    target = fixture.target
    let marker = BrowserComposedUITestFixture.directoryURL(identifier: identifier)
      .appendingPathComponent("uncertainty.json")
    _controls = StateObject(wrappedValue: PhoneControlStore(credential: fixture.credential))
    _browser = StateObject(wrappedValue: BrowserPhoneControlStore(
      credential: fixture.credential,
      uncertainty: PrivateBrowserMutationUncertaintyStore(fileURL: marker)))
    _speech = StateObject(wrappedValue: SpeechTurnStore(
      credential: fixture.credential, recorder: BrowserVoiceUITestRecorder(),
      transport: BrowserComposedUITestSpeechTransport()))
    _lifeReview = StateObject(wrappedValue: IOSQuietVoiceStore(
      credential: fixture.credential, client: BrowserVoiceUITestLifeClient(),
      journal: BrowserVoiceUITestUncertaintyStore()))
  }

  var body: some View {
    NavigationStack {
      SpeechTurnView(credential: credential, controls: controls, browser: browser,
        speech: speech, lifeReview: lifeReview)
    }
    .overlay(alignment: .bottomTrailing) {
      Text("Synthetic transcript; real pinned browser transport")
        .font(.caption2).padding(4)
        .accessibilityIdentifier("browser-composed-synthetic-label")
    }
    .onAppear { controls.refresh() }
    .onChange(of: controls.nodes) { _, nodes in
      if controls.selectedNodeID == nil && nodes.contains(where: { $0.id == target }) {
        controls.selectedNodeID = target
      }
    }
  }
}

private struct BrowserComposedUITestSpeechTransport: SpeechTransporting {
  func availability(for credential: NativeEnrollmentCredential) async throws {}
  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String { "Search for owned synthetic video" }
  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async {}
}

@MainActor
struct BrowserTargetUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport

  private let credential: NativeEnrollmentCredential
  private let rowActions: Bool

  init(readOnly: Bool = false, unavailablePlayback: Bool = false,
       netflixRows: Bool = false, rowActions: Bool = false) {
    let credential = readOnly
      ? BrowserVoiceUITestFixture.readOnlyCredential : BrowserVoiceUITestFixture.credential
    self.credential = credential
    self.rowActions = rowActions
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport(
      completeActions: rowActions,
      source: netflixRows ? .companion : .webmcp,
      siteOverride: unavailablePlayback
        ? BrowserPhoneSite(page: .watch, playback: .unavailable, currentTimeSeconds: nil)
        : netflixRows ? BrowserVoiceUITestFixture.netflixRowsSite
        : rowActions ? BrowserPhoneSite(page: .watch, playback: .playing, currentTimeSeconds: 1)
        : nil)
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
        if rowActions {
          Text("Actions: \(browserTransport.actionHistory.joined(separator: ","))")
            .accessibilityIdentifier("browser-fixture-action-history")
        }
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
  static let netflixRowsSite = BrowserPhoneSite(
    provider: .netflix, page: .browse, playback: .unavailable, currentTimeSeconds: nil,
    rows: [
      BrowserPhoneRow(id: "10000000-0000-4000-8000-000000000001", label: "Row 1: Featured"),
      BrowserPhoneRow(id: "10000000-0000-4000-8000-000000000002", label: "Row 2: New"),
    ])
  static let netflixSearchSite = BrowserPhoneSite(
    provider: .netflix, page: .browse, playback: .unavailable, currentTimeSeconds: nil,
    searchControl: BrowserPhoneSearchControl(
      id: "10000000-0000-4000-8000-000000000003", label: "Search"))
  static let netflixResultsSite = BrowserPhoneSite(
    provider: .netflix, page: .results, playback: .unavailable, currentTimeSeconds: nil,
    searchControl: BrowserPhoneSearchControl(
      id: "10000000-0000-4000-8000-000000000004", label: "Search"))
  static let youtubeHomeSite = BrowserPhoneSite(
    provider: .youtube, page: .home, playback: .unavailable, currentTimeSeconds: nil,
    searchControl: BrowserPhoneSearchControl(
      id: "10000000-0000-4000-8000-000000000005", label: "Search"))
  static let youtubeHomeWithoutSearch = BrowserPhoneSite(
    provider: .youtube, page: .home, playback: .unavailable, currentTimeSeconds: nil)
  static let youtubeResultsSite = BrowserPhoneSite(
    provider: .youtube, page: .results, playback: .unavailable, currentTimeSeconds: nil,
    searchControl: BrowserPhoneSearchControl(
      id: "10000000-0000-4000-8000-000000000006", label: "Search"))
  static let youtubeWatchSite = BrowserPhoneSite(
    provider: .youtube, page: .watch, playback: .paused, currentTimeSeconds: 1)
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

@MainActor
private struct BrowserVoiceUITestLifeClient: IOSQuietVoiceClient {
  func epoch(_ credential: NativeEnrollmentCredential) async throws -> Int {
    throw IOSQuietFailure.unavailable
  }
  func send(_ credential: NativeEnrollmentCredential, body: Data) async throws
    -> IOSQuietChatOutcome {
    throw IOSQuietFailure.unavailable
  }
  func status(_ credential: NativeEnrollmentCredential, requestID: String) async throws
    -> IOSQuietChatOutcome {
    throw IOSQuietFailure.unavailable
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
  let transcript: String
  func availability(for credential: NativeEnrollmentCredential) async throws {}
  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String {
    transcript
  }
  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async {}
}

@MainActor
private final class BrowserVoiceUITestTransport: ObservableObject,
  BrowserPhoneControlTransporting
{
  @Published private(set) var mutationCount = 0
  @Published private(set) var readNodeIDs: [String] = []
  @Published private(set) var actionHistory: [String] = []
  private var failNextRead: Bool
  private let completeActions: Bool
  private let siteOverride: BrowserPhoneSite?
  private let netflixSearch: Bool
  private let youtubeSearch: Bool
  private let source: BrowserPhoneSource

  init(
    failNextRead: Bool = false, completeActions: Bool = false,
    source: BrowserPhoneSource = .webmcp,
    siteOverride: BrowserPhoneSite? = nil, netflixSearch: Bool = false,
    youtubeSearch: Bool = false
  ) {
    self.failNextRead = failNextRead
    self.completeActions = completeActions
    self.siteOverride = siteOverride
    self.netflixSearch = netflixSearch
    self.youtubeSearch = youtubeSearch
    self.source = source
  }

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    switch action {
    case .status, .refresh:
      return .status(
        source: youtubeSearch ? .accessibility : source, connected: true,
        revision: BrowserVoiceUITestFixture.revision)
    case .read:
      readNodeIDs.append(nodeID)
      if failNextRead {
        failNextRead = false
        throw PhoneControlFailure.unavailable
      }
      let isA = nodeID == BrowserVoiceUITestFixture.nodeAID
      if youtubeSearch {
        let stage = mutationCount == 0 ? "home" : mutationCount == 1 ? "results" : "watch"
        actionHistory.append("read.\(stage)")
        return .page(BrowserPhonePage(
          nodeID: nodeID, source: source, revision: BrowserVoiceUITestFixture.revision,
          title: "Synthetic YouTube \(stage)", summary: "Owned fixture observation",
          items: stage == "results"
            ? [BrowserPhoneItem(id: "public-video-a", label: "Synthetic public result", state: nil)]
            : [],
          site: stage == "home" ? (readNodeIDs.count == 1
              ? BrowserVoiceUITestFixture.youtubeHomeWithoutSearch
              : BrowserVoiceUITestFixture.youtubeHomeSite)
            : stage == "results" ? BrowserVoiceUITestFixture.youtubeResultsSite
            : BrowserVoiceUITestFixture.youtubeWatchSite))
      }
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: source, revision: BrowserVoiceUITestFixture.revision,
          title: isA ? "Mac A page" : "Mac B page", summary: "One observed public result",
          items: netflixSearch && mutationCount == 0 ? [] : [
            BrowserPhoneItem(
              id: isA ? "public-video-a" : "public-video-b",
              label: isA ? "A result" : "B result", state: nil)
          ], site: netflixSearch
            ? (mutationCount == 0
                ? BrowserVoiceUITestFixture.netflixSearchSite
                : BrowserVoiceUITestFixture.netflixResultsSite)
            : siteOverride ?? (completeActions ? observedSite : nil)))
    case .search(let query, _):
      mutationCount += 1
      if youtubeSearch { actionHistory.append("search.\(query)") }
      return .command(
        source: source, status: youtubeSearch ? .unknown : .completed,
        revision: BrowserVoiceUITestFixture.revision)
    case .select:
      mutationCount += 1
      if youtubeSearch { actionHistory.append("select") }
      if !completeActions && !youtubeSearch {
        do { try await Task.sleep(for: .seconds(30)) }
        catch { throw PhoneControlFailure.cancelled }
      }
      return .command(
        source: source, status: youtubeSearch ? .unknown : .completed,
        revision: BrowserVoiceUITestFixture.revision)
    case .scroll(let direction, _):
      actionHistory.append("scroll.\(direction.rawValue)")
      mutationCount += 1
      return .command(
        source: source, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .scrollRow:
      mutationCount += 1
      return .command(
        source: source, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .playback(let intent, _):
      actionHistory.append(intent == .play ? "playback.play" : "playback.pause")
      mutationCount += 1
      return .command(
        source: source, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    }
  }

  private var observedSite: BrowserPhoneSite {
    switch mutationCount {
    case 0:
      BrowserVoiceUITestFixture.netflixSearchSite
    case 1:
      BrowserVoiceUITestFixture.netflixResultsSite
    case 3:
      BrowserPhoneSite(
        provider: .netflix, page: .watch, playback: .playing, currentTimeSeconds: 1)
    default:
      BrowserPhoneSite(
        provider: .netflix, page: .watch, playback: .paused, currentTimeSeconds: 1)
    }
  }
}
#endif
