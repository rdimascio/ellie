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
    private let client: IOSQuietFixtureClient
    private let credential = NativeEnrollmentCredential(
        origin: URL(string: "https://127.0.0.1:8444")!,
        certificateSha256: String(repeating: "b", count: 64),
        client: NativeClient(id: "fixture-phone", role: "native_phone_controller",
            label: "Fixture", grants: [], createdAt: 1_800_000_000_000,
            expiresAt: 1_807_776_000_000),
        token: String(repeating: "c", count: 64))

    init() {
        let client = IOSQuietFixtureClient()
        self.client = client
        _store = StateObject(wrappedValue: IOSQuietSessionsStore(client: client))
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 10) {
                    IOSQuietSessionsHome(store: store, credential: credential)
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
#endif
