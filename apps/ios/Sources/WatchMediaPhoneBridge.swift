import Combine
import Foundation
import WatchConnectivity

/// WCSession only transports short, live requests. The phone keeps the credential and decides
/// whether an explicit Watch tap is authorized for its currently selected Mac and browser page.
@MainActor
final class WatchMediaPhoneBridge: NSObject, ObservableObject, WCSessionDelegate {
  static let shared = WatchMediaPhoneBridge()

  @Published private(set) var enabledTargetID: String?
  @Published private(set) var available = false
  private var controller: WatchMediaPhoneController
  private var activated = false

  override init() {
    controller = WatchMediaPhoneController()
    super.init()
  }

  init(controller: WatchMediaPhoneController) {
    self.controller = controller
    super.init()
    enabledTargetID = controller.enabledTargetID
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    let session = WCSession.default
    guard !activated else { return }
    activated = true
    session.delegate = self
    session.activate()
    updateAvailability(session)
  }

  @discardableResult
  func enable(credential: NativeEnrollmentCredential, node: PhoneControlNode) -> Bool {
    activate()
    disable()
    guard available, controller.enable(credential: credential, node: node) else { return false }
    enabledTargetID = node.id
    recordPairedFixtureReadiness()
    return true
  }

  func disable() {
    controller.disable()
    enabledTargetID = nil
    recordPairedFixtureReadiness()
  }

  #if DEBUG
  func recordPairedFixtureReadiness() {
    guard WCSession.isSupported() else { return }
    WatchPairedUITestReadiness.record(session: WCSession.default, enabledTargetID: enabledTargetID)
  }
  #else
  private func recordPairedFixtureReadiness() {}
  #endif

  #if DEBUG
  /// The paired-Simulator fixture changes only the phone's backend. WCSession and this delegate
  /// remain the installed app's real transport.
  func installPairedTestController(_ fixture: WatchMediaPhoneController) {
    guard ProcessInfo.processInfo.arguments.contains("--ellie-ui-watch-paired-fixture") else { return }
    disable()
    controller = fixture
  }
  #endif

  func retainOnly(_ credential: NativeEnrollmentCredential?) {
    controller.retainOnly(credential)
    enabledTargetID = controller.enabledTargetID
  }

  nonisolated func session(
    _ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
    error: Error?
  ) {
    Task { @MainActor in self.updateAvailability(session) }
  }

  nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
    Task { @MainActor in self.updateAvailability(session) }
  }

  nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
    Task { @MainActor in self.updateAvailability(session) }
  }

  nonisolated func sessionDidBecomeInactive(_ session: WCSession) {
    Task { @MainActor in self.updateAvailability(session) }
  }

  nonisolated func sessionDidDeactivate(_ session: WCSession) {
    Task { @MainActor in
      self.updateAvailability(session)
      if watchMediaSessionNeedsActivation(session.activationState) { session.activate() }
    }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    Task { @MainActor in
      #if DEBUG
      WatchPairedUITestReadiness.noteReceived(enabledTargetID: self.enabledTargetID)
      #endif
      guard let request = WatchMediaRequest.decode(message) else {
        // A malformed request has no trusted ID or authority; never interpret its action.
        replyHandler(["version": 1, "id": "invalid", "state": "blocked"])
        #if DEBUG
        WatchPairedUITestReadiness.noteReply(.blocked, enabledTargetID: self.enabledTargetID)
        #endif
        return
      }
      #if DEBUG
      WatchPairedUITestReadiness.noteDecoded(enabledTargetID: self.enabledTargetID)
      #endif
      let response = await self.handle(request) {
        session.activationState == .activated && session.isReachable
          && session.isPaired && session.isWatchAppInstalled
      }
      replyHandler(response.message)
      #if DEBUG
      WatchPairedUITestReadiness.noteReply(response.state, enabledTargetID: self.enabledTargetID)
      #endif
    }
  }

  func handle(
    _ request: WatchMediaRequest, reachable: @escaping () -> Bool = { true }
  ) async -> WatchMediaReply {
    let response = await controller.handle(request, reachable: reachable)
    enabledTargetID = controller.enabledTargetID
    return response
  }

  private func updateAvailability(_ session: WCSession) {
    updateAvailability(
      activated: session.activationState == .activated,
      paired: session.isPaired,
      watchAppInstalled: session.isWatchAppInstalled)
    recordPairedFixtureReadiness()
  }

  func updateAvailability(activated: Bool, paired: Bool, watchAppInstalled: Bool) {
    available = watchMediaSessionIsAvailable(
      activated: activated, paired: paired, watchAppInstalled: watchAppInstalled)
    if !available { disable() }
  }
}

/// Delegate callbacks cross to the main actor asynchronously. Decisions therefore use the
/// session's current state when they run, rather than unconditionally applying an older event.
func watchMediaSessionIsAvailable(
  activated: Bool, paired: Bool, watchAppInstalled: Bool
) -> Bool {
  activated && paired && watchAppInstalled
}

func watchMediaSessionNeedsActivation(_ state: WCSessionActivationState) -> Bool {
  state != .activated
}
