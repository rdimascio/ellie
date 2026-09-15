import AppKit
import ApplicationServices
import Foundation
import Security

enum BrowserAccessibilityFailure: Error, Equatable {
  case unavailable, unauthorized, ambiguous, stale, invalid, cancelled, deadline
  case partialUnknown
}

enum BrowserAccessibilityBrowser: String, Sendable {
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

struct BrowserAccessibilityItem: Equatable, Sendable {
  let id: String
  let label: String
}

struct BrowserAccessibilityObservation: Equatable, Sendable {
  let generation: String
  let documentRevision: String
  let title: String?
  let summary: String?
  let items: [BrowserAccessibilityItem]
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

protocol BrowserAccessibilityBackend: AnyObject {
  func snapshot(browser: BrowserAccessibilityBrowser, processID: Int32) throws
    -> BrowserAccessibilitySnapshot
  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool
  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws
  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws
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

  private static let maximumQueryUTF16 = 200
  private static let maximumTextBytes = 8_192
  private static let maximumItems = 64
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
    var items: [BrowserAccessibilityItem] = []
    var retained: [String: BrowserAccessibilityNode] = [:]
    var text: [String] = []
    var textBytes = 0
    for node in snapshot.nodes {
      if node.kind == .text, let label = node.label, !label.isEmpty {
        let size = label.utf8.count + (text.isEmpty ? 0 : 1)
        if textBytes + size <= Self.maximumTextBytes {
          text.append(label)
          textBytes += size
        }
      }
      guard items.count < Self.maximumItems,
        (node.kind == .link || node.kind == .button), node.enabled,
        let label = node.label, validLabel(label), node.actions.contains("press")
      else { continue }
      let id = UUID().uuidString.lowercased()
      items.append(BrowserAccessibilityItem(id: id, label: label))
      retained[id] = node
    }
    let generation = UUID().uuidString.lowercased()
    observed = Observed(generation: generation, page: page, items: retained)
    return BrowserAccessibilityObservation(
      generation: generation, documentRevision: page.documentRevision,
      title: snapshot.title.flatMap { validLabel($0) ? $0 : nil },
      summary: text.isEmpty ? nil : text.joined(separator: " "), items: items)
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
      let candidates = snapshot.nodes.filter {
        $0.kind == .search && $0.enabled && $0.actions.contains("set-value")
          && $0.actions.contains("confirm")
      }
      guard candidates.count == 1, let field = candidates.first else {
        throw BrowserAccessibilityFailure.ambiguous
      }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do { try backend.setValue(query, on: field.reference) }
      catch { return outcome(.search, .unknown, page) }
      do {
        guard !cancelled() else { throw BrowserAccessibilityFailure.partialUnknown }
        let afterSet = try rebound(page)
        guard let reboundField = uniqueRebind(field, in: afterSet.nodes) else {
          throw BrowserAccessibilityFailure.partialUnknown
        }
        try backend.perform("confirm", on: reboundField.reference)
        return outcome(.search, .dispatchedUnverified, page)
      } catch {
        return outcome(.search, .unknown, page)
      }
    case .select(let itemID, _, _):
      guard let item = observed.items[itemID], let reboundItem = uniqueRebind(item, in: snapshot.nodes)
      else { throw BrowserAccessibilityFailure.stale }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do { try backend.perform("press", on: reboundItem.reference) }
      catch { return outcome(.select, .unknown, page) }
      return outcome(.select, .dispatchedUnverified, page)
    case .playback(let playback, _, _):
      let candidates = snapshot.nodes.filter {
        $0.kind == .button && $0.enabled && $0.actions.contains("press")
          && $0.label?.lowercased() == playback.rawValue
      }
      guard candidates.count == 1, let control = candidates.first else {
        throw BrowserAccessibilityFailure.ambiguous
      }
      guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
      do { try backend.perform("press", on: control.reference) }
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
        && $0.enabled && $0.actions == prior.actions && backend.same($0.reference, prior.reference)
    }
    return matches.count == 1 ? matches[0] : nil
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
    !value.isEmpty && value.utf16.count <= 256 && value.utf8.count <= 1_024
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }
}

final class MacBrowserAccessibilityBackend: BrowserAccessibilityBackend {
  private static let maximumNodes = 256
  private static let maximumDepth = 8
  private static let maximumCalls = 512
  private static let timeout: Float = 0.25
  private static let totalSeconds = 2.0
  private var calls = 0
  private var deadline = 0.0

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
    try verifyRunningBrowser(app, browser: browser, processID: processID, executableURL: executableURL)
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

  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws {
    guard CFGetTypeID(element.value) == AXUIElementGetTypeID() else {
      throw BrowserAccessibilityFailure.invalid
    }
    let target = element.value as! AXUIElement
    let name: String
    switch action {
    case "press": name = kAXPressAction
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
    guard depth <= Self.maximumDepth, nodes.count < Self.maximumNodes else {
      throw BrowserAccessibilityFailure.unavailable
    }
    guard !visited.contains(where: { CFEqual($0, element) }) else {
      throw BrowserAccessibilityFailure.ambiguous
    }
    visited.append(element)
    AXUIElementSetMessagingTimeout(element, Self.timeout)
    let role = try string(element, kAXRoleAttribute)
    let label = try string(element, kAXTitleAttribute) ?? string(element, kAXDescriptionAttribute)
    let enabled = (try boolean(element, kAXEnabledAttribute)) ?? false
    let actionNames = try actions(element)
    let webArea = role == "AXWebArea"
    let identifier = !insideWebArea ? try string(element, kAXIdentifierAttribute) : nil
    let placeholder = !insideWebArea ? try string(element, kAXPlaceholderValueAttribute) : nil
    let isAddress = !insideWebArea
      && browserAccessibilityAddressRole(
        role: role, browser: browser, label: label, identifier: identifier,
        placeholder: placeholder)
    let kind: BrowserAccessibilityNode.Kind?
    if webArea { kind = .webArea }
    else if isAddress { kind = .address }
    else if insideWebArea && (role == "AXSearchField" || role == kAXTextFieldRole) {
      kind = .search
    } else if insideWebArea && role == "AXLink" { kind = .link }
    else if insideWebArea && role == kAXButtonRole { kind = .button }
    else if insideWebArea && role == kAXStaticTextRole { kind = .text }
    else if insideWebArea && role == kAXScrollAreaRole { kind = .scrollArea }
    else { kind = nil }
    if let kind {
      let value = webArea ? try pageURL(element, kAXURLAttribute) : nil
      nodes.append(
        BrowserAccessibilityNode(
          reference: BrowserAccessibilityElementReference(element), kind: kind, label: label,
          value: value, enabled: enabled, path: path, actions: actionNames))
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
    guard calls <= Self.maximumCalls, ProcessInfo.processInfo.systemUptime <= deadline else {
      throw BrowserAccessibilityFailure.deadline
    }
  }

  private func verifyRunningBrowser(
    _ app: NSRunningApplication, browser: BrowserAccessibilityBrowser, processID: Int32,
    executableURL: URL
  ) throws {
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
    guard SecCodeCheckValidityWithErrors(code, flags, requirement, nil) == errSecSuccess else {
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
      signedExecutable.standardizedFileURL == executableURL
    else { throw BrowserAccessibilityFailure.unauthorized }
    if browser == .arc {
      guard values[kSecCodeInfoTeamIdentifier as String] as? String == "S6N382Y83G" else {
        throw BrowserAccessibilityFailure.unauthorized
      }
    }
    guard app.executableURL?.standardizedFileURL == executableURL else {
      throw BrowserAccessibilityFailure.unauthorized
    }
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
    guard let values = value as? [Any], values.count <= Self.maximumNodes else {
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

  private func pageURL(_ element: AXUIElement, _ attribute: String) throws -> String? {
    guard let value = try raw(element, attribute) else { return nil }
    return browserAccessibilityCanonicalPageURL(value)
  }

  private func boolean(_ element: AXUIElement, _ attribute: String) throws -> Bool? {
    guard let value = try raw(element, attribute) else { return nil }
    guard CFGetTypeID(value) == CFBooleanGetTypeID() else {
      throw BrowserAccessibilityFailure.unavailable
    }
    return CFBooleanGetValue((value as! CFBoolean))
  }

  private func actions(_ element: AXUIElement) throws -> Set<String> {
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
    if try settable(element, kAXValueAttribute) { result.insert("set-value") }
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
