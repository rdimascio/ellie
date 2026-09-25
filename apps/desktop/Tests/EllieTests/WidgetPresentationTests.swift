import Foundation
import XCTest
@testable import Ellie

final class WidgetPresentationTests: XCTestCase {
  @MainActor
  func testRecentForecastRestoredAfterRelaunchIsLabeledCached() throws {
    let now = Date(timeIntervalSince1970: 1_789_300_000)
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "EllieWidgetPresentationTests-\(UUID().uuidString)", isDirectory: true)
    let fileURL = root.appendingPathComponent("weatherv1.json")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let state = WeatherState(
      enabled: true,
      place: try WeatherPlace.validated(name: "London", latitude: 51.5072, longitude: -0.1276),
      snapshot: WeatherSnapshot(
        fetchedAt: now, observedAt: now, temperature: 63, apparentTemperature: 62,
        weatherCode: 2, isDay: true, windSpeed: 5, temperatureUnit: "°F",
        windSpeedUnit: "mp/h"))
    try JSONEncoder().encode(state).write(to: fileURL)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o600], ofItemAtPath: fileURL.path)

    let restored = WeatherStore(fileURL: fileURL, now: { now })

    XCTAssertFalse(restored.fetchedInCurrentSession)
    XCTAssertFalse(restored.needsRefresh)
    XCTAssertEqual(
      DesktopWeatherPresentation.status(store: restored, at: now),
      "Cached forecast · Updated just now")
  }
}
