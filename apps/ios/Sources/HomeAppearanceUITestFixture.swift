#if DEBUG
import Combine
import Foundation
import SwiftUI

@MainActor
struct HomeAppearanceUITestFixtureView: View {
    let accessibilityLayout: Bool
    let narrowLayout: Bool
    let weatherFixtureEnabled: Bool
    let calendarFixtureEnabled: Bool
    @StateObject private var dashboards: DashboardStore
    @StateObject private var chores: ChoresStore
    @StateObject private var weather: WeatherStore
    @StateObject private var agenda: IOSGoogleAgendaStore
    @StateObject private var enrollment: NativeEnrollmentStore
    @StateObject private var probe: HomeAppearanceProbe

    init(accessibilityLayout: Bool, narrowLayout: Bool) {
        self.accessibilityLayout = accessibilityLayout
        self.narrowLayout = narrowLayout
        let probe = HomeAppearanceProbe()
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("ellie-home-appearance-\(UUID().uuidString).json")
        precondition(!FileManager.default.fileExists(atPath: file.path))
        let arguments = ProcessInfo.processInfo.arguments
        let calendarSession: UUID?
        if let marker = arguments.firstIndex(of: "--ellie-ui-calendar-session"),
           arguments.indices.contains(marker + 1) {
            calendarSession = UUID(uuidString: arguments[marker + 1])
        } else { calendarSession = nil }
        calendarFixtureEnabled = calendarSession != nil
        let dashboardStore = DashboardStore(fileURL: file)
        if calendarFixtureEnabled { dashboardStore.addWidget(kind: .calendar) }
        let calendarDefaults: UserDefaults
        if let calendarSession {
            let suite = "ellie-agenda-ui-\(calendarSession.uuidString)"
            calendarDefaults = UserDefaults(suiteName: suite)!
            if arguments.contains("--ellie-ui-calendar-cleanup") {
                calendarDefaults.removePersistentDomain(forName: suite)
            }
        } else {
            calendarDefaults = UserDefaults(suiteName: "ellie-agenda-ui-inert-\(UUID().uuidString)")!
        }
        let weatherFile: URL
        if let marker = arguments.firstIndex(of: "--ellie-ui-weather-session"),
           arguments.indices.contains(marker + 1),
           let identifier = UUID(uuidString: arguments[marker + 1]) {
            weatherFixtureEnabled = true
            weatherFile = FileManager.default.temporaryDirectory
                .appendingPathComponent("ellie-home-weather-\(identifier.uuidString).json")
            if arguments.contains("--ellie-ui-weather-cleanup") {
                try? FileManager.default.removeItem(at: weatherFile)
            }
        } else {
            weatherFixtureEnabled = false
            weatherFile = file.deletingPathExtension().appendingPathExtension("weather.json")
        }
        _dashboards = StateObject(wrappedValue: dashboardStore)
        _chores = StateObject(wrappedValue: ChoresStore(fileURL: file.deletingPathExtension().appendingPathExtension("chores.json")))
        _weather = StateObject(wrappedValue: WeatherStore(
            fileURL: weatherFile,
            client: OpenMeteoClient(transport: HomeAppearanceWeatherTransport(probe: probe))))
        _agenda = StateObject(wrappedValue: IOSGoogleAgendaStore(
            client: HomeAppearanceAgendaClient(probe: probe), defaults: calendarDefaults))
        _probe = StateObject(wrappedValue: probe)
        _enrollment = StateObject(wrappedValue: NativeEnrollmentStore(
            vault: HomeAppearanceVault(probe: probe),
            transport: HomeAppearanceRejectTransport(probe: probe),
            now: { Date(timeIntervalSince1970: 1_800_000_000) }))
    }

    var body: some View {
        VStack(spacing: 0) {
            IOSDashboardList(store: dashboards, enrollment: enrollment, choresStore: chores,
                weatherStore: weather, agendaStore: agenda, uiTestLifeDestination: { credential in
                AnyView(Text("Synthetic Life destination: \(credential.client.id)")
                    .accessibilityIdentifier("home-fixture-life-destination")
                    .navigationTitle("Fixture Life")
                    .onAppear { probe.lifeOpens += 1 })
            })
            .dynamicTypeSize(accessibilityLayout ? .accessibility5 : .large)
            .frame(width: narrowLayout || accessibilityLayout ? 320 : nil)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            VStack(spacing: 4) {
                HStack {
                    Button("Load fixture pairing") { enrollment.startScanning() }
                        .accessibilityIdentifier("home-fixture-load-pairing")
                    Button("Remove fixture pairing") { enrollment.removeLocalCredential() }
                        .accessibilityIdentifier("home-fixture-remove-pairing")
                }
                Text("Fixture vault reads: \(probe.vaultReads)")
                    .accessibilityIdentifier("home-fixture-vault-reads")
                Text("Fixture transport calls: \(probe.transportCalls)")
                    .accessibilityIdentifier("home-fixture-transport-calls")
                Text("Fixture Life opens: \(probe.lifeOpens)")
                    .accessibilityIdentifier("home-fixture-life-opens")
                if weatherFixtureEnabled {
                    Text("Fixture weather requests: \(probe.weatherCalls)")
                        .accessibilityIdentifier("home-fixture-weather-calls")
                    Button("Fail next weather request") { probe.failNextWeather = true }
                        .accessibilityIdentifier("home-fixture-weather-fail-next")
                }
                if calendarFixtureEnabled {
                    Text("Fixture agenda requests: \(probe.agendaCalls)")
                        .accessibilityIdentifier("home-fixture-agenda-calls")
                    Button("Fail next agenda read") { probe.failNextAgenda = true }
                        .accessibilityIdentifier("home-fixture-agenda-fail-next")
                }
            }
            .font(.caption)
            .padding(8)
            .frame(maxWidth: .infinity)
            .background(ElliePalette.background)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("home-fixture-controls")
        }
        .tint(ElliePalette.accent)
        .preferredColorScheme(.dark)
    }
}

@MainActor
private final class HomeAppearanceProbe: ObservableObject {
    @Published var vaultReads = 0
    @Published var transportCalls = 0
    @Published var lifeOpens = 0
    @Published var weatherCalls = 0
    @Published var agendaCalls = 0
    var failNextWeather = false
    var failNextAgenda = false
    func readVault() { vaultReads += 1 }
    func calledTransport() { transportCalls += 1 }
    func calledWeather() -> Bool {
        weatherCalls += 1
        let shouldFail = failNextWeather
        failNextWeather = false
        return shouldFail
    }
    func calledAgenda() -> Bool {
        agendaCalls += 1
        let shouldFail = failNextAgenda
        failNextAgenda = false
        return shouldFail
    }
}

private actor HomeAppearanceAgendaClient: IOSAgendaClient {
    let probe: HomeAppearanceProbe
    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func connections(_ credential: NativeEnrollmentCredential) async throws -> [IOSAgendaConnection] {
        if await probe.calledAgenda() { throw IOSAgendaFailure.unavailable }
        return [IOSAgendaConnection(id: "fixture-calendar", label: "Fixture Google account",
            state: "connected", selectedCalendarId: "selected-fixture-calendar")]
    }
    func agenda(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSAgendaSnapshot {
        if await probe.calledAgenda() { throw IOSAgendaFailure.unavailable }
        let now = Date()
        return IOSAgendaSnapshot(connectionId: id, label: "Fixture Google account", state: "connected",
            selectedCalendarId: "selected-fixture-calendar", lastSyncAt: now, complete: true,
            horizonStart: now, horizonEnd: now.addingTimeInterval(30 * 86_400),
            events: [IOSAgendaEvent(title: "Fixture calendar event", status: "confirmed",
                start: now.addingTimeInterval(86_400), end: now.addingTimeInterval(90_000),
                startDate: nil, endDate: nil, timeZone: "America/Los_Angeles")])
    }
}

private actor HomeAppearanceWeatherTransport: WeatherTransport {
    let probe: HomeAppearanceProbe
    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func data(for request: URLRequest, maximumBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let shouldFail = await probe.calledWeather()
        if shouldFail {
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 503,
                httpVersion: nil, headerFields: nil)!)
        }
        let json = """
            {"current":{"time":\(Int(Date().timeIntervalSince1970)),"temperature_2m":72.4,
            "apparent_temperature":71.1,"weather_code":2,"is_day":1,"wind_speed_10m":8.7},
            "current_units":{"temperature_2m":"°F","wind_speed_10m":"mp/h"}}
            """
        return (Data(json.utf8), HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: nil)!)
    }
}

private actor HomeAppearanceVault: NativeCredentialVault {
    let probe: HomeAppearanceProbe
    private var active: NativeEnrollmentCredential? = NativeEnrollmentCredential(
        origin: URL(string: "https://127.0.0.1:8444")!,
        certificateSha256: String(repeating: "b", count: 64),
        client: NativeClient(
            id: "home-fixture-phone", role: "native_phone_controller", label: "Home fixture phone",
            grants: [NativeGrant(target: "fixture-mac", capabilities: ["app.open"])],
            createdAt: 1_800_000_000_000, expiresAt: 1_807_776_000_000),
        token: String(repeating: "c", count: 64))

    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func loadActive() async -> NativeEnrollmentCredential? {
        await probe.readVault()
        return active
    }
    func loadPending() async -> PendingNativeEnrollment? {
        await probe.readVault()
        return nil
    }
    func savePending(_ value: PendingNativeEnrollment) throws { throw NativeEnrollmentFailure.unavailable }
    func promote(_ value: NativeEnrollmentCredential) throws { throw NativeEnrollmentFailure.unavailable }
    func removePending() {}
    func removeActive() { active = nil }
    func removeAll() { active = nil }
}

private actor HomeAppearanceRejectTransport: NativeEnrollmentTransporting {
    let probe: HomeAppearanceProbe
    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) async throws -> NativeClient {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
    func recover(_ pending: PendingNativeEnrollment) async throws -> NativeClient? {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
    func logout(_ credential: NativeEnrollmentCredential) async throws {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
}
#endif
