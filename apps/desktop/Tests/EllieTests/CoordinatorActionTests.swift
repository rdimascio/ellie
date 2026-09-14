import Foundation
import XCTest
@testable import Ellie

final class CoordinatorActionTests: XCTestCase {
    @MainActor
    func testStartsOnlyOneRequestAndKeepsStartTimeTarget() async throws {
        let client = ActionClient { _, _, _, _ in
            try await Task.sleep(for: .seconds(30))
            return .completed
        }
        let store = CoordinatorActionStore(client: client, now: { Date(timeIntervalSince1970: 100) })
        store.start(connection: connection, node: node(id: "first"), app: .arc)
        store.start(connection: connection, node: node(id: "second"), app: .safari)
        let began = await awaitRequestCount(client, 1)
        XCTAssertTrue(began)

        XCTAssertTrue(store.running)
        XCTAssertEqual(store.nodeID, "first")
        XCTAssertEqual(store.app, .arc)
        let requestCount = await client.requestCount()
        XCTAssertEqual(requestCount, 1)
        store.cancel()
    }

    @MainActor
    func testCancelStopsWaitingAndLateCompletionCannotOverwriteUnknownOutcome() async throws {
        let client = ActionClient { _, _, _, _ in
            do { try await Task.sleep(for: .seconds(30)) } catch {}
            return .completed
        }
        let store = CoordinatorActionStore(client: client, now: { Date(timeIntervalSince1970: 100) })
        store.start(connection: connection, node: node(), app: .messages)
        let began = await awaitRequestCount(client, 1)
        XCTAssertTrue(began)
        store.cancel()
        try? await Task.sleep(for: .milliseconds(20))

        XCTAssertFalse(store.running)
        XCTAssertEqual(store.terminalState, .stoppedWaitingOutcomeUnknown)
        XCTAssertTrue(store.terminalState?.message.contains("may have opened") == true)
    }

    @MainActor
    func testFailureAndFalseReplyRemainOutcomeUnknown() async throws {
        for failure in [NativeCommandFailure.outcomeUnknown, .cancelled] {
            let client = ActionClient { _, _, _, _ in throw failure }
            let store = CoordinatorActionStore(client: client, now: { Date(timeIntervalSince1970: 100) })
            store.start(connection: connection, node: node(), app: .safari)
            let stopped = await awaitStopped(store)
            XCTAssertTrue(stopped)
            XCTAssertEqual(store.terminalState, .outcomeUnknown)
        }
    }

    @MainActor
    func testRejectsStaleOrIncapableNodeWithoutSending() async throws {
        let client = ActionClient { _, _, _, _ in XCTFail("Request must not be sent"); return .completed }
        let now = Date(timeIntervalSince1970: 100)
        let store = CoordinatorActionStore(client: client, now: { now })

        store.start(connection: connection, node: CoordinatorNode(id: "stale", capabilities: ["app.open"], lastSeen: now.addingTimeInterval(-61)), app: .arc)
        XCTAssertEqual(store.terminalState, .rejected(.staleNode))
        store.start(connection: connection, node: CoordinatorNode(id: "limited", capabilities: [], lastSeen: now), app: .arc)
        XCTAssertEqual(store.terminalState, .rejected(.capabilityMissing))
        let requestCount = await client.requestCount()
        XCTAssertEqual(requestCount, 0)
    }

    @MainActor
    func testInitializationDoesNotReplayAnAction() async {
        let client = ActionClient { _, _, _, _ in XCTFail("Request must not be sent"); return .completed }
        let store = CoordinatorActionStore(client: client)
        await Task.yield()
        XCTAssertFalse(store.running)
        XCTAssertNil(store.terminalState)
        XCTAssertNil(store.nodeID)
        XCTAssertNil(store.app)
        let requestCount = await client.requestCount()
        XCTAssertEqual(requestCount, 0)
    }

    @MainActor
    func testLateCompletionFromCancelledActionCannotClobberNewAction() async throws {
        let gate = ActionGate()
        let client = ActionClient { _, _, _, sequence in
            await gate.wait(sequence)
            return .completed
        }
        let store = CoordinatorActionStore(client: client, now: { Date(timeIntervalSince1970: 100) })
        store.start(connection: connection, node: node(id: "first"), app: .arc)
        let firstBegan = await awaitRequestCount(client, 1)
        XCTAssertTrue(firstBegan)
        store.cancel()
        store.start(connection: connection, node: node(id: "second"), app: .safari)
        let secondBegan = await awaitRequestCount(client, 2)
        XCTAssertTrue(secondBegan)

        await gate.release(1)
        try? await Task.sleep(for: .milliseconds(20))
        XCTAssertTrue(store.running)
        XCTAssertEqual(store.nodeID, "second")
        XCTAssertEqual(store.app, .safari)
        XCTAssertNil(store.terminalState)

        await gate.release(2)
        let stopped = await awaitStopped(store)
        XCTAssertTrue(stopped)
        XCTAssertEqual(store.terminalState, .completed)
    }

    @MainActor
    private func awaitStopped(_ store: CoordinatorActionStore) async -> Bool {
        for _ in 0..<100 {
            if !store.running { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    @MainActor
    private func awaitRequestCount(_ client: ActionClient, _ expected: Int) async -> Bool {
        for _ in 0..<100 {
            if await client.requestCount() == expected { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }

    private func node(id: String = "mac") -> CoordinatorNode {
        CoordinatorNode(id: id, capabilities: ["app.open"], lastSeen: Date(timeIntervalSince1970: 100))
    }

    private var connection: CoordinatorConnection {
        CoordinatorConnection(origin: URL(string: "https://127.0.0.1:7437")!, certificateDER: Data(), token: "")
    }
}

private actor ActionClient: CoordinatorActing {
    typealias Handler = @Sendable (CoordinatorConnection, String, NativeApp, Int) async throws -> NativeCommandOutcome
    private let handler: Handler
    private var count = 0

    init(handler: @escaping Handler) { self.handler = handler }

    func openApp(connection: CoordinatorConnection, nodeID: String, app: NativeApp) async throws -> NativeCommandOutcome {
        count += 1
        return try await handler(connection, nodeID, app, count)
    }

    func requestCount() -> Int { count }
}

private actor ActionGate {
    private var waiting: [Int: CheckedContinuation<Void, Never>] = [:]
    private var released: Set<Int> = []

    func wait(_ sequence: Int) async {
        if released.remove(sequence) != nil { return }
        await withCheckedContinuation { waiting[sequence] = $0 }
    }

    func release(_ sequence: Int) {
        if let continuation = waiting.removeValue(forKey: sequence) { continuation.resume() }
        else { released.insert(sequence) }
    }
}
