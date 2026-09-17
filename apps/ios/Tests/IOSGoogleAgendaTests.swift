import Foundation
import XCTest
@testable import Ellie

private actor AgendaFixtureClient: IOSAgendaClient {
    var listing: [IOSAgendaConnection] = []
    var result: IOSAgendaSnapshot?
    var listingFailure: IOSAgendaFailure?
    var agendaFailure: IOSAgendaFailure?
    var calls: [String] = []
    private var held: CheckedContinuation<IOSAgendaSnapshot, Error>?
    var holdAgenda = false

    func configure(_ listing: [IOSAgendaConnection], result: IOSAgendaSnapshot? = nil,
                   listingFailure: IOSAgendaFailure? = nil,
                   agendaFailure: IOSAgendaFailure? = nil, holdAgenda: Bool = false) {
        self.listing = listing; self.result = result
        self.listingFailure = listingFailure; self.agendaFailure = agendaFailure
        self.holdAgenda = holdAgenda
    }
    func connections(_ credential: NativeEnrollmentCredential) async throws -> [IOSAgendaConnection] {
        calls.append("list")
        if let listingFailure { throw listingFailure }
        return listing
    }
    func agenda(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSAgendaSnapshot {
        calls.append("agenda:\(id)")
        if let agendaFailure { throw agendaFailure }
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

    private func credential(_ id: String = "phone-a", expiry: Int64 = 1_807_776_000_000) -> NativeEnrollmentCredential {
        NativeEnrollmentCredential(origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: id, role: "native_phone_controller", label: "Fixture",
                grants: [], createdAt: 1_800_000_000_000, expiresAt: expiry),
            token: String(repeating: "c", count: 64))
    }

    private func snapshot(_ id: String = "calendar_123", selectedCalendar: String = "selected") -> IOSAgendaSnapshot {
        IOSAgendaSnapshot(connectionId: id, label: "Fixture calendar", state: "connected",
            selectedCalendarId: selectedCalendar, displayTimeZone: TimeZone.current.identifier,
            lastSyncAt: Date(), complete: true,
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

        await client.configure([account], result: original, listingFailure: .revoked)
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

    @MainActor
    func testCalendarChangeInvalidatesOldEventsBeforeFailedReadAndCredentialRevisionInvalidatesMemory() async throws {
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

        let changed = IOSAgendaConnection(id: account.id, label: account.label,
            state: "connected", selectedCalendarId: "other-calendar")
        await client.configure([changed], result: original, agendaFailure: .unavailable)
        store.refresh(); await eventually { !store.isRefreshing }
        XCTAssertNil(store.snapshot, "A failed read of calendar B must not retain calendar A events")
        XCTAssertEqual(store.selectedID, account.id)

        let replacement = snapshot(selectedCalendar: "other-calendar")
        await client.configure([changed], result: replacement)
        store.refresh(); await eventually { !store.isRefreshing }
        XCTAssertEqual(store.snapshot, replacement)
        store.bind(credential(expiry: 1_807_775_000_000))
        XCTAssertNil(store.snapshot, "changed grants or expiry must invalidate even with the same token")
        XCTAssertEqual(store.selectedID, account.id)

        await client.configure([])
        store.refresh(); await eventually { !store.isRefreshing }
        XCTAssertNil(store.selectedID, "a connection absent from a fresh actor listing must be forgotten")
    }

    func testWireRejectsForeignIdentityAndUnknownOrOversizedEvents() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let start = Int(now.timeIntervalSince1970 * 1_000)
        let valid = """
          {"connectionId":"calendar_123","label":"Fixture","state":"connected",
           "selectedCalendarId":"selected","displayTimeZone":"\(TimeZone.current.identifier)",
           "lastSyncAt":\(start),"complete":true,
           "horizonStart":\(start),"horizonEnd":\(start + 30 * 86_400_000),
           "events":[{"title":"Tomorrow","status":"confirmed",
                      "startAt":\(start + 86_400_000),"endAt":\(start + 90_000_000)}]}
          """
        let parsed = try IOSAgendaWire.snapshot(Data(valid.utf8), expectedID: "calendar_123", now: now)
        XCTAssertEqual(parsed.events.map(\.title), ["Tomorrow"])
        let unicode = valid.replacingOccurrences(of: "Tomorrow", with: "家族 🗓️")
            .replacingOccurrences(of: "\"Fixture\"", with: "\"日程 🗓️\"")
        XCTAssertEqual(try IOSAgendaWire.snapshot(Data(unicode.utf8),
            expectedID: "calendar_123", now: now).events.map(\.title), ["家族 🗓️"])
        let joined = valid.replacingOccurrences(of: "Tomorrow", with: "Family 👩‍👩‍👧‍👦")
            .replacingOccurrences(of: "\"Fixture\"", with: "\"Family 👩‍👩‍👧‍👦 calendar\"")
        let joinedSnapshot = try IOSAgendaWire.snapshot(Data(joined.utf8),
            expectedID: "calendar_123", now: now)
        XCTAssertEqual(joinedSnapshot.label, "Family 👩‍👩‍👧‍👦 calendar")
        XCTAssertEqual(joinedSnapshot.events.map(\.title), ["Family 👩‍👩‍👧‍👦"])
        let control = valid.replacingOccurrences(of: "Tomorrow", with: "Unsafe\\u0007title")
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(control.utf8),
            expectedID: "calendar_123", now: now))
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.utf8), expectedID: "another", now: now))
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.replacingOccurrences(of: "\"status\":\"confirmed\"", with: "\"status\":\"cancelled\"").utf8), expectedID: "calendar_123", now: now))
        XCTAssertThrowsError(try IOSAgendaWire.snapshot(Data(valid.replacingOccurrences(of: "\"title\":\"Tomorrow\"", with: "\"title\":\"Tomorrow\",\"token\":\"secret\"").utf8), expectedID: "calendar_123", now: now))
    }

    func testAllDayExclusiveEndAtLocalMidnightAndOngoingMultiDayPresentation() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let now = Date(timeIntervalSince1970: 1_789_628_400) // 2026-09-17 00:00 PDT.
        let events = [
            IOSAgendaEvent(title: "Ended", status: "confirmed", start: nil, end: nil,
                startDate: "2026-09-16", endDate: "2026-09-17", timeZone: nil),
            IOSAgendaEvent(title: "Ongoing", status: "confirmed", start: nil, end: nil,
                startDate: "2026-09-15", endDate: "2026-09-18", timeZone: nil),
            IOSAgendaEvent(title: "Ended timed", status: "confirmed",
                start: now.addingTimeInterval(-3_600), end: now,
                startDate: nil, endDate: nil, timeZone: nil),
        ]
        let value = IOSAgendaSnapshot(connectionId: "calendar_123", label: "Fixture", state: "connected",
            selectedCalendarId: "selected", displayTimeZone: zone.identifier,
            lastSyncAt: now, complete: true, horizonStart: now,
            horizonEnd: now.addingTimeInterval(30 * 86_400), events: events)
        XCTAssertEqual(IOSAgendaPresentation.upcoming(value, at: now, timeZone: zone).map(\.title),
            ["Ongoing"])
        XCTAssertEqual(IOSAgendaPresentation.upcoming(value, at: now, timeZone: .gmt).count, 0)
    }
}
