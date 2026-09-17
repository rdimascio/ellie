#if DEBUG
import Combine
import Foundation
import SwiftUI

@MainActor
private final class GmailFixtureProbe: ObservableObject {
    @Published var bodyReads = 0
    var holdNext = false
    var revoked = false
    private var pending: CheckedContinuation<Void, Never>?

    func readBody() async {
        bodyReads += 1
        if holdNext {
            await withCheckedContinuation { pending = $0 }
        }
    }
    func release() {
        holdNext = false
        pending?.resume()
        pending = nil
    }
}

private actor GmailFixtureClient: IOSGmailClient {
    let probe: GmailFixtureProbe
    init(probe: GmailFixtureProbe) { self.probe = probe }
    func accounts(_ credential: NativeEnrollmentCredential) async throws -> [IOSGmailAccount] {
        if await probe.revoked { throw IOSGmailFailure.revoked }
        return [IOSGmailAccount(id: "fixture_gmail", label: "Fixture Gmail account", state: "connected")]
    }
    func preview(_ credential: NativeEnrollmentCredential, accountID: String) async throws -> [IOSGmailMessage] {
        if await probe.revoked { throw IOSGmailFailure.revoked }
        return [IOSGmailMessage(id: "fixture_message", subject: "Fixture private subject",
            from: "sender@example.test", snippet: "Fixture header snippet",
            sentAt: Date(timeIntervalSince1970: 1_800_000_000))]
    }
    func detail(_ credential: NativeEnrollmentCredential, accountID: String,
                messageID: String) async throws -> IOSGmailDetail {
        await probe.readBody()
        if await probe.revoked { throw IOSGmailFailure.revoked }
        return IOSGmailDetail(message: IOSGmailMessage(id: messageID,
            subject: "Fixture private subject", from: "sender@example.test",
            snippet: "Fixture header snippet", sentAt: Date(timeIntervalSince1970: 1_800_000_000)),
            to: ["owner@example.test"], status: "plain", text: "Transient fixture message body",
            additionalPartsOmitted: false)
    }
}

@MainActor
struct IOSGmailUITestFixtureView: View {
    @StateObject private var probe: GmailFixtureProbe
    private let client: GmailFixtureClient
    private let credential = NativeEnrollmentCredential(
        origin: URL(string: "https://127.0.0.1:8444")!,
        certificateSha256: String(repeating: "b", count: 64),
        client: NativeClient(id: "fixture-phone", role: "native_phone_controller",
            label: "Fixture", grants: [], createdAt: 1_800_000_000_000,
            expiresAt: 1_807_776_000_000),
        token: String(repeating: "c", count: 64))

    init() {
        let probe = GmailFixtureProbe()
        _probe = StateObject(wrappedValue: probe)
        client = GmailFixtureClient(probe: probe)
    }
    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                IOSGmailInboxView(credential: credential, client: client)
                VStack(spacing: 4) {
                    Text("Fixture body reads: \(probe.bodyReads)")
                        .accessibilityIdentifier("ios-gmail-fixture-reads")
                    HStack {
                        Button("Hold next body") { probe.holdNext = true }
                        Button("Release held body") { probe.release() }
                        Button("Revoke fixture") { probe.revoked = true; probe.release() }
                    }
                }
                .font(.caption)
                .padding(8)
            }
        }
    }
}
#endif
