import Combine
import Foundation

@MainActor
final class CoordinatorStore: ObservableObject {
    enum Phase: Equatable {
        case disconnected, connecting, connected, reconnecting, unavailable, blocked
    }

    @Published var role: CoordinatorRole = .coordinator
    @Published var selectedNodeID: String?
    @Published private(set) var phase: Phase = .disconnected
    @Published private(set) var nodes: [CoordinatorNode] = []
    @Published private(set) var failure: CoordinatorFailure?
    @Published private(set) var lastUpdated: Date?

    private let client: any CoordinatorReading
    private let load: @Sendable (CoordinatorRole) async throws -> CoordinatorConnection
    private let pause: @Sendable (TimeInterval) async throws -> Void
    private let now: @Sendable () -> Date
    private var connection: CoordinatorConnection?
    private var task: Task<Void, Never>?
    private var revision = UUID()

    init(
        client: any CoordinatorReading = PinnedCoordinatorClient(),
        load: @escaping @Sendable (CoordinatorRole) async throws -> CoordinatorConnection = {
            try await InstalledCoordinatorLoader().load(role: $0)
        },
        pause: @escaping @Sendable (TimeInterval) async throws -> Void = {
            try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000))
        },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.load = load
        self.pause = pause
        self.now = now
    }

    var selectedNode: CoordinatorNode? { nodes.first { $0.id == selectedNodeID } }
    var isMonitoring: Bool { [.connecting, .connected, .reconnecting].contains(phase) }

    func connect() {
        disconnect()
        phase = .connecting
        let current = revision
        let requestedRole = role
        task = Task {
            do {
                let credentials = try await load(requestedRole)
                guard current == revision, !Task.isCancelled else { return }
                connection = credentials
                await monitor(credentials, revision: current)
            } catch {
                guard current == revision, !Task.isCancelled else { return }
                stopAfterFailure(error)
            }
        }
    }

    func refresh() {
        guard let connection else { connect(); return }
        task?.cancel()
        revision = UUID()
        let current = revision
        phase = .connecting
        task = Task { await monitor(connection, revision: current) }
    }

    func disconnect() {
        revision = UUID()
        task?.cancel()
        task = nil
        connection = nil
        nodes = []
        selectedNodeID = nil
        lastUpdated = nil
        failure = nil
        phase = .disconnected
    }

    private func monitor(_ credentials: CoordinatorConnection, revision current: UUID) async {
        var failures = 0
        while current == revision, !Task.isCancelled {
            do {
                let snapshot = try await client.nodes(connection: credentials)
                guard current == revision, !Task.isCancelled else { return }
                nodes = snapshot
                if !snapshot.contains(where: { $0.id == selectedNodeID }) { selectedNodeID = nil }
                lastUpdated = now()
                failure = nil
                phase = .connected
                failures = 0
                try await pause(10)
            } catch {
                guard current == revision, !Task.isCancelled else { return }
                let reason = error as? CoordinatorFailure ?? .unavailable
                // Only read-only availability failures retry. Invalid trust, revoked
                // credentials and malformed data require an explicit reconnect.
                guard reason == .unavailable, failures < 3 else {
                    stopAfterFailure(reason)
                    return
                }
                failure = .unavailable
                phase = .reconnecting
                failures += 1
                do { try await pause(pow(2, Double(failures))) }
                catch { return }
            }
        }
    }

    private func stopAfterFailure(_ error: Error) {
        let reason = error as? CoordinatorFailure ?? .unavailable
        failure = reason
        phase = reason == .unavailable ? .unavailable : .blocked
        connection = nil
        // Cached inventory is not evidence of current access after revocation or
        // failed trust. Availability failures may retain it with an unknown status.
        if reason != .unavailable {
            nodes = []
            selectedNodeID = nil
            lastUpdated = nil
        }
        task = nil
    }
}
