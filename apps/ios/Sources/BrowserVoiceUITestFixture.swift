#if DEBUG
import Combine
import Foundation
import SwiftUI

@MainActor
struct BrowserVoiceUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var speech: SpeechTurnStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport

  init() {
    let credential = BrowserVoiceUITestFixture.credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport()
    _controls = StateObject(
      wrappedValue: PhoneControlStore(
        credential: credential, transport: BrowserVoiceUITestPhoneTransport()))
    _browser = StateObject(
      wrappedValue: BrowserPhoneControlStore(
        credential: credential, transport: browserTransport))
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
      Text("Fixture mutations: \(browserTransport.mutationCount)")
        .font(.caption2)
        .padding(4)
        .accessibilityIdentifier("browser-fixture-mutation-count")
    }
    .onAppear { controls.refresh() }
    .onChange(of: controls.nodes) { _, nodes in
      if controls.selectedNodeID == nil { controls.selectedNodeID = nodes.first?.id }
    }
  }
}

@MainActor
struct BrowserTargetUITestFixtureView: View {
  @StateObject private var controls: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @StateObject private var browserTransport: BrowserVoiceUITestTransport

  init() {
    let credential = BrowserVoiceUITestFixture.credential
    precondition((try? validateNativeGrants(credential.client.grants)) != nil)
    let browserTransport = BrowserVoiceUITestTransport()
    _controls = StateObject(
      wrappedValue: PhoneControlStore(
        credential: credential, transport: BrowserVoiceUITestPhoneTransport()))
    _browser = StateObject(
      wrappedValue: BrowserPhoneControlStore(
        credential: credential, transport: browserTransport))
    _browserTransport = StateObject(wrappedValue: browserTransport)
  }

  var body: some View {
    NavigationStack {
      PhoneControlView(
        credential: BrowserVoiceUITestFixture.credential, store: controls, browser: browser)
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
}

private struct BrowserVoiceUITestPhoneTransport: PhoneControlTransporting {
  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    [
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

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    switch action {
    case .status:
      return .status(
        source: .webmcp, connected: true, revision: BrowserVoiceUITestFixture.revision)
    case .read:
      readNodeIDs.append(nodeID)
      let isA = nodeID == BrowserVoiceUITestFixture.nodeAID
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: .webmcp, revision: BrowserVoiceUITestFixture.revision,
          title: isA ? "Mac A page" : "Mac B page", summary: "One observed public result",
          items: [
            BrowserPhoneItem(
              id: isA ? "public-video-a" : "public-video-b",
              label: isA ? "A result" : "B result", state: nil)
          ]))
    case .search:
      mutationCount += 1
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .select:
      mutationCount += 1
      do { try await Task.sleep(for: .seconds(30)) } catch { throw PhoneControlFailure.cancelled }
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    case .scroll, .playback:
      mutationCount += 1
      return .command(
        source: .webmcp, status: .completed, revision: BrowserVoiceUITestFixture.revision)
    }
  }
}
#endif
