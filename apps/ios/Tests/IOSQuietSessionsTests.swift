import Foundation
import XCTest
@testable import Ellie

private actor QuietFixtureClient: IOSQuietClient {
    var calls: [String] = []
    var completedDetails: [String] = []
    var revoked = false
    var holdDetail = false
    var holdList = false
    var completedPages = 0
    private var held: CheckedContinuation<IOSQuietDetail, Error>?
    private var heldPage: CheckedContinuation<IOSQuietPage, Error>?
    let photo = IOSQuietSession(id: "photo_session", title: "Family photos",
        updatedAt: Date(timeIntervalSince1970: 1_800_000_000), turnCount: 1, pending: false)
    let trip = IOSQuietSession(id: "trip_session", title: "Trip planning",
        updatedAt: Date(timeIntervalSince1970: 1_800_000_100), turnCount: 1, pending: false)

    func sessions(_ credential: NativeEnrollmentCredential, limit: Int, cursor: String?) async throws -> IOSQuietPage {
        calls.append("list:\(limit)")
        if revoked { throw IOSQuietFailure.revoked }
        if holdList {
            holdList = false
            let page: IOSQuietPage = try await withCheckedThrowingContinuation { heldPage = $0 }
            completedPages += 1
            return page
        }
        return IOSQuietPage(sessions: limit == 3 ? [trip, photo] : [trip, photo],
            hasMore: false, nextCursor: nil)
    }
    func detail(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSQuietDetail {
        calls.append("detail:\(id)")
        if revoked { throw IOSQuietFailure.revoked }
        if holdDetail {
            holdDetail = false
            let value: IOSQuietDetail = try await withCheckedThrowingContinuation { held = $0 }
            completedDetails.append(id)
            return value
        }
        return result(id)
    }
    func result(_ id: String) -> IOSQuietDetail {
        IOSQuietDetail(session: id == photo.id ? photo : trip,
            originalRequest: id == photo.id ? "Review photos" : "Plan trip",
            turns: [IOSQuietTurn(id: "turn_\(id)", request: id == photo.id ? "Review photos" : "Plan trip",
                reply: "Reviewed", status: "completed", updatedAt: Date(timeIntervalSince1970: 1_800_000_000))],
            activity: [IOSQuietActivity(id: "task_\(id)", state: "running",
                updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                progress: ["Checking"], finding: nil, findingStale: false)],
            activityLimited: false, olderTurnsOmitted: false)
    }
    func setHold() { holdDetail = true }
    func setHoldList() { holdList = true }
    func pending() -> Bool { held != nil }
    func pendingPage() -> Bool { heldPage != nil }
    func pageCompletions() -> Int { completedPages }
    func release(_ id: String) { held?.resume(returning: result(id)); held = nil }
    func releasePage() {
        heldPage?.resume(returning: IOSQuietPage(sessions: [trip, photo], hasMore: false,
            nextCursor: nil))
        heldPage = nil
    }
    func revoke() { revoked = true }
    func requests() -> [String] { calls }
    func completed() -> [String] { completedDetails }
}

@MainActor
private final class QuietVoiceJournal: BrowserMutationUncertaintyPersisting {
    var token: String?
    var recordedScopes: [String] = []
    func pendingToken(for scope: String) throws -> String? { token }
    func recordIfClear(token value: String, for scope: String) throws -> Bool {
        guard token == nil else { return false }
        recordedScopes.append(scope)
        token = value
        return true
    }
    func clear(token value: String, for scope: String) throws -> BrowserMutationUncertaintyClearResult {
        guard token == value else { return .mismatch }
        token = nil
        return .cleared
    }
}

@MainActor
private final class QuietVoiceClientFixture: IOSQuietVoiceClient {
    var sends: [(String, String?)] = []
    var statusCalls = 0
    var failNextSend = false
    var statusNotFound = false
    func epoch(_ credential: NativeEnrollmentCredential) async throws -> Int { 1 }
    func send(_ credential: NativeEnrollmentCredential, body: Data) async throws
        -> IOSQuietChatOutcome {
        let value = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let requestID = try XCTUnwrap(value["requestId"] as? String)
        sends.append((requestID, value["conversationId"] as? String))
        if failNextSend {
            failNextSend = false
            throw IOSQuietFailure.unavailable
        }
        return IOSQuietChatOutcome(status: "completed", conversationID: "quiet_1",
            turnID: "turn_2", reply: "A read-only reply.", needsMacReview: false)
    }
    func status(_ credential: NativeEnrollmentCredential, requestID: String) async throws
        -> IOSQuietChatOutcome {
        statusCalls += 1
        if statusNotFound { throw IOSQuietFailure.notFound }
        return IOSQuietChatOutcome(status: "completed", conversationID: "quiet_1",
            turnID: "turn_1", reply: "The first read-only reply.", needsMacReview: false)
    }
}

final class IOSQuietSessionsTests: XCTestCase {
    private func json(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value)
    }
    private func credential(_ id: String = "phone-a") -> NativeEnrollmentCredential {
        NativeEnrollmentCredential(origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: id, role: "native_phone_controller", label: "Fixture",
                grants: [], createdAt: 1_800_000_000_000, expiresAt: 1_807_776_000_000),
            token: String(repeating: "c", count: 64))
    }
    @MainActor
    private func eventually(_ condition: @escaping @MainActor () -> Bool) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Quiet fixture did not settle")
    }

    func testPinnedQuietGETAndClosedWire() throws {
        XCTAssertEqual(NativeEnrollmentTransport.lifeQuietMaximumBytes(
            path: "/api/life/native/sessions?limit=3"), 24_000)
        XCTAssertEqual(NativeEnrollmentTransport.lifeQuietMaximumBytes(
            path: "/api/life/native/sessions?limit=20&cursor=abc_-"), 24_000)
        XCTAssertEqual(NativeEnrollmentTransport.lifeQuietMaximumBytes(
            path: "/api/life/native/sessions/photo_session"), 256_000)
        XCTAssertEqual(NativeEnrollmentTransport.lifeQuietMaximumBytes(
            path: "/api/life/native/chat/state"), 1_024)
        XCTAssertEqual(NativeEnrollmentTransport.lifeQuietMaximumBytes(
            path: "/api/life/native/chat/requests/native_820c96b1-b537-47e7-acce-d821bc4bacaa"), 16_384)
        for path in ["/api/life/native/sessions?scope=user:bob&limit=3",
                     "/api/life/native/sessions?limit=21",
                     "/api/life/native/sessions?limit=3&cursor=%2F",
                     "/api/life/native/sessions/photo_session?delete=1",
                     "/api/life/native/sessions/../trip_session",
                     "https://elsewhere.test/api/life/native/sessions?limit=3"] {
            XCTAssertNil(NativeEnrollmentTransport.lifeQuietMaximumBytes(path: path))
        }
        let page = try json(["sessions": [["id": "photo_session", "title": "Family photos",
            "updatedAt": "2027-01-15T08:00:00.000Z", "turnCount": 1, "pending": false]],
            "page": ["hasMore": false]])
        XCTAssertEqual(try IOSQuietWire.page(page).sessions.map(\.id), ["photo_session"])
        let unicodePage = try json(["sessions": [["id": "unicode_session",
            "title": "Family 👩‍👩‍👧‍👧\r\nphotos",
            "updatedAt": "2027-01-15T08:00:00.000Z", "turnCount": 1, "pending": false]],
            "page": ["hasMore": false]])
        XCTAssertEqual(try IOSQuietWire.page(unicodePage).sessions.first?.title,
            "Family 👩‍👩‍👧‍👧\r\nphotos")
        XCTAssertThrowsError(try IOSQuietWire.page(try json(["sessions": [[
            "id": "bad", "title": "bad\u{0000}",
            "updatedAt": "2027-01-15T08:00:00.000Z", "turnCount": 1, "pending": false]],
            "page": ["hasMore": false]])))
        let detail = try json(["session": ["id": "photo_session", "title": "Family photos",
                "updatedAt": "2027-01-15T08:00:00.000Z", "pending": false],
            "originalRequest": "Review photos",
            "turns": [["id": "turn_1", "request": "Review photos", "reply": "Reviewed",
                "status": "completed", "updatedAt": "2027-01-15T08:00:00.000Z"]],
            "activity": [["id": "photo.task:1@life/path", "state": "succeeded",
                "updatedAt": "2027-01-15T08:00:00.000Z", "progress": [],
                "finding": ["summary": "Albums checked", "citations": [[
                    "title": "Album register", "sourceId": "source.album:1@life/path",
                    "sourceRevision": 1]]]]],
            "activityLimited": false,
            "page": ["hasMore": false]])
        XCTAssertEqual(try IOSQuietWire.detail(detail, expectedID: "photo_session")
            .activity.first?.finding?.summary, "Albums checked")
        XCTAssertEqual(try IOSQuietWire.detail(detail, expectedID: "photo_session")
            .activity.first?.id, "photo.task:1@life/path")
        let unicodeDetail = try json(["session": ["id": "unicode_session",
                "title": "Family 👩‍👩‍👧‍👧\r\nphotos",
                "updatedAt": "2027-01-15T08:00:00.000Z", "pending": false],
            "originalRequest": "Family 👩‍👩‍👧‍👧\r\nphotos", "turns": [], "activity": [],
            "activityLimited": false, "page": ["hasMore": false]])
        XCTAssertEqual(try IOSQuietWire.detail(unicodeDetail,
            expectedID: "unicode_session").originalRequest, "Family 👩‍👩‍👧‍👧\r\nphotos")
        XCTAssertThrowsError(try IOSQuietWire.detail(detail, expectedID: "trip_session"))
        XCTAssertThrowsError(try IOSQuietWire.page(try json(["sessions": [],
            "page": ["hasMore": false], "token": "never expose"])))
        XCTAssertThrowsError(try IOSQuietWire.page(try json(["sessions": [],
            "page": ["hasMore": false], "chatEpoch": 1])))
        XCTAssertEqual(try IOSQuietWire.chatEpoch(try json([
            "chatEpoch": 1, "available": true])), 1)
        XCTAssertThrowsError(try IOSQuietWire.chatEpoch(try json([
            "chatEpoch": 1, "available": false])))
        let requestID = "820c96b1-b537-47e7-acce-d821bc4bacaa"
        let multilingual = String(repeating: "日", count: 900)
        let encoded = try IOSPinnedQuietVoiceClient.encodedBody(requestID: requestID,
            epoch: 1, message: multilingual, conversationID: nil)
        XCTAssertTrue(encoded.count <= 4_096)
        XCTAssertEqual((try JSONSerialization.jsonObject(with: encoded) as? [String: Any])?["message"] as? String,
            multilingual)
        XCTAssertThrowsError(try IOSPinnedQuietVoiceClient.encodedBody(requestID: requestID,
            epoch: 1, message: String(repeating: "日", count: 2_000), conversationID: nil))
        XCTAssertEqual(try IOSQuietWire.chatOutcome(try json([
            "status": "completed", "conversationId": "quiet_1", "turnId": "turn_1",
            "reply": "Review 👩‍👩‍👧‍👧\r\ncomplete", "needsMacReview": true])).needsMacReview, true)
        XCTAssertThrowsError(try IOSQuietWire.page(try json(["sessions": [],
            "page": ["hasMore": true]])))
    }

    func testDecodesExactProductionLifeDetailFixtureWithOpaqueIdentifiers() throws {
        let url = try XCTUnwrap(Bundle(for: IOSQuietSessionsTests.self)
            .url(forResource: "QuietNativeDetail", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let detail = try IOSQuietWire.detail(data, expectedID: "quiet_1")
        XCTAssertEqual(detail.originalRequest, "Review the albums")
        XCTAssertEqual(detail.activity.first?.id, "photo.task:1")
        XCTAssertEqual(detail.activity.first?.progress, ["Checked three albums"])
        XCTAssertEqual(detail.activity.first?.finding?.summary, "Three albums checked.")
        XCTAssertEqual(detail.activity.first?.finding?.citations, ["Album register"])
    }

    @MainActor
    func testAllSessionsCancelClearsAndExplicitRefreshRecovers() async {
        let client = QuietFixtureClient(), store = IOSQuietSessionsStore(client: client)
        store.bind(credential())
        await client.setHoldList()
        store.loadAll()
        for _ in 0..<100 {
            if await client.pendingPage() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let pendingPage = await client.pendingPage()
        XCTAssertTrue(pendingPage)
        XCTAssertTrue(store.busy)
        store.cancel()
        XCTAssertFalse(store.busy)
        XCTAssertTrue(store.all.isEmpty)
        XCTAssertTrue(store.notice?.contains("cancelled") == true)
        await client.releasePage()
        let completionDeadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < completionDeadline {
            if await client.pageCompletions() == 1 { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let completions = await client.pageCompletions()
        XCTAssertEqual(completions, 1, "The held list client did not settle after release")
        let observationEnd = ContinuousClock.now + .milliseconds(250)
        while ContinuousClock.now < observationEnd {
            XCTAssertTrue(store.all.isEmpty)
            try? await Task.sleep(for: .milliseconds(20))
        }
        store.loadAll()
        await eventually { !store.busy && store.all.count == 2 }
        XCTAssertEqual(store.all.map(\.id), ["trip_session", "photo_session"])
    }

    @MainActor
    func testVoiceUnknownSurvivesRelaunchAndReconcilesWithoutResend() async {
        let client = QuietVoiceClientFixture(), journal = QuietVoiceJournal()
        client.failNextSend = true
        let first = IOSQuietVoiceStore(credential: credential(), client: client, journal: journal)
        first.restore()
        first.sendReviewed("What happened with our trip?", conversationID: "quiet_1")
        await eventually { first.phase == .unknown }
        XCTAssertEqual(client.sends.count, 1)
        XCTAssertNotNil(journal.token)
        let restored = IOSQuietVoiceStore(credential: credential(), client: client, journal: journal)
        restored.restore()
        XCTAssertEqual(restored.phase, .unknown)
        XCTAssertFalse(restored.canSend)
        restored.reconcile()
        await eventually {
            if case .completed = restored.phase { return true }
            return false
        }
        XCTAssertEqual(client.sends.count, 1, "a status read never resends a question")
        XCTAssertEqual(client.statusCalls, 1)
        XCTAssertNil(journal.token)
        restored.reset()
        restored.sendReviewed("What is next for our trip?")
        await eventually {
            if case .completed = restored.phase { return client.sends.count == 2 }
            return false
        }
        XCTAssertEqual(client.sends[1].1, "quiet_1", "a deliberate next question stays in the conversation")
        XCTAssertNotEqual(client.sends[0].0, client.sends[1].0)
        XCTAssertEqual(Set(journal.recordedScopes).count, 1)
        restored.background()
        XCTAssertEqual(restored.phase, .idle, "backgrounding removes the private reply")
        restored.credentialDidChange()
        XCTAssertEqual(restored.phase, .revoked)
        XCTAssertFalse(restored.canSend)
    }

    @MainActor
    func testVoiceStopTrackingUsesExactTokenAndNeverResends() async {
        let client = QuietVoiceClientFixture(), journal = QuietVoiceJournal()
        client.failNextSend = true
        let store = IOSQuietVoiceStore(credential: credential(), client: client, journal: journal)
        store.sendReviewed("Read this question")
        await eventually { store.phase == .unknown }
        let original = journal.token
        journal.token = UUID().uuidString.lowercased()
        store.stopTracking()
        XCTAssertEqual(store.phase, .storageUnavailable)
        XCTAssertNotEqual(journal.token, original, "a newer marker cannot be cleared")
        XCTAssertEqual(client.sends.count, 1)
        XCTAssertEqual(client.statusCalls, 0)

        let secondJournal = QuietVoiceJournal(), secondClient = QuietVoiceClientFixture()
        secondClient.failNextSend = true
        let second = IOSQuietVoiceStore(credential: credential(), client: secondClient,
            journal: secondJournal)
        second.sendReviewed("Another reviewed question")
        await eventually { second.phase == .unknown }
        secondClient.statusNotFound = true
        second.reconcile()
        await eventually { second.phase == .notFound }
        XCTAssertNotNil(secondJournal.token, "404 cannot prove an in-flight POST will not arrive")
        second.stopTracking()
        XCTAssertEqual(second.phase, .idle)
        XCTAssertNil(secondJournal.token)
        XCTAssertEqual(secondClient.sends.count, 1)
        XCTAssertEqual(secondClient.statusCalls, 0)
    }

    @MainActor
    func testVoiceEncodedBodyLimitFailsBeforeDurableMarkerOrPOST() async {
        let client = QuietVoiceClientFixture(), journal = QuietVoiceJournal()
        let store = IOSQuietVoiceStore(credential: credential(), client: client, journal: journal)
        store.sendReviewed(String(repeating: "日", count: 2_000))
        await eventually {
            if case .failed = store.phase { return true }
            return false
        }
        XCTAssertNil(journal.token)
        XCTAssertTrue(journal.recordedScopes.isEmpty)
        XCTAssertTrue(client.sends.isEmpty)
        XCTAssertTrue(store.canSend)
    }

    @MainActor
    func testLateDetailCannotResurrectOtherSessionOrRevokedAccess() async {
        let client = QuietFixtureClient(), store = IOSQuietSessionsStore(client: client)
        store.bind(credential())
        store.refreshRecent()
        await eventually { store.recent.count == 2 }
        await client.setHold()
        store.open("photo_session")
        for _ in 0..<100 {
            if await client.pending() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let pending = await client.pending()
        XCTAssertTrue(pending)
        store.open("trip_session")
        await eventually { store.detail?.session.id == "trip_session" }
        await client.release("photo_session")
        for _ in 0..<100 {
            if await client.completed().contains("photo_session") { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let completedPhoto = await client.completed().contains("photo_session")
        XCTAssertTrue(completedPhoto)
        for _ in 0..<20 {
            await Task.yield()
            XCTAssertEqual(store.detail?.session.id, "trip_session")
        }
        await client.setHold()
        store.open("trip_session")
        for _ in 0..<100 {
            if await client.pending() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let pendingTrip = await client.pending()
        XCTAssertTrue(pendingTrip)
        store.cancel()
        await client.release("trip_session")
        for _ in 0..<100 {
            if await client.completed().contains("trip_session") { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let completedTrip = await client.completed().contains("trip_session")
        XCTAssertTrue(completedTrip)
        for _ in 0..<20 {
            await Task.yield()
            XCTAssertNil(store.detail)
        }
        XCTAssertTrue(store.recent.isEmpty)
        store.open("trip_session")
        await eventually { store.detail?.session.id == "trip_session" }
        store.background()
        XCTAssertNil(store.detail)
        store.open("trip_session")
        await eventually { store.detail?.session.id == "trip_session" }
        store.bind(credential("phone-b"))
        XCTAssertNil(store.detail)
        XCTAssertTrue(store.recent.isEmpty)
        await client.revoke()
        store.refreshRecent()
        await eventually { store.notice != nil }
        XCTAssertTrue(store.recent.isEmpty)
        XCTAssertTrue(store.notice?.contains("access was removed") == true)
        let requests = await client.requests()
        XCTAssertEqual(requests, ["list:3", "detail:photo_session",
            "detail:trip_session", "detail:trip_session", "detail:trip_session",
            "detail:trip_session", "list:3"])
    }
}
