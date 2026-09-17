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
  private var controller = WatchMediaPhoneController()
  private var activated = false

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
    Task { @MainActor in self.disable(); self.updateAvailability(session) }
  }

  nonisolated func sessionDidDeactivate(_ session: WCSession) {
    Task { @MainActor in
      self.disable()
      self.updateAvailability(session)
      session.activate()
    }
  }

  nonisolated func session(
    _ session: WCSession, didReceiveMessage message: [String: Any],
    replyHandler: @escaping ([String: Any]) -> Void
  ) {
    Task { @MainActor in
      guard let request = WatchMediaRequest.decode(message) else {
        // A malformed request has no trusted ID or authority; never interpret its action.
        replyHandler(["version": 1, "id": "invalid", "state": "blocked"])
        return
      }
      let response = await self.controller.handle(request) {
        session.activationState == .activated && session.isReachable
          && session.isPaired && session.isWatchAppInstalled
      }
      replyHandler(response.message)
    }
  }

  private func updateAvailability(_ session: WCSession) {
    available = session.activationState == .activated && session.isPaired
      && session.isWatchAppInstalled
    if !available { disable() }
    recordPairedFixtureReadiness()
  }
}
