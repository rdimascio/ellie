import Foundation
import XCTest
@testable import Ellie

private actor GmailFixtureClient: IOSGmailClient {
    var calls: [String] = []
    var holdNextDetail = false
    var revokeAccounts = false
    private var held: CheckedContinuation<IOSGmailDetail, Error>?
    let account = IOSGmailAccount(id: "gmail_1", label: "Fixture inbox", state: "connected")
    let message = IOSGmailMessage(id: "message_1", subject: "Fixture subject",
        from: "sender@example.test", snippet: "Fixture snippet", sentAt: Date(timeIntervalSince1970: 1_800_000_000))

    func accounts(_ credential: NativeEnrollmentCredential) async throws -> [IOSGmailAccount] {
        calls.append("accounts")
        if revokeAccounts { throw IOSGmailFailure.revoked }
        return [account]
    }
    func preview(_ credential: NativeEnrollmentCredential, accountID: String) async throws -> [IOSGmailMessage] {
        calls.append("preview:\(accountID)")
        return [message]
    }
    func detail(_ credential: NativeEnrollmentCredential, accountID: String,
                messageID: String) async throws -> IOSGmailDetail {
        calls.append("detail:\(accountID):\(messageID)")
        if holdNextDetail {
            holdNextDetail = false
            return try await withCheckedThrowingContinuation { held = $0 }
        }
        return result()
    }
    func result() -> IOSGmailDetail {
        IOSGmailDetail(message: message, to: ["owner@example.test"], status: "plain",
            text: "Transient fixture body", additionalPartsOmitted: false)
    }
    func setHold() { holdNextDetail = true }
    func setRevoke() { revokeAccounts = true }
    func awaitingDetail() -> Bool { held != nil }
    func release() {
        held?.resume(returning: result())
        held = nil
    }
    func requests() -> [String] { calls }
}

final class IOSGmailInboxTests: XCTestCase {
    private func json(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value)
    }
    private func credential(_ id: String = "phone-a") -> NativeEnrollmentCredential {
        NativeEnrollmentCredential(origin: URL(string: "https://127.0.0.1:8444")!,
            certificateSha256: String(repeating: "b", count: 64),
            client: NativeClient(id: id, role: "native_phone_controller", label: "Fixture",
                grants: [], createdAt: 1_800_000_000_000, expiresAt: 1_807_776_000_000),
            token: String(repeating: "c", count: 64))
    }
    @MainActor
    private func eventually(_ predicate: @escaping @MainActor () -> Bool) async {
        for _ in 0..<100 {
            if predicate() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("Gmail fixture did not settle")
    }

    func testPinnedGmailRoutesAndStrictResponseBounds() throws {
        XCTAssertEqual(NativeEnrollmentTransport.lifeGmailMaximumBytes(path: "/api/connections"), 48_000)
        XCTAssertEqual(NativeEnrollmentTransport.lifeGmailMaximumBytes(
            path: "/api/connections/gmail_1/preview"), 48_000)
        XCTAssertEqual(NativeEnrollmentTransport.lifeGmailMaximumBytes(
            path: "/api/connections/gmail_1/messages/message_1"), 240 * 1_024)
        for path in ["/api/connections/gmail_1/messages/message_1?format=raw",
                     "/api/connections/gmail_1/messages/message_1#fragment",
                     "/api/connections/gmail_1/messages/../preview",
                     "/api/connections/gmail_1/messages/%2F",
                     "https://example.test/api/connections",
                     "/api/connections/gmail_1/refresh"] {
            XCTAssertNil(NativeEnrollmentTransport.lifeGmailMaximumBytes(path: path))
        }
        let listing = try json(["connections": [
            ["id": "gmail_1", "provider": "gmail", "label": "Fixture inbox",
             "state": "connected", "mode": "observe"],
            ["id": "calendar_1", "provider": "google-calendar", "label": "Calendar",
             "state": "connected", "mode": "observe", "selectedCalendarId": "primary"]],
            "providers": []])
        XCTAssertEqual(try IOSGmailWire.accounts(listing).map(\.id), ["gmail_1"])
        let preview = try json(["state": "connected", "items": [["kind": "message",
            "messageId": "message_1", "subject": "Fixture subject", "from": "sender@example.test",
            "to": ["owner@example.test"], "snippet": "Fixture snippet", "sentAt": 1_800_000_000_000]]])
        XCTAssertEqual(try IOSGmailWire.preview(preview).map(\.id), ["message_1"])
        let detail = try json(["messageId": "message_1", "subject": "Fixture subject",
            "from": "sender@example.test", "to": ["owner@example.test"],
            "sentAt": 1_800_000_000_000, "status": "plain", "text": "First part",
            "additionalPartsOmitted": true])
        XCTAssertEqual(try IOSGmailWire.detail(detail, expectedID: "message_1").text, "First part")
        XCTAssertTrue(try IOSGmailWire.detail(detail, expectedID: "message_1").additionalPartsOmitted)
        XCTAssertThrowsError(try IOSGmailWire.detail(detail, expectedID: "different"))
        XCTAssertThrowsError(try IOSGmailWire.detail(json(["messageId": "message_1",
            "subject": "Fixture", "from": "sender@example.test", "to": [],
            "sentAt": 1_800_000_000_000, "status": "plain",
            "text": String(repeating: "x", count: 32 * 1_024 + 1)]), expectedID: "message_1"))
        XCTAssertThrowsError(try IOSGmailWire.detail(json(["messageId": "message_1",
            "subject": "Fixture", "from": "sender@example.test", "to": [],
            "sentAt": 1_800_000_000_000, "status": "unavailable",
            "text": "unsupported HTML"]), expectedID: "message_1"))
    }

    @MainActor
    func testExplicitReadsCancelLateResultAndClearOnRevocationOrBackground() async {
        let client = GmailFixtureClient()
        let store = IOSGmailInboxStore(client: client)
        store.bind(credential())
        let initialRequests = await client.requests()
        XCTAssertTrue(initialRequests.isEmpty, "binding must not fetch message bodies")
        store.refresh()
        await eventually { !store.busy && store.accounts.count == 1 }
        store.selectAccount("gmail_1")
        await eventually { !store.busy && store.messages.count == 1 }
        let previewRequests = await client.requests()
        XCTAssertEqual(previewRequests, ["accounts", "preview:gmail_1"])
        await client.setHold()
        store.selectMessage("message_1")
        for _ in 0..<100 {
            if await client.awaitingDetail() { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        let held = await client.awaitingDetail()
        XCTAssertTrue(held)
        store.cancelRead()
        await client.release()
        await eventually { !store.busy }
        XCTAssertNil(store.detail, "late response after Cancel must remain inert")
        store.selectMessage("message_1")
        await eventually { !store.busy && store.detail != nil }
        XCTAssertEqual(store.detail?.text, "Transient fixture body")
        store.enterBackground()
        XCTAssertNil(store.detail, "backgrounding discards the transient body")
        await client.setRevoke()
        store.refresh()
        await eventually { !store.busy && store.notice?.contains("access was removed") == true }
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertTrue(store.messages.isEmpty)
        XCTAssertNil(store.detail)
        store.bind(credential("phone-b"))
        XCTAssertTrue(store.accounts.isEmpty, "another enrollment cannot inherit private rows")
    }
}
