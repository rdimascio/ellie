import Foundation
import XCTest
@testable import Ellie

private actor InventoryFixture: CoordinatorReading {
    enum Outcome { case nodes([CoordinatorNode]), failure(CoordinatorFailure) }
    var outcomes: [Outcome]
    var calls = 0
    init(_ outcomes: [Outcome]) { self.outcomes = outcomes }
    func nodes(connection: CoordinatorConnection) async throws -> [CoordinatorNode] {
        calls += 1
        guard !outcomes.isEmpty else { throw CoordinatorFailure.unavailable }
        switch outcomes.removeFirst() {
        case .nodes(let nodes): return nodes
        case .failure(let failure): throw failure
        }
    }
}

private actor DelayRecorder {
    var values: [TimeInterval] = []
    func record(_ value: TimeInterval) { values.append(value) }
}

private actor CredentialGate {
    var continuation: CheckedContinuation<CoordinatorConnection, Error>?
    var started = false
    func load() async throws -> CoordinatorConnection {
        started = true
        return try await withCheckedThrowingContinuation { continuation = $0 }
    }
    func finish(_ connection: CoordinatorConnection) {
        continuation?.resume(returning: connection)
        continuation = nil
    }
}

final class CoordinatorStoreTests: XCTestCase {
    private let connection = CoordinatorConnection(origin: URL(string: "https://127.0.0.1:7437")!, certificateDER: Data(), token: "synthetic")
    private let node = CoordinatorNode(id: "synthetic-node", capabilities: ["app.open"], lastSeen: Date(timeIntervalSince1970: 1000))

    @MainActor
    func testUnavailableReadsRetryOnlyThreeTimesThenStop() async throws {
        let client = InventoryFixture(Array(repeating: .failure(.unavailable), count: 6))
        let delays = DelayRecorder()
        let credentials = connection
        let store = CoordinatorStore(client: client, load: { _ in credentials }, pause: { await delays.record($0) })
        store.connect()
        try await waitUntil { store.phase == .unavailable }
        let calls = await client.calls
        let recorded = await delays.values
        XCTAssertEqual(calls, 4)
        XCTAssertEqual(recorded, [2, 4, 8])
        XCTAssertEqual(store.failure, .unavailable)
        XCTAssertFalse(store.isMonitoring)
    }

    @MainActor
    func testRevocationClearsCachedInventoryAndDoesNotRetry() async throws {
        let client = InventoryFixture([.nodes([node]), .failure(.unauthorized)])
        let credentials = connection
        let store = CoordinatorStore(client: client, load: { _ in credentials }, pause: { _ in })
        store.connect()
        try await waitUntil { store.phase == .blocked }
        let calls = await client.calls
        XCTAssertEqual(calls, 2)
        XCTAssertEqual(store.failure, .unauthorized)
        XCTAssertTrue(store.nodes.isEmpty)
        XCTAssertNil(store.selectedNodeID)
        XCTAssertNil(store.lastUpdated)
    }

    @MainActor
    func testTrustFailureNeverRetries() async throws {
        let client = InventoryFixture([.failure(.trustFailed)])
        let credentials = connection
        let store = CoordinatorStore(client: client, load: { _ in credentials })
        store.connect()
        try await waitUntil { store.phase == .blocked }
        let calls = await client.calls
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(store.failure, .trustFailed)
    }

    @MainActor
    func testTargetSelectionIsExplicitAndRemovedTargetsLoseSelection() async throws {
        let client = InventoryFixture([.nodes([node]), .nodes([])])
        let credentials = connection
        let store = CoordinatorStore(client: client, load: { _ in credentials }, pause: { _ in
            try await Task.sleep(nanoseconds: 60_000_000_000)
        })
        store.connect()
        try await waitUntil { store.phase == .connected }
        XCTAssertNil(store.selectedNodeID)
        store.selectedNodeID = node.id
        XCTAssertEqual(store.selectedNode?.id, node.id)
        store.refresh()
        try await waitUntil { store.phase == .connected && store.nodes.isEmpty }
        XCTAssertNil(store.selectedNodeID)
        store.disconnect()
    }

    @MainActor
    func testDisconnectRejectsLateCredentialCompletion() async throws {
        let gate = CredentialGate()
        let client = InventoryFixture([.nodes([node])])
        let store = CoordinatorStore(client: client, load: { _ in try await gate.load() })
        store.connect()
        while !(await gate.started) { await Task.yield() }
        store.disconnect()
        await gate.finish(connection)
        for _ in 0..<30 { await Task.yield() }
        let calls = await client.calls
        XCTAssertEqual(calls, 0)
        XCTAssertEqual(store.phase, .disconnected)
        XCTAssertTrue(store.nodes.isEmpty)
    }

    @MainActor
    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition(), ContinuousClock.now < deadline { await Task.yield() }
        XCTAssertTrue(condition(), "Timed out waiting for the expected inventory state")
    }
}
