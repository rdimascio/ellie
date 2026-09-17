import Combine
import Foundation
import WatchConnectivity

@MainActor
final class WatchMediaWatchStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published private(set) var status = "Open Ellie on iPhone and enable Watch control."
  @Published private(set) var observation: WatchMediaObservation?
  @Published private(set) var waiting = false
  @Published private(set) var reachable = false
  #if DEBUG
  @Published private(set) var pairedDiagnostic = "supported=unknown activation=unknown reachable=false foreground=false"
  #endif

  private var pendingID: String?
  private var pendingOperation: WatchMediaOperation?
  private var timeout: Task<Void, Never>?
  private var activated = false
  private var foreground = false

  var canPlay: Bool { !waiting && reachable && observation?.playback == "paused" }
  var canPause: Bool { !waiting && reachable && observation?.playback == "playing" }

  func activate() {
    foreground = true
    guard WCSession.isSupported() else {
      updatePairedDiagnostic(nil)
      return
    }
    let session = WCSession.default
    if !activated {
      activated = true
      session.delegate = self
      session.activate()
    }
    updateReachability(session)
  }

  func suspend() {
    foreground = false
    reachable = false
    updatePairedDiagnostic(WCSession.isSupported() ? WCSession.default : nil)
    if let pendingOperation { finishUncertain(pendingOperation) }
    else {
      observation = nil
      status = "Read the current page after returning to Ellie."
    }
  }

  func read() { send(.read) }
  func play() { if canPlay { send(.play) } }
  func pause() { if canPause { send(.pause) } }

  private func send(_ operation: WatchMediaOperation) {
    guard !waiting, WCSession.isSupported() else { return }
    let session = WCSession.default
    guard session.activationState == .activated, session.isReachable else {
      observation = nil
      status = "The iPhone is unreachable. Open Ellie on iPhone, then read again."
      return
    }
    let request: WatchMediaRequest
    if operation == .read {
      request = .make(.read)
    } else {
      guard let observed = observation else { return }
      request = .make(operation, target: observed.target, epoch: observed.epoch,
                      revision: observed.revision)
    }
    // A previous observation is never authority for a second action after this request.
    observation = nil
    pendingID = request.id
    pendingOperation = operation
    waiting = true
    status = operation == .read ? "Reading the selected Mac…" : "Command sent; outcome unverified."
    timeout?.cancel()
    timeout = Task {
      try? await Task.sleep(for: .milliseconds(WatchMediaRequest.lifetimeMilliseconds))
      guard !Task.isCancelled, pendingID == request.id else { return }
      finishUncertain(operation)
    }
    session.sendMessage(request.message) { response in
      Task { @MainActor in self.receive(response, request: request) }
    } errorHandler: { _ in
      Task { @MainActor in
        guard self.pendingID == request.id else { return }
        self.finishUncertain(operation)
      }
    }
  }

  private func receive(_ value: [String: Any], request: WatchMediaRequest) {
    guard pendingID == request.id else { return }
    guard foreground, WatchMediaWire.now() < request.expiresAt else {
      finishUncertain(request.operation)
      return
    }
    timeout?.cancel()
    timeout = nil
    pendingID = nil
    pendingOperation = nil
    waiting = false
    guard let reply = WatchMediaReply.decode(value, expectedID: request.id) else {
      status = request.operation == .read
        ? "The iPhone returned an invalid observation. Read again."
        : "The command outcome is unknown. Read the page before another action."
      return
    }
    switch reply.state {
    case .observed:
      guard request.operation == .read, let observed = reply.observation else {
        status = "The command outcome is unknown. Read the page before another action."
        return
      }
      observation = observed
      status = "Fresh page observation"
    case .unknown:
      status = "The command may have run. Read the page before another action."
    case .blocked:
      status = "Watch control is disabled or no longer authorized on iPhone."
    case .stale:
      status = "The selected page or phone session changed. Read again."
    case .unavailable:
      status = "No reviewed player is available. Check Ellie on iPhone."
    }
  }

  private func finishUncertain(_ operation: WatchMediaOperation) {
    timeout?.cancel()
    timeout = nil
    pendingID = nil
    pendingOperation = nil
    waiting = false
    observation = nil
    status = operation == .read
      ? "The iPhone did not return a fresh page. Read again when reachable."
      : "The command outcome is unknown. Read the page before another action."
  }

  private func updateReachability(_ session: WCSession) {
    reachable = foreground && session.activationState == .activated && session.isReachable
    updatePairedDiagnostic(session)
    if !reachable {
      let operation = pendingOperation
      observation = nil
      if let operation { finishUncertain(operation) }
      else { status = "The iPhone is unreachable. Open Ellie on iPhone, then read again." }
    }
  }

  private func updatePairedDiagnostic(_ session: WCSession?) {
    #if DEBUG
    let activation: String
    switch session?.activationState {
    case .activated: activation = "activated"
    case .inactive: activation = "inactive"
    case .notActivated: activation = "not_activated"
    case nil: activation = "unsupported"
    @unknown default: activation = "unknown"
    }
    pairedDiagnostic = "supported=\(session != nil) activation=\(activation) reachable=\(session?.isReachable ?? false) foreground=\(foreground)"
    #endif
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    Task { @MainActor in self.updateReachability(session) }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    Task { @MainActor in self.updateReachability(session) }
  }
}
