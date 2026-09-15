#if DEBUG
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

private enum BrowserVoiceUITestFixture {
  static let nodeID = "ui-fixture-mac"
  static let revision = String(repeating: "a", count: 64)
  static let credential = NativeEnrollmentCredential(
    origin: URL(string: "https://127.0.0.1:8444")!,
    certificateSha256: String(repeating: "b", count: 64),
    client: NativeClient(
      id: "ui-fixture-phone", role: "native_phone_controller", label: "UI fixture phone",
      grants: [
        NativeGrant(
          target: nodeID,
          capabilities: ["browser.read", "browser.control"])
      ],
      createdAt: 1, expiresAt: 2),
    token: String(repeating: "c", count: 64))
}

private struct BrowserVoiceUITestPhoneTransport: PhoneControlTransporting {
  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    [
      PhoneControlNode(
        id: BrowserVoiceUITestFixture.nodeID, label: "Fixture Mac", online: true,
        capabilities: ["browser.read", "browser.control"])
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

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    switch action {
    case .status:
      return .status(
        source: .webmcp, connected: true, revision: BrowserVoiceUITestFixture.revision)
    case .read:
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: .webmcp, revision: BrowserVoiceUITestFixture.revision,
          title: "Public videos", summary: "One observed public result",
          items: [BrowserPhoneItem(id: "public-video-1", label: "Public video", state: nil)]))
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
