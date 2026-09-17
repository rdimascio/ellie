import Combine
import Foundation
import SwiftUI

enum IOSQuietFailure: Error, Equatable { case revoked, unavailable, invalidResponse }

struct IOSQuietSession: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let updatedAt: Date
    let turnCount: Int
    let pending: Bool
}

struct IOSQuietPage: Equatable, Sendable {
    let sessions: [IOSQuietSession]
    let hasMore: Bool
    let nextCursor: String?
}

struct IOSQuietTurn: Identifiable, Equatable, Sendable {
    let id: String
    let request: String
    let reply: String?
    let status: String
    let updatedAt: Date
}

struct IOSQuietFinding: Equatable, Sendable {
    let summary: String
    let citations: [String]
}

struct IOSQuietActivity: Identifiable, Equatable, Sendable {
    let id: String
    let state: String
    let updatedAt: Date
    let progress: [String]
    let finding: IOSQuietFinding?
    let findingStale: Bool
}

struct IOSQuietDetail: Equatable, Sendable {
    let session: IOSQuietSession
    let originalRequest: String
    let turns: [IOSQuietTurn]
    let activity: [IOSQuietActivity]
    let activityLimited: Bool
    let olderTurnsOmitted: Bool
}

enum IOSQuietWire {
    private static func object(_ raw: Any?) throws -> [String: Any] {
        guard let value = raw as? [String: Any] else { throw IOSQuietFailure.invalidResponse }
        return value
    }
    private static func keys(_ value: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(value.keys)), Set(value.keys).isSubset(of: required.union(optional))
        else { throw IOSQuietFailure.invalidResponse }
    }
    private static func text(_ raw: Any?, maximum: Int, empty: Bool = false) throws -> String {
        guard let value = raw as? String, (empty || !value.isEmpty), value.utf8.count <= maximum * 4,
              value.unicodeScalars.count <= maximum,
              !value.unicodeScalars.contains(where: {
                  CharacterSet.controlCharacters.contains($0) &&
                  ![9, 10, 13, 0x200C, 0x200D].contains($0.value)
              })
        else { throw IOSQuietFailure.invalidResponse }
        return value
    }
    private static func id(_ raw: Any?) throws -> String {
        let value = try text(raw, maximum: 200)
        guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$",
            options: .regularExpression) != nil
        else { throw IOSQuietFailure.invalidResponse }
        return value
    }
    private static func sessionID(_ raw: Any?) throws -> String {
        let value = try id(raw)
        guard value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
        else { throw IOSQuietFailure.invalidResponse }
        return value
    }
    private static func bool(_ raw: Any?) throws -> Bool {
        guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID()
        else { throw IOSQuietFailure.invalidResponse }
        return value.boolValue
    }
    private static func number(_ raw: Any?, maximum: Int) throws -> Int {
        guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue == Double(value.intValue), (0...maximum).contains(value.intValue)
        else { throw IOSQuietFailure.invalidResponse }
        return value.intValue
    }
    private static func date(_ raw: Any?) throws -> Date {
        let value = try text(raw, maximum: 40)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        else { throw IOSQuietFailure.invalidResponse }
        return date
    }
    private static func root(_ data: Data, maximum: Int) throws -> [String: Any] {
        guard data.count <= maximum else { throw IOSQuietFailure.invalidResponse }
        return try object(JSONSerialization.jsonObject(with: data))
    }
    private static func session(_ raw: Any?, detail: Bool = false) throws -> IOSQuietSession {
        let value = try object(raw)
        if detail {
            try keys(value, required: ["id", "title", "updatedAt", "pending"])
        } else {
            try keys(value, required: ["id", "title", "updatedAt", "turnCount", "pending"])
        }
        return IOSQuietSession(id: try sessionID(value["id"]), title: try text(value["title"], maximum: 160),
            updatedAt: try date(value["updatedAt"]),
            turnCount: detail ? 0 : try number(value["turnCount"], maximum: 10_000),
            pending: try bool(value["pending"]))
    }
    static func page(_ data: Data) throws -> IOSQuietPage {
        let value = try root(data, maximum: 24_000)
        try keys(value, required: ["sessions", "page"])
        guard let rows = value["sessions"] as? [Any], rows.count <= 20 else {
            throw IOSQuietFailure.invalidResponse
        }
        let sessions = try rows.map { try session($0) }
        guard Set(sessions.map(\.id)).count == sessions.count else { throw IOSQuietFailure.invalidResponse }
        let page = try object(value["page"])
        try keys(page, required: ["hasMore"], optional: ["nextCursor"])
        let hasMore = try bool(page["hasMore"])
        let cursor = try page["nextCursor"].map { try text($0, maximum: 512) }
        guard hasMore == (cursor != nil),
              cursor == nil || cursor?.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil
        else { throw IOSQuietFailure.invalidResponse }
        return IOSQuietPage(sessions: sessions, hasMore: hasMore, nextCursor: cursor)
    }
    static func detail(_ data: Data, expectedID: String) throws -> IOSQuietDetail {
        let value = try root(data, maximum: 256_000)
        try keys(value, required: ["session", "originalRequest", "turns", "activity", "activityLimited", "page"])
        let selected = try session(value["session"], detail: true)
        guard selected.id == expectedID, let turnRows = value["turns"] as? [Any],
              turnRows.count <= 12, let activityRows = value["activity"] as? [Any],
              activityRows.count <= 8 else { throw IOSQuietFailure.invalidResponse }
        let turns: [IOSQuietTurn] = try turnRows.map { raw in
            let row = try object(raw)
            try keys(row, required: ["id", "request", "status", "updatedAt"], optional: ["reply"])
            let status = try text(row["status"], maximum: 16)
            guard ["pending", "completed", "interrupted"].contains(status)
            else { throw IOSQuietFailure.invalidResponse }
            return IOSQuietTurn(id: try id(row["id"]), request: try text(row["request"], maximum: 1_000),
                reply: try row["reply"].map { try text($0, maximum: 2_000, empty: true) },
                status: status, updatedAt: try date(row["updatedAt"]))
        }
        let activities: [IOSQuietActivity] = try activityRows.map { raw in
            let row = try object(raw)
            try keys(row, required: ["id", "state", "updatedAt", "progress"],
                optional: ["finding", "findingStale"])
            let state = try text(row["state"], maximum: 16)
            guard ["queued", "running", "waiting", "scheduled", "paused", "succeeded",
                   "failed", "cancelled", "expired", "unknown"].contains(state),
                  let progressRows = row["progress"] as? [Any], progressRows.count <= 4
            else { throw IOSQuietFailure.invalidResponse }
            let progress: [String] = try progressRows.map { item in
                let point = try object(item)
                try keys(point, required: ["at", "message"])
                _ = try date(point["at"])
                return try text(point["message"], maximum: 200)
            }
            var finding: IOSQuietFinding?
            if let rawFinding = row["finding"] {
                let found = try object(rawFinding)
                try keys(found, required: ["summary", "citations"])
                guard let citations = found["citations"] as? [Any], (1...4).contains(citations.count),
                      state == "succeeded" else { throw IOSQuietFailure.invalidResponse }
                let titles: [String] = try citations.map { item in
                    let citation = try object(item)
                    try keys(citation, required: ["title", "sourceId", "sourceRevision"])
                    _ = try id(citation["sourceId"])
                    _ = try number(citation["sourceRevision"], maximum: Int.max)
                    return try text(citation["title"], maximum: 160)
                }
                finding = IOSQuietFinding(summary: try text(found["summary"], maximum: 600),
                    citations: titles)
            }
            let stale = try row["findingStale"].map { try bool($0) } ?? false
            guard !stale || finding == nil else { throw IOSQuietFailure.invalidResponse }
            return IOSQuietActivity(id: try id(row["id"]), state: state,
                updatedAt: try date(row["updatedAt"]), progress: progress,
                finding: finding, findingStale: stale)
        }
        guard Set(turns.map(\.id)).count == turns.count,
              Set(activities.map(\.id)).count == activities.count else {
            throw IOSQuietFailure.invalidResponse
        }
        let page = try object(value["page"])
        try keys(page, required: ["hasMore"])
        return IOSQuietDetail(session: selected,
            originalRequest: try text(value["originalRequest"], maximum: 1_000, empty: true),
            turns: turns, activity: activities,
            activityLimited: try bool(value["activityLimited"]),
            olderTurnsOmitted: try bool(page["hasMore"]))
    }
}

protocol IOSQuietClient: Sendable {
    func sessions(_ credential: NativeEnrollmentCredential, limit: Int, cursor: String?) async throws -> IOSQuietPage
    func detail(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSQuietDetail
}

struct IOSPinnedQuietClient: IOSQuietClient {
    private let transport = NativeEnrollmentTransport()
    private let authorizer = NativeLifeWebSessionAuthorizer()
    func sessions(_ credential: NativeEnrollmentCredential, limit: Int, cursor: String?) async throws -> IOSQuietPage {
        guard limit == 3 || limit == 20,
              cursor == nil || cursor?.range(of: "^[A-Za-z0-9_-]{1,512}$", options: .regularExpression) != nil
        else { throw IOSQuietFailure.invalidResponse }
        let suffix = cursor.map { "&cursor=\($0)" } ?? ""
        let (data, response) = try await get(credential,
            path: "/api/life/native/sessions?limit=\(limit)\(suffix)")
        try check(response.statusCode)
        let page = try IOSQuietWire.page(data)
        guard page.sessions.count <= limit else { throw IOSQuietFailure.invalidResponse }
        return page
    }
    func detail(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSQuietDetail {
        guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
        else { throw IOSQuietFailure.invalidResponse }
        let (data, response) = try await get(credential, path: "/api/life/native/sessions/\(id)")
        try check(response.statusCode)
        return try IOSQuietWire.detail(data, expectedID: id)
    }
    private func get(_ credential: NativeEnrollmentCredential, path: String) async throws
        -> (Data, HTTPURLResponse) {
        let authority = LifeWebCredential(enrollment: credential)
        let session = try await authorizer.authorize(authority)
        try Task.checkCancellation()
        guard session.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000)
        else { throw IOSQuietFailure.unavailable }
        return try await transport.lifeQuietGET(path: path, credential: authority,
            sessionToken: session.token)
    }
    private func check(_ status: Int) throws {
        switch status {
        case 200: return
        case 401, 403: throw IOSQuietFailure.revoked
        default: throw IOSQuietFailure.unavailable
        }
    }
}

@MainActor
final class IOSQuietSessionsStore: ObservableObject {
    @Published private(set) var recent: [IOSQuietSession] = []
    @Published private(set) var all: [IOSQuietSession] = []
    @Published private(set) var detail: IOSQuietDetail?
    @Published private(set) var busy = false
    @Published private(set) var notice: String?
    @Published private(set) var hasMore = false
    private(set) var selectedID: String?
    private var cursor: String?
    private var credential: NativeEnrollmentCredential?
    private var generation = 0
    private var operation: Task<Void, Never>?
    private let client: IOSQuietClient

    init(client: IOSQuietClient = IOSPinnedQuietClient()) { self.client = client }

    func bind(_ incoming: NativeEnrollmentCredential?) {
        guard credential != incoming else { return }
        invalidate()
        credential = incoming
        recent = []; all = []; detail = nil; selectedID = nil
        cursor = nil; hasMore = false; notice = nil
    }
    func refreshRecent() {
        guard let credential else { return }
        invalidate()
        busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let page = try await client.sessions(credential, limit: 3, cursor: nil)
                try Task.checkCancellation()
                guard let self, self.generation == ticket else { return }
                self.recent = page.sessions
                self.notice = page.sessions.isEmpty
                    ? "No Life sessions yet. Start one in Ellie Life on your Mac."
                    : nil
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func loadAll() { loadPage(cursor: nil) }
    func loadMore() {
        guard hasMore, let cursor else { return }
        loadPage(cursor: cursor)
    }
    private func loadPage(cursor requestedCursor: String?) {
        guard let credential else { return }
        invalidate()
        busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let page = try await client.sessions(credential, limit: 20, cursor: requestedCursor)
                try Task.checkCancellation()
                guard let self, self.generation == ticket else { return }
                if requestedCursor == nil { self.all = page.sessions }
                else {
                    guard Set(self.all.map(\.id)).isDisjoint(with: page.sessions.map(\.id))
                    else { throw IOSQuietFailure.invalidResponse }
                    self.all += page.sessions
                }
                self.cursor = page.nextCursor
                self.hasMore = page.hasMore
                self.notice = self.all.isEmpty ? "No Life sessions yet." : nil
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func open(_ id: String) {
        guard let credential, selectedID == id || (recent + all).contains(where: { $0.id == id })
        else { return }
        invalidate()
        selectedID = id; detail = nil; busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let result = try await client.detail(credential, id: id)
                try Task.checkCancellation()
                guard let self, self.generation == ticket, self.selectedID == id else { return }
                self.detail = result
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func cancel() {
        invalidate()
        recent = []; all = []; detail = nil
        cursor = nil; hasMore = false
        notice = "Read cancelled. Refresh when you’re ready."
    }
    func background() {
        invalidate()
        recent = []; all = []; detail = nil
        cursor = nil; hasMore = false; notice = nil
    }
    private func invalidate() {
        generation += 1
        operation?.cancel(); operation = nil
        busy = false
    }
    private func finish(ticket: Int) {
        guard generation == ticket else { return }
        busy = false; operation = nil
    }
    private func fail(_ error: Error, ticket: Int) {
        guard generation == ticket else { return }
        if error as? IOSQuietFailure == .revoked ||
            error as? LifeWebSessionFailure == .revoked ||
            error as? LifeWebSessionFailure == .grantRequired {
            recent = []; all = []; detail = nil; selectedID = nil
            cursor = nil; hasMore = false
            notice = "Life access was removed. Restore the Life account grant on your Mac."
        } else {
            recent = []; all = []; detail = nil
            cursor = nil; hasMore = false
            notice = "Sessions are unavailable. Check your Mac and refresh to read current work."
        }
    }
}

@MainActor
struct IOSQuietSessionsHome: View {
    @ObservedObject var store: IOSQuietSessionsStore
    let credential: NativeEnrollmentCredential
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Your recent sessions")
                    .font(.title2.weight(.medium)).foregroundStyle(ElliePalette.foreground)
                Spacer(minLength: 8)
                Button("Refresh") { store.refreshRecent() }
                    .font(.subheadline).disabled(store.busy)
                    .accessibilityIdentifier("quiet-refresh")
            }
            if store.busy {
                ProgressView("Reading sessions")
                Button("Stop waiting") { store.cancel() }
                    .accessibilityIdentifier("quiet-cancel")
            }
            if let notice = store.notice {
                Text(notice).font(.subheadline).foregroundStyle(ElliePalette.muted)
                    .accessibilityIdentifier("quiet-notice")
            }
            ForEach(store.recent) { session in
                NavigationLink {
                    IOSQuietSessionDetail(store: store, id: session.id)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(session.title).font(.body.weight(.medium))
                                .foregroundStyle(ElliePalette.foreground)
                            Text(session.pending ? "Reply in progress" : "Updated \(session.updatedAt.formatted(.relative(presentation: .named)))")
                                .font(.caption).foregroundStyle(ElliePalette.muted)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.right").font(.caption)
                            .foregroundStyle(ElliePalette.muted)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("quiet-session-\(session.id)")
                if session.id != store.recent.last?.id { Divider().overlay(ElliePalette.border) }
            }
            HStack(spacing: 18) {
                NavigationLink("See all") { IOSQuietAllSessions(store: store) }
                    .accessibilityIdentifier("quiet-see-all")
                Spacer()
                NavigationLink {
                    IOSQuietVoiceEntry(credential: credential)
                } label: { Label("Voice controls", systemImage: "waveform") }
                    .accessibilityIdentifier("quiet-voice")
            }
            .font(.subheadline.weight(.medium))
            Text("Review Life sessions here. Use Voice controls for reviewed desktop actions.")
                .font(.caption).foregroundStyle(ElliePalette.muted)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 12)
        .onAppear {
            store.bind(credential)
            if store.recent.isEmpty && !store.busy { store.refreshRecent() }
        }
        .onChange(of: credential) { _, updated in store.bind(updated); store.refreshRecent() }
        .onChange(of: scenePhase) { _, phase in if phase != .active { store.background() } }
        .accessibilityIdentifier("quiet-home")
    }
}

@MainActor
private struct IOSQuietVoiceEntry: View {
    let credential: NativeEnrollmentCredential
    @StateObject private var controls: PhoneControlStore
    @StateObject private var browser: BrowserPhoneControlStore
    init(credential: NativeEnrollmentCredential) {
        self.credential = credential
        _controls = StateObject(wrappedValue: PhoneControlStore(credential: credential))
        _browser = StateObject(wrappedValue: BrowserPhoneControlStore(credential: credential))
    }
    var body: some View {
        SpeechTurnView(credential: credential, controls: controls, browser: browser)
    }
}

@MainActor
private struct IOSQuietAllSessions: View {
    @ObservedObject var store: IOSQuietSessionsStore
    var body: some View {
        List {
            if store.busy {
                ProgressView("Reading sessions")
                    .accessibilityIdentifier("quiet-all-progress")
                Button("Stop waiting") { store.cancel() }
                    .accessibilityIdentifier("quiet-all-cancel")
            }
            if let notice = store.notice {
                Text(notice).accessibilityIdentifier("quiet-all-notice")
            }
            ForEach(store.all) { session in
                NavigationLink(session.title) { IOSQuietSessionDetail(store: store, id: session.id) }
                    .accessibilityIdentifier("quiet-all-session-\(session.id)")
            }
            if store.hasMore {
                Button("Load more") { store.loadMore() }.disabled(store.busy)
                    .accessibilityIdentifier("quiet-load-more")
            }
        }
        .navigationTitle("All sessions")
        .ellieScreen()
        .toolbar { Button("Refresh") { store.loadAll() }.disabled(store.busy) }
        .onAppear { if store.all.isEmpty && !store.busy { store.loadAll() } }
    }
}

@MainActor
private struct IOSQuietSessionDetail: View {
    @ObservedObject var store: IOSQuietSessionsStore
    let id: String
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                if store.busy {
                    ProgressView("Reading session")
                    Button("Stop waiting") { store.cancel() }
                        .accessibilityIdentifier("quiet-detail-cancel")
                }
                if let notice = store.notice {
                    Text(notice).foregroundStyle(ElliePalette.muted)
                        .accessibilityIdentifier("quiet-detail-notice")
                }
                if let detail = store.detail, detail.session.id == id {
                    if detail.olderTurnsOmitted && !detail.originalRequest.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Original request").font(.caption).foregroundStyle(ElliePalette.muted)
                            Text(detail.originalRequest).foregroundStyle(ElliePalette.foreground)
                        }
                        .accessibilityIdentifier("quiet-original-request")
                    }
                    ForEach(detail.turns.reversed()) { turn in
                        VStack(alignment: .leading, spacing: 10) {
                            Text("You asked").font(.caption).foregroundStyle(ElliePalette.muted)
                            Text(turn.request).font(.body).foregroundStyle(ElliePalette.foreground)
                            if let reply = turn.reply {
                                Text("Ellie replied").font(.caption).foregroundStyle(ElliePalette.muted)
                                Text(reply).font(.body).foregroundStyle(ElliePalette.foreground)
                            } else if turn.status == "pending" {
                                Text("Reply in progress").foregroundStyle(ElliePalette.muted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("quiet-turn-\(turn.id)")
                        Divider().overlay(ElliePalette.border)
                    }
                    if detail.olderTurnsOmitted {
                        Text("Older turns are available in Ellie Life on your Mac.")
                            .font(.footnote).foregroundStyle(ElliePalette.muted)
                    }
                    if !detail.activity.isEmpty {
                        Text("Linked work").font(.headline).foregroundStyle(ElliePalette.foreground)
                        ForEach(detail.activity) { task in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(task.state.capitalized).font(.subheadline.weight(.semibold))
                                ForEach(Array(task.progress.enumerated()), id: \.offset) { entry in
                                    Text(entry.element).font(.subheadline)
                                }
                                if let finding = task.finding {
                                    DisclosureGroup("Verified finding") {
                                        Text(finding.summary)
                                        ForEach(Array(finding.citations.enumerated()), id: \.offset) { entry in
                                            Text("Source: \(entry.element)").font(.footnote)
                                        }
                                    }
                                    .accessibilityIdentifier("quiet-finding-\(task.id)")
                                } else if task.findingStale {
                                    Text("A source changed. This finding needs a fresh review.")
                                        .font(.footnote).foregroundStyle(ElliePalette.muted)
                                } else if task.state == "succeeded" {
                                    Text("Completed. No cited finding is available in this review.")
                                        .font(.footnote).foregroundStyle(ElliePalette.muted)
                                }
                            }
                            .foregroundStyle(ElliePalette.foreground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(16)
                            .background(ElliePalette.surface, in: RoundedRectangle(cornerRadius: 16))
                            .accessibilityIdentifier("quiet-activity-\(task.id)")
                        }
                    }
                    if detail.activityLimited {
                        Text("More linked work is available in Ellie Life on your Mac.")
                            .font(.footnote).foregroundStyle(ElliePalette.muted)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .navigationTitle(store.detail?.session.id == id ? store.detail?.session.title ?? "Session" : "Session")
        .ellieScreen()
        .toolbar { Button("Refresh") { store.open(id) }.disabled(store.busy) }
        .onAppear { store.open(id) }
    }
}
