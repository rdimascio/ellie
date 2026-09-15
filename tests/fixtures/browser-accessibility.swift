import Foundation

private final class Token: NSObject {}

private final class MockBackend: BrowserAccessibilityBackend {
  var current: BrowserAccessibilitySnapshot
  var actions: [String] = []
  var afterSet: (() -> Void)?
  var beforeSnapshot: ((Int) -> Void)?
  var snapshotFailure: BrowserAccessibilityFailure?
  var actionFailure = false
  var snapshots = 0

  init(nodes: [BrowserAccessibilityNode] = MockBackend.defaultNodes()) {
    let window = BrowserAccessibilityElementReference(Token())
    let web = nodes.first(where: { $0.kind == .webArea })!.reference
    let address = BrowserAccessibilityElementReference(Token())
    current = BrowserAccessibilitySnapshot(
      browser: .safari, processID: 42, launchIdentity: "launch-1",
      exactURL: "https://media.example.test/catalogue?row=1", window: window, webArea: web,
      address: address, title: "Catalogue", nodes: nodes)
  }

  func snapshot(browser: BrowserAccessibilityBrowser, processID: Int32) throws
    -> BrowserAccessibilitySnapshot
  {
    snapshots += 1
    beforeSnapshot?(snapshots)
    if let snapshotFailure { throw snapshotFailure }
    return current
  }

  func same(
    _ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference
  ) -> Bool { first.isSameObject(as: second) }

  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws {
    actions.append("set:\(value)")
    afterSet?()
  }

  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws {
    actions.append(action)
    if actionFailure { throw BrowserAccessibilityFailure.unavailable }
  }

  static func node(
    _ kind: BrowserAccessibilityNode.Kind, _ label: String?, _ path: [Int],
    _ actions: Set<String>, value: String? = nil, enabled: Bool = true,
    reference: BrowserAccessibilityElementReference = BrowserAccessibilityElementReference(Token())
  ) -> BrowserAccessibilityNode {
    BrowserAccessibilityNode(
      reference: reference, kind: kind, label: label, value: value, enabled: enabled, path: path,
      actions: actions)
  }

  static func defaultNodes() -> [BrowserAccessibilityNode] {
    let web = BrowserAccessibilityElementReference(Token())
    return [
      node(.webArea, "Catalogue", [0], ["scroll-up", "scroll-down"], reference: web),
      node(.text, "Featured titles", [0, 0], []),
      node(.search, "Search", [0, 1], ["set-value", "confirm"]),
      node(.link, "Nature", [0, 2], ["press"], value: "https://www.youtube.com/watch?v=iTHUUjTA-LI&pp=fixture"),
      node(.link, "Disabled", [0, 6], ["press"], enabled: false),
      node(.button, "Play keyboard shortcut k", [0, 3], ["press"]),
      node(.button, "Pause (k)", [0, 4], ["press"]),
    ]
  }

  static func buttonSearchNodes() -> [BrowserAccessibilityNode] {
    defaultNodes().map { node in
      guard node.kind == .search else { return node }
      return MockBackend.node(
        node.kind, node.label, node.path, ["set-value"], value: node.value,
        enabled: node.enabled, reference: node.reference)
    } + [node(.button, "Search", [0, 7], ["press"])]
  }
}

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw NSError(domain: "BrowserAccessibilityFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

private func expectFailure(_ expected: BrowserAccessibilityFailure, _ action: () throws -> Void) throws {
  do {
    try action()
    throw NSError(domain: "BrowserAccessibilityFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "missing failure"])
  } catch let failure as BrowserAccessibilityFailure {
    try expect(failure == expected, "unexpected failure \(failure)")
  }
}

private func bind(_ adapter: BrowserAccessibilityAdapter) throws -> BrowserAccessibilityAuthorizedPage {
  try adapter.bindAuthorizedPage(
    browser: .safari, processID: 42,
    exactURL: "https://media.example.test/catalogue?row=1", documentRevision: "revision-1")
}

private func replacingSearchButton(
  in snapshot: BrowserAccessibilitySnapshot
) -> BrowserAccessibilitySnapshot {
  BrowserAccessibilitySnapshot(
    browser: snapshot.browser, processID: snapshot.processID,
    launchIdentity: snapshot.launchIdentity, exactURL: snapshot.exactURL,
    window: snapshot.window, webArea: snapshot.webArea, address: snapshot.address,
    title: snapshot.title,
    nodes: snapshot.nodes.map { node in
      guard node.kind == .button, node.label == "Search" else { return node }
      return MockBackend.node(
        node.kind, node.label, node.path, node.actions, value: node.value,
        enabled: node.enabled)
    })
}

private func scenario(_ name: String) throws {
  switch name {
  case "read-select-stale":
    let backend = MockBackend()
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    try expect(view.title == "Catalogue", "title")
    try expect(view.summary == "Featured titles", "summary")
    try expect(view.items.map(\.label) == ["Nature"], "items")
    let nature = view.items[0]
    let result = try adapter.perform(
      .select(itemID: nature.id, generation: view.generation, documentRevision: view.documentRevision),
      on: page)
    try expect(result.status == .dispatchedUnverified, "select status")
    try expect(backend.actions == ["press"], "single select dispatch")
    try expectFailure(.stale) {
      _ = try adapter.perform(
        .select(itemID: nature.id, generation: view.generation, documentRevision: view.documentRevision),
        on: page)
    }
    try expect(backend.actions == ["press"], "no replay")
  case "link-url-rebind":
    let backend = MockBackend()
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    let item = view.items[0]
    backend.current = BrowserAccessibilitySnapshot(
      browser: backend.current.browser, processID: backend.current.processID,
      launchIdentity: backend.current.launchIdentity, exactURL: backend.current.exactURL,
      window: backend.current.window, webArea: backend.current.webArea,
      address: backend.current.address, title: backend.current.title,
      nodes: backend.current.nodes.map { node in
        guard node.kind == .link, node.label == "Nature" else { return node }
        return MockBackend.node(
          node.kind, node.label, node.path, node.actions,
          value: "https://www.youtube.com/watch?v=abcdefghijk&pp=fixture",
          enabled: node.enabled, reference: node.reference)
      })
    try expectFailure(.stale) {
      _ = try adapter.perform(
        .select(
          itemID: item.id, generation: view.generation,
          documentRevision: view.documentRevision), on: page)
    }
    try expect(backend.actions.isEmpty, "changed link URL dispatched")
  case "page-rebind":
    let backend = MockBackend()
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    backend.current = BrowserAccessibilitySnapshot(
      browser: backend.current.browser, processID: backend.current.processID,
      launchIdentity: backend.current.launchIdentity,
      exactURL: "https://media.example.test/other", window: backend.current.window,
      webArea: backend.current.webArea, address: backend.current.address,
      title: backend.current.title, nodes: backend.current.nodes)
    try expectFailure(.stale) {
      _ = try adapter.perform(
        .scroll(.down, generation: view.generation, documentRevision: view.documentRevision),
        on: page)
    }
    try expect(backend.actions.isEmpty, "same-origin navigation dispatched")
  case "identity-and-generation":
    let backend = MockBackend()
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let old = try adapter.read(page)
    let fresh = try adapter.read(page)
    try expect(old.generation != fresh.generation, "generation reused")
    try expectFailure(.stale) {
      _ = try adapter.perform(
        .scroll(.down, generation: old.generation, documentRevision: old.documentRevision),
        on: page)
    }
    backend.current = BrowserAccessibilitySnapshot(
      browser: backend.current.browser, processID: backend.current.processID,
      launchIdentity: "launch-2", exactURL: backend.current.exactURL,
      window: backend.current.window, webArea: backend.current.webArea,
      address: backend.current.address, title: backend.current.title, nodes: backend.current.nodes)
    try expectFailure(.stale) {
      _ = try adapter.perform(
        .scroll(.down, generation: fresh.generation, documentRevision: fresh.documentRevision),
        on: page)
    }
    try expect(backend.actions.isEmpty, "reused process dispatched")
  case "cancel-and-bounds":
    let many = [MockBackend.defaultNodes()[0]] + (0..<80).map {
      MockBackend.node(
        .link, "Item \($0)", [0, $0 + 1], ["press"],
        value: "https://www.youtube.com/watch?v=vid\(String(format: "%08d", $0))")
    }
    let backend = MockBackend(nodes: many)
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    try expect(view.items.count == 64, "item bound")
    try expectFailure(.cancelled) {
      _ = try adapter.perform(
        .scroll(.down, generation: view.generation, documentRevision: view.documentRevision),
        on: page, cancelled: { true })
    }
    try expect(backend.actions.isEmpty, "cancel dispatched")
    let captureBackend = MockBackend()
    let captureAdapter = BrowserAccessibilityAdapter(backend: captureBackend)
    let capturePage = try bind(captureAdapter)
    try expectFailure(.cancelled) {
      _ = try captureAdapter.read(capturePage, cancelled: { captureBackend.snapshots >= 2 })
    }
  case "search-partial":
    let backend = MockBackend()
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    backend.afterSet = {
      backend.current = BrowserAccessibilitySnapshot(
        browser: backend.current.browser, processID: backend.current.processID,
        launchIdentity: backend.current.launchIdentity,
        exactURL: "https://media.example.test/search?q=nature", window: backend.current.window,
        webArea: backend.current.webArea, address: backend.current.address,
        title: backend.current.title, nodes: backend.current.nodes)
    }
    let result = try adapter.perform(
      .search(query: "nature", generation: view.generation, documentRevision: view.documentRevision),
      on: page)
    try expect(result.status == .unknown, "partial search was not unknown")
    try expect(backend.actions == ["set:nature"], "partial search replayed")
  case "search-submit-plans":
    let confirmBackend = MockBackend()
    let confirmAdapter = BrowserAccessibilityAdapter(backend: confirmBackend)
    let confirmPage = try bind(confirmAdapter)
    let confirmView = try confirmAdapter.read(confirmPage)
    let confirmResult = try confirmAdapter.perform(
      .search(
        query: "nature", generation: confirmView.generation,
        documentRevision: confirmView.documentRevision), on: confirmPage)
    try expect(confirmResult.status == .dispatchedUnverified, "confirm search status")
    try expect(confirmBackend.actions == ["set:nature", "confirm"], "confirm search chain")

    let buttonBackend = MockBackend(nodes: MockBackend.buttonSearchNodes())
    let buttonAdapter = BrowserAccessibilityAdapter(backend: buttonBackend)
    let buttonPage = try bind(buttonAdapter)
    let buttonView = try buttonAdapter.read(buttonPage)
    let buttonResult = try buttonAdapter.perform(
      .search(
        query: "nature", generation: buttonView.generation,
        documentRevision: buttonView.documentRevision), on: buttonPage)
    try expect(buttonResult.status == .dispatchedUnverified, "button search status")
    try expect(buttonBackend.actions == ["set:nature", "press"], "button search chain")

    let preferredBackend = MockBackend(
      nodes: MockBackend.defaultNodes() + [MockBackend.node(.button, "Search", [0, 7], ["press"])])
    let preferredAdapter = BrowserAccessibilityAdapter(backend: preferredBackend)
    let preferredPage = try bind(preferredAdapter)
    let preferredView = try preferredAdapter.read(preferredPage)
    _ = try preferredAdapter.perform(
      .search(
        query: "nature", generation: preferredView.generation,
        documentRevision: preferredView.documentRevision), on: preferredPage)
    try expect(preferredBackend.actions == ["set:nature", "confirm"], "confirm not preferred")

    let noSubmitNodes = MockBackend.buttonSearchNodes().filter {
      !($0.kind == .button && $0.label == "Search")
    }
    let noSubmitBackend = MockBackend(nodes: noSubmitNodes)
    let noSubmitAdapter = BrowserAccessibilityAdapter(backend: noSubmitBackend)
    let noSubmitPage = try bind(noSubmitAdapter)
    let noSubmitView = try noSubmitAdapter.read(noSubmitPage)
    try expectFailure(.ambiguous) {
      _ = try noSubmitAdapter.perform(
        .search(
          query: "nature", generation: noSubmitView.generation,
          documentRevision: noSubmitView.documentRevision), on: noSubmitPage)
    }
    try expect(noSubmitBackend.actions.isEmpty, "missing submit method mutated field")

    let ambiguousBackend = MockBackend(
      nodes: MockBackend.buttonSearchNodes()
        + [MockBackend.node(.button, "Search", [0, 8], ["press"])])
    let ambiguousAdapter = BrowserAccessibilityAdapter(backend: ambiguousBackend)
    let ambiguousPage = try bind(ambiguousAdapter)
    let ambiguousView = try ambiguousAdapter.read(ambiguousPage)
    try expectFailure(.ambiguous) {
      _ = try ambiguousAdapter.perform(
        .search(
          query: "nature", generation: ambiguousView.generation,
          documentRevision: ambiguousView.documentRevision), on: ambiguousPage)
    }
    try expect(ambiguousBackend.actions.isEmpty, "ambiguous Search buttons mutated field")
  case "search-target-revalidation":
    let beforeBackend = MockBackend(nodes: MockBackend.buttonSearchNodes())
    let beforeAdapter = BrowserAccessibilityAdapter(backend: beforeBackend)
    let beforePage = try bind(beforeAdapter)
    let beforeView = try beforeAdapter.read(beforePage)
    beforeBackend.beforeSnapshot = { count in
      if count == 4 {
        beforeBackend.current = replacingSearchButton(in: beforeBackend.current)
      }
    }
    let beforeResult = try beforeAdapter.perform(
      .search(
        query: "nature", generation: beforeView.generation,
        documentRevision: beforeView.documentRevision), on: beforePage)
    try expect(beforeResult.status == .unknown, "pre-set target change was not unknown")
    try expect(beforeBackend.actions.isEmpty, "pre-set target change mutated field")

    let afterBackend = MockBackend(nodes: MockBackend.buttonSearchNodes())
    let afterAdapter = BrowserAccessibilityAdapter(backend: afterBackend)
    let afterPage = try bind(afterAdapter)
    let afterView = try afterAdapter.read(afterPage)
    afterBackend.afterSet = {
      afterBackend.current = replacingSearchButton(in: afterBackend.current)
    }
    let afterCommand = BrowserAccessibilityCommand.search(
      query: "nature", generation: afterView.generation,
      documentRevision: afterView.documentRevision)
    let afterResult = try afterAdapter.perform(afterCommand, on: afterPage)
    try expect(afterResult.status == .unknown, "post-set target change was not unknown")
    try expect(afterBackend.actions == ["set:nature"], "post-set target change dispatched submit")
    try expectFailure(.stale) {
      _ = try afterAdapter.perform(afterCommand, on: afterPage)
    }
    try expect(afterBackend.actions == ["set:nature"], "unknown search was replayed")
  case "ambiguous-and-playback":
    let nodes = MockBackend.defaultNodes() + [
      MockBackend.node(.button, "Play keyboard shortcut k", [0, 5], ["press"])
    ]
    let backend = MockBackend(nodes: nodes)
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    var view = try adapter.read(page)
    try expectFailure(.ambiguous) {
      _ = try adapter.perform(
        .playback(.play, generation: view.generation, documentRevision: view.documentRevision),
        on: page)
    }
    try expect(backend.actions.isEmpty, "ambiguous playback dispatched")
    backend.current = MockBackend().current
    let reboundPage = try bind(adapter)
    view = try adapter.read(reboundPage)
    let result = try adapter.perform(
      .playback(.pause, generation: view.generation, documentRevision: view.documentRevision),
      on: reboundPage)
    try expect(result.status == .dispatchedUnverified, "playback overclaimed")
    try expect(backend.actions == ["press"], "playback dispatch")
    let failedBackend = MockBackend()
    failedBackend.actionFailure = true
    let failedAdapter = BrowserAccessibilityAdapter(backend: failedBackend)
    let failedPage = try bind(failedAdapter)
    let failedView = try failedAdapter.read(failedPage)
    let uncertain = try failedAdapter.perform(
      .playback(
        .play, generation: failedView.generation, documentRevision: failedView.documentRevision),
      on: failedPage)
    try expect(uncertain.status == .unknown, "failed AX dispatch was replayable")
  case "youtube-item-policy":
    let web = MockBackend.defaultNodes()[0]
    let nodes = [
      web,
      MockBackend.node(
        .link, "Unique video", [0, 1], ["press"],
        value: "https://www.youtube.com/watch?v=abcdefghijk"),
      MockBackend.node(
        .link, "Duplicate video one", [0, 2], ["press"],
        value: "https://www.youtube.com/watch?v=lmnopqrstuv"),
      MockBackend.node(
        .link, "Duplicate video two", [0, 3], ["press"],
        value: "https://www.youtube.com/watch?v=lmnopqrstuv&pp=tracking"),
      MockBackend.node(
        .link, "Wrong host", [0, 4], ["press"],
        value: "https://example.test/watch?v=abcdefghijk"),
      MockBackend.node(
        .link, "Unknown query", [0, 5], ["press"],
        value: "https://www.youtube.com/watch?v=01234567890&list=private"),
      MockBackend.node(.button, "Subscribe", [0, 6], ["press"]),
      MockBackend.node(.button, "Share", [0, 7], ["press"]),
    ]
    let backend = MockBackend(nodes: nodes)
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    try expect(view.items.map(\.label) == ["Unique video"], "unsafe selectable item admitted")
    let result = try adapter.perform(
      .select(
        itemID: view.items[0].id, generation: view.generation,
        documentRevision: view.documentRevision), on: page)
    try expect(result.status == .dispatchedUnverified, "video selection overclaimed")
    try expect(backend.actions == ["press"], "video selection dispatch")
  case "typed-browser-topology":
    try expect(
      browserAccessibilityAddressRole(
        role: "AXStaticText", browser: .arc, label: nil,
        identifier: "commandBarPlaceholderTextField", placeholder: "Search or Enter URL…"),
      "resting Arc chrome rejected")
    try expect(
      browserAccessibilityAddressRole(
        role: "AXTextField", browser: .arc, label: nil,
        identifier: "commandBarTextField", placeholder: "Search or Enter URL…"),
      "focused Arc chrome rejected")
    try expect(
      !browserAccessibilityAddressRole(
        role: "AXStaticText", browser: .arc, label: "example.com", identifier: nil,
        placeholder: nil), "spoofable page text admitted")
    try expect(
      browserAccessibilityCanonicalPageURL("https://example.com/") == "https://example.com/",
      "String URL rejected")
    try expect(
      browserAccessibilityCanonicalPageURL(NSURL(string: "https://example.com/")!)
        == "https://example.com/", "NSURL rejected")
    try expect(browserAccessibilityCanonicalPageURL("example.com") == nil, "scheme inferred")
    try expect(browserAccessibilityCanonicalPageURL(NSNumber(value: 1)) == nil, "numeric URL admitted")
  case "raw-ax-projection":
    let link = browserAccessibilityProjectNode(
      reference: BrowserAccessibilityElementReference(Token()), role: "AXLink", browser: .arc,
      label: "Projected video", enabled: true, path: [0, 2, 4], actions: ["press"],
      identifier: nil, placeholder: nil,
      rawURL: NSURL(string: "https://www.youtube.com/watch?v=abcdefghijk&pp=fixture")!,
      insideWebArea: true)
    try expect(link?.kind == .link, "raw AXLink role not projected")
    try expect(
      link?.value == "https://www.youtube.com/watch?v=abcdefghijk&pp=fixture",
      "raw AXLink URL not projected")
    guard let link else { throw BrowserAccessibilityFailure.unavailable }
    let backend = MockBackend(nodes: [MockBackend.defaultNodes()[0], link])
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    let view = try adapter.read(page)
    try expect(view.items.map(\.label) == ["Projected video"],
      "projected AXLink was not selectable")
    let invalidURL = browserAccessibilityProjectNode(
      reference: BrowserAccessibilityElementReference(Token()), role: "AXLink", browser: .arc,
      label: "Invalid URL", enabled: true, path: [0, 2, 5], actions: ["press"],
      identifier: nil, placeholder: nil, rawURL: NSNumber(value: 1), insideWebArea: true)
    try expect(invalidURL?.value == nil, "non-URL AXLink value admitted")
  case "real-tree-bounds":
    try expect(
      BrowserAccessibilityTraversalLimits.permitsElement(count: 960, depth: 10),
      "observed full Arc tree rejected")
    try expect(
      BrowserAccessibilityTraversalLimits.permitsNode(count: 403),
      "observed full Arc projection rejected")
    try expect(
      BrowserAccessibilityTraversalLimits.permitsCall(count: 4_500),
      "bounded optimized reads rejected")
    try expect(
      !BrowserAccessibilityTraversalLimits.permitsElement(count: 1_281, depth: 10),
      "oversized element tree admitted")
    try expect(
      !BrowserAccessibilityTraversalLimits.permitsElement(count: 960, depth: 13),
      "over-depth tree admitted")
    try expect(
      !BrowserAccessibilityTraversalLimits.permitsNode(count: 769),
      "oversized node projection admitted")
    try expect(
      !BrowserAccessibilityTraversalLimits.permitsChildren(count: 513),
      "oversized child list admitted")
    try expect(
      !BrowserAccessibilityTraversalLimits.permitsCall(count: 6_145),
      "over-budget AX reads admitted")
  case "summary-contract-bound":
    let web = MockBackend.defaultNodes()[0]
    let first = String(repeating: "🧭", count: 200)
    let second = String(repeating: "🌎", count: 200)
    let nodes = [web,
      MockBackend.node(.text, first, [0, 1], []),
      MockBackend.node(.text, second, [0, 2], []),
      MockBackend.node(.text, String(repeating: "🌙", count: 200), [0, 3], []),
    ]
    let backend = MockBackend(nodes: nodes)
    let adapter = BrowserAccessibilityAdapter(backend: backend)
    let page = try bind(adapter)
    guard let summary = try adapter.read(page).summary else {
      throw BrowserAccessibilityFailure.unavailable
    }
    try expect(summary == "\(first) \(second)", "bounded Unicode summary changed")
    try expect(summary.utf8.count == 1_601, "summary UTF-8 accounting changed")
    try expect(summary.utf8.count <= 2_000, "summary byte bound exceeded")

    let safeLabel = String(repeating: "🌍", count: 125)
    let oversizedLabel = String(repeating: "🌍", count: 126)
    let labelBackend = MockBackend(nodes: [web,
      MockBackend.node(.link, safeLabel, [0, 4], ["press"],
        value: "https://www.youtube.com/watch?v=abcdefghijk"),
      MockBackend.node(.link, oversizedLabel, [0, 5], ["press"],
        value: "https://www.youtube.com/watch?v=lmnopqrstuv"),
    ])
    labelBackend.current = BrowserAccessibilitySnapshot(
      browser: labelBackend.current.browser, processID: labelBackend.current.processID,
      launchIdentity: labelBackend.current.launchIdentity,
      exactURL: labelBackend.current.exactURL, window: labelBackend.current.window,
      webArea: labelBackend.current.webArea, address: labelBackend.current.address,
      title: oversizedLabel, nodes: labelBackend.current.nodes)
    let labelAdapter = BrowserAccessibilityAdapter(backend: labelBackend)
    let labelPage = try bind(labelAdapter)
    let labelView = try labelAdapter.read(labelPage)
    try expect(labelView.title == nil, "oversized UTF-8 title emitted")
    try expect(labelView.items.map(\.label) == [safeLabel], "oversized UTF-8 item label emitted")
  default:
    throw NSError(domain: "BrowserAccessibilityFixture", code: 3)
  }
}

@main
enum BrowserAccessibilityFixture {
  static func main() {
    do {
      guard CommandLine.arguments.count == 2 else { throw BrowserAccessibilityFailure.invalid }
      try scenario(CommandLine.arguments[1])
      print("passed")
    } catch {
      FileHandle.standardError.write(Data("fixture failed\n".utf8))
      exit(1)
    }
  }
}
