import Combine
import CryptoKit
import Foundation
import SwiftUI

enum IOSAgendaFailure: Error, Equatable {
    case revoked, unavailable, invalidResponse
}

struct IOSAgendaConnection: Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let state: String
    let selectedCalendarId: String
}

struct IOSAgendaEvent: Equatable, Sendable {
    let title: String
    let status: String
    let start: Date?
    let end: Date?
    let startDate: String?
    let endDate: String?
    let timeZone: String?
}

struct IOSAgendaSnapshot: Equatable, Sendable {
    let connectionId: String
    let label: String
    let state: String
    let selectedCalendarId: String
    let displayTimeZone: String
    let lastSyncAt: Date?
    let complete: Bool
    let horizonStart: Date
    let horizonEnd: Date
    let events: [IOSAgendaEvent]
}

enum IOSAgendaPresentation {
    static func upcoming(_ snapshot: IOSAgendaSnapshot, at now: Date,
                         timeZone: TimeZone) -> [IOSAgendaEvent] {
        guard snapshot.displayTimeZone == timeZone.identifier else { return [] }
        let display = DateFormatter()
        display.locale = Locale(identifier: "en_US_POSIX")
        display.timeZone = timeZone
        display.dateFormat = "yyyy-MM-dd"
        let today = display.string(from: now)
        return snapshot.events.filter { event in
            if let end = event.end { return end > now }
            return event.endDate.map { $0 > today } ?? false
        }
    }
}

enum IOSAgendaWire {
    private static func object(_ value: Any) throws -> [String: Any] {
        guard let object = value as? [String: Any] else { throw IOSAgendaFailure.invalidResponse }
        return object
    }
    private static func text(_ value: Any?, maximum: Int) throws -> String {
        guard let value = value as? String, !value.isEmpty,
              value.utf16.count <= maximum, value.utf8.count <= maximum * 4,
              value.unicodeScalars.allSatisfy({ scalar in
                  !CharacterSet.controlCharacters.contains(scalar) ||
                      scalar.value == 0x200C || scalar.value == 0x200D
              })
        else { throw IOSAgendaFailure.invalidResponse }
        return value
    }
    private static func milliseconds(_ value: Any?) throws -> Date {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue <= 4_102_444_800_000,
              number.doubleValue == Double(number.int64Value)
        else { throw IOSAgendaFailure.invalidResponse }
        return Date(timeIntervalSince1970: number.doubleValue / 1_000)
    }
    private static func identifier(_ value: Any?) throws -> String {
        let value = try text(value, maximum: 128)
        guard value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
        else { throw IOSAgendaFailure.invalidResponse }
        return value
    }
    static func connections(_ data: Data) throws -> [IOSAgendaConnection] {
        guard data.count <= 48_000 else { throw IOSAgendaFailure.invalidResponse }
        let root = try object(JSONSerialization.jsonObject(with: data))
        guard Set(root.keys) == ["connections", "providers"],
              let rows = root["connections"] as? [Any], rows.count <= 100
        else { throw IOSAgendaFailure.invalidResponse }
        return try rows.compactMap { raw in
            let row = try object(raw)
            guard let provider = row["provider"] as? String else { throw IOSAgendaFailure.invalidResponse }
            if provider != "google-calendar" { return nil }
            guard Set(row.keys).isSubset(of: ["id", "provider", "label", "state", "mode", "lastSyncAt", "error", "selectedCalendarId"]),
                  let state = row["state"] as? String,
                  ["connecting", "connected", "paused", "error", "revoked"].contains(state)
            else { throw IOSAgendaFailure.invalidResponse }
            return IOSAgendaConnection(
                id: try identifier(row["id"]),
                label: String(try text(row["label"], maximum: 2_000).prefix(80)),
                state: state, selectedCalendarId: try text(row["selectedCalendarId"], maximum: 1_024))
        }
    }
    static func snapshot(_ data: Data, expectedID: String, now: Date = Date()) throws -> IOSAgendaSnapshot {
        guard data.count <= 48_000 else { throw IOSAgendaFailure.invalidResponse }
        let root = try object(JSONSerialization.jsonObject(with: data))
        guard Set(root.keys).isSubset(of: ["connectionId", "label", "state", "selectedCalendarId", "displayTimeZone", "lastSyncAt", "complete", "horizonStart", "horizonEnd", "events"]),
              Set(["connectionId", "label", "state", "selectedCalendarId", "displayTimeZone", "complete", "horizonStart", "horizonEnd", "events"]).isSubset(of: Set(root.keys)),
              try identifier(root["connectionId"]) == expectedID,
              let state = root["state"] as? String,
              ["connected", "paused", "error", "connecting"].contains(state),
              let complete = root["complete"] as? NSNumber,
              CFGetTypeID(complete) == CFBooleanGetTypeID(),
              let rows = root["events"] as? [Any], rows.count <= 20
        else { throw IOSAgendaFailure.invalidResponse }
        let horizonStart = try milliseconds(root["horizonStart"])
        let horizonEnd = try milliseconds(root["horizonEnd"])
        let displayTimeZone = try text(root["displayTimeZone"], maximum: 80)
        guard horizonEnd > horizonStart,
              abs(horizonEnd.timeIntervalSince(horizonStart) - 30 * 86_400) < 0.001,
              abs(now.timeIntervalSince(horizonStart)) <= 86_400,
              displayTimeZone == TimeZone.current.identifier,
              complete.boolValue || rows.isEmpty
        else { throw IOSAgendaFailure.invalidResponse }
        let lastSyncAt = try root["lastSyncAt"].map(milliseconds)
        guard (!complete.boolValue || lastSyncAt != nil),
              lastSyncAt.map({ $0 <= now.addingTimeInterval(86_400) }) ?? true
        else { throw IOSAgendaFailure.invalidResponse }
        let events = try rows.map { raw -> IOSAgendaEvent in
            let event = try object(raw)
            guard Set(event.keys).isSubset(of: ["title", "status", "startAt", "endAt", "startDate", "endDate", "timeZone"]),
                  let status = event["status"] as? String,
                  status == "confirmed" || status == "tentative"
            else { throw IOSAgendaFailure.invalidResponse }
            let title = try text(event["title"], maximum: 160)
            if event["startAt"] != nil || event["endAt"] != nil {
                guard event["startDate"] == nil, event["endDate"] == nil else { throw IOSAgendaFailure.invalidResponse }
                let start = try milliseconds(event["startAt"])
                let end = try milliseconds(event["endAt"])
                guard start < end, end > horizonStart.addingTimeInterval(-86_400),
                      start < horizonEnd else { throw IOSAgendaFailure.invalidResponse }
                let timeZone = try event["timeZone"].map { try text($0, maximum: 80) }
                return IOSAgendaEvent(title: title, status: status, start: start, end: end,
                    startDate: nil, endDate: nil, timeZone: timeZone)
            }
            guard event["timeZone"] == nil else { throw IOSAgendaFailure.invalidResponse }
            let startDate = try text(event["startDate"], maximum: 10)
            let endDate = try text(event["endDate"], maximum: 10)
            guard validDay(startDate), validDay(endDate), startDate < endDate else {
                throw IOSAgendaFailure.invalidResponse
            }
            return IOSAgendaEvent(title: title, status: status, start: nil, end: nil,
                startDate: startDate, endDate: endDate, timeZone: nil)
        }
        return IOSAgendaSnapshot(connectionId: expectedID, label: try text(root["label"], maximum: 80),
            state: state, selectedCalendarId: try text(root["selectedCalendarId"], maximum: 1_024),
            displayTimeZone: displayTimeZone,
            lastSyncAt: lastSyncAt, complete: complete.boolValue, horizonStart: horizonStart,
            horizonEnd: horizonEnd, events: events)
    }
    private static func validDay(_ value: String) -> Bool {
        guard value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter.date(from: value).map { formatter.string(from: $0) == value } ?? false
    }
}

protocol IOSAgendaClient: Sendable {
    func connections(_ credential: NativeEnrollmentCredential) async throws -> [IOSAgendaConnection]
    func agenda(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSAgendaSnapshot
}

struct IOSPinnedAgendaClient: IOSAgendaClient {
    private let transport = NativeEnrollmentTransport()
    private let authorizer = NativeLifeWebSessionAuthorizer()
    func connections(_ credential: NativeEnrollmentCredential) async throws -> [IOSAgendaConnection] {
        let (data, response) = try await get(credential, path: "/api/connections")
        try check(response.statusCode)
        return try IOSAgendaWire.connections(data)
    }
    func agenda(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSAgendaSnapshot {
        guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
        else { throw IOSAgendaFailure.invalidResponse }
        var components = URLComponents()
        components.path = "/api/connections/\(id)/agenda"
        components.queryItems = [URLQueryItem(name: "timeZone", value: TimeZone.current.identifier)]
        guard let path = components.string else { throw IOSAgendaFailure.invalidResponse }
        let (data, response) = try await get(credential, path: path)
        try check(response.statusCode)
        return try IOSAgendaWire.snapshot(data, expectedID: id)
    }
    private func get(_ credential: NativeEnrollmentCredential, path: String) async throws
        -> (Data, HTTPURLResponse) {
        let authority = LifeWebCredential(enrollment: credential)
        let session = try await authorizer.authorize(authority)
        try Task.checkCancellation()
        guard session.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else {
            throw IOSAgendaFailure.unavailable
        }
        return try await transport.lifeCalendarGET(path: path, credential: authority,
            sessionToken: session.token)
    }
    private func check(_ status: Int) throws {
        switch status {
        case 200: return
        case 401, 403, 404: throw IOSAgendaFailure.revoked
        default: throw IOSAgendaFailure.unavailable
        }
    }
}

@MainActor
final class IOSGoogleAgendaStore: ObservableObject {
    @Published private(set) var connections: [IOSAgendaConnection] = []
    @Published private(set) var selectedID: String?
    @Published private(set) var snapshot: IOSAgendaSnapshot?
    @Published private(set) var refreshedAt: Date?
    @Published private(set) var isRefreshing = false
    @Published private(set) var message: String?
    private let client: IOSAgendaClient
    private let defaults: UserDefaults
    private var credential: NativeEnrollmentCredential?
    private var scope: String?
    private var operation: Task<Void, Never>?
    private var generation = 0

    var snapshotProvenance: String {
        isRefreshing || message != nil ? "Cached this session" : "Current read"
    }

    init(client: IOSAgendaClient = IOSPinnedAgendaClient(), defaults: UserDefaults = .standard) {
        self.client = client
        self.defaults = defaults
    }

    func bind(_ incoming: NativeEnrollmentCredential?) {
        let next = incoming.map(Self.scopeForCredential)
        guard next != scope || incoming != credential else { return }
        generation += 1
        operation?.cancel(); operation = nil
        credential = incoming
        scope = next
        connections = []
        snapshot = nil
        refreshedAt = nil
        isRefreshing = false
        message = nil
        selectedID = next.flatMap { defaults.string(forKey: "ios-agenda-selected-\($0)") }
    }

    func select(_ id: String) {
        guard let scope, connections.contains(where: { $0.id == id && $0.state != "revoked" }) else { return }
        generation += 1
        operation?.cancel(); operation = nil
        isRefreshing = false
        selectedID = id
        snapshot = nil
        refreshedAt = nil
        message = "Tap Refresh to read events already imported on your Mac."
        defaults.set(id, forKey: "ios-agenda-selected-\(scope)")
    }

    func refresh() {
        guard let credential, let scope, !isRefreshing else { return }
        generation += 1
        let ticket = generation
        isRefreshing = true
        message = nil
        operation = Task { [weak self, client] in
            do {
                let available = try await client.connections(credential)
                try Task.checkCancellation()
                guard let self, self.generation == ticket, self.scope == scope else { return }
                self.connections = available.filter { $0.state != "revoked" }
                if let id = self.selectedID, !self.connections.contains(where: { $0.id == id }) {
                    self.clearSelection(scope: scope)
                }
                if let old = self.snapshot, let id = self.selectedID,
                   let current = self.connections.first(where: { $0.id == id }),
                   old.selectedCalendarId != current.selectedCalendarId {
                    self.snapshot = nil
                    self.refreshedAt = nil
                }
                if let id = self.selectedID {
                    let result = try await client.agenda(credential, id: id)
                    try Task.checkCancellation()
                    guard self.generation == ticket, self.scope == scope, self.selectedID == id else { return }
                    if result.selectedCalendarId == self.connections.first(where: { $0.id == id })?.selectedCalendarId {
                        self.snapshot = result
                        self.refreshedAt = Date()
                        self.message = !result.complete
                            ? "The Mac has not completed its first calendar import."
                            : result.state == "connected" ? nil
                            : "The Mac account is \(result.state). Showing its last completed import."
                    } else {
                        self.message = "The selected calendar changed during this read. Tap Refresh to check the Mac again."
                    }
                } else {
                    self.message = self.connections.isEmpty
                        ? "Connect Google Calendar in Ellie Life on your Mac, then refresh here."
                        : "Choose a connected Google account below."
                }
            } catch is CancellationError { }
            catch {
                guard let self, self.generation == ticket, self.scope == scope else { return }
                if error as? IOSAgendaFailure == .revoked || error as? LifeWebSessionFailure == .revoked ||
                    error as? LifeWebSessionFailure == .grantRequired {
                    self.connections = []
                    self.clearSelection(scope: scope)
                    self.message = "Account access was removed. Open Ellie Life on your Mac to reconnect."
                } else {
                    self.message = self.snapshot == nil
                        ? "Calendar is unavailable. Check your Mac connection and tap Refresh."
                        : "Offline. Showing events cached in this app session; tap Refresh when connected."
                }
            }
            guard let self, self.generation == ticket, self.scope == scope else { return }
            self.isRefreshing = false
            self.operation = nil
        }
    }

    private func clearSelection(scope: String) {
        defaults.removeObject(forKey: "ios-agenda-selected-\(scope)")
        selectedID = nil
        snapshot = nil
        refreshedAt = nil
    }
    private static func scopeForCredential(_ credential: NativeEnrollmentCredential) -> String {
        let identity = "\(credential.origin.absoluteString)|\(credential.certificateSha256)|\(credential.client.id)|\(credential.token)"
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

@MainActor
struct IOSGoogleAgendaWidget: View {
    @ObservedObject var store: IOSGoogleAgendaStore
    @ObservedObject var enrollment: NativeEnrollmentStore
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if case .enrolled(let credential) = enrollment.phase {
                if let selected = store.connections.first(where: { $0.id == store.selectedID }) {
                    Text(selected.label).font(.subheadline.weight(.semibold))
                    Text("Selected calendar: \(store.snapshot?.selectedCalendarId ?? selected.selectedCalendarId)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let snapshot = store.snapshot {
                    if !snapshot.complete {
                        Text("Waiting for the Mac’s first completed import.").font(.caption)
                    } else {
                        TimelineView(.periodic(from: .now, by: 60)) { context in
                            if snapshot.displayTimeZone != TimeZone.current.identifier {
                                Text("Time zone changed. Refresh this calendar before viewing events.")
                                    .font(.caption).foregroundStyle(.secondary)
                            } else {
                                let events = IOSAgendaPresentation.upcoming(snapshot, at: context.date,
                                    timeZone: .current)
                                if events.isEmpty {
                                    Text("No upcoming events in this read. Refresh to check the Mac’s latest import.")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                ForEach(Array(events.prefix(3).enumerated()), id: \.offset) { _, event in
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(event.title).font(.subheadline)
                                        Text(eventDate(event)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    if let last = snapshot.lastSyncAt {
                        Text("Mac import: \(last.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Text("Read here: \(store.refreshedAt?.formatted(date: .abbreviated, time: .shortened) ?? "Unknown") · \(store.snapshotProvenance)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let message = store.message {
                    Label(message, systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("ios-agenda-message")
                }
                if store.isRefreshing { ProgressView("Reading imported calendar") }
                Menu("Google account") {
                    if store.connections.isEmpty {
                        Text("Refresh to find connected accounts")
                    }
                    ForEach(store.connections) { connection in
                        Button(connection.label) { store.select(connection.id) }
                    }
                }
                .accessibilityIdentifier("ios-agenda-account")
                Button("Refresh imported agenda") { store.refresh() }
                    .disabled(store.isRefreshing)
                    .accessibilityIdentifier("ios-agenda-refresh")
                NavigationLink("View calendar status in Ellie Life") {
                    LifeWebView(credential: LifeWebCredential(enrollment: credential))
                }
                .font(.caption)
                .accessibilityIdentifier("ios-agenda-life-status")
                Text("Before starting consent, verify a Google Desktop OAuth client on your coordinator Mac. Then connect Calendar, choose a calendar, and refresh the provider in Ellie Life on that Mac. This iPhone only reads the existing import when you refresh here; it does not start consent.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("ios-agenda-setup-guidance")
            } else {
                Text("Pair this iPhone and grant Ellie Life account access to read your Mac’s imported calendar.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private func eventDate(_ event: IOSAgendaEvent) -> String {
        if let start = event.start, let end = event.end {
            return "\(start.formatted(date: .abbreviated, time: .shortened)) – \(end.formatted(date: .abbreviated, time: .shortened))"
        }
        if let first = event.startDate, let exclusiveEnd = event.endDate {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withFullDate]
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(secondsFromGMT: 0)!
            if let start = formatter.date(from: first), let end = formatter.date(from: exclusiveEnd),
               let last = calendar.date(byAdding: .day, value: -1, to: end) {
                let display = DateFormatter()
                display.locale = .current
                display.calendar = calendar
                display.timeZone = calendar.timeZone
                display.dateStyle = .medium
                let startLabel = display.string(from: start)
                let endLabel = display.string(from: last)
                return startLabel == endLabel ? "All day · \(startLabel)" : "All day · \(startLabel) – \(endLabel)"
            }
        }
        return "All-day date unavailable"
    }
}
