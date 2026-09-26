import Foundation

/// The Watch has no coordinator identity. This process-local controller owns the phone's existing
/// enrollment and browser store only after an explicit enable tap on a selected Mac.
@MainActor
final class WatchMediaPhoneController {
  private let inventory: PhoneControlTransporting
  private let makeBrowser: (NativeEnrollmentCredential) -> BrowserPhoneControlStore
  private var credential: NativeEnrollmentCredential?
  private var targetID: String?
  private var epoch: String?
  private var browser: BrowserPhoneControlStore?
  private var seenRequests = [String: Int64]()
  private var requestInFlight = false
  private var activation = 0

  init(
    inventory: PhoneControlTransporting = PhoneControlTransport(),
    browserTransport: BrowserPhoneControlTransporting = BrowserPhoneControlTransport(),
    makeBrowser: ((NativeEnrollmentCredential) -> BrowserPhoneControlStore)? = nil
  ) {
    self.inventory = inventory
    self.makeBrowser = makeBrowser ?? { BrowserPhoneControlStore(credential: $0, transport: browserTransport) }
  }

  var enabledTargetID: String? { targetID }

  @discardableResult
  func enable(credential: NativeEnrollmentCredential, node: PhoneControlNode) -> Bool {
    // An attempted switch must not leave an older target enabled if the new choice fails.
    disable()
    guard node.online, node.capabilities.contains("browser.read"),
      node.capabilities.contains("browser.control"),
      credential.client.role == "phone",
      credential.client.expiresAt > WatchMediaWire.now(),
      credential.client.grants.contains(where: {
        $0.target == node.id && validNativeCapabilities($0.capabilities)
          && $0.capabilities.contains("browser.read")
          && $0.capabilities.contains("browser.control")
    })
    else { return false }
    self.credential = credential
    targetID = node.id
    epoch = UUID().uuidString.lowercased()
    browser = makeBrowser(credential)
    browser?.clearIfTargetChanged(to: node.id)
    return true
  }

  func disable() {
    activation += 1
    browser?.cancel()
    credential = nil
    targetID = nil
    epoch = nil
    browser = nil
    seenRequests.removeAll()
  }

  func retainOnly(_ credential: NativeEnrollmentCredential?) {
    guard credential == self.credential else { disable(); return }
  }

  func handle(
    _ request: WatchMediaRequest, reachable: @escaping () -> Bool = { true },
    now: @escaping () -> Int64 = WatchMediaWire.now
  ) async -> WatchMediaReply {
    func reply(_ state: WatchMediaState) -> WatchMediaReply {
      WatchMediaReply(id: request.id, state: state, observation: nil)
    }
    let receivedAt = now()
    // Expired packets cannot run, so their IDs need no longer occupy the bounded replay cache.
    // Never evict a still-live accepted ID merely to make room for another request.
    seenRequests = seenRequests.filter { $0.value > receivedAt }
    guard request.expiresAt > receivedAt, reachable(), !requestInFlight,
      seenRequests.count < 128, seenRequests[request.id] == nil,
      let credential, let targetID, let epoch, let browser,
      credential.client.expiresAt > now()
    else { return reply(.blocked) }
    seenRequests[request.id] = request.expiresAt
    let currentActivation = activation
    requestInFlight = true
    defer { requestInFlight = false }
    if request.operation != .read {
      guard request.target == targetID, request.epoch == epoch else { return reply(.stale) }
    }
    let node: PhoneControlNode
    do {
      let nodes = try await inventory.nodes(for: credential)
      guard currentActivation == activation, self.targetID == targetID,
        self.epoch == epoch, request.expiresAt > now(), reachable()
      else { return reply(.stale) }
      guard credential.client.expiresAt > now() else { return reply(.blocked) }
      guard let selected = nodes.first(where: { $0.id == targetID }), selected.online else {
        return reply(.unavailable)
      }
      node = selected
    } catch {
      guard currentActivation == activation, self.targetID == targetID, self.epoch == epoch else {
        return reply(.stale)
      }
      if error as? PhoneControlFailure == .revoked { disable(); return reply(.blocked) }
      return reply(.unavailable)
    }
    switch request.operation {
    case .read:
      guard node.capabilities.contains("browser.read"), browser.refresh(on: node) else {
        return reply(.blocked)
      }
      while browser.isBusy && request.expiresAt > now() && currentActivation == activation {
        try? await Task.sleep(for: .milliseconds(40))
      }
      guard currentActivation == activation, request.expiresAt > now(), reachable() else {
        browser.cancel()
        return reply(.stale)
      }
      guard !browser.isBusy, browser.phase == .ready, let page = browser.page,
        page.nodeID == targetID, page.site?.page == .watch
      else { return reply(.unavailable) }
      let playback: String
      switch page.site?.playback {
      case .playing where browser.canPerform(.pause, on: node): playback = "playing"
      case .paused where browser.canPerform(.play, on: node): playback = "paused"
      default: playback = "unavailable"
      }
      let title = page.title.flatMap {
        WatchMediaWire.validText($0, maximum: 500) ? $0 : nil
      }
      return WatchMediaReply(
        id: request.id, state: .observed,
        observation: WatchMediaObservation(
          target: targetID, targetLabel: node.label, epoch: epoch,
          revision: page.revision, title: title, playback: playback))
    case .play, .pause:
      guard node.capabilities.contains("browser.control") else { return reply(.blocked) }
      guard let page = browser.page, page.nodeID == targetID,
        page.revision == request.revision,
        request.expiresAt > now(), reachable()
      else { return reply(.stale) }
      let intent: BrowserVoiceIntent = request.operation == .play ? .play : .pause
      guard browser.canPerform(intent, on: node), browser.perform(intent, on: node) else {
        return reply(.blocked)
      }
      // Admission starts the existing one-shot, durable-uncertainty store. Even a quick
      // completed response is not proof of the Watch's observed player state.
      return reply(.unknown)
    }
  }
}
