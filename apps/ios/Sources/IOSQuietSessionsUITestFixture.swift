#if DEBUG
import Foundation
import SwiftUI

private actor IOSQuietFixtureClient: IOSQuietClient {
    private var revoked = false
    func sessions(_ credential: NativeEnrollmentCredential, limit: Int, cursor: String?) async throws -> IOSQuietPage {
        if revoked { throw IOSQuietFailure.revoked }
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        return IOSQuietPage(sessions: [
            IOSQuietSession(id: "trip_session", title: "Plan the family trip", updatedAt: at,
                turnCount: 1, pending: false),
            IOSQuietSession(id: "photo_session", title: "Sort family photos", updatedAt: at,
                turnCount: 1, pending: false),
            IOSQuietSession(id: "gift_session", title: "Find a birthday gift", updatedAt: at,
                turnCount: 1, pending: false),
        ], hasMore: false, nextCursor: nil)
    }
    func detail(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSQuietDetail {
        if revoked { throw IOSQuietFailure.revoked }
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        let title = id == "trip_session" ? "Plan the family trip" :
            id == "photo_session" ? "Sort family photos" : "Find a birthday gift"
        return IOSQuietDetail(session: IOSQuietSession(id: id, title: title, updatedAt: at,
                turnCount: 1, pending: false),
            originalRequest: "Review \(title)",
            turns: [IOSQuietTurn(id: "turn_\(id)", request: "Review \(title)",
                reply: "Here is the current review.", status: "completed", updatedAt: at)],
            activity: [IOSQuietActivity(id: "task_\(id)", state: id == "trip_session" ? "running" : "succeeded",
                updatedAt: at, progress: ["Checked current details"],
                finding: id == "trip_session" ? nil : IOSQuietFinding(
                    summary: "The review is complete.", citations: ["Saved source"]),
                findingStale: false)], activityLimited: false, olderTurnsOmitted: false)
    }
    func revoke() { revoked = true }
}

@MainActor
struct IOSQuietSessionsUITestFixtureView: View {
    @StateObject private var store: IOSQuietSessionsStore
    @StateObject private var voice: IOSQuietVoiceStore
    private let client: IOSQuietFixtureClient
    private let credential: NativeEnrollmentCredential

    init() {
        let client = IOSQuietFixtureClient()
        let credential = NativeEnrollmentCredential(
            origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: "fixture-phone", role: "native_phone_controller",
                label: "Fixture", grants: [], createdAt: 1_800_000_000_000,
                expiresAt: 1_807_776_000_000),
            token: String(repeating: "c", count: 64))
        self.client = client
        self.credential = credential
        _store = StateObject(wrappedValue: IOSQuietSessionsStore(client: client))
        _voice = StateObject(wrappedValue: IOSQuietVoiceStore(credential: credential,
            client: IOSQuietUnavailableVoiceFixtureClient(),
            journal: IOSQuietMemoryMarkerFixture()))
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 10) {
                    IOSQuietSessionsHome(store: store, credential: credential,
                        uiTestVoiceStore: voice)
                    Button("Revoke fixture grant") {
                        Task { await client.revoke(); store.refreshRecent() }
                    }
                    .accessibilityIdentifier("quiet-fixture-revoke")
                }
                .padding(20)
            }
            .ellieScreen()
        }
    }
}

@MainActor
private struct IOSQuietUnavailableVoiceFixtureClient: IOSQuietVoiceClient {
    func epoch(_ credential: NativeEnrollmentCredential) async throws -> Int {
        throw IOSQuietFailure.unavailable
    }
    func send(_ credential: NativeEnrollmentCredential, body: Data) async throws
        -> IOSQuietChatOutcome { throw IOSQuietFailure.unavailable }
    func status(_ credential: NativeEnrollmentCredential, requestID: String) async throws
        -> IOSQuietChatOutcome { throw IOSQuietFailure.unavailable }
}

@MainActor
private final class IOSQuietMemoryMarkerFixture: BrowserMutationUncertaintyPersisting {
    private var marker: String?
    func pendingToken(for scope: String) throws -> String? { marker }
    func recordIfClear(token: String, for scope: String) throws -> Bool {
        guard marker == nil else { return false }
        marker = token
        return true
    }
    func clear(token: String, for scope: String) throws -> BrowserMutationUncertaintyClearResult {
        guard marker == token else { return .mismatch }
        marker = nil
        return .cleared
    }
}

private actor IOSQuietVoiceFixtureRecorder: SpeechRecording {
    func start() async throws {}
    func stop() async throws -> SpeechAudioArtifact {
        SpeechAudioArtifact(id: UUID(), url: URL(fileURLWithPath: "/dev/null"))
    }
    func cancel() async throws {}
    func dispose(_ artifact: SpeechAudioArtifact) async throws {}
}

private actor IOSQuietVoiceFixtureSpeech: SpeechTransporting {
    private var index = 0
    func availability(for credential: NativeEnrollmentCredential) async throws {}
    func transcribe(_ artifact: SpeechAudioArtifact, turnID: UUID,
        credential: NativeEnrollmentCredential) async throws -> String {
        defer { index += 1 }
        return ["What did we plan?", "What happens next?", "One more question?"][min(index, 2)]
    }
    func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async {}
}

@MainActor
private final class IOSQuietVoiceFixtureClient: ObservableObject, IOSQuietVoiceClient {
    @Published private(set) var sends = 0
    @Published private(set) var statusReads = 0
    @Published private(set) var conversationIDs: [String?] = []
    func epoch(_ credential: NativeEnrollmentCredential) async throws -> Int { 1 }
    func send(_ credential: NativeEnrollmentCredential, body: Data) async throws
        -> IOSQuietChatOutcome {
        let value = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        sends += 1
        conversationIDs.append(value?["conversationId"] as? String)
        if sends == 3 { throw IOSQuietFailure.unavailable }
        return IOSQuietChatOutcome(status: "completed", conversationID: "quiet_fixture",
            turnID: "turn_\(sends)", reply: "Read-only reply \(sends).", needsMacReview: false)
    }
    func status(_ credential: NativeEnrollmentCredential, requestID: String) async throws
        -> IOSQuietChatOutcome {
        statusReads += 1
        throw IOSQuietFailure.revoked
    }
}

@MainActor
struct IOSQuietVoiceUITestFixtureView: View {
    @StateObject private var client: IOSQuietVoiceFixtureClient
    @StateObject private var speech: SpeechTurnStore
    @StateObject private var life: IOSQuietVoiceStore
    @StateObject private var controls: PhoneControlStore
    @StateObject private var browser: BrowserPhoneControlStore
    private let credential: NativeEnrollmentCredential

    init() {
        let credential = NativeEnrollmentCredential(
            origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: "fixture-phone", role: "native_phone_controller",
                label: "Fixture", grants: [], createdAt: 1_800_000_000_000,
                expiresAt: 1_807_776_000_000),
            token: String(repeating: "c", count: 64))
        let client = IOSQuietVoiceFixtureClient()
        self.credential = credential
        _client = StateObject(wrappedValue: client)
        _speech = StateObject(wrappedValue: SpeechTurnStore(credential: credential,
            recorder: IOSQuietVoiceFixtureRecorder(), transport: IOSQuietVoiceFixtureSpeech()))
        _life = StateObject(wrappedValue: IOSQuietVoiceStore(credential: credential,
            client: client, journal: IOSQuietMemoryMarkerFixture()))
        _controls = StateObject(wrappedValue: PhoneControlStore(credential: credential))
        _browser = StateObject(wrappedValue: BrowserPhoneControlStore(credential: credential,
            uncertainty: IOSQuietMemoryMarkerFixture()))
    }
    var body: some View {
        NavigationStack {
            SpeechTurnView(credential: credential, controls: controls, browser: browser,
                speech: speech, lifeReview: life)
        }
        .overlay(alignment: .bottomTrailing) {
            VStack {
                Text("Fixture sends: \(client.sends)")
                    .accessibilityIdentifier("quiet-voice-fixture-sends")
                Text("Fixture status reads: \(client.statusReads)")
                    .accessibilityIdentifier("quiet-voice-fixture-status")
                Text("Fixture follow-up bound: \(client.conversationIDs.dropFirst().first == "quiet_fixture")")
                    .accessibilityIdentifier("quiet-voice-fixture-follow-up")
            }.font(.caption2).padding(4).allowsHitTesting(false)
        }
    }
}
#endif
