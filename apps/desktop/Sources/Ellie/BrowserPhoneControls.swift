import Combine
import Foundation

@MainActor
final class BrowserPhoneControlStore: ObservableObject {
  enum Phase: Equatable {
    case idle, checking, reading, sending(String), cancelling
    case ready
    case outcome(String)
    case unknown(String)
    case failed(String)
    case revoked
  }

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var page: BrowserPhonePage?
  private let credential: NativeEnrollmentCredential
  private let transport: BrowserPhoneControlTransporting
  private var task: Task<Void, Never>?
  private var generation = 0
  private var dispatched = false
  private var activeTargetID: String?

  init(
    credential: NativeEnrollmentCredential,
    transport: BrowserPhoneControlTransporting = BrowserPhoneControlTransport()
  ) {
    self.credential = credential
    self.transport = transport
  }

  var isBusy: Bool { task != nil }

  func clearIfTargetChanged(to nodeID: String?) {
    guard page?.nodeID != nodeID || activeTargetID != nil && activeTargetID != nodeID else {
      return
    }
    page = nil
    if task != nil, activeTargetID != nodeID {
      invalidateActiveOperation()
    } else if task == nil {
      phase = .idle
    }
  }

  func refresh(on node: PhoneControlNode?) {
    guard task == nil, let node, node.online, node.capabilities.contains("browser.read") else {
      if node != nil { phase = .failed("The selected Mac does not allow browser reading.") }
      return
    }
    page = nil
    phase = .checking
    launch(targetID: node.id, mayDispatch: false) {
      let status = try await self.transport.execute(
        .status, nodeID: node.id, credential: self.credential)
      guard case .status(let source, true, let revision?) = status else {
        throw PhoneControlFailure.rejected
      }
      let read = try await self.transport.execute(
        .read(revision: revision), nodeID: node.id, credential: self.credential)
      guard case .page(let page) = read, page.nodeID == node.id, page.source == source,
        page.revision == revision
      else { throw PhoneControlFailure.invalidResponse }
      return (.ready, page)
    }
  }

  func perform(_ intent: BrowserVoiceIntent, on node: PhoneControlNode?) {
    guard task == nil, let node else { return }
    if intent == .inspect || intent == .refresh { refresh(on: node); return }
    guard node.online, node.capabilities.contains("browser.control"), let page,
      page.nodeID == node.id
    else {
      phase = .failed("Read the current browser page on the selected Mac first.")
      return
    }
    let action: BrowserPhoneAction
    switch intent {
    case .scroll(let direction): action = .scroll(direction, revision: page.revision)
    case .search(let query):
      guard query == query.trimmingCharacters(in: .whitespacesAndNewlines),
        !query.isEmpty, query.utf16.count <= 200, query.utf8.count <= 512,
        !query.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
      else {
        phase = .failed("The search text is not valid.")
        return
      }
      action = .search(query, revision: page.revision)
    case .openResult(let index):
      guard (1...page.items.count).contains(index) else {
        phase = .failed("That result is not in the current page list.")
        return
      }
      action = .select(page.items[index - 1].id, revision: page.revision)
    case .play, .pause: action = .playback(intent, revision: page.revision)
    case .back:
      phase = .failed("Back is not available for reviewed browser control yet.")
      return
    case .inspect, .refresh: return
    }
    let label = intent.displayLabel
    phase = .sending(label)
    launch(targetID: node.id, mayDispatch: true) {
      self.dispatched = true
      let response = try await self.transport.execute(
        action, nodeID: node.id, credential: self.credential)
      guard case .command(let source, let status, let revision) = response,
        source == page.source, revision == page.revision
      else { throw PhoneControlFailure.invalidResponse }
      switch status {
      case .completed: return (.outcome("\(label) completed."), nil)
      case .failed:
        return (.failed("The browser reported that \(label.lowercased()) failed."), nil)
      case .unknown, .cancelled, .timedOut:
        return (
          .unknown("The result is unknown. Read the page before sending another command."), nil)
      }
    }
  }

  func cancel() {
    guard task != nil else { return }
    page = nil
    invalidateActiveOperation()
  }

  private func invalidateActiveOperation() {
    generation += 1
    task?.cancel()
    phase = .cancelling
  }

  private func launch(
    targetID: String, mayDispatch: Bool,
    operation: @escaping @MainActor () async throws -> (Phase, BrowserPhonePage?)
  ) {
    generation += 1
    let expected = generation
    dispatched = false
    activeTargetID = targetID
    task = Task {
      defer {
        task = nil
        activeTargetID = nil
        if expected != generation, phase == .cancelling {
          phase = mayDispatch && dispatched
            ? .unknown("The result is unknown. Read the page before trying again.") : .idle
        }
        dispatched = false
      }
      do {
        let result = try await operation()
        if expected == generation, activeTargetID == targetID {
          phase = result.0
          page = result.1
        }
      } catch {
        guard expected == generation else { return }
        page = nil
        if mayDispatch && dispatched {
          phase = .unknown("The result is unknown. Read the page before trying again.")
        } else if error as? PhoneControlFailure == .revoked {
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
}
