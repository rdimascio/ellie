import Combine
import Foundation

struct WeatherPlace: Codable, Equatable, Sendable {
    let name: String
    let latitude: Double
    let longitude: Double

    static func validated(name: String, latitude: Double, longitude: Double) throws -> Self {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.utf16.count <= 80 else { throw WeatherError.invalidPlace }
        guard (-90...90).contains(latitude), (-180...180).contains(longitude),
              latitude.isFinite, longitude.isFinite else { throw WeatherError.invalidCoordinates }
        return Self(name: clean, latitude: latitude, longitude: longitude)
    }
}

struct WeatherSnapshot: Codable, Equatable, Sendable {
    let fetchedAt: Date
    let observedAt: Date
    let temperature: Double
    let apparentTemperature: Double
    let weatherCode: Int
    let isDay: Bool
    let windSpeed: Double
    let temperatureUnit: String
    let windSpeedUnit: String

    func validate(referenceDate: Date) throws {
        let validCodes: Set<Int> = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]
        guard temperature.isFinite, apparentTemperature.isFinite, windSpeed.isFinite,
              (-200...150).contains(temperature), (-200...150).contains(apparentTemperature),
              (0...300).contains(windSpeed), validCodes.contains(weatherCode),
              temperatureUnit == "°F", windSpeedUnit == "mp/h",
              fetchedAt >= Date(timeIntervalSince1970: 1_577_836_800),
              fetchedAt <= referenceDate.addingTimeInterval(5 * 60),
              observedAt <= fetchedAt.addingTimeInterval(5 * 60),
              fetchedAt.timeIntervalSince(observedAt) <= 6 * 60 * 60 else {
            throw WeatherError.invalidResponse
        }
    }
}

struct WeatherState: Codable, Equatable, Sendable {
    var version = 1
    var enabled = false
    var place: WeatherPlace?
    var snapshot: WeatherSnapshot?
}

enum WeatherError: LocalizedError, Equatable {
    case invalidPlace, invalidCoordinates, invalidState, responseTooLarge, invalidResponse
    case insecureResponse, server(Int), timedOut, cacheWrite

    var errorDescription: String? {
        switch self {
        case .invalidPlace: "Enter a place name of 1–80 characters."
        case .invalidCoordinates: "Latitude must be −90…90 and longitude −180…180."
        case .invalidState: "Saved weather settings are invalid."
        case .responseTooLarge: "The weather response exceeded the 64 KB safety limit."
        case .invalidResponse: "Open-Meteo returned an unreadable forecast."
        case .insecureResponse: "The weather request was redirected outside the secure Open-Meteo endpoint."
        case .server(let status): "Open-Meteo returned HTTP \(status)."
        case .timedOut: "The weather request timed out."
        case .cacheWrite: "The forecast arrived, but its cache could not be saved."
        }
    }
}

protocol WeatherTransport: Sendable {
    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse)
}

final class OpenMeteoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct URLSessionWeatherTransport: WeatherTransport {
    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 12
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: OpenMeteoRedirectDelegate(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw WeatherError.invalidResponse }
            guard http.url?.scheme == "https", http.url?.host == "api.open-meteo.com" else { throw WeatherError.insecureResponse }
            if let expected = http.expectedContentLength as Int64?, expected > maximumBytes { throw WeatherError.responseTooLarge }
            guard (200..<300).contains(http.statusCode) else { throw WeatherError.server(http.statusCode) }
            var data = Data()
            data.reserveCapacity(min(maximumBytes, max(0, Int(http.expectedContentLength))))
            for try await byte in bytes {
                guard data.count < maximumBytes else { throw WeatherError.responseTooLarge }
                data.append(byte)
            }
            return (data, http)
        } catch is CancellationError { throw CancellationError() }
        catch let error as WeatherError { throw error }
        catch let error as URLError where error.code == .timedOut { throw WeatherError.timedOut }
        catch { throw WeatherError.invalidResponse }
    }
}

struct OpenMeteoClient: Sendable {
    static let maximumResponseBytes = 64 * 1024
    let transport: any WeatherTransport

    init(transport: any WeatherTransport = URLSessionWeatherTransport()) { self.transport = transport }

    func forecast(for place: WeatherPlace, now: Date = Date()) async throws -> WeatherSnapshot {
        var components = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
        components.queryItems = [
            .init(name: "latitude", value: String(format: "%.6f", place.latitude)),
            .init(name: "longitude", value: String(format: "%.6f", place.longitude)),
            .init(name: "current", value: "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m"),
            .init(name: "temperature_unit", value: "fahrenheit"),
            .init(name: "wind_speed_unit", value: "mph"),
            .init(name: "timeformat", value: "unixtime"),
            .init(name: "timezone", value: "GMT"),
            .init(name: "forecast_days", value: "1"),
        ]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, http) = try await transport.data(for: request, maximumBytes: Self.maximumResponseBytes)
        guard http.url == request.url, http.url?.scheme == "https", http.url?.host == "api.open-meteo.com" else { throw WeatherError.insecureResponse }
        guard (200..<300).contains(http.statusCode) else { throw WeatherError.server(http.statusCode) }
        guard data.count <= Self.maximumResponseBytes else { throw WeatherError.responseTooLarge }
        let response: Response
        do { response = try JSONDecoder().decode(Response.self, from: data) }
        catch { throw WeatherError.invalidResponse }
        guard response.current.isDay == 0 || response.current.isDay == 1 else { throw WeatherError.invalidResponse }
        let snapshot = WeatherSnapshot(fetchedAt: now, observedAt: Date(timeIntervalSince1970: response.current.time),
            temperature: response.current.temperature, apparentTemperature: response.current.apparent,
            weatherCode: response.current.code, isDay: response.current.isDay == 1, windSpeed: response.current.wind,
            temperatureUnit: response.currentUnits.temperature, windSpeedUnit: response.currentUnits.wind)
        try snapshot.validate(referenceDate: now)
        return snapshot
    }

    private struct Response: Decodable {
        let current: Current
        let currentUnits: Units
        enum CodingKeys: String, CodingKey { case current; case currentUnits = "current_units" }
    }
    private struct Current: Decodable {
        let time: TimeInterval
        let temperature: Double
        let apparent: Double
        let code: Int
        let isDay: Int
        let wind: Double
        enum CodingKeys: String, CodingKey {
            case time; case temperature = "temperature_2m"; case apparent = "apparent_temperature"
            case code = "weather_code"; case isDay = "is_day"; case wind = "wind_speed_10m"
        }
    }
    private struct Units: Decodable {
        let temperature: String
        let wind: String
        enum CodingKeys: String, CodingKey { case temperature = "temperature_2m"; case wind = "wind_speed_10m" }
    }
}

@MainActor
final class WeatherStore: ObservableObject {
    @Published private(set) var state: WeatherState
    @Published private(set) var isRefreshing = false
    @Published private(set) var fetchedInCurrentSession = false
    @Published private(set) var message: String?

    let fileURL: URL
    private let client: OpenMeteoClient
    private let now: @Sendable () -> Date
    private let setFileAttributes: ([FileAttributeKey: Any], String) throws -> Void
    private var refreshTask: Task<Void, Never>?
    private var refreshID: UUID?
    private var recoveryRequired = false
    static let staleAfter: TimeInterval = 30 * 60
    static let maximumFileBytes = 32 * 1024

    init(fileURL: URL? = nil, client: OpenMeteoClient = OpenMeteoClient(),
         now: @escaping @Sendable () -> Date = { Date() },
         setFileAttributes: @escaping ([FileAttributeKey: Any], String) throws -> Void = {
             try FileManager.default.setAttributes($0, ofItemAtPath: $1)
         }) {
        self.fileURL = fileURL ?? Self.defaultFileURL()
        self.client = client
        self.now = now
        self.setFileAttributes = setFileAttributes
        do { state = try Self.load(from: self.fileURL, now: now()) }
        catch {
            state = WeatherState()
            recoveryRequired = true
            message = "Saved weather settings are unreadable. Weather remains off; the original file was preserved."
        }
    }

    var needsRefresh: Bool {
        guard state.enabled, state.place != nil else { return false }
        guard let snapshot = state.snapshot else { return true }
        let age = now().timeIntervalSince(snapshot.fetchedAt)
        return !age.isFinite || age < 0 || age >= Self.staleAfter
    }

    @discardableResult
    func configure(name: String, latitudeText: String, longitudeText: String) -> Bool {
        do {
            guard !recoveryRequired else { message = "Saved weather settings must be repaired or removed before weather can be enabled."; return false }
            guard let latitude = Double(latitudeText), let longitude = Double(longitudeText) else { throw WeatherError.invalidCoordinates }
            let place = try WeatherPlace.validated(name: name, latitude: latitude, longitude: longitude)
            refreshTask?.cancel()
            refreshID = nil
            isRefreshing = false
            let candidate = WeatherState(enabled: true, place: place, snapshot: state.place == place ? state.snapshot : nil)
            try persist(candidate)
            state = candidate
            fetchedInCurrentSession = false
            message = nil
            refresh(force: true)
            return true
        } catch let error as WeatherError { message = error.localizedDescription; return false }
        catch { message = "Weather settings could not be saved. Nothing was changed."; return false }
    }

    @discardableResult
    func disable() -> Bool {
        refreshTask?.cancel()
        refreshTask = nil
        refreshID = nil
        isRefreshing = false
        state = WeatherState()
        fetchedInCurrentSession = false
        guard !recoveryRequired else {
            message = "Weather is off, but the unreadable settings file was preserved and may still contain the previous place."
            return false
        }
        do { try persist(state); message = nil; return true }
        catch { message = "Weather is off, but its saved place could not be cleared from disk."; return false }
    }

    func refresh(force: Bool = false) {
        guard state.enabled, let place = state.place, !isRefreshing, force || needsRefresh else { return }
        let id = UUID()
        refreshID = id
        isRefreshing = true
        message = nil
        refreshTask = Task { [weak self, client] in
            do {
                let snapshot = try await client.forecast(for: place, now: self?.now() ?? Date())
                try Task.checkCancellation()
                guard let self, self.refreshID == id, self.state.enabled, self.state.place == place else { return }
                var candidate = self.state
                candidate.snapshot = snapshot
                do { try self.persist(candidate) }
                catch { throw WeatherError.cacheWrite }
                self.state = candidate
                self.fetchedInCurrentSession = true
            } catch is CancellationError { }
            catch {
                guard let self, self.refreshID == id else { return }
                let prefix: String
                switch error {
                case WeatherError.cacheWrite: prefix = "Forecast received, but its cache could not be saved"
                case WeatherError.timedOut, is URLError: prefix = "Provider unavailable"
                case is WeatherError: prefix = "Forecast unavailable"
                default: prefix = "Forecast unavailable"
                }
                self.message = self.state.snapshot == nil ? "\(prefix). Try again." : "\(prefix) — \(self.freshness(at: self.now()).lowercased())"
            }
            guard let self, self.refreshID == id else { return }
            self.refreshID = nil
            self.isRefreshing = false
        }
    }

    func freshness(at date: Date) -> String {
        guard let fetched = state.snapshot?.fetchedAt else { return "No forecast yet" }
        let interval = date.timeIntervalSince(fetched)
        guard interval.isFinite, interval >= 0, interval < TimeInterval(Int.max) else { return "Update time unavailable" }
        let minutes = Int(interval / 60)
        if minutes < 1 { return "Updated just now" }
        if minutes < 60 { return "Updated \(minutes)m ago" }
        return "Updated \(minutes / 60)h ago"
    }

    private static func load(from url: URL, now: Date) throws -> WeatherState {
        guard FileManager.default.fileExists(atPath: url.path) else { return WeatherState() }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true,
              let size = values.fileSize, size <= maximumFileBytes else { throw WeatherError.invalidState }
        let permissions = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
        guard let permissions, permissions.intValue & 0o077 == 0 else { throw WeatherError.invalidState }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumFileBytes + 1) ?? Data()
        guard data.count <= maximumFileBytes else { throw WeatherError.invalidState }
        let value = try JSONDecoder().decode(WeatherState.self, from: data)
        guard value.version == 1,
              (value.enabled && value.place != nil || !value.enabled && value.place == nil && value.snapshot == nil) else { throw WeatherError.invalidState }
        if let place = value.place { _ = try WeatherPlace.validated(name: place.name, latitude: place.latitude, longitude: place.longitude) }
        if let snapshot = value.snapshot { try snapshot.validate(referenceDate: now) }
        return value
    }

    private func persist(_ candidate: WeatherState) throws {
        let data = try JSONEncoder().encode(candidate)
        guard data.count <= Self.maximumFileBytes else { throw WeatherError.invalidState }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let staging = directory.appendingPathComponent(".weather-\(UUID().uuidString).tmp")
        do {
            try data.write(to: staging, options: .atomic)
            try setFileAttributes([.posixPermissions: 0o600], staging.path)
            // The staged file already has its final private metadata. Keep the
            // replacement as the commit boundary: a later throwing operation
            // could report failure after the durable state has already changed.
            if FileManager.default.fileExists(atPath: fileURL.path) {
                let values = try fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw WeatherError.invalidState }
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: staging, backupItemName: nil, options: .usingNewMetadataOnly)
            } else { try FileManager.default.moveItem(at: staging, to: fileURL) }
        } catch { try? FileManager.default.removeItem(at: staging); throw error }
    }

    static func defaultFileURL() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Ellie", isDirectory: true).appendingPathComponent("weatherv1.json")
    }
}

extension WeatherSnapshot {
    var condition: String {
        switch weatherCode {
        case 0: "Clear"
        case 1: "Mostly clear"
        case 2: "Partly cloudy"
        case 3: "Overcast"
        case 45, 48: "Foggy"
        case 51...57: "Drizzle"
        case 61...67, 80...82: "Rain"
        case 71...77, 85, 86: "Snow"
        case 95...99: "Thunderstorms"
        default: "Current conditions"
        }
    }
    var symbol: String {
        switch weatherCode {
        case 0: isDay ? "sun.max.fill" : "moon.stars.fill"
        case 1, 2: isDay ? "cloud.sun.fill" : "cloud.moon.fill"
        case 3: "cloud.fill"
        case 45, 48: "cloud.fog.fill"
        case 51...67, 80...82: "cloud.rain.fill"
        case 71...77, 85, 86: "cloud.snow.fill"
        case 95...99: "cloud.bolt.rain.fill"
        default: "cloud.fill"
        }
    }
}
