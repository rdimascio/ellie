import Foundation
import XCTest
@testable import Ellie

final class DashboardModelTests: XCTestCase {
    func testClockFormattingUsesTheSelectedTimeZone() throws {
        let date = Date(timeIntervalSince1970: 0)
        let locale = Locale(identifier: "en_US_POSIX")
        let utc = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let losAngeles = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let utcText = DashboardModel.formattedTime(date, in: utc, locale: locale)
        let losAngelesText = DashboardModel.formattedTime(date, in: losAngeles, locale: locale)
        XCTAssertTrue(utcText.hasPrefix("12:00"))
        XCTAssertTrue(losAngelesText.hasPrefix("4:00"))
        XCTAssertNotEqual(utcText, losAngelesText)
    }

    func testIOSEditPreservesImportedNativeWidgetConfiguration() throws {
        let input = Data(#"{"version":1,"dashboards":[{"id":"family","name":"Family","widgets":[{"id":"playlist","type":"playlist","title":"Videos","size":"wide","config":{"youtubePlaylistID":"PLC77007E23FF423C6"}},{"id":"weather","type":"weather","title":"Weather","size":"small","config":{}},{"id":"calendar","type":"calendar","title":"Agenda","size":"wide","config":{}}]}]}"#.utf8)
        let widgets = try XCTUnwrap(DashboardModel.decode(input).dashboards.first?.widgets)

        for widget in widgets {
            XCTAssertEqual(
                try DashboardModel.configAfterEditing(widget, note: "ignored", timeZone: "UTC"),
                widget.config
            )
        }
    }

    @MainActor
    func testIOSPlaylistEditPersistsCanonicalIDAndRejectsUnsafeInput() async throws {
        let location = temporaryLocation()
        let store = DashboardStore(fileURL: location)
        store.addWidget(kind: .playlist)
        let widget = try XCTUnwrap(store.selectedDashboard?.widgets.last)
        let identifier = "PLC77007E23FF423C6"
        let url = "https://www.youtube.com/playlist?list=\(identifier)"
        let config = try DashboardModel.configAfterEditing(
            widget, note: "", timeZone: "", playlist: url)
        XCTAssertEqual(config, ["youtubePlaylistID": identifier])
        store.updateWidget(id: widget.id, title: "Family videos", size: .wide, config: config)
        XCTAssertNil(store.error)

        let reloaded = DashboardStore(fileURL: location)
        let saved = try XCTUnwrap(reloaded.selectedDashboard?.widgets.first { $0.id == widget.id })
        XCTAssertEqual(saved.title, "Family videos")
        XCTAssertEqual(saved.size, .wide)
        XCTAssertEqual(saved.config, ["youtubePlaylistID": identifier])
        XCTAssertEqual(YouTubePlaylist.publicURL(for: identifier)?.absoluteString, url)
        XCTAssertNil(YouTubePlaylist.publicURL(for: "https://example.invalid/playlist"))
        for unsafe in ["https://example.invalid/playlist?list=\(identifier)",
                       "https://www.youtube.com:443/playlist?list=\(identifier)",
                       "https://user@www.youtube.com/playlist?list=\(identifier)"] {
            XCTAssertThrowsError(try DashboardModel.configAfterEditing(
                saved, note: "", timeZone: "", playlist: unsafe))
        }
        XCTAssertEqual(try DashboardModel.decode(Data(contentsOf: location)), reloaded.state)
    }

    func testIOSEditClearsAnExplicitlyBlankClockTimeZone() throws {
        let clock = DashboardWidget(
            id: "clock", type: .clock, title: "Clock", size: .small,
            config: ["timeZone": "America/Los_Angeles"]
        )

        XCTAssertEqual(
            try DashboardModel.configAfterEditing(clock, note: "ignored", timeZone: ""),
            [:]
        )
    }

    func testIOSEditDoesNotPreserveConfigurationOutsideTheWidgetSchema() {
        let weather = DashboardWidget(
            id: "weather", type: .weather, title: "Weather", size: .small,
            config: ["remoteURL": "https://example.invalid"]
        )

        XCTAssertThrowsError(
            try DashboardModel.configAfterEditing(weather, note: "ignored", timeZone: "UTC")
        ) { error in
            XCTAssertEqual(error as? DashboardModelError, .invalidConfig)
        }
    }

    func testBrowserExportRoundTripsWithoutChangingItsSchema() throws {
        let input = Data(#"{"version":1,"dashboards":[{"id":"family","name":"Family","widgets":[{"id":"clock-one","type":"clock","title":"Clock","size":"wide","config":{"timeZone":"America/Los_Angeles"}},{"id":"note-one","type":"note","title":"Note","size":"small","config":{"text":"Dinner is at six."}}]}]}"#.utf8)
        let state = try DashboardModel.decode(input)
        XCTAssertEqual(state.dashboards.first?.widgets.map(\.type), [.clock, .note])
        XCTAssertEqual(try DashboardModel.decode(DashboardModel.encode(state)), state)
    }

    @MainActor
    func testPersistsEditsAndUsesPrivatePermissions() async throws {
        let location = temporaryLocation()
        let store = DashboardStore(fileURL: location)
        store.renameDashboard(id: "home", name: "Downstairs")
        XCTAssertNil(store.error)

        let reloaded = DashboardStore(fileURL: location)
        XCTAssertEqual(reloaded.selectedDashboard?.name, "Downstairs")
        let fileMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: location.path)[.posixPermissions] as? NSNumber)
        let directoryMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: location.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
        XCTAssertEqual(directoryMode.intValue & 0o777, 0o700)
    }

    @MainActor
    func testCreateAndRenameNormalizeIncidentalWhitespaceBeforePersisting() async throws {
        let location = temporaryLocation()
        let store = DashboardStore(fileURL: location)

        store.createDashboard(name: "  Evening  ")

        XCTAssertNil(store.error)
        let dashboardID = try XCTUnwrap(store.selectedDashboard?.id)
        XCTAssertEqual(store.selectedDashboard?.name, "Evening")
        XCTAssertEqual(
            DashboardStore(fileURL: location).state.dashboards.first { $0.id == dashboardID }?.name,
            "Evening"
        )

        store.renameDashboard(id: dashboardID, name: "\n Kitchen \t")

        XCTAssertNil(store.error)
        XCTAssertEqual(store.selectedDashboard?.name, "Kitchen")
        XCTAssertEqual(
            DashboardStore(fileURL: location).state.dashboards.first { $0.id == dashboardID }?.name,
            "Kitchen"
        )
    }

    @MainActor
    func testCorruptSavedFileIsPreservedAndReported() async throws {
        let location = temporaryLocation()
        try FileManager.default.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
        let corrupt = Data("not json".utf8)
        try corrupt.write(to: location)

        let store = DashboardStore(fileURL: location)
        XCTAssertEqual(store.state, DashboardModel.initialState)
        XCTAssertNotNil(store.error)
        XCTAssertEqual(try Data(contentsOf: location), corrupt)

        store.error = nil
        store.renameDashboard(id: "home", name: "Must not replace corrupt data")
        XCTAssertEqual(store.state, DashboardModel.initialState)
        XCTAssertEqual(try Data(contentsOf: location), corrupt)
        XCTAssertNotNil(store.error)

        store.reset()
        XCTAssertNil(store.error)
        XCTAssertEqual(try DashboardModel.decode(Data(contentsOf: location)), DashboardModel.initialState)
    }

    @MainActor
    func testInvalidImportPreservesCurrentStateAndSavedFile() async throws {
        let location = temporaryLocation()
        let store = DashboardStore(fileURL: location)
        store.renameDashboard(id: "home", name: "Kitchen")
        let previousState = store.state
        let previousData = try Data(contentsOf: location)

        store.importData(Data(#"{"version":2,"dashboards":[]}"#.utf8))

        XCTAssertEqual(store.state, previousState)
        XCTAssertEqual(try Data(contentsOf: location), previousData)
        XCTAssertNotNil(store.error)
    }

    func testRejectsUnknownKindsDuplicateIDsAndUnknownFields() throws {
        let documents = [
            #"{"version":1,"dashboards":[{"id":"x","name":"X","widgets":[{"id":"w","type":"video","title":"Video","size":"small","config":{}}]}]}"#,
            #"{"version":1,"dashboards":[{"id":"x","name":"X","widgets":[]},{"id":"x","name":"Again","widgets":[]}]}"#,
            #"{"version":1,"dashboards":[],"extra":true}"#,
        ]
        for document in documents {
            XCTAssertThrowsError(try DashboardModel.decode(Data(document.utf8)))
        }
    }

    func testEnforcesCollectionNoteAndSerializedBounds() throws {
        let board = Dashboard(id: "board", name: "Board", widgets: [])
        XCTAssertThrowsError(try DashboardModel.encode(DashboardState(dashboards: Array(repeating: board, count: 13))))

        let widgets = (0..<25).map {
            DashboardWidget(id: "note-\($0)", type: .note, title: "Note", size: .small, config: ["text": ""])
        }
        XCTAssertThrowsError(try DashboardModel.encode(DashboardState(dashboards: [Dashboard(id: "home", name: "Home", widgets: widgets)])))

        let longNote = String(repeating: "a", count: 2_001)
        let note = DashboardWidget(id: "note", type: .note, title: "Note", size: .small, config: ["text": longNote])
        XCTAssertThrowsError(try DashboardModel.encode(DashboardState(dashboards: [Dashboard(id: "home", name: "Home", widgets: [note])])))

        XCTAssertThrowsError(try DashboardModel.decode(Data(repeating: 0x20, count: DashboardModel.maximumSerializedBytes + 1)))
    }

    @MainActor
    func testFailedMutationKeepsState() async throws {
        let store = DashboardStore(fileURL: temporaryLocation())
        let previous = store.state
        store.renameDashboard(id: "home", name: "  ")
        XCTAssertEqual(store.state, previous)
        XCTAssertNotNil(store.error)
    }

    @MainActor
    func testCustomStatePathDoesNotChangeExistingParentPermissions() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("EllieExistingParent-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o755]
        )
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
        let location = directory.appendingPathComponent("state.json")

        let store = DashboardStore(fileURL: location)
        store.renameDashboard(id: "home", name: "Private file")

        let directoryMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)
        let fileMode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: location.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(directoryMode.intValue & 0o777, 0o755)
        XCTAssertEqual(fileMode.intValue & 0o777, 0o600)
    }

    @MainActor
    func testSymbolicLinkStatePathIsRejectedWithoutTouchingTarget() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("EllieSymlinkState-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let target = directory.appendingPathComponent("target.json")
        let link = directory.appendingPathComponent("state.json")
        let targetData = try DashboardModel.encode(DashboardModel.initialState)
        try targetData.write(to: target)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        let store = DashboardStore(fileURL: link)
        XCTAssertNotNil(store.error)
        store.renameDashboard(id: "home", name: "Must not follow link")
        XCTAssertEqual(try Data(contentsOf: target), targetData)
    }

    private func temporaryLocation() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("EllieDashboardTests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("dashboardsv1.json")
    }
}
