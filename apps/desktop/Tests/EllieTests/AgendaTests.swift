import Darwin
import XCTest

@testable import Ellie

final class AgendaTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_789_300_000)
  func testNormalizesTimedAndAllDayEventsWithProvenance() throws {
    let data = Data(
      ##"{"version":1,"source":{"id":"import-1","name":"Team export"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[{"id":"work","name":"Work","color":"#3366AA"}],"events":[{"id":"b","calendarID":"work","title":"Later","start":"2026-09-15T17:00:00Z","end":"2026-09-15T18:00:00Z","timeZone":"America/Los_Angeles"},{"id":"a","calendarID":"work","title":"All day","startDate":"2026-09-14","endDate":"2026-09-15"}]}"##
        .utf8)
    let result = try AgendaModel.decode(data, now: now)
    XCTAssertEqual(result.events.map(\.id), ["a", "b"])
    XCTAssertTrue(result.events[0].isAllDay)
    XCTAssertEqual(result.calendars[0].id, result.events[0].calendarID)
  }
  func testAllDayAndTimedEndsAreExclusiveAcrossDST() throws {
    let data = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00.125Z","calendars":[{"id":"c","name":"C"}],"events":[{"id":"day","calendarID":"c","title":"Day","startDate":"2026-11-01","endDate":"2026-11-02"},{"id":"timed","calendarID":"c","title":"Timed","start":"2026-11-01T08:00:00Z","end":"2026-11-01T09:00:00Z","timeZone":"America/Los_Angeles"}]}"##
        .utf8)
    let snapshot = try AgendaModel.decode(data, now: now)
    let zone = TimeZone(identifier: "America/Los_Angeles")!
    XCTAssertEqual(
      snapshot.relevantEvents(
        at: ISO8601DateFormatter().date(from: "2026-11-02T07:59:59Z")!, displayTimeZone: zone
      ).map(\.id), ["day"])
    XCTAssertTrue(
      snapshot.relevantEvents(
        at: ISO8601DateFormatter().date(from: "2026-11-02T08:00:00Z")!, displayTimeZone: zone
      ).isEmpty)
    XCTAssertFalse(
      snapshot.events.first { $0.id == "timed" }!.isRelevant(
        at: ISO8601DateFormatter().date(from: "2026-11-01T09:00:00Z")!, displayTimeZone: zone))
  }
  func testPresentationOrderUsesDisplayZoneCivilStart() throws {
    let data = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[{"id":"c","name":"C"}],"events":[{"id":"market","calendarID":"c","title":"Farmers market","startDate":"2026-09-14","endDate":"2026-09-15"},{"id":"supper","calendarID":"c","title":"Sunday supper","start":"2026-09-14T01:00:00Z","end":"2026-09-14T02:00:00Z","timeZone":"America/Los_Angeles"}]}"##
        .utf8)
    let snapshot = try AgendaModel.decode(data, now: now)
    let zone = TimeZone(identifier: "America/Los_Angeles")!
    XCTAssertEqual(
      snapshot.relevantEvents(at: now, displayTimeZone: zone).map(\.id), ["supper", "market"])
  }
  func testTiedStartsSortByCalendarAndIDAndUnknownFieldsFail() throws {
    let tied = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[{"id":"c","name":"C"}],"events":[{"id":"z","calendarID":"c","title":"Z","startDate":"2026-09-14","endDate":"2026-09-15"},{"id":"a","calendarID":"c","title":"A","startDate":"2026-09-14","endDate":"2026-09-15"}]}"##
        .utf8)
    XCTAssertEqual(try AgendaModel.decode(tied, now: now).events.map(\.id), ["a", "z"])
    let unknown = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[],"events":[],"secret":true}"##
        .utf8)
    XCTAssertThrowsError(try AgendaModel.decode(unknown, now: now))
  }
  @MainActor func testCorruptCacheCanClearAndNeverRecursivelyDeletesDirectory() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-agenda-corrupt-\(UUID())")
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let url = dir.appendingPathComponent("agenda.json")
    try Data("bad".utf8).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    let corrupt = AgendaStore(fileURL: url, now: { self.now })
    XCTAssertTrue(corrupt.canClear)
    corrupt.disconnect()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
    let unsafe = AgendaStore(fileURL: url, now: { self.now })
    unsafe.disconnect()
    var isDirectory: ObjCBool = false
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory))
    XCTAssertTrue(isDirectory.boolValue)
    XCTAssertTrue(unsafe.canClear)
  }
  @MainActor func testFailedPersistenceAndDisconnectRaceDoNotPublish() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-agenda-fail-\(UUID())")
    defer { try? FileManager.default.removeItem(at: dir) }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let parent = dir.appendingPathComponent("file")
    try Data().write(to: parent)
    let failing = AgendaStore(
      fileURL: parent.appendingPathComponent("agenda.json"), now: { self.now })
    let valid = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[],"events":[]}"##
        .utf8)
    failing.importData(valid)
    for _ in 0..<20 { await Task.yield() }
    XCTAssertNil(failing.snapshot)
    XCTAssertNotNil(failing.message)
    let racing = AgendaStore(fileURL: dir.appendingPathComponent("race.json"), now: { self.now })
    racing.importData(valid)
    racing.disconnect()
    for _ in 0..<20 { await Task.yield() }
    XCTAssertNil(racing.snapshot)
  }
  @MainActor func testImportReaderImmediatelyRejectsFIFO_DIRECTORY_ANDSymlink() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-agenda-reader-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let fifo = root.appendingPathComponent("agenda.fifo")
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)
    let started = Date()
    XCTAssertThrowsError(try AgendaStore.safeRead(fifo))
    XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    XCTAssertThrowsError(try AgendaStore.safeRead(root))
    let target = root.appendingPathComponent("target.json")
    try Data("{}".utf8).write(to: target)
    let link = root.appendingPathComponent("link.json")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    XCTAssertThrowsError(try AgendaStore.safeRead(link))
  }
  func testRejectsMixedAllDayAndTimedShape() {
    let data = Data(
      ##"{"version":1,"source":{"id":"x","name":"X"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[{"id":"c","name":"C"}],"events":[{"id":"e","calendarID":"c","title":"Bad","start":"2026-09-15T17:00:00Z","end":"2026-09-15T18:00:00Z","timeZone":"UTC","startDate":"2026-09-15","endDate":"2026-09-16"}]}"##
        .utf8)
    XCTAssertThrowsError(try AgendaModel.decode(data, now: now))
  }
  @MainActor func testDisconnectClearsMemoryAndPrivateCache() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-agenda-test-\(UUID())")
    defer { try? FileManager.default.removeItem(at: dir) }
    let url = dir.appendingPathComponent("agenda.json")
    let store = AgendaStore(fileURL: url, now: { self.now })
    let data = Data(
      ##"{"version":1,"source":{"id":"x","name":"Imported"},"generatedAt":"2026-09-13T00:00:00Z","calendars":[],"events":[]}"##
        .utf8)
    store.importData(data)
    await Task.yield()
    await Task.yield()
    XCTAssertNotNil(store.snapshot)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    store.disconnect()
    XCTAssertNil(store.snapshot)
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
  }
}
