import Combine
import Foundation
import SwiftUI

enum IOSGmailFailure: Error, Equatable {
    case revoked, unavailable, invalidResponse
}

struct IOSGmailAccount: Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    let state: String
}

struct IOSGmailMessage: Equatable, Identifiable, Sendable {
    let id: String
    let subject: String
    let from: String
    let snippet: String?
    let sentAt: Date
}

struct IOSGmailDetail: Equatable, Sendable {
    let message: IOSGmailMessage
    let to: [String]
    let status: String
    let text: String?
    let additionalPartsOmitted: Bool
}

enum IOSGmailWire {
    private static func object(_ value: Any) throws -> [String: Any] {
        guard let value = value as? [String: Any] else { throw IOSGmailFailure.invalidResponse }
        return value
    }
    private static func root(_ data: Data, maximum: Int) throws -> [String: Any] {
        guard data.count <= maximum else { throw IOSGmailFailure.invalidResponse }
        return try object(JSONSerialization.jsonObject(with: data))
    }
    private static func text(_ value: Any?, maximum: Int, allowEmpty: Bool = false) throws -> String {
        guard let value = value as? String, (allowEmpty || !value.isEmpty),
              value.utf8.count <= maximum * 4, value.utf16.count <= maximum
        else { throw IOSGmailFailure.invalidResponse }
        // Provider metadata is display text. Keep script and emoji joiners, but do not render
        // terminal, bidi, or other non-printing controls from an external mailbox.
        return value.unicodeScalars.map { scalar in
            CharacterSet.controlCharacters.contains(scalar) &&
                scalar.value != 0x200C && scalar.value != 0x200D ? " " : String(scalar)
        }.joined()
    }
    private static func identifier(_ value: Any?, maximum: Int) throws -> String {
        let id = try text(value, maximum: maximum)
        guard id.range(of: "^[A-Za-z0-9_-]{1,\(maximum)}$", options: .regularExpression) != nil
        else { throw IOSGmailFailure.invalidResponse }
        return id
    }
    private static func date(_ value: Any?) throws -> Date {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0,
              number.doubleValue <= 4_102_444_800_000,
              number.doubleValue == Double(number.int64Value)
        else { throw IOSGmailFailure.invalidResponse }
        return Date(timeIntervalSince1970: number.doubleValue / 1_000)
    }
    static func accounts(_ data: Data) throws -> [IOSGmailAccount] {
        let value = try root(data, maximum: 48_000)
        guard Set(value.keys) == ["connections", "providers"],
              let rows = value["connections"] as? [Any], rows.count <= 100
        else { throw IOSGmailFailure.invalidResponse }
        let accounts: [IOSGmailAccount] = try rows.compactMap { raw in
            let row = try object(raw)
            guard let provider = row["provider"] as? String else { throw IOSGmailFailure.invalidResponse }
            if provider != "gmail" { return nil }
            guard Set(row.keys).isSubset(of: ["id", "provider", "label", "state", "mode", "lastSyncAt", "error"]),
                  let state = row["state"] as? String,
                  ["connecting", "connected", "paused", "error", "revoked"].contains(state)
            else { throw IOSGmailFailure.invalidResponse }
            return IOSGmailAccount(id: try identifier(row["id"], maximum: 128),
                label: String(try text(row["label"], maximum: 2_000).prefix(80)), state: state)
        }
        guard Set(accounts.map(\.id)).count == accounts.count else { throw IOSGmailFailure.invalidResponse }
        return accounts
    }
    static func preview(_ data: Data) throws -> [IOSGmailMessage] {
        let value = try root(data, maximum: 48_000)
        guard Set(value.keys).isSubset(of: ["items", "lastSyncAt", "error", "state"]),
              value["state"] as? String == "connected",
              let rows = value["items"] as? [Any], rows.count <= 10
        else { throw IOSGmailFailure.invalidResponse }
        let messages: [IOSGmailMessage] = try rows.map { raw in
            let row = try object(raw)
            guard Set(row.keys).isSubset(of: ["kind", "messageId", "subject", "from", "to", "snippet", "sentAt"]),
                  row["kind"] as? String == "message"
            else { throw IOSGmailFailure.invalidResponse }
            let snippet = try row["snippet"].map { try text($0, maximum: 500, allowEmpty: true) }
            return IOSGmailMessage(id: try identifier(row["messageId"], maximum: 1_024),
                subject: try text(row["subject"], maximum: 200, allowEmpty: true),
                from: try text(row["from"], maximum: 320, allowEmpty: true),
                snippet: snippet, sentAt: try date(row["sentAt"]))
        }
        guard Set(messages.map(\.id)).count == messages.count else { throw IOSGmailFailure.invalidResponse }
        return messages
    }
    static func detail(_ data: Data, expectedID: String) throws -> IOSGmailDetail {
        let value = try root(data, maximum: 240 * 1_024)
        guard Set(value.keys).isSubset(of: ["messageId", "subject", "from", "to", "sentAt", "snippet", "status", "text", "additionalPartsOmitted"]),
              try identifier(value["messageId"], maximum: 1_024) == expectedID,
              let recipients = value["to"] as? [Any], recipients.count <= 50,
              let status = value["status"] as? String,
              ["plain", "truncated", "unavailable"].contains(status)
        else { throw IOSGmailFailure.invalidResponse }
        let omitted: Bool
        if let raw = value["additionalPartsOmitted"] {
            guard let number = raw as? NSNumber,
                  CFGetTypeID(number) == CFBooleanGetTypeID(), number.boolValue,
                  status != "unavailable"
            else { throw IOSGmailFailure.invalidResponse }
            omitted = true
        } else { omitted = false }
        let body: String?
        if status == "unavailable" {
            guard value["text"] == nil else { throw IOSGmailFailure.invalidResponse }
            body = nil
        } else {
            guard let candidate = value["text"] as? String,
                  candidate.utf8.count <= 32 * 1_024
            else { throw IOSGmailFailure.invalidResponse }
            body = candidate
        }
        let message = IOSGmailMessage(id: expectedID,
            subject: try text(value["subject"], maximum: 200, allowEmpty: true),
            from: try text(value["from"], maximum: 320, allowEmpty: true),
            snippet: try value["snippet"].map { try text($0, maximum: 500, allowEmpty: true) },
            sentAt: try date(value["sentAt"]))
        return IOSGmailDetail(message: message,
            to: try recipients.map { try text($0, maximum: 320, allowEmpty: true) },
            status: status, text: body, additionalPartsOmitted: omitted)
    }
}

protocol IOSGmailClient: Sendable {
    func accounts(_ credential: NativeEnrollmentCredential) async throws -> [IOSGmailAccount]
    func preview(_ credential: NativeEnrollmentCredential, accountID: String) async throws -> [IOSGmailMessage]
    func detail(_ credential: NativeEnrollmentCredential, accountID: String,
                messageID: String) async throws -> IOSGmailDetail
}

struct IOSPinnedGmailClient: IOSGmailClient {
    private let transport = NativeEnrollmentTransport()
    private let authorizer = NativeLifeWebSessionAuthorizer()
    func accounts(_ credential: NativeEnrollmentCredential) async throws -> [IOSGmailAccount] {
        let (data, response) = try await get(credential, path: "/api/connections")
        try check(response.statusCode)
        return try IOSGmailWire.accounts(data)
    }
    func preview(_ credential: NativeEnrollmentCredential, accountID: String) async throws -> [IOSGmailMessage] {
        guard valid(accountID, maximum: 128) else { throw IOSGmailFailure.invalidResponse }
        let (data, response) = try await get(credential, path: "/api/connections/\(accountID)/preview")
        try check(response.statusCode)
        return try IOSGmailWire.preview(data)
    }
    func detail(_ credential: NativeEnrollmentCredential, accountID: String,
                messageID: String) async throws -> IOSGmailDetail {
        guard valid(accountID, maximum: 128), valid(messageID, maximum: 1_024)
        else { throw IOSGmailFailure.invalidResponse }
        let (data, response) = try await get(credential,
            path: "/api/connections/\(accountID)/messages/\(messageID)")
        try check(response.statusCode)
        return try IOSGmailWire.detail(data, expectedID: messageID)
    }
    private func valid(_ id: String, maximum: Int) -> Bool {
        id.range(of: "^[A-Za-z0-9_-]{1,\(maximum)}$", options: .regularExpression) != nil
    }
    private func get(_ credential: NativeEnrollmentCredential, path: String) async throws
        -> (Data, HTTPURLResponse) {
        let authority = LifeWebCredential(enrollment: credential)
        let session = try await authorizer.authorize(authority)
        try Task.checkCancellation()
        guard session.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000)
        else { throw IOSGmailFailure.unavailable }
        return try await transport.lifeGmailGET(path: path, credential: authority,
            sessionToken: session.token)
    }
    private func check(_ status: Int) throws {
        switch status {
        case 200: return
        case 401, 403, 404: throw IOSGmailFailure.revoked
        default: throw IOSGmailFailure.unavailable
        }
    }
}

@MainActor
final class IOSGmailInboxStore: ObservableObject {
    @Published private(set) var accounts: [IOSGmailAccount] = []
    @Published private(set) var selectedAccountID: String?
    @Published private(set) var messages: [IOSGmailMessage] = []
    @Published private(set) var selectedMessageID: String?
    @Published private(set) var detail: IOSGmailDetail?
    @Published private(set) var busy = false
    @Published private(set) var notice: String?
    private let client: IOSGmailClient
    private var credential: NativeEnrollmentCredential?
    private var operation: Task<Void, Never>?
    private var generation = 0

    init(client: IOSGmailClient = IOSPinnedGmailClient()) { self.client = client }

    func bind(_ incoming: NativeEnrollmentCredential?) {
        guard incoming != credential else { return }
        invalidate()
        credential = incoming
        accounts = []; selectedAccountID = nil; messages = []
        notice = nil
    }
    func refresh() {
        guard let credential else { return }
        invalidate()
        accounts = []; selectedAccountID = nil; messages = []
        busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let result = try await client.accounts(credential)
                try Task.checkCancellation()
                guard let self, self.generation == ticket else { return }
                self.accounts = result.filter { $0.state == "connected" }
                self.notice = self.accounts.isEmpty
                    ? "Connect and import Gmail in Ellie Life on your Mac, then refresh here."
                    : "Choose a connected Gmail account to read its imported preview."
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func selectAccount(_ id: String) {
        guard let credential, accounts.contains(where: { $0.id == id && $0.state == "connected" })
        else { return }
        invalidate()
        selectedAccountID = id; messages = []
        busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let result = try await client.preview(credential, accountID: id)
                try Task.checkCancellation()
                guard let self, self.generation == ticket, self.selectedAccountID == id else { return }
                self.messages = result
                self.notice = result.isEmpty
                    ? "No imported messages in this preview. Refresh Gmail on your Mac, then refresh here."
                    : "Select a message to read its plain-text body."
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func selectMessage(_ id: String) {
        guard let credential, let accountID = selectedAccountID,
              messages.contains(where: { $0.id == id }) else { return }
        invalidate()
        selectedMessageID = id
        busy = true; notice = nil
        let ticket = generation
        operation = Task { [weak self, client] in
            do {
                let result = try await client.detail(credential, accountID: accountID, messageID: id)
                try Task.checkCancellation()
                guard let self, self.generation == ticket,
                      self.selectedAccountID == accountID, self.selectedMessageID == id,
                      self.messages.contains(where: { $0.id == id }) else { return }
                self.detail = result
            } catch is CancellationError { }
            catch { self?.fail(error, ticket: ticket) }
            self?.finish(ticket: ticket)
        }
    }
    func cancelRead() {
        guard busy else { return }
        invalidate()
        notice = "Read cancelled. Select Refresh or a message to try again."
    }
    func enterBackground() { invalidate(); detail = nil; selectedMessageID = nil }
    func leaveView() {
        invalidate(); detail = nil; selectedMessageID = nil
        messages = []; accounts = []; selectedAccountID = nil
    }
    private func invalidate() {
        generation += 1
        operation?.cancel(); operation = nil
        busy = false; detail = nil; selectedMessageID = nil
    }
    private func finish(ticket: Int) {
        guard generation == ticket else { return }
        busy = false; operation = nil
    }
    private func fail(_ error: Error, ticket: Int) {
        guard generation == ticket else { return }
        if error as? IOSGmailFailure == .revoked || error as? LifeWebSessionFailure == .revoked ||
            error as? LifeWebSessionFailure == .grantRequired {
            accounts = []; selectedAccountID = nil; messages = []
            detail = nil; selectedMessageID = nil
            notice = "Gmail access was removed. Reconnect or restore the Life account grant on your Mac."
        } else {
            detail = nil
            notice = "Gmail read unavailable. Check your Mac and refresh before selecting again."
        }
    }
}

@MainActor
struct IOSGmailInboxView: View {
    let credential: NativeEnrollmentCredential
    @StateObject private var store: IOSGmailInboxStore
    @Environment(\.scenePhase) private var scenePhase

    init(credential: NativeEnrollmentCredential, client: IOSGmailClient = IOSPinnedGmailClient()) {
        self.credential = credential
        _store = StateObject(wrappedValue: IOSGmailInboxStore(client: client))
    }
    var body: some View {
        Form {
            Section {
                Button("Refresh Gmail accounts") { store.refresh() }
                    .disabled(store.busy)
                    .accessibilityIdentifier("ios-gmail-refresh")
                if store.busy {
                    ProgressView("Reading Gmail")
                    Button("Cancel read") { store.cancelRead() }
                        .accessibilityIdentifier("ios-gmail-cancel")
                }
                if let notice = store.notice {
                    Text(notice).accessibilityIdentifier("ios-gmail-notice")
                }
                NavigationLink("View Gmail status in Ellie Life") {
                    LifeWebView(credential: LifeWebCredential(enrollment: credential))
                }
                .accessibilityIdentifier("ios-gmail-life-status")
            } footer: {
                Text("Requires an explicit Ellie Life account grant. This iPhone can inspect connection status, but Google consent and provider refresh must be completed on your coordinator Mac. Account and message previews come from its imports. Selecting a message makes one fresh read-only Gmail body request.")
                    .accessibilityIdentifier("ios-gmail-setup-guidance")
            }
            if !store.accounts.isEmpty {
                Section("Gmail account") {
                    ForEach(store.accounts) { account in
                        Button(account.label) { store.selectAccount(account.id) }
                            .accessibilityIdentifier("ios-gmail-account-\(account.id)")
                    }
                }
            }
            if store.selectedAccountID != nil {
                Section("Imported message previews") {
                    ForEach(store.messages) { message in
                        Button { store.selectMessage(message.id) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(message.subject).font(.headline)
                                Text(message.from).font(.caption)
                                if let snippet = message.snippet {
                                    Text("Preview: \(snippet)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                        .accessibilityIdentifier("ios-gmail-message-\(message.id)")
                    }
                }
            }
            if let detail = store.detail {
                Section("Selected message") {
                    Text(detail.message.subject).font(.headline)
                    Text("From: \(detail.message.from)")
                    Text("To: \(detail.to.joined(separator: ", "))")
                    if let snippet = detail.message.snippet { Text("Preview: \(snippet)") }
                    if detail.status == "unavailable" {
                        Text("No inline plain-text body is available. HTML and attachments are not opened.")
                    } else {
                        Text(detail.status == "truncated" ? "Plain text, truncated at 32 KiB" : "Plain text")
                        if detail.additionalPartsOmitted { Text("First inline plain-text part only.") }
                        Text(detail.text ?? "").textSelection(.enabled)
                            .accessibilityIdentifier("ios-gmail-body")
                    }
                }
            }
        }
        .navigationTitle("Read Gmail")
        .onAppear { store.bind(credential) }
        .onChange(of: credential) { _, updated in store.bind(updated) }
        .onDisappear { store.leaveView() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { store.enterBackground() }
        }
    }
}
