import Foundation
import XCTest
@testable import Ellie

private actor AgendaFixtureClient: IOSAgendaClient {
    var listing: [IOSAgendaConnection] = []
    var result: IOSAgendaSnapshot?
    var failure: IOSAgendaFailure?
    var calls: [String] = []
    private var held: CheckedContinuation<IOSAgendaSnapshot, Error>?
    var holdAgenda = false

    func configure(_ listing: [IOSAgendaConnection], result: IOSAgendaSnapshot? = nil,
                   failure: IOSAgendaFailure? = nil, holdAgenda: Bool = false) {
        self.listing = listing; self.result = result; self.failure = failure
        self.holdAgenda = holdAgenda
    }
    func connections(_ credential: NativeEnrollmentCredential) async throws -> [IOSAgendaConnection] {
        calls.append("list")
        if let failure { throw failure }
        return listing
    }
    func agenda(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSAgendaSnapshot {
        calls.append("agenda:\(id)")
        if let failure { throw failure }
        if holdAgenda { return try await withCheckedThrowingContinuation { held = $0 } }
        guard let result else { throw IOSAgendaFailure.invalidResponse }
        return result
    }
    func release(_ value: IOSAgendaSnapshot) {
        held?.resume(returning: value)
        held = nil
    }
    func requestLog() -> [String] { calls }
    func awaitingAgenda() -> Bool { held != nil }
}

final class IOSGoogleAgendaTests: XCTestCase {
    private let account = IOSAgendaConnection(id: "calendar_123", label: "Fixture calendar",
        state: "connected", selectedCalendarId: "selected")

    private func credential(_ id: String = "phone-a") -> NativeEnrollmentCredential {
        NativeEnrollmentCredential(origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: id, role: "native_phone_controller", label: "Fixture",
                grants: [], createdAt: 1_800_000_000_000, expiresAt: 1_807_776_000_000),
            token: String(repeating: "c", count: 64))
    }

    private func snapshot(_ id: String = "calendar_123") -> IOSAgendaSnapshot {
        IOSAgendaSnapshot(connectionId: id, label: "Fixture calendar", state: "connected",
            selectedCalendarId: "selected", lastSyncAt: Date(), complete: true,
            horizonStart: Date(), horizonEnd: Date().addingTimeInterval(30 * 86_400),
            events: [IOSAgendaEvent(title: "Tomorrow", status: "confirmed",
                start: Date().addingTimeInterval(86_400), end: Date().addingTimeInterval(90_000),
                startDate: nil, endDate: nil, timeZone: "America/Los_Angeles")])
    }

    private func eventually(_ predicate: @escaping @MainActor () -> Bool) async {
        for _ in 0..<100 {
            if await predicate() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Agenda fixture did not settle")
    }

    @MainActor
    func testExplicitRefreshSelectionAndSessionOnlyCache() async throws {
        let client = AgendaFixtureClient()
        let original = snapshot()
        await client.configure([account], result: original)
        let suite = "ellie-agenda-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = IOSGoogleAgendaStore(client: client, defaults: defaults)
        store.bind(credential())
        let initialRequests = await client.requestLog()
        XCTAssertEqual(initialRequests, [], "rendering or binding must not read the network")
        store.refresh()
        await eventually { !store.isRefreshing }
        XCTAssertEqual(store.connections, [account])
        XCTAssertNil(store.snapshot)
        store.select(account.id)
        store.refresh()
        await eventually { !store.isRefreshing }
        XCTAssertEqual(store.snapshot, original)
        let completedRequests = await client.requestLog()
        XCTAssertEqual(completedRequests, ["list", "list", "agenda:calendar_123"])

        let relaunched = IOSGoogleAgendaStore(client: client, defaults: defaults)
        relaunched.bind(credential())
        XCTAssertEqual(relaunched.selectedID, account.id)
        XCTAssertNil(relaunched.snapshot, "private event cache must not survive relaunch")
        relaunched.bind(credential("phone-b"))
        XCTAssertNil(relaunched.selectedID, "another enrollment cannot inherit the selected account")
    }

    @MainActor
    func testRevocationClearsSelectionAndLateOtherEnrollmentReadCannotResurrect() async throws {
        let client = AgendaFixtureClient()
        let original = snapshot()
        await client.configure([account], result: original)
        let suite = "ellie-agenda-test-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = IOSGoogleAgendaStore(client: client, defaults: defaults)
        store.bind(credential())
        store.refresh(); await eventually { !store.isRefreshing }
        store.select(account.id)
        store.refresh(); await eventually { !store.isRefreshing }
        XCTAssertEqual(store.snapshot, original)

        await client.configure([account], result: original, failure: .revoked)
        store.refresh(); await eventually { !store.isRefreshing }
        XCTAssertNil(store.selectedID)
        XCTAssertNil(store.snapshot)
        XCTAssertTrue(store.message?.contains("removed") == true)

        await client.configure([account], result: original, holdAgenda: true)
        store.refresh(); await eventually { !store.isRefreshing }
        store.select(account.id)
        store.refresh()
        for _ in 0..<100 {
            if await client.awaitingAgenda() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let waiting = await client.awaitingAgenda()
        XCTAssertTrue(waiting)
        store.bind(credential("phone-b"))
        await client.release(original)
        await eventually { !store.isRefreshing }
        XCTAssertNil(store.snapshot)
        XCTAssertNil(store.selectedID)
    }

    func testWireRejectsForeignIdentityAndUnknownOrOversizedEvents() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let start = Int(now.timeIntervalSince1970 * 1_000)
        let valid = """
          {"connectionId":"calendar_123","label":"Fixture","state":"connected",
           "selectedCalendarId":"selected","lastSyncAt":\(start),"complete":true,
           "horizonStart":\(start),"horizonEnd":\(start + 30 * 86_400_000),
           "events":[{"title":"Tomorrow","status":"confirmed",
                      "startAt":\(start + 86_400_000),"endAt":\(start + 90_000_000)}]}
          """
        let parsed = try IOSAgendaWire.snapshot(Data(valid.utf8), expectedID: "calendar_123", now: now)
        XCTAssertEqual(parsed.events.map(\.title), ["Tomorrow"])
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.utf8), expectedID: "another", now: now))
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.replacingOccurrences(of: "\"status\":\"confirmed\"", with: "\"status\":\"cancelled\"").utf8), expectedID: "calendar_123", now: now))
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.replacingOccurrences(of: "\"title\":\"Tomorrow\"", with: "\"title\":\"Tomorrow\",\"token\":\"secret\"").utf8), expectedID: "calendar_123", now: now))
    }
}
