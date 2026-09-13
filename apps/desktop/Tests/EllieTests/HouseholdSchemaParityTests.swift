import Foundation
import XCTest

@testable import Ellie

final class HouseholdSchemaParityTests: XCTestCase {
  func testSharedHouseholdFixturesMatchNativeModels() throws {
    let testFile = URL(fileURLWithPath: #filePath)
    let root = testFile.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixtureURL = root.appendingPathComponent("contracts/household-schema-fixtures.v1.json")
    let document = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: fixtureURL)) as? [String: Any]
    )
    XCTAssertEqual(document["version"] as? Int, 1)
    for fixture in try fixtures(named: "valid", in: document) {
      XCTAssertNoThrow(try decode(fixture), "Expected valid \(fixture.kind) fixture")
    }
    for fixture in try fixtures(named: "invalid", in: document) {
      XCTAssertThrowsError(try decode(fixture), "Expected invalid \(fixture.kind) fixture")
    }
  }

  private func fixtures(named name: String, in document: [String: Any]) throws -> [Fixture] {
    let rows = try XCTUnwrap(document[name] as? [[String: Any]])
    return try rows.map { row in
      let data: Data
      if let rawValue = row["rawValue"] as? String {
        data = Data(rawValue.utf8)
      } else {
        data = try JSONSerialization.data(withJSONObject: try XCTUnwrap(row["value"]))
      }
      return Fixture(
        kind: try XCTUnwrap(row["kind"] as? String),
        data: data
      )
    }
  }

  private func decode(_ fixture: Fixture) throws {
    switch fixture.kind {
    case "dashboards": _ = try DashboardModel.decode(fixture.data)
    case "chores": _ = try ChoresModel.decode(fixture.data)
    default:
      XCTFail("Unexpected fixture kind")
      throw FixtureError.unknownKind
    }
  }

  private struct Fixture {
    let kind: String
    let data: Data
  }
  private enum FixtureError: Error { case unknownKind }
}
