import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Security

enum BrowserAccessibilityFailure: Error, Equatable {
  case unavailable, unauthorized, ambiguous, stale, invalid, cancelled, deadline
  case partialUnknown
}

enum BrowserAccessibilityBrowser: String, Equatable, Sendable {
  case safari
  case arc

  var bundleIdentifier: String {
    switch self {
    case .safari: "com.apple.Safari"
    case .arc: "company.thebrowser.Browser"
    }
  }
}

enum BrowserAccessibilityDirection: String, Sendable { case up, down, left, right }
enum BrowserAccessibilityPlayback: String, Sendable { case play, pause }

enum BrowserAccessibilityCommand: Sendable {
  case scroll(BrowserAccessibilityDirection, generation: String, documentRevision: String)
  case search(query: String, generation: String, documentRevision: String)
  case select(itemID: String, generation: String, documentRevision: String)
  case playback(BrowserAccessibilityPlayback, generation: String, documentRevision: String)
}

enum BrowserAccessibilityOperation: String, Sendable { case scroll, search, select, playback }
enum BrowserAccessibilityStatus: String, Sendable { case dispatchedUnverified, unknown }

struct BrowserAccessibilityOutcome: Equatable, Sendable {
  let source = "accessibility"
  let operation: BrowserAccessibilityOperation
  let status: BrowserAccessibilityStatus
  let documentRevision: String
}

struct BrowserAccessibilityItem: Encodable, Equatable, Sendable {
  let id: String
  let label: String
}

struct BrowserAccessibilityObservation: Equatable, Sendable {
  let generation: String
  let documentRevision: String
  let title: String?
  let summary: String?
  let items: [BrowserAccessibilityItem]
  let scrollDirections: [String]
}

final class BrowserAccessibilityElementReference: @unchecked Sendable {
  fileprivate let value: AnyObject
  init(_ value: AnyObject) { self.value = value }
  func isSameObject(as other: BrowserAccessibilityElementReference) -> Bool {
    value === other.value
  }
}

struct BrowserAccessibilityNode: Sendable {
  enum Kind: String, Sendable { case webArea, address, search, link, button, text, scrollArea }
  let reference: BrowserAccessibilityElementReference
  let kind: Kind
  let label: String?
  let value: String?
  let enabled: Bool
  let path: [Int]
  let actions: Set<String>
}

struct BrowserAccessibilitySnapshot: Sendable {
  let browser: BrowserAccessibilityBrowser
  let processID: Int32
  let launchIdentity: String
  let exactURL: String
  let window: BrowserAccessibilityElementReference
  let webArea: BrowserAccessibilityElementReference
  let address: BrowserAccessibilityElementReference
  let title: String?
  let nodes: [BrowserAccessibilityNode]
}

struct BrowserProcessIdentity: Equatable, Sendable {
  let processID: Int32
  let startSeconds: UInt64
  let startMicroseconds: UInt64
  let codeHash: Data
}

func browserProcessStartIdentity(_ processID: Int32) -> (UInt64, UInt64)? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard processID > 0, proc_pidinfo(processID, PROC_PIDTBSDINFO, 0, &info, size) == size,
    info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000
  else { return nil }
  return (UInt64(info.pbi_start_tvsec), UInt64(info.pbi_start_tvusec))
}

protocol BrowserAccessibilityBackend: AnyObject {
  func snapshot(browser: BrowserAccessibilityBrowser, processID: Int32) throws
    -> BrowserAccessibilitySnapshot
  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool
  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws
  func value(on element: BrowserAccessibilityElementReference) throws -> String?
  func press(
    revalidate: () throws -> BrowserAccessibilityPressAuthorization,
    cancelled: () -> Bool
  ) throws
  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws
}

struct BrowserAccessibilityPressAuthorization {
  let browser: BrowserAccessibilityBrowser
  let processID: Int32
  let launchIdentity: String
  let exactURL: String
  let documentRevision: String
  let window: BrowserAccessibilityElementReference
  let webArea: BrowserAccessibilityElementReference
  let target: BrowserAccessibilityElementReference
}

extension BrowserAccessibilityBackend {
  func value(on element: BrowserAccessibilityElementReference) throws -> String? {
    throw BrowserAccessibilityFailure.unavailable
  }
}

final class BrowserAccessibilityAuthorizedPage: @unchecked Sendable {
  fileprivate let browser: BrowserAccessibilityBrowser
  fileprivate let processID: Int32
  fileprivate let exactURL: String
  fileprivate let documentRevision: String
  fileprivate let launchIdentity: String
  fileprivate let window: BrowserAccessibilityElementReference
  fileprivate let webArea: BrowserAccessibilityElementReference
  fileprivate let address: BrowserAccessibilityElementReference

  fileprivate init(
    browser: BrowserAccessibilityBrowser, processID: Int32, exactURL: String,
    documentRevision: String, snapshot: BrowserAccessibilitySnapshot
  ) {
    self.browser = browser
    self.processID = processID
    self.exactURL = exactURL
    self.documentRevision = documentRevision
    launchIdentity = snapshot.launchIdentity
    window = snapshot.window
    webArea = snapshot.webArea
    address = snapshot.address
  }
}

final class BrowserAccessibilityAdapter {
  private struct Observed {
    let generation: String
    let page: BrowserAccessibilityAuthorizedPage
    let items: [String: BrowserAccessibilityNode]
  }

  private enum SearchSubmission: Equatable {
    case confirm
    case press
  }

  private struct SearchPlan {
    let field: BrowserAccessibilityNode
    let target: BrowserAccessibilityNode
    let submission: SearchSubmission
  }

  private struct ReadContent: Encodable {
    let title: String?
    let summary: String?
    let items: [BrowserAccessibilityItem]
  }

  private static let maximumQueryUTF16 = 200
  private static let searchAcknowledgementSeconds = 0.5
  private static let searchAcknowledgementPollSeconds = 0.01
  private static let maximumLabelBytes = 500
  private static let maximumTextBytes = 2_000
  private static let maximumItems = 64
  // The session frame is 16,384 bytes. This leaves more than 4 KiB for the response envelope,
  // including its bounded request, session, generation, and revision identifiers.
  private static let maximumReadContentBytes = 12_000
  private let backend: BrowserAccessibilityBackend
  private var observed: Observed?

  init(backend: BrowserAccessibilityBackend = MacBrowserAccessibilityBackend()) {
    self.backend = backend
  }

  func bindAuthorizedPage(
    browser: BrowserAccessibilityBrowser, processID: Int32, exactURL: String,
    documentRevision: String
  ) throws -> BrowserAccessibilityAuthorizedPage {
    guard processID > 0, validRevision(documentRevision), canonicalURL(exactURL) != nil else {
      throw BrowserAccessibilityFailure.invalid
    }
    let snapshot = try backend.snapshot(browser: browser, processID: processID)
    guard snapshot.browser == browser, snapshot.processID == processID,
      snapshot.exactURL == canonicalURL(exactURL)
    else { throw BrowserAccessibilityFailure.unauthorized }
    observed = nil
    return BrowserAccessibilityAuthorizedPage(
      browser: browser, processID: processID, exactURL: canonicalURL(exactURL)!,
      documentRevision: documentRevision, snapshot: snapshot)
  }

  func read(
    _ page: BrowserAccessibilityAuthorizedPage, cancelled: () -> Bool = { false }
  ) throws -> BrowserAccessibilityObservation {
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    let snapshot = try rebound(page)
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    var text: [String] = []
    var textBytes = 0
    for node in snapshot.nodes {
      if node.kind == .text, let label = node.label, !label.isEmpty {
        let separatorSize = text.isEmpty ? 0 : 1
        let byteSize = label.utf8.count + separatorSize
        if textBytes + byteSize <= Self.maximumTextBytes {
          text.append(label)
          textBytes += byteSize
        }
      }
    }
    let title = snapshot.title.flatMap { validLabel($0) ? $0 : nil }
    let summary = text.isEmpty ? nil : text.joined(separator: " ")
    var items: [BrowserAccessibilityItem] = []
    var retained: [String: BrowserAccessibilityNode] = [:]
    guard let initialBytes = encodedReadContentBytes(title: title, summary: summary, items: items),
      initialBytes <= Self.maximumReadContentBytes
    else { throw BrowserAccessibilityFailure.unavailable }
    for node in selectableVideoLinks(snapshot.nodes) {
      guard items.count < Self.maximumItems else { break }
      guard let label = node.label else { continue }
      let id = UUID().uuidString.lowercased()
      let item = BrowserAccessibilityItem(id: id, label: label)
      let proposed = items + [item]
      guard let encodedBytes = encodedReadContentBytes(
        title: title, summary: summary, items: proposed)
      else { throw BrowserAccessibilityFailure.unavailable }
      guard encodedBytes <= Self.maximumReadContentBytes else { continue }
      items.append(item)
      retained[id] = node
    }
    let generation = UUID().uuidString.lowercased()
    observed = Observed(generation: generation, page: page, items: retained)
    let webAreaActions = snapshot.nodes.first { $0.kind == .webArea }?.actions ?? []
    let scrollDirections = ["up", "down"].filter { webAreaActions.contains("scroll-\($0)") }
    return BrowserAccessibilityObservation(
      generation: generation, documentRevision: page.documentRevision,
      title: title, summary: summary, items: items, scrollDirections: scrollDirections)
  }

  func perform(
    _ command: BrowserAccessibilityCommand, on page: BrowserAccessibilityAuthorizedPage,
    cancelled: () -> Bool = { false }
  ) throws -> BrowserAccessibilityOutcome {
    let values = commandValues(command)
    guard let observed, observed.generation == values.generation,
      observed.page === page, values.revision == page.documentRevision
    else { throw BrowserAccessibilityFailure.stale }
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    defer { self.observed = nil }
    let snapshot = try rebound(page)

    switch command {
    case .scroll(let direction, _, _):
      let action = "scroll-\(direction.rawValue)"
      guard snapshot.nodes.first(where: { $0.kind == .webArea })?.actions.contains(action) == true
      else { throw BrowserAccessibilityFailure.unavailable }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do { try backend.perform(action, on: snapshot.webArea) }
      catch { return outcome(.scroll, .unknown, page) }
      return outcome(.scroll, .dispatchedUnverified, page)
    case .search(let query, _, _):
      guard validQuery(query) else { throw BrowserAccessibilityFailure.invalid }
      let selected = try searchPlan(in: snapshot.nodes)
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      let beforeSet: SearchPlan
      do {
        let fresh = try rebound(page)
        guard let rebound = rebindSearchPlan(selected, in: fresh.nodes) else {
          return outcome(.search, .unknown, page)
        }
        beforeSet = rebound
      } catch {
        return outcome(.search, .unknown, page)
      }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do { try backend.setValue(query, on: beforeSet.field.reference) }
      catch { return outcome(.search, .unknown, page) }
      do {
        try acknowledgeSearchValue(
          query, on: beforeSet.field.reference, cancelled: cancelled)
        let afterSet = try rebound(page)
        guard let ready = rebindSearchPlan(beforeSet, in: afterSet.nodes) else {
          throw BrowserAccessibilityFailure.partialUnknown
        }
        guard !cancelled() else { throw BrowserAccessibilityFailure.partialUnknown }
        switch ready.submission {
        case .confirm:
          try backend.perform("confirm", on: ready.target.reference)
        case .press:
          try backend.press(
            revalidate: {
              let fresh = try self.rebound(page)
              guard let final = self.rebindSearchPlan(ready, in: fresh.nodes),
                final.submission == .press
              else { throw BrowserAccessibilityFailure.stale }
              return self.pressAuthorization(fresh, page: page, target: final.target.reference)
            }, cancelled: cancelled)
        }
        return outcome(.search, .dispatchedUnverified, page)
      } catch {
        return outcome(.search, .unknown, page)
      }
    case .select(let itemID, _, _):
      guard let item = observed.items[itemID], let reboundItem = uniqueRebind(item, in: snapshot.nodes)
      else { throw BrowserAccessibilityFailure.stale }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do {
        try backend.press(
          revalidate: {
            let fresh = try self.rebound(page)
            guard let final = self.uniqueRebind(reboundItem, in: fresh.nodes) else {
              throw BrowserAccessibilityFailure.stale
            }
            return self.pressAuthorization(fresh, page: page, target: final.reference)
          }, cancelled: cancelled)
      }
      catch { return outcome(.select, .unknown, page) }
      return outcome(.select, .dispatchedUnverified, page)
    case .playback(let playback, _, _):
      let candidates = snapshot.nodes.filter {
        $0.kind == .button && $0.enabled && $0.actions.contains("press")
          && playbackLabel($0.label, matches: playback)
      }
      guard candidates.count == 1, let control = candidates.first else {
        throw BrowserAccessibilityFailure.ambiguous
      }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do {
        try backend.press(
          revalidate: {
            let fresh = try self.rebound(page)
            let matches = fresh.nodes.filter {
              $0.kind == .button && $0.enabled && $0.actions.contains("press")
                && self.playbackLabel($0.label, matches: playback)
            }
            guard matches.count == 1,
              let final = self.uniqueRebind(control, in: matches)
            else { throw BrowserAccessibilityFailure.stale }
            return self.pressAuthorization(fresh, page: page, target: final.reference)
          }, cancelled: cancelled)
      }
      catch { return outcome(.playback, .unknown, page) }
      return outcome(.playback, .dispatchedUnverified, page)
    }
  }

  private func rebound(_ page: BrowserAccessibilityAuthorizedPage) throws
    -> BrowserAccessibilitySnapshot
  {
    let snapshot = try backend.snapshot(browser: page.browser, processID: page.processID)
    guard snapshot.browser == page.browser, snapshot.processID == page.processID,
      snapshot.launchIdentity == page.launchIdentity, snapshot.exactURL == page.exactURL,
      backend.same(snapshot.window, page.window), backend.same(snapshot.webArea, page.webArea),
      backend.same(snapshot.address, page.address)
    else { throw BrowserAccessibilityFailure.stale }
    return snapshot
  }

  private func uniqueRebind(
    _ prior: BrowserAccessibilityNode, in nodes: [BrowserAccessibilityNode]
  ) -> BrowserAccessibilityNode? {
    let matches = nodes.filter {
      $0.kind == prior.kind && $0.path == prior.path && $0.label == prior.label
        && $0.value == prior.value && $0.enabled && $0.actions == prior.actions
        && backend.same($0.reference, prior.reference)
    }
    return matches.count == 1 ? matches[0] : nil
  }

  private func pressAuthorization(
    _ snapshot: BrowserAccessibilitySnapshot,
    page: BrowserAccessibilityAuthorizedPage,
    target: BrowserAccessibilityElementReference
  ) -> BrowserAccessibilityPressAuthorization {
    BrowserAccessibilityPressAuthorization(
      browser: snapshot.browser, processID: snapshot.processID,
      launchIdentity: snapshot.launchIdentity, exactURL: snapshot.exactURL,
      documentRevision: page.documentRevision, window: snapshot.window,
      webArea: snapshot.webArea, target: target)
  }

  private func searchPlan(in nodes: [BrowserAccessibilityNode]) throws -> SearchPlan {
    let fields = nodes.filter {
      $0.kind == .search && $0.enabled && $0.actions.contains("set-value")
    }
    guard fields.count == 1, let field = fields.first else {
      throw BrowserAccessibilityFailure.ambiguous
    }
    if field.actions.contains("confirm") {
      return SearchPlan(field: field, target: field, submission: .confirm)
    }
    let buttons = nodes.filter {
      $0.kind == .button && $0.label == "Search" && $0.enabled && $0.actions.contains("press")
    }
    guard buttons.count == 1, let button = buttons.first else {
      throw BrowserAccessibilityFailure.ambiguous
    }
    return SearchPlan(field: field, target: button, submission: .press)
  }

  private func rebindSearchPlan(
    _ prior: SearchPlan, in nodes: [BrowserAccessibilityNode]
  ) -> SearchPlan? {
    guard let selected = try? searchPlan(in: nodes), selected.submission == prior.submission,
      let field = uniqueRebind(prior.field, in: nodes),
      let target = uniqueRebind(prior.target, in: nodes),
      backend.same(selected.field.reference, field.reference),
      backend.same(selected.target.reference, target.reference)
    else { return nil }
    return SearchPlan(field: field, target: target, submission: prior.submission)
  }

  private func acknowledgeSearchValue(
    _ expected: String, on field: BrowserAccessibilityElementReference,
    cancelled: () -> Bool
  ) throws {
    guard validQuery(expected) else { throw BrowserAccessibilityFailure.invalid }
    let deadline = ProcessInfo.processInfo.systemUptime + Self.searchAcknowledgementSeconds
    while true {
      guard !cancelled() else { throw BrowserAccessibilityFailure.partialUnknown }
      let value = try backend.value(on: field)
      let remaining = deadline - ProcessInfo.processInfo.systemUptime
      guard remaining >= 0 else { throw BrowserAccessibilityFailure.deadline }
      guard !cancelled() else { throw BrowserAccessibilityFailure.partialUnknown }
      guard value == expected else {
        guard remaining > 0 else { throw BrowserAccessibilityFailure.deadline }
        Thread.sleep(
          forTimeInterval: min(Self.searchAcknowledgementPollSeconds, remaining))
        continue
      }
      return
    }
  }

  private func commandValues(_ command: BrowserAccessibilityCommand) -> (generation: String, revision: String) {
    switch command {
    case .scroll(_, let generation, let revision), .search(_, let generation, let revision),
      .select(_, let generation, let revision), .playback(_, let generation, let revision):
      (generation, revision)
    }
  }

  private func outcome(
    _ operation: BrowserAccessibilityOperation, _ status: BrowserAccessibilityStatus,
    _ page: BrowserAccessibilityAuthorizedPage
  ) -> BrowserAccessibilityOutcome {
    BrowserAccessibilityOutcome(
      operation: operation, status: status, documentRevision: page.documentRevision)
  }

  private func canonicalURL(_ value: String) -> String? {
    guard value.utf8.count <= 2_048, let url = URL(string: value), url.scheme == "https",
      url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
      url.absoluteString == value
    else { return nil }
    return value
  }

  private func validRevision(_ value: String) -> Bool {
    value.range(of: #"^[A-Za-z0-9._-]{1,128}$"#, options: .regularExpression) != nil
  }

  private func validQuery(_ value: String) -> Bool {
    !value.isEmpty && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
      && value.utf16.count <= Self.maximumQueryUTF16 && value.utf8.count <= 512
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }

  private func validLabel(_ value: String) -> Bool {
    !value.isEmpty && value.utf16.count <= 256 && value.utf8.count <= Self.maximumLabelBytes
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }

  private func encodedReadContentBytes(
    title: String?, summary: String?, items: [BrowserAccessibilityItem]
  ) -> Int? {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try? encoder.encode(ReadContent(title: title, summary: summary, items: items)).count
  }

  private func selectableVideoLinks(_ nodes: [BrowserAccessibilityNode]) -> [BrowserAccessibilityNode] {
    var candidates: [(node: BrowserAccessibilityNode, videoID: String)] = []
    var counts: [String: Int] = [:]
    for node in nodes {
      guard node.kind == .link, node.enabled, node.actions.contains("press"),
        let label = node.label, validLabel(label), let value = node.value,
        let videoID = youtubeWatchVideoID(value)
      else { continue }
      candidates.append((node, videoID))
      counts[videoID, default: 0] += 1
    }
    return candidates.compactMap { counts[$0.videoID] == 1 ? $0.node : nil }
  }

  private func youtubeWatchVideoID(_ value: String) -> String? {
    guard value.utf8.count <= 2_048, let components = URLComponents(string: value),
      components.scheme == "https", components.host == "www.youtube.com",
      components.port == nil, components.user == nil, components.password == nil,
      components.fragment == nil,
      components.path == "/watch", components.url?.absoluteString == value,
      let queryItems = components.queryItems, !queryItems.isEmpty,
      let encodedQuery = components.percentEncodedQuery
    else { return nil }
    let encodedItems = encodedQuery.split(separator: "&", omittingEmptySubsequences: false)
    guard encodedItems.count == queryItems.count else { return nil }
    var videoID: String?
    var timestampSeen = false
    for (item, encodedItem) in zip(queryItems, encodedItems) {
      guard (item.name == "v" || item.name == "pp" || item.name == "t"),
        let itemValue = item.value,
        !itemValue.isEmpty, itemValue.utf8.count <= 256
      else { return nil }
      if item.name == "v" {
        guard videoID == nil,
          itemValue.range(of: #"^[A-Za-z0-9_-]{11}$"#, options: .regularExpression) != nil
        else { return nil }
        videoID = itemValue
      } else if item.name == "t" {
        guard !timestampSeen, encodedItem == "t=\(itemValue)",
          validYoutubeTimestamp(itemValue)
        else { return nil }
        timestampSeen = true
      }
    }
    return videoID
  }

  private func validYoutubeTimestamp(_ value: String) -> Bool {
    guard value.range(of: #"^(0|[1-9][0-9]{0,4})s?$"#, options: .regularExpression) != nil
    else { return false }
    let digits = value.last == "s" ? value.dropLast() : value[...]
    guard let seconds = Int(digits) else { return false }
    return seconds <= 86_400
  }

  private func playbackLabel(
    _ label: String?, matches playback: BrowserAccessibilityPlayback
  ) -> Bool {
    guard let label, validLabel(label) else { return false }
    switch playback {
    case .play: return label == "Play (k)" || label == "Play keyboard shortcut k"
    case .pause: return label == "Pause (k)" || label == "Pause keyboard shortcut k"
    }
  }
}

enum BrowserAccessibilityTraversalLimits {
  // A full Arc YouTube window exposed 1,782 elements, 483 relevant nodes, and depth 21.
  // Keep finite headroom for browser chrome and dynamic page content while rejecting trees that
  // cannot be inspected completely for ambiguous controls.
  private static let maximumElements = 2_560
  private static let maximumNodes = 768
  private static let maximumChildren = 512
  private static let maximumDepth = 32
  private static let maximumCalls = 6_144

  static func permitsElement(count: Int, depth: Int) -> Bool {
    count > 0 && count <= maximumElements && depth >= 0 && depth <= maximumDepth
  }

  static func permitsNode(count: Int) -> Bool {
    count > 0 && count <= maximumNodes
  }

  static func permitsChildren(count: Int) -> Bool {
    count >= 0 && count <= maximumChildren
  }

  static func permitsCall(count: Int) -> Bool {
    count > 0 && count <= maximumCalls
  }
}

final class BrowserAccessibilityMouseEvent {
  fileprivate let value: AnyObject
  init(_ value: AnyObject) { self.value = value }
}

struct BrowserAccessibilityMouseEvents {
  let down: BrowserAccessibilityMouseEvent
  let up: BrowserAccessibilityMouseEvent
}

protocol BrowserAccessibilityPressSystem: AnyObject {
  func accessibilityTrusted() -> Bool
  func postEventAccessPermitted() -> Bool
  func applicationIsActive(processID: Int32) -> Bool
  func frontmostProcessID() -> Int32?
  func frame(of element: BrowserAccessibilityElementReference) throws -> CGRect
  func displayFrames() throws -> [CGRect]
  func hitTest(at point: CGPoint) throws -> BrowserAccessibilityElementReference
  func processID(of element: BrowserAccessibilityElementReference) throws -> Int32
  func parent(of element: BrowserAccessibilityElementReference) throws
    -> BrowserAccessibilityElementReference?
  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool
  func mouseEvents(at point: CGPoint) -> BrowserAccessibilityMouseEvents?
  func post(_ event: BrowserAccessibilityMouseEvent, to processID: Int32)
}

final class BrowserAccessibilityPressDispatcher {
  private struct Geometry {
    let target: CGRect
    let window: CGRect
    let webArea: CGRect
    let point: CGPoint
  }

  private static let maximumParentDepth = 16
  static let maximumDisplayCount: UInt32 = 32
  private static let maximumCalls = 128
  private static let totalSeconds = 2.0
  private let system: BrowserAccessibilityPressSystem
  private var calls = 0
  private var deadline = 0.0

  init(system: BrowserAccessibilityPressSystem) { self.system = system }

  func press(
    revalidate: () throws -> BrowserAccessibilityPressAuthorization,
    cancelled: () -> Bool
  ) throws {
    calls = 0
    deadline = ProcessInfo.processInfo.systemUptime + Self.totalSeconds
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    let first = try revalidate()
    let firstGeometry = try validate(first)
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    let final = try revalidate()
    guard sameAuthorization(first, final) else { throw BrowserAccessibilityFailure.stale }
    let finalGeometry = try validate(final)
    guard sameGeometry(firstGeometry, finalGeometry) else {
      throw BrowserAccessibilityFailure.stale
    }
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    guard let events = system.mouseEvents(at: finalGeometry.point) else {
      throw BrowserAccessibilityFailure.unavailable
    }
    try check()
    try requireAuthority(final.processID)
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    try checkDeadline()
    system.post(events.down, to: final.processID)
    defer { system.post(events.up, to: final.processID) }
    guard !cancelled() else { throw BrowserAccessibilityFailure.partialUnknown }
  }

  private func validate(_ authorization: BrowserAccessibilityPressAuthorization) throws
    -> Geometry
  {
    guard authorization.processID > 0, !authorization.launchIdentity.isEmpty,
      !authorization.exactURL.isEmpty, !authorization.documentRevision.isEmpty
    else { throw BrowserAccessibilityFailure.unauthorized }
    try requireAuthority(authorization.processID)
    let target = try checked { try system.frame(of: authorization.target) }
    let window = try checked { try system.frame(of: authorization.window) }
    let webArea = try checked { try system.frame(of: authorization.webArea) }
    guard validFrame(target), validFrame(window), validFrame(webArea) else {
      throw BrowserAccessibilityFailure.unavailable
    }
    let visible = target.intersection(window).intersection(webArea)
    guard validFrame(visible) else { throw BrowserAccessibilityFailure.unavailable }
    let displays = try checked { try system.displayFrames() }
    guard !displays.isEmpty, displays.count <= Int(Self.maximumDisplayCount),
      displays.allSatisfy(validFrame)
    else { throw BrowserAccessibilityFailure.unavailable }
    let visibleDisplays = displays.map { visible.intersection($0) }.filter(validFrame)
    guard visibleDisplays.count == 1, let visibleTarget = visibleDisplays.first else {
      throw BrowserAccessibilityFailure.ambiguous
    }
    let point = CGPoint(x: visibleTarget.midX, y: visibleTarget.midY)
    guard point.x.isFinite, point.y.isFinite else {
      throw BrowserAccessibilityFailure.unavailable
    }
    let hit = try checked { try system.hitTest(at: point) }
    guard try belongsToTarget(
      hit, target: authorization.target, processID: authorization.processID)
    else { throw BrowserAccessibilityFailure.unauthorized }
    return Geometry(target: target, window: window, webArea: webArea, point: point)
  }

  private func belongsToTarget(
    _ hit: BrowserAccessibilityElementReference,
    target: BrowserAccessibilityElementReference,
    processID: Int32
  ) throws -> Bool {
    guard try checked({ try system.processID(of: target) }) == processID else { return false }
    var element = hit
    for depth in 0...Self.maximumParentDepth {
      guard try checked({ try system.processID(of: element) }) == processID else { return false }
      if system.same(element, target) { return true }
      guard depth < Self.maximumParentDepth,
        let parent = try checked({ try system.parent(of: element) })
      else { return false }
      element = parent
    }
    return false
  }

  private func requireAuthority(_ processID: Int32) throws {
    try check()
    guard system.accessibilityTrusted(), system.postEventAccessPermitted(),
      system.applicationIsActive(processID: processID),
      system.frontmostProcessID() == processID
    else { throw BrowserAccessibilityFailure.unauthorized }
    try checkDeadline()
  }

  private func sameAuthorization(
    _ first: BrowserAccessibilityPressAuthorization,
    _ second: BrowserAccessibilityPressAuthorization
  ) -> Bool {
    first.browser == second.browser && first.processID == second.processID
      && first.launchIdentity == second.launchIdentity && first.exactURL == second.exactURL
      && first.documentRevision == second.documentRevision
      && system.same(first.window, second.window) && system.same(first.webArea, second.webArea)
      && system.same(first.target, second.target)
  }

  private func sameGeometry(_ first: Geometry, _ second: Geometry) -> Bool {
    first.target == second.target && first.window == second.window
      && first.webArea == second.webArea && first.point == second.point
  }

  private func validFrame(_ frame: CGRect) -> Bool {
    frame.origin.x.isFinite && frame.origin.y.isFinite && frame.width.isFinite
      && frame.height.isFinite && frame.width > 0 && frame.height > 0
      && !frame.isNull && !frame.isInfinite
  }

  private func checked<T>(_ operation: () throws -> T) throws -> T {
    try check()
    let result = try operation()
    try checkDeadline()
    return result
  }

  private func check() throws {
    calls += 1
    guard calls <= Self.maximumCalls else { throw BrowserAccessibilityFailure.deadline }
    try checkDeadline()
  }

  private func checkDeadline() throws {
    guard ProcessInfo.processInfo.systemUptime <= deadline else {
      throw BrowserAccessibilityFailure.deadline
    }
  }
}

final class MacBrowserAccessibilityPressSystem: BrowserAccessibilityPressSystem {
  private static let timeout: Float = 0.1

  func accessibilityTrusted() -> Bool { AXIsProcessTrusted() }
  func postEventAccessPermitted() -> Bool { CGPreflightPostEventAccess() }

  func applicationIsActive(processID: Int32) -> Bool {
    NSRunningApplication(processIdentifier: processID)?.isActive == true
  }

  func frontmostProcessID() -> Int32? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
  }

  func frame(of element: BrowserAccessibilityElementReference) throws -> CGRect {
    let position = try axValue(element, attribute: kAXPositionAttribute, type: .cgPoint)
    let size = try axValue(element, attribute: kAXSizeAttribute, type: .cgSize)
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point),
      AXValueGetValue(size, .cgSize, &dimensions)
    else { throw BrowserAccessibilityFailure.unavailable }
    return CGRect(origin: point, size: dimensions)
  }

  func displayFrames() throws -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0,
      count <= BrowserAccessibilityPressDispatcher.maximumDisplayCount
    else { throw BrowserAccessibilityFailure.unavailable }
    var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
    var finalCount: UInt32 = 0
    guard CGGetActiveDisplayList(count, &displays, &finalCount) == .success,
      finalCount == count
    else { throw BrowserAccessibilityFailure.unavailable }
    return displays.map(CGDisplayBounds)
  }

  func hitTest(at point: CGPoint) throws -> BrowserAccessibilityElementReference {
    let systemWide = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(systemWide, Self.timeout)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
      systemWide, Float(point.x), Float(point.y), &hit) == .success, let hit
    else { throw BrowserAccessibilityFailure.unavailable }
    AXUIElementSetMessagingTimeout(hit, Self.timeout)
    return BrowserAccessibilityElementReference(hit)
  }

  func processID(of element: BrowserAccessibilityElementReference) throws -> Int32 {
    let target = try axElement(element)
    var processID: pid_t = 0
    guard AXUIElementGetPid(target, &processID) == .success, processID > 0 else {
      throw BrowserAccessibilityFailure.unavailable
    }
    return processID
  }

  func parent(of element: BrowserAccessibilityElementReference) throws
    -> BrowserAccessibilityElementReference?
  {
    let target = try axElement(element)
    var raw: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(target, kAXParentAttribute as CFString, &raw)
    if status == .noValue || status == .attributeUnsupported { return nil }
    guard status == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.unavailable
    }
    let parent = raw as! AXUIElement
    AXUIElementSetMessagingTimeout(parent, Self.timeout)
    return BrowserAccessibilityElementReference(parent)
  }

  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool { CFEqual(first.value, second.value) }

  func mouseEvents(at point: CGPoint) -> BrowserAccessibilityMouseEvents? {
    guard let source = CGEventSource(stateID: .privateState),
      let down = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseDown,
        mouseCursorPosition: point, mouseButton: .left),
      let up = CGEvent(
        mouseEventSource: source, mouseType: .leftMouseUp,
        mouseCursorPosition: point, mouseButton: .left)
    else { return nil }
    down.flags = []
    up.flags = []
    down.setIntegerValueField(.mouseEventClickState, value: 1)
    up.setIntegerValueField(.mouseEventClickState, value: 1)
    return BrowserAccessibilityMouseEvents(
      down: BrowserAccessibilityMouseEvent(down), up: BrowserAccessibilityMouseEvent(up))
  }

  func post(_ event: BrowserAccessibilityMouseEvent, to processID: Int32) {
    (event.value as! CGEvent).postToPid(processID)
  }

  private func axElement(_ reference: BrowserAccessibilityElementReference) throws -> AXUIElement {
    guard CFGetTypeID(reference.value) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.invalid
    }
    let element = reference.value as! AXUIElement
    AXUIElementSetMessagingTimeout(element, Self.timeout)
    return element
  }

  private func axValue(
    _ reference: BrowserAccessibilityElementReference, attribute: String,
    type: AXValueType
  ) throws -> AXValue {
    let element = try axElement(reference)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
      let raw, CFGetTypeID(raw) == AXValueGetTypeID()
    else { throw BrowserAccessibilityFailure.unavailable }
    let value = raw as! AXValue
    guard AXValueGetType(value) == type else { throw BrowserAccessibilityFailure.unavailable }
    return value
  }
}

final class MacBrowserAccessibilityBackend: BrowserAccessibilityBackend {
  private static let timeout: Float = 0.25
  private static let totalSeconds = 4.0
  private var calls = 0
  private var deadline = 0.0
  private let pressDispatcher: BrowserAccessibilityPressDispatcher

  init(pressSystem: BrowserAccessibilityPressSystem = MacBrowserAccessibilityPressSystem()) {
    pressDispatcher = BrowserAccessibilityPressDispatcher(system: pressSystem)
  }

  // The process ID must be derived from the trusted native-host/browser connection. It must
  // never come from a phone or network request. This verifies that supplied process, but the
  // future bridge still owns browser-parent, focused-window, and authorized-page correlation.

  func snapshot(browser: BrowserAccessibilityBrowser, processID: Int32) throws
    -> BrowserAccessibilitySnapshot
  {
    guard AXIsProcessTrusted() else { throw BrowserAccessibilityFailure.unauthorized }
    calls = 0
    deadline = ProcessInfo.processInfo.systemUptime + Self.totalSeconds
    guard let app = NSRunningApplication(processIdentifier: processID), !app.isTerminated,
      app.bundleIdentifier == browser.bundleIdentifier, let launched = app.launchDate,
      let executableURL = app.executableURL?.standardizedFileURL
    else { throw BrowserAccessibilityFailure.unauthorized }
    _ = try verifyRunningBrowser(
      app, browser: browser, processID: processID, executableURL: executableURL)
    let executable = executableURL.path
    let application = AXUIElementCreateApplication(processID)
    AXUIElementSetMessagingTimeout(application, Self.timeout)
    guard let window = try element(application, kAXFocusedWindowAttribute) else {
      throw BrowserAccessibilityFailure.unavailable
    }
    AXUIElementSetMessagingTimeout(window, Self.timeout)
    var nodes: [BrowserAccessibilityNode] = []
    var visited: [AXUIElement] = []
    try walk(
      window, browser: browser, depth: 0, path: [], insideWebArea: false, nodes: &nodes,
      visited: &visited)
    let webAreas = nodes.filter { $0.kind == .webArea }
    let addresses = nodes.filter { $0.kind == .address }
    guard webAreas.count == 1, addresses.count == 1, let webArea = webAreas.first,
      let address = addresses.first, let exactURL = webArea.value
    else { throw BrowserAccessibilityFailure.ambiguous }
    let title = try string(window, kAXTitleAttribute)
    return BrowserAccessibilitySnapshot(
      browser: browser, processID: processID,
      launchIdentity: "\(processID):\(launched.timeIntervalSinceReferenceDate):\(executable)",
      exactURL: exactURL, window: BrowserAccessibilityElementReference(window),
      webArea: webArea.reference, address: address.reference, title: title, nodes: nodes)
  }

  func browserProcessIdentity(
    browser: BrowserAccessibilityBrowser, processID: Int32
  ) throws -> BrowserProcessIdentity {
    guard let app = NSRunningApplication(processIdentifier: processID), !app.isTerminated,
      app.bundleIdentifier == browser.bundleIdentifier,
      let executableURL = app.executableURL?.standardizedFileURL,
      let (seconds, microseconds) = browserProcessStartIdentity(processID)
    else { throw BrowserAccessibilityFailure.unauthorized }
    let codeHash = try verifyRunningBrowser(app, browser: browser, processID: processID,
      executableURL: executableURL)
    guard codeHash.count == 20 || codeHash.count == 32,
      let finalStart = browserProcessStartIdentity(processID), finalStart.0 == seconds,
      finalStart.1 == microseconds
    else { throw BrowserAccessibilityFailure.unauthorized }
    return BrowserProcessIdentity(
      processID: processID, startSeconds: seconds, startMicroseconds: microseconds,
      codeHash: codeHash)
  }

  func verifyBrowserProcess(browser: BrowserAccessibilityBrowser, processID: Int32) throws {
    _ = try browserProcessIdentity(browser: browser, processID: processID)
  }

  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool {
    CFEqual(first.value, second.value)
  }

  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws {
    guard CFGetTypeID(element.value) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.invalid
    }
    let target = element.value as! AXUIElement
    try check()
    guard AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, value as CFString)
      == .success
    else { throw BrowserAccessibilityFailure.unavailable }
  }

  func value(on element: BrowserAccessibilityElementReference) throws -> String? {
    guard CFGetTypeID(element.value) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.invalid
    }
    return try string(element.value as! AXUIElement, kAXValueAttribute)
  }

  func press(
    revalidate: () throws -> BrowserAccessibilityPressAuthorization,
    cancelled: () -> Bool
  ) throws {
    try pressDispatcher.press(revalidate: revalidate, cancelled: cancelled)
  }

  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws {
    guard CFGetTypeID(element.value) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.invalid
    }
    let target = element.value as! AXUIElement
    let name: String
    switch action {
    case "confirm": name = kAXConfirmAction
    case "scroll-up": name = "AXScrollUpByPage"
    case "scroll-down": name = "AXScrollDownByPage"
    case "scroll-left": name = "AXScrollLeftByPage"
    case "scroll-right": name = "AXScrollRightByPage"
    default: throw BrowserAccessibilityFailure.invalid
    }
    try check()
    guard AXUIElementPerformAction(target, name as CFString) == .success else {
      throw BrowserAccessibilityFailure.unavailable
    }
  }

  private func walk(
    _ element: AXUIElement, browser: BrowserAccessibilityBrowser, depth: Int, path: [Int],
    insideWebArea: Bool,
    nodes: inout [BrowserAccessibilityNode], visited: inout [AXUIElement]
  ) throws {
    guard BrowserAccessibilityTraversalLimits.permitsElement(
      count: visited.count + 1, depth: depth)
    else {
      throw BrowserAccessibilityFailure.unavailable
    }
    guard !visited.contains(where: { CFEqual($0, element) }) else {
      throw BrowserAccessibilityFailure.ambiguous
    }
    visited.append(element)
    AXUIElementSetMessagingTimeout(element, Self.timeout)
    let role = try string(element, kAXRoleAttribute)
    // A dialog in the selected window can intercept an otherwise available web-area scroll.
    guard !browserAccessibilityModallyBlockedRole(role) else {
      throw BrowserAccessibilityFailure.unavailable
    }
    let webArea = role == "AXWebArea"
    let addressCandidate = !insideWebArea && browserAccessibilityAddressCandidate(
      role: role, browser: browser)
    let labeledContent = insideWebArea
      && (role == "AXSearchField" || role == kAXTextFieldRole || role == "AXTextArea"
        || role == "AXLink" || role == kAXButtonRole || role == kAXStaticTextRole)
    let needsLabel = labeledContent || (addressCandidate && browser == .safari)
    let label = needsLabel
      ? try string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute) : nil
    let identifier = addressCandidate && browser == .arc
      ? try string(element, kAXIdentifierAttribute) : nil
    let placeholder = addressCandidate && browser == .arc
      ? try string(element, kAXPlaceholderValueAttribute) : nil
    let kind = browserAccessibilityNodeKind(
      role: role, browser: browser, label: label, identifier: identifier,
      placeholder: placeholder, insideWebArea: insideWebArea)
    let enabled = kind == .search || kind == .link || kind == .button
      ? (try boolean(element, kAXEnabledAttribute)) ?? false : false
    let actionNames: Set<String>
    switch kind {
    case .webArea, .link, .button, .scrollArea:
      actionNames = try actions(element, includeSetValue: false)
    case .search:
      actionNames = try actions(element, includeSetValue: true)
    default:
      actionNames = []
    }
    let rawURL = kind == .webArea || kind == .link
      ? try raw(element, kAXURLAttribute) : nil
    if let node = browserAccessibilityProjectNode(
      reference: BrowserAccessibilityElementReference(element), role: role, browser: browser,
      label: label, enabled: enabled, path: path, actions: actionNames,
      identifier: identifier, placeholder: placeholder, rawURL: rawURL,
      insideWebArea: insideWebArea)
    {
      guard BrowserAccessibilityTraversalLimits.permitsNode(count: nodes.count + 1) else {
        throw BrowserAccessibilityFailure.unavailable
      }
      nodes.append(
        node)
    }
    let children = try elements(element, kAXChildrenAttribute)
    for (index, child) in children.enumerated() {
      try walk(
        child, browser: browser, depth: depth + 1, path: path + [index],
        insideWebArea: insideWebArea || webArea, nodes: &nodes, visited: &visited)
    }
  }

  private func check() throws {
    calls += 1
    guard BrowserAccessibilityTraversalLimits.permitsCall(count: calls),
      ProcessInfo.processInfo.systemUptime <= deadline
    else {
      throw BrowserAccessibilityFailure.deadline
    }
  }

  private func verifyRunningBrowser(
    _ app: NSRunningApplication, browser: BrowserAccessibilityBrowser, processID: Int32,
    executableURL: URL
  ) throws -> Data {
    let requirementText: String
    switch browser {
    case .safari:
      requirementText = #"identifier "com.apple.Safari" and anchor apple"#
    case .arc:
      requirementText = #"anchor apple generic and identifier "company.thebrowser.Browser" and (certificate leaf[field.1.2.840.113635.100.6.1.9] exists or certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "S6N382Y83G")"#
    }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
      let requirement
    else { throw BrowserAccessibilityFailure.unauthorized }
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: processID)] as CFDictionary
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else {
      throw BrowserAccessibilityFailure.unauthorized
    }
    let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
    guard SecCodeCheckValidityWithErrors(code, [], requirement, nil) == errSecSuccess else {
      throw BrowserAccessibilityFailure.unauthorized
    }
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(executableURL as CFURL, [], &staticCode) == errSecSuccess,
      let staticCode,
      SecStaticCodeCheckValidityWithErrors(staticCode, flags, requirement, nil) == errSecSuccess
    else { throw BrowserAccessibilityFailure.unauthorized }
    var information: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information)
      == errSecSuccess, let values = information as? [String: Any],
      values[kSecCodeInfoIdentifier as String] as? String == browser.bundleIdentifier,
      let signedExecutable = values[kSecCodeInfoMainExecutable as String] as? URL,
      signedExecutable.standardizedFileURL == executableURL,
      let codeHash = values[kSecCodeInfoUnique as String] as? Data
    else { throw BrowserAccessibilityFailure.unauthorized }
    if browser == .arc {
      guard values[kSecCodeInfoTeamIdentifier as String] as? String == "S6N382Y83G" else {
        throw BrowserAccessibilityFailure.unauthorized
      }
    }
    guard app.executableURL?.standardizedFileURL == executableURL else {
      throw BrowserAccessibilityFailure.unauthorized
    }
    return codeHash
  }

  private func raw(_ element: AXUIElement, _ attribute: String) throws -> CFTypeRef? {
    try check()
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if status == .noValue || status == .attributeUnsupported { return nil }
    guard status == .success else { throw BrowserAccessibilityFailure.unavailable }
    return value
  }

  private func element(_ element: AXUIElement, _ attribute: String) throws -> AXUIElement? {
    guard let value = try raw(element, attribute), CFGetTypeID(value) == AXUIElementGetTypeID()
    else { return nil }
    return (value as! AXUIElement)
  }

  private func elements(_ element: AXUIElement, _ attribute: String) throws -> [AXUIElement] {
    guard let value = try raw(element, attribute) else { return [] }
    guard let values = value as? [Any],
      BrowserAccessibilityTraversalLimits.permitsChildren(count: values.count)
    else {
      throw BrowserAccessibilityFailure.unavailable
    }
    var result: [AXUIElement] = []
    for value in values {
      guard CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else {
        throw BrowserAccessibilityFailure.unavailable
      }
      result.append(value as! AXUIElement)
    }
    return result
  }

  private func string(_ element: AXUIElement, _ attribute: String) throws -> String? {
    guard let value = try raw(element, attribute) else { return nil }
    guard let result = value as? String, result.utf8.count <= 2_048,
      !result.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
    else { throw BrowserAccessibilityFailure.unavailable }
    return result
  }

  private func boolean(_ element: AXUIElement, _ attribute: String) throws -> Bool? {
    guard let value = try raw(element, attribute) else { return nil }
    guard CFGetTypeID(value) == CFBooleanGetTypeID() else {
      throw BrowserAccessibilityFailure.unavailable
    }
    return CFBooleanGetValue((value as! CFBoolean))
  }

  private func actions(_ element: AXUIElement, includeSetValue: Bool) throws -> Set<String> {
    try check()
    var names: CFArray?
    let status = AXUIElementCopyActionNames(element, &names)
    if status == .actionUnsupported { return [] }
    guard status == .success, let values = names as? [String], values.count <= 32 else {
      throw BrowserAccessibilityFailure.unavailable
    }
    var result = Set<String>()
    for value in values {
      switch value {
      case kAXPressAction: result.insert("press")
      case kAXConfirmAction: result.insert("confirm")
      case "AXScrollUpByPage": result.insert("scroll-up")
      case "AXScrollDownByPage": result.insert("scroll-down")
      case "AXScrollLeftByPage": result.insert("scroll-left")
      case "AXScrollRightByPage": result.insert("scroll-right")
      default: break
      }
    }
    if includeSetValue, try settable(element, kAXValueAttribute) { result.insert("set-value") }
    return result
  }

  private func settable(_ element: AXUIElement, _ attribute: String) throws -> Bool {
    try check()
    var value: DarwinBoolean = false
    let status = AXUIElementIsAttributeSettable(element, attribute as CFString, &value)
    if status == .attributeUnsupported { return false }
    guard status == .success else { throw BrowserAccessibilityFailure.unavailable }
    return value.boolValue
  }
}

func browserAccessibilityModallyBlockedRole(_ role: String?) -> Bool {
  role == "AXDialog" || role == "AXSheet" || role == "AXAlert"
}

func browserAccessibilityAddressCandidate(
  role: String?, browser: BrowserAccessibilityBrowser
) -> Bool {
  switch browser {
  case .safari:
    role == kAXTextFieldRole || role == kAXComboBoxRole
  case .arc:
    role == kAXStaticTextRole || role == kAXTextFieldRole
  }
}

func browserAccessibilityNodeKind(
  role: String?, browser: BrowserAccessibilityBrowser, label: String?, identifier: String?,
  placeholder: String?, insideWebArea: Bool
) -> BrowserAccessibilityNode.Kind? {
  if role == "AXWebArea" { return .webArea }
  if !insideWebArea,
    browserAccessibilityAddressRole(
      role: role, browser: browser, label: label, identifier: identifier,
      placeholder: placeholder)
  {
    return .address
  }
  guard insideWebArea else { return nil }
  switch role {
  case "AXSearchField", kAXTextFieldRole, "AXTextArea": return .search
  case "AXLink": return .link
  case kAXButtonRole: return .button
  case kAXStaticTextRole: return .text
  case kAXScrollAreaRole: return .scrollArea
  default: return nil
  }
}

func browserAccessibilityProjectNode(
  reference: BrowserAccessibilityElementReference, role: String?,
  browser: BrowserAccessibilityBrowser, label: String?, enabled: Bool, path: [Int],
  actions: Set<String>, identifier: String?, placeholder: String?, rawURL: Any?,
  insideWebArea: Bool
) -> BrowserAccessibilityNode? {
  guard let kind = browserAccessibilityNodeKind(
    role: role, browser: browser, label: label, identifier: identifier,
    placeholder: placeholder, insideWebArea: insideWebArea)
  else { return nil }
  let value: String?
  if kind == .webArea || kind == .link, let rawURL {
    value = browserAccessibilityCanonicalPageURL(rawURL)
  } else {
    value = nil
  }
  return BrowserAccessibilityNode(
    reference: reference, kind: kind, label: label, value: value, enabled: enabled,
    path: path, actions: actions)
}

func browserAccessibilityAddressRole(
  role: String?, browser: BrowserAccessibilityBrowser, label: String?, identifier: String?,
  placeholder: String?
) -> Bool {
  switch browser {
  case .safari:
    return (role == kAXTextFieldRole || role == kAXComboBoxRole) && label == "Smart Search Field"
  case .arc:
    guard placeholder == "Search or Enter URL…" else { return false }
    return (role == kAXStaticTextRole && identifier == "commandBarPlaceholderTextField")
      || (role == kAXTextFieldRole && identifier == "commandBarTextField")
  }
}

func browserAccessibilityCanonicalPageURL(_ value: Any) -> String? {
  let text: String
  if let value = value as? URL { text = value.absoluteString }
  else if let value = value as? NSURL { text = value.absoluteString ?? "" }
  else if let value = value as? String { text = value }
  else { return nil }
  guard text.utf8.count <= 2_048, let url = URL(string: text), url.scheme == "https",
    url.host != nil, url.user == nil, url.password == nil, url.fragment == nil,
    url.absoluteString == text
  else { return nil }
  return text
}
