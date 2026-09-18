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
  @Published private(set) var deliveryDiagnostic = "idle"
  private var deliveryStartedAt: UInt64?
  private var deliveryEvents: [String] = []
  private var firstDeliveryTerminal: String?

  private func noteDelivery(_ event: String, terminal: Bool = false, begin: Bool = false) {
    let now = DispatchTime.now().uptimeNanoseconds
    if begin {
      deliveryStartedAt = now
      deliveryEvents = []
      firstDeliveryTerminal = nil
    }
    let elapsed = min(99_999, Int((now - (deliveryStartedAt ?? now)) / 1_000_000))
    if deliveryEvents.count < 8 { deliveryEvents.append("\(event)@\(elapsed)") }
    if terminal && firstDeliveryTerminal == nil { firstDeliveryTerminal = event }
    deliveryDiagnostic = "first=\(firstDeliveryTerminal ?? "none") trace=\(deliveryEvents.joined(separator: ","))"
  }
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
    if let pendingOperation {
      #if DEBUG
      noteDelivery("suspended", terminal: true)
      #endif
      finishUncertain(pendingOperation)
    }
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
    #if DEBUG
    noteDelivery("sent", begin: true)
    #endif
    status = operation == .read ? "Reading the selected Mac…" : "Command sent; outcome unverified."
    timeout?.cancel()
    timeout = Task {
      try? await Task.sleep(for: .milliseconds(
        WatchMediaRequest.lifetimeMilliseconds(for: request.operation)))
      guard !Task.isCancelled, pendingID == request.id else { return }
      #if DEBUG
      noteDelivery("deadline", terminal: true)
      #endif
      finishUncertain(operation)
    }
    session.sendMessage(request.message) { response in
      Task { @MainActor in self.receive(response, request: request) }
    } errorHandler: { _ in
      Task { @MainActor in
        guard self.pendingID == request.id else { return }
        #if DEBUG
        self.noteDelivery("send_error", terminal: true)
        #endif
        self.finishUncertain(operation)
      }
    }
  }

  private func receive(_ value: [String: Any], request: WatchMediaRequest) {
    guard pendingID == request.id else {
      #if DEBUG
      noteDelivery("late_reply")
      #endif
      return
    }
    guard foreground, WatchMediaWire.now() < request.expiresAt else {
      #if DEBUG
      noteDelivery("expired_reply", terminal: true)
      #endif
      finishUncertain(request.operation)
      return
    }
    timeout?.cancel()
    timeout = nil
    pendingID = nil
    pendingOperation = nil
    waiting = false
    guard let reply = WatchMediaReply.decode(value, expectedID: request.id) else {
      #if DEBUG
      noteDelivery("invalid_reply", terminal: true)
      #endif
      status = request.operation == .read
        ? "The iPhone returned an invalid observation. Read again."
        : "The command outcome is unknown. Read the page before another action."
      return
    }
    #if DEBUG
    noteDelivery("reply_\(reply.state.rawValue)", terminal: true)
    #endif
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
      if let operation {
        #if DEBUG
        noteDelivery("reachability_lost", terminal: true)
        #endif
        finishUncertain(operation)
      }
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
