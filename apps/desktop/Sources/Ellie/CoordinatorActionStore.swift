import Combine
import Foundation

enum NativeActionTerminalState: Equatable, Sendable {
    case completed
    case rejected(NativeCommandRejection)
    case outcomeUnknown
    case stoppedWaitingOutcomeUnknown

    var title: String {
        switch self {
        case .completed: "App opened"
        case .rejected: "App request rejected"
        case .outcomeUnknown: "Result unknown"
        case .stoppedWaitingOutcomeUnknown: "Stopped waiting"
        }
    }

    var message: String {
        switch self {
        case .completed:
            "Ellie confirmed that the app opened."
        case .rejected(.invalidRequest):
            "The coordinator rejected this app request. Refresh the node list and try again."
        case .rejected(.unauthorized):
            "The coordinator rejected this identity. Its pairing may have been revoked."
        case .rejected(.forbidden):
            "This identity is not allowed to control that node."
        case .rejected(.nodeNotFound):
            "That node is no longer registered. Refresh the node list."
        case .rejected(.nodeUnavailable):
            "That node is offline or busy. Wait for it to become available, then try again."
        case .rejected(.staleNode):
            "That node is not currently online. Refresh its status before opening an app."
        case .rejected(.capabilityMissing):
            "That node does not currently allow app opening. Check its Ellie service and permissions."
        case .outcomeUnknown:
            "Ellie could not confirm the result. The app may have opened. Check the target Mac before trying again."
        case .stoppedWaitingOutcomeUnknown:
            "Ellie stopped waiting for the result. The app may have opened. Check the target Mac before trying again."
        }
    }
}

@MainActor
final class CoordinatorActionStore: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var terminalState: NativeActionTerminalState?
    @Published private(set) var nodeID: String?
    @Published private(set) var app: NativeApp?

    private let client: any CoordinatorActing
    private let now: @Sendable () -> Date
    private var task: Task<Void, Never>?
    private var revision = UUID()

    init(
        client: any CoordinatorActing = PinnedCoordinatorClient(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.client = client
        self.now = now
    }

    func start(connection: CoordinatorConnection, node: CoordinatorNode, app: NativeApp) {
        guard !running else { return }
        nodeID = node.id
        self.app = app
        terminalState = nil

        guard node.isOnline(at: now()) else {
            terminalState = .rejected(.staleNode)
            return
        }
        guard node.capabilities.contains("app.open") else {
            terminalState = .rejected(.capabilityMissing)
            return
        }

        running = true
        revision = UUID()
        let current = revision
        let targetID = node.id
        task = Task {
            do {
                _ = try await client.openApp(connection: connection, nodeID: targetID, app: app)
                guard current == revision, !Task.isCancelled else { return }
                running = false
                terminalState = .completed
                task = nil
            } catch let failure as NativeCommandFailure {
                guard current == revision, !Task.isCancelled else { return }
                running = false
                if case let .rejected(reason) = failure {
                    terminalState = .rejected(reason)
                } else {
                    terminalState = .outcomeUnknown
                }
                task = nil
            } catch {
                guard current == revision, !Task.isCancelled else { return }
                running = false
                terminalState = .outcomeUnknown
                task = nil
            }
        }
    }

    func cancel() {
        guard running else { return }
        revision = UUID()
        task?.cancel()
        task = nil
        running = false
        terminalState = .stoppedWaitingOutcomeUnknown
    }
}
