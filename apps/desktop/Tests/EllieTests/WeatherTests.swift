import Foundation
import XCTest
@testable import Ellie

private actor FixtureTransport: WeatherTransport {
    private(set) var requests: [URLRequest] = []
    let payload: Data
    let status: Int
    let responseURL: URL?

    init(json: String, status: Int = 200) {
        payload = Data(json.utf8)
        self.status = status
        responseURL = nil
    }

    init(data: Data, status: Int = 200, url: URL? = nil) {
        payload = data
        self.status = status
        responseURL = url
    }

    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let url = responseURL ?? request.url!
        return (payload, HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    func requestCount() -> Int { requests.count }
    func lastRequest() -> URLRequest? { requests.last }
}

private actor LateTransport: WeatherTransport {
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var requestURL: URL?
    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        requestURL = request.url
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func finish(with data: Data) {
        let response = HTTPURLResponse(url: requestURL!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        continuation?.resume(returning: (data, response))
        continuation = nil
    }
    func isWaiting() -> Bool { continuation != nil }
}

final class WeatherTests: XCTestCase {
    private let forecast = #"{"current":{"time":1789300000,"temperature_2m":72.4,"apparent_temperature":71.1,"weather_code":2,"is_day":1,"wind_speed_10m":8.7},"current_units":{"temperature_2m":"°F","wind_speed_10m":"mp/h"}}"#

    func testOpenMeteoRequestIsBoundedAndDecodesCurrentConditions() async throws {
        let transport = FixtureTransport(json: forecast)
        let place = try WeatherPlace.validated(name: "San Francisco", latitude: 37.7749, longitude: -122.4194)
        let now = Date(timeIntervalSince1970: 1_789_300_000)
        let snapshot = try await OpenMeteoClient(transport: transport).forecast(for: place, now: now)

        XCTAssertEqual(snapshot.temperature, 72.4)
        XCTAssertEqual(snapshot.condition, "Partly cloudy")
        XCTAssertEqual(snapshot.symbol, "cloud.sun.fill")
        let recordedRequest = await transport.lastRequest()
        let request = try XCTUnwrap(recordedRequest)
        XCTAssertEqual(request.url?.scheme, "https")
        XCTAssertEqual(request.url?.host, "api.open-meteo.com")
        XCTAssertLessThanOrEqual(request.timeoutInterval, 10)
        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items["latitude"], "37.774900")
        XCTAssertEqual(items["longitude"], "-122.419400")
        XCTAssertEqual(items["forecast_days"], "1")
        XCTAssertEqual(items["timeformat"], "unixtime")
        XCTAssertEqual(items["timezone"], "GMT")
        XCTAssertEqual(items["current"], "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m")
    }

    func testDecodesNightAndUsesNightSymbols() async throws {
        let night = forecast.replacingOccurrences(of: "\"is_day\":1", with: "\"is_day\":0")
        let place = try WeatherPlace.validated(name: "Night", latitude: 0, longitude: 0)
        let partlyCloudy = try await OpenMeteoClient(transport: FixtureTransport(json: night))
            .forecast(for: place, now: Date(timeIntervalSince1970: 1_789_300_000))
        let clear = try await OpenMeteoClient(transport: FixtureTransport(
            json: night.replacingOccurrences(of: "\"weather_code\":2", with: "\"weather_code\":0")
        )).forecast(for: place, now: Date(timeIntervalSince1970: 1_789_300_000))

        XCTAssertFalse(partlyCloudy.isDay)
        XCTAssertEqual(partlyCloudy.condition, "Partly cloudy")
        XCTAssertEqual(partlyCloudy.symbol, "cloud.moon.fill")
        XCTAssertEqual(clear.condition, "Clear")
        XCTAssertEqual(clear.symbol, "moon.stars.fill")
    }

    @MainActor
    func testStoreMakesNoRequestUntilExplicitlyEnabledAndUsesPrivateCache() async throws {
        let transport = FixtureTransport(json: forecast)
        let url = temporaryURL()
        let store = WeatherStore(fileURL: url, client: OpenMeteoClient(transport: transport), now: { Date(timeIntervalSince1970: 1_789_300_000) })
        store.refresh()
        let countBeforeEnable = await transport.requestCount()
        XCTAssertEqual(countBeforeEnable, 0)

        store.configure(name: "San Francisco", latitudeText: "37.7749", longitudeText: "-122.4194")
        await eventually { store.state.snapshot != nil }
        let countAfterEnable = await transport.requestCount()
        XCTAssertEqual(countAfterEnable, 1)
        XCTAssertEqual(store.state.place?.name, "San Francisco")
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)
        XCTAssertEqual(mode.intValue & 0o777, 0o600)

        let cached = WeatherStore(fileURL: url, client: OpenMeteoClient(transport: transport), now: { Date(timeIntervalSince1970: 1_789_300_100) })
        XCTAssertEqual(cached.state.snapshot?.temperature, 72.4)
        XCTAssertFalse(cached.needsRefresh)
    }

    @MainActor
    func testDisableClearsPlaceAndForecastAndStopsFurtherRefreshes() async throws {
        let transport = FixtureTransport(json: forecast)
        let url = temporaryURL()
        let store = WeatherStore(fileURL: url, client: OpenMeteoClient(transport: transport), now: { Date(timeIntervalSince1970: 1_789_300_000) })
        store.configure(name: "Test City", latitudeText: "1", longitudeText: "2")
        await eventually { store.state.snapshot != nil }
        store.disable()
        store.refresh(force: true)

        XCTAssertEqual(store.state, WeatherState())
        let countAfterDisable = await transport.requestCount()
        XCTAssertEqual(countAfterDisable, 1)
        let persisted = try JSONDecoder().decode(WeatherState.self, from: Data(contentsOf: url))
        XCTAssertNil(persisted.place)
        XCTAssertNil(persisted.snapshot)
        XCTAssertFalse(persisted.enabled)
    }

    func testValidationRejectsInvalidPlaceAndProviderPayload() async throws {
        XCTAssertThrowsError(try WeatherPlace.validated(name: " ", latitude: 0, longitude: 0))
        XCTAssertThrowsError(try WeatherPlace.validated(name: "Somewhere", latitude: 91, longitude: 0))
        let transport = FixtureTransport(json: #"{"current":{},"current_units":{}}"#)
        let place = try WeatherPlace.validated(name: "Somewhere", latitude: 0, longitude: 0)
        await XCTAssertThrowsErrorAsync { try await OpenMeteoClient(transport: transport).forecast(for: place) }
    }

    func testClientRejectsHugeBodyStatusWrongEndpointAndImplausibleValues() async throws {
        let place = try WeatherPlace.validated(name: "Somewhere", latitude: 0, longitude: 0)
        let now = Date(timeIntervalSince1970: 1_789_300_000)
        let clients = [
            OpenMeteoClient(transport: FixtureTransport(data: Data(repeating: 0x20, count: OpenMeteoClient.maximumResponseBytes + 1))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast, status: 503)),
            OpenMeteoClient(transport: FixtureTransport(data: Data(forecast.utf8), url: URL(string: "https://example.com/forecast")!)),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "72.4", with: "1e100"))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "\"weather_code\":2", with: "\"weather_code\":4"))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "\"is_day\":1", with: "\"is_day\":2"))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "1789300000", with: "1789200000"))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "1789300000", with: "1789400000"))),
            OpenMeteoClient(transport: FixtureTransport(json: forecast.replacingOccurrences(of: "1789300000", with: "1789301800"))),
        ]
        for client in clients {
            await XCTAssertThrowsErrorAsync { try await client.forecast(for: place, now: now) }
        }
    }

    @MainActor
    func testFailedSavePreservesState() async throws {
        let root = temporaryURL().deletingLastPathComponent()
        try Data("parent is a file".utf8).write(to: root)
        let url = root.appendingPathComponent("weatherv1.json")
        let store = WeatherStore(fileURL: url)
        let original = store.state
        XCTAssertFalse(store.configure(name: "Test", latitudeText: "1", longitudeText: "2"))
        XCTAssertEqual(store.state, original)
        XCTAssertNotNil(store.message)
    }

    @MainActor
    func testCorruptCacheIsPreservedAndBlocksOverwrite() async throws {
        let url = temporaryURL()
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let corrupt = Data("not json".utf8)
        try corrupt.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let store = WeatherStore(fileURL: url)
        XCTAssertFalse(store.configure(name: "Test", latitudeText: "1", longitudeText: "2"))
        store.disable()
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
        XCTAssertEqual(store.state, WeatherState())
        XCTAssertTrue(store.message?.contains("preserved") == true)
    }

    @MainActor
    func testFutureCacheIsRejectedWithoutCrashingFreshness() async throws {
        let url = temporaryURL()
        let now = Date(timeIntervalSince1970: 1_789_300_000)
        let place = try WeatherPlace.validated(name: "Test", latitude: 1, longitude: 2)
        let snapshot = WeatherSnapshot(fetchedAt: now.addingTimeInterval(10_000), observedAt: now,
            temperature: 70, apparentTemperature: 70, weatherCode: 0, isDay: true, windSpeed: 2,
            temperatureUnit: "°F", windSpeedUnit: "mp/h")
        try writeCache(WeatherState(enabled: true, place: place, snapshot: snapshot), to: url)
        let store = WeatherStore(fileURL: url, now: { now })
        XCTAssertEqual(store.state, WeatherState())
        XCTAssertEqual(store.freshness(at: now), "No forecast yet")
    }

    @MainActor
    func testLateResultAfterDisableCannotRestorePlaceOrSnapshot() async throws {
        let transport = LateTransport()
        let url = temporaryURL()
        let store = WeatherStore(fileURL: url, client: OpenMeteoClient(transport: transport), now: { Date(timeIntervalSince1970: 1_789_300_000) })
        XCTAssertTrue(store.configure(name: "Test", latitudeText: "1", longitudeText: "2"))
        await eventually { await transport.isWaiting() }
        store.disable()
        await transport.finish(with: Data(forecast.utf8))
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertEqual(store.state, WeatherState())
    }

    @MainActor
    func testCachedFailureReportsProviderAndAge() async throws {
        let url = temporaryURL()
        let fetched = Date(timeIntervalSince1970: 1_789_300_000)
        let now = fetched.addingTimeInterval(3_700)
        let place = try WeatherPlace.validated(name: "Test", latitude: 1, longitude: 2)
        let snapshot = WeatherSnapshot(fetchedAt: fetched, observedAt: fetched, temperature: 70,
            apparentTemperature: 69, weatherCode: 0, isDay: true, windSpeed: 2, temperatureUnit: "°F", windSpeedUnit: "mp/h")
        try writeCache(WeatherState(enabled: true, place: place, snapshot: snapshot), to: url)
        let transport = FixtureTransport(json: "{}", status: 503)
        let store = WeatherStore(fileURL: url, client: OpenMeteoClient(transport: transport), now: { now })
        store.refresh(force: true)
        await eventually { !store.isRefreshing }
        XCTAssertEqual(store.state.snapshot, snapshot)
        XCTAssertTrue(store.message?.contains("updated 1h ago") == true)
        XCTAssertFalse(store.message?.contains("Offline") == true)
    }

    @MainActor
    private func eventually(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<100 {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Condition did not become true")
    }

    private func temporaryURL() -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("EllieWeatherTests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("weatherv1.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return url
    }

    private func writeCache(_ state: WeatherState, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

private func XCTAssertThrowsErrorAsync(_ expression: () async throws -> Void,
                                       file: StaticString = #filePath, line: UInt = #line) async {
    do { try await expression(); XCTFail("Expected error", file: file, line: line) }
    catch { }
}
