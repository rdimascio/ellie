import Combine
import Foundation

enum PhoneControlApp: String, CaseIterable, Identifiable, Sendable {
  case arc, safari, messages
  var id: String { rawValue }
  var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

struct PhoneControlNode: Equatable, Identifiable, Sendable {
  let id: String
  let label: String
  let online: Bool
  let capabilities: [String]
  var canOpenApps: Bool { online && capabilities.contains("app.open") }
}

struct PhoneControlNodeAvailability: Equatable, Sendable {
  let title: String
  let systemImage: String
  let guidance: String?
}

func phoneControlNodeAvailability(_ node: PhoneControlNode) -> PhoneControlNodeAvailability {
  if node.online {
    return PhoneControlNodeAvailability(
      title: "\(node.label) is online", systemImage: "checkmark.circle.fill", guidance: nil)
  }
  return PhoneControlNodeAvailability(
    title: "\(node.label) is offline",
    systemImage: "wifi.slash",
    guidance: "Ellie keeps this Mac listed while the coordinator still grants access. "
      + "Reconnect it, then tap Refresh Macs. To remove this iPhone’s access, the coordinator "
      + "owner must use Manage iPhone Pairing and then pair again with the intended Macs. "
      + "Nothing is removed automatically.")
}

enum PhoneCommandOutcome: Equatable, Sendable {
  case completed, failed, unknown
}

enum PhoneControlFailure: Error, Equatable, LocalizedError {
  case revoked, rejected, unavailable, invalidResponse, cancelled
  case browserReadSettling, browserObservationUnavailable
  var errorDescription: String? {
    switch self {
    case .revoked: "This iPhone’s coordinator session is no longer authorized."
    case .rejected: "The coordinator did not accept this request. Refresh devices and try again."
    case .unavailable:
      "The saved coordinator connection is unavailable. Check its phone listener and network; keep this pairing while you investigate."
    case .invalidResponse: "The coordinator returned an invalid response."
    case .cancelled: "The request stopped."
    case .browserReadSettling:
      "The previous browser command is still settling. Wait, then tap Read current page again."
    case .browserObservationUnavailable:
      "The page could not be observed yet. Wait, then tap Read current page again."
    }
  }
}

protocol PhoneControlTransporting: Sendable {
  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode]
  func open(
    _ app: PhoneControlApp, on nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> PhoneCommandOutcome
}

@MainActor
final class PhoneControlStore: ObservableObject {
  enum Phase: Equatable {
    case idle, loading, ready, sending, cancelling
    case outcome(PhoneCommandOutcome, nodeID: String, app: PhoneControlApp)
    case failed(String)
    case revoked
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var nodes: [PhoneControlNode] = []
  @Published private(set) var credentialChanged = false
  @Published var selectedNodeID: String?
  @Published var selectedApp: PhoneControlApp = .safari

  private let credential: NativeEnrollmentCredential
  private let transport: PhoneControlTransporting
  private var task: Task<Void, Never>?
  private var activeCommand: (nodeID: String, app: PhoneControlApp)?
  private var generation = 0

  init(
    credential: NativeEnrollmentCredential,
    transport: PhoneControlTransporting = PhoneControlTransport()
  ) {
    self.credential = credential
    self.transport = transport
  }

  var selectedNode: PhoneControlNode? {
    nodes.first { $0.id == selectedNodeID }
  }

  var canSend: Bool {
    !credentialChanged && task == nil && selectedNode?.canOpenApps == true
  }

  func refresh() {
    guard !credentialChanged, task == nil else { return }
    phase = .loading
    launchInventory()
  }

  func send() {
    guard !credentialChanged, task == nil, let node = selectedNode, node.canOpenApps else {
      return
    }
    let nodeID = node.id
    let app = selectedApp
    activeCommand = (nodeID, app)
    phase = .sending
    launch(commandMayHaveRun: true) {
      let outcome = try await self.transport.open(
        app, on: nodeID, credential: self.credential)
      return .outcome(outcome, nodeID: nodeID, app: app)
    }
  }

  func cancel() {
    guard task != nil else { return }
    generation += 1
    task?.cancel()
    phase = .cancelling
  }

  func credentialDidChange() {
    guard !credentialChanged else { return }
    credentialChanged = true
    cancel()
    nodes = []
    selectedNodeID = nil
  }

  private func launchInventory() {
    generation += 1
    let expected = generation
    task = Task {
      defer {
        task = nil
        if expected != generation, phase == .cancelling { phase = .idle }
      }
      do {
        try Task.checkCancellation()
        let received = try await transport.nodes(for: credential)
        guard expected == generation else { return }
        nodes = received
        if !received.contains(where: { $0.id == selectedNodeID }) { selectedNodeID = nil }
        phase = .ready
      } catch {
        guard expected == generation else { return }
        if let failure = error as? PhoneControlFailure, failure == .revoked {
          nodes = []
          selectedNodeID = nil
          phase = .revoked
        } else if error is CancellationError || error as? PhoneControlFailure == .cancelled {
          phase = .idle
        } else {
          phase = .failed(
            (error as? PhoneControlFailure)?.localizedDescription
              ?? PhoneControlFailure.unavailable.localizedDescription)
        }
      }
    }
  }

  private func launch(
    commandMayHaveRun: Bool, operation: @escaping @MainActor () async throws -> Phase
  ) {
    generation += 1
    let expected = generation
    task = Task {
      defer {
        task = nil
        if expected != generation, phase == .cancelling {
          phase =
            activeCommand.map {
              .outcome(.unknown, nodeID: $0.nodeID, app: $0.app)
            } ?? .idle
        }
        activeCommand = nil
      }
      do {
        try Task.checkCancellation()
        let result = try await operation()
        if expected == generation { phase = result }
      } catch {
        guard expected == generation else { return }
        if let failure = error as? PhoneControlFailure, failure == .revoked {
          nodes = []
          selectedNodeID = nil
          phase = .revoked
        } else if error is CancellationError || error as? PhoneControlFailure == .cancelled {
          if commandMayHaveRun, let command = activeCommand {
            phase = .outcome(.unknown, nodeID: command.nodeID, app: command.app)
          } else {
            phase = .idle
          }
        } else {
          phase = .failed(
            (error as? PhoneControlFailure)?.localizedDescription
              ?? PhoneControlFailure.unavailable.localizedDescription)
        }
      }
    }
  }
}
