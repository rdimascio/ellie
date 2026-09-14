import Foundation
import XCTest
@testable import Ellie

final class ChoresModelTests: XCTestCase {
    func testStrictDateValidationAndRoundTrip() throws {
        XCTAssertThrowsError(try ChoreDay("2026-02-29"))
        XCTAssertThrowsError(try ChoreDay("2026-2-09"))
        XCTAssertThrowsError(try ChoreDay("+026-01-01"))
        let state = ChoresState(householdTimeZone: "America/Los_Angeles", chores: [
            Chore(id: UUID().uuidString, title: "Water plants", member: "Alex", dueDay: try ChoreDay("2026-09-13")),
        ])
        XCTAssertEqual(try ChoresModel.decode(ChoresModel.encode(state)), state)
    }

    func testRejectsFutureVersionDuplicatesUnknownFieldsAndBounds() throws {
        let id = UUID().uuidString
        let documents = [
            #"{"version":2,"householdTimeZone":"UTC","chores":[]}"#,
            #"{"version":1,"householdTimeZone":"UTC","chores":[],"extra":true}"#,
            #"{"version":1,"householdTimeZone":"UTC","chores":[{"id":"\#(id)","title":"One","member":"A","body":"","dueDay":"2026-09-13","completedDay":null},{"id":"\#(id)","title":"Two","member":"B","body":"","dueDay":"2026-09-14","completedDay":null}]}"#,
            #"{"version":1,"householdTimeZone":"Not/AZone","chores":[]}"#,
        ]
        for document in documents { XCTAssertThrowsError(try ChoresModel.decode(Data(document.utf8))) }
        XCTAssertThrowsError(try ChoresModel.decode(Data(repeating: 0x20, count: ChoresModel.maximumSerializedBytes + 1)))
    }

    func testHouseholdDayAndMondayWeekAcrossDST() throws {
        let zone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let instant = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-11-01T07:30:00Z"))
        XCTAssertEqual(ChoreDay.from(instant, timeZone: zone), try ChoreDay("2026-11-01"))
        XCTAssertEqual(ChoresModel.weekDays(containing: try ChoreDay("2026-11-01"), timeZone: zone).map(\.value),
                       ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"])

        let monday = try ChoreDay("2026-09-14")
        XCTAssertEqual(monday.date(in: zone), ISO8601DateFormatter().date(from: "2026-09-14T07:00:00Z"))
        XCTAssertEqual(ChoresModel.weekDays(containing: monday, timeZone: zone).first, monday)
        XCTAssertFalse(ChoresModel.weekDays(containing: try ChoreDay("0001-01-01"), timeZone: zone).isEmpty)
        XCTAssertFalse(ChoresModel.weekDays(containing: try ChoreDay("9999-12-31"), timeZone: zone).isEmpty)
    }

    func testEnforcesTaskAndTextBounds() throws {
        let day = try ChoreDay("2026-09-13")
        let tooMany = (0...ChoresModel.maximumChores).map { Chore(id: UUID().uuidString, title: "Task \($0)", member: "A", dueDay: day) }
        XCTAssertThrowsError(try ChoresModel.encode(ChoresState(householdTimeZone: "UTC", chores: tooMany)))
        XCTAssertThrowsError(try encode(title: String(repeating: "a", count: ChoresModel.maximumTitleLength + 1), member: "A", body: "", day: day))
        XCTAssertThrowsError(try encode(title: "Task", member: String(repeating: "a", count: ChoresModel.maximumMemberLength + 1), body: "", day: day))
        XCTAssertThrowsError(try encode(title: "Task", member: "A", body: String(repeating: "a", count: ChoresModel.maximumBodyLength + 1), day: day))
    }

    @MainActor
    func testCompleteUndoDeleteAndPrivatePersistence() async throws {
        let location = temporaryLocation()
        let store = ChoresStore(fileURL: location, defaultTimeZone: TimeZone(identifier: "UTC")!)
        store.add(title: "Bins", member: "Sam", dueDay: try ChoreDay("2026-09-13"))
        let id = try XCTUnwrap(store.state.chores.first?.id)
        store.setCompleted(id: id, completed: true, now: ISO8601DateFormatter().date(from: "2026-09-14T01:00:00Z")!)
        XCTAssertEqual(store.state.chores.first?.completedDay, try ChoreDay("2026-09-14"))
        store.setCompleted(id: id, completed: false)
        XCTAssertNil(store.state.chores.first?.completedDay)
        XCTAssertEqual(ChoresStore(fileURL: location).state.chores.count, 1)
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: location.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)
        store.delete(id: id)
        XCTAssertTrue(store.state.chores.isEmpty)
    }

    @MainActor
    func testCorruptFileIsPreservedAndBlocksWrites() async throws {
        let location = temporaryLocation()
        try FileManager.default.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
        let corrupt = Data("broken".utf8)
        try corrupt.write(to: location)
        let store = ChoresStore(fileURL: location)
        XCTAssertNotNil(store.error)
        store.add(title: "Must not save", member: "Nobody", dueDay: try ChoreDay("2026-09-13"))
        XCTAssertEqual(try Data(contentsOf: location), corrupt)
        XCTAssertTrue(store.state.chores.isEmpty)
    }

    private func temporaryLocation() -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("EllieChoresTests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("choresv1.json")
    }

    private func encode(title: String, member: String, body: String, day: ChoreDay) throws -> Data {
        try ChoresModel.encode(ChoresState(householdTimeZone: "UTC", chores: [
            Chore(id: UUID().uuidString, title: title, member: member, body: body, dueDay: day),
        ]))
    }
}
