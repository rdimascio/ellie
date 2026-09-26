import Foundation
import XCTest

@testable import Ellie

@MainActor
final class DashboardSyncImportPresentationTests: XCTestCase {
  func testFailedReplacementPreservesLocalStateAndBytesUntilExplicitDismissal() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "EllieDashboardImportPresentation-\(UUID().uuidString)",
        isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("dashboards.json")
    let local = DashboardStore(fileURL: file)
    local.renameDashboard(id: "home", name: "Keep local")
    let localState = local.state
    let localBytes = try Data(contentsOf: file)
    var persistenceAttempts = 0
    let failing = DashboardStore(fileURL: file) { _, path in
      if path.contains(".dashboards-") {
        persistenceAttempts += 1
        throw CocoaError(.fileWriteNoPermission)
      }
    }
    var presentation = DashboardSyncImportPresentation()
    let remote = DashboardState(dashboards: [
      Dashboard(id: "remote", name: "Remote replacement", widgets: [])
    ])

    presentation.replace(with: remote, dashboards: failing)

    XCTAssertEqual(failing.state, localState)
    XCTAssertEqual(try Data(contentsOf: file), localBytes)
    XCTAssertEqual(presentation.error, failing.error)
    XCTAssertTrue(presentation.isPresentingError)
    XCTAssertNotNil(failing.error, "The store persistence error must remain available to the view")

    XCTAssertTrue(
      presentation.isPresentingError,
      "Observing the presentation must not clear the persistence error")
    XCTAssertNotNil(failing.error)
    presentation.replace(with: remote, dashboards: failing)
    XCTAssertEqual(
      persistenceAttempts, 1,
      "A visible persistence error blocks another replacement until dismissal")
    presentation.dismissError(dashboards: failing)
    XCTAssertFalse(presentation.isPresentingError)
    XCTAssertNil(failing.error)
    XCTAssertEqual(try Data(contentsOf: file), localBytes)
  }

  func testSuccessfulReplacementPersistsAndPublishesExactlyOnce() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "EllieDashboardImportSuccess-\(UUID().uuidString)",
        isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("dashboards.json")
    var stagingMetadataWrites = 0
    let dashboards = DashboardStore(fileURL: file) { attributes, path in
      if path.contains(".dashboards-") { stagingMetadataWrites += 1 }
      try FileManager.default.setAttributes(attributes, ofItemAtPath: path)
    }
    var presentation = DashboardSyncImportPresentation()
    let remote = DashboardState(dashboards: [
      Dashboard(id: "remote", name: "Remote replacement", widgets: [])
    ])

    presentation.replace(with: remote, dashboards: dashboards)

    XCTAssertEqual(stagingMetadataWrites, 1)
    XCTAssertEqual(dashboards.state, remote)
    XCTAssertEqual(try DashboardModel.decode(Data(contentsOf: file)), remote)
    XCTAssertNil(dashboards.error)
    XCTAssertFalse(presentation.isPresentingError)
  }

  func testDismissalDoesNotClearANewerStoreError() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent(
        "EllieDashboardImportNewerError-\(UUID().uuidString)",
        isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent("dashboards.json")
    let dashboards = DashboardStore(fileURL: file) { _, path in
      if path.contains(".dashboards-") { throw CocoaError(.fileWriteNoPermission) }
    }
    var presentation = DashboardSyncImportPresentation()
    let remote = DashboardState(dashboards: [
      Dashboard(id: "remote", name: "Remote replacement", widgets: [])
    ])
    presentation.replace(with: remote, dashboards: dashboards)
    XCTAssertTrue(presentation.isPresentingError)

    dashboards.error = "A newer dashboard error"
    presentation.dismissError(dashboards: dashboards)

    XCTAssertFalse(presentation.isPresentingError)
    XCTAssertEqual(dashboards.error, "A newer dashboard error")
  }
}
