import Foundation
import Darwin

private final class SessionToken: NSObject {}

private final class SessionBackend: BrowserAccessibilityBackend {
  private let window = BrowserAccessibilityElementReference(SessionToken())
  private let web = BrowserAccessibilityElementReference(SessionToken())
  private let address = BrowserAccessibilityElementReference(SessionToken())
  private let search = BrowserAccessibilityElementReference(SessionToken())
  private let video = BrowserAccessibilityElementReference(SessionToken())

  func snapshot(browser: BrowserAccessibilityBrowser, processID: Int32) throws
    -> BrowserAccessibilitySnapshot
  {
    guard processID == getppid() else { throw BrowserAccessibilityFailure.unauthorized }
    return BrowserAccessibilitySnapshot(
      browser: .arc, processID: processID, launchIdentity: "fixture-launch",
      exactURL: "https://www.youtube.com/watch?v=iTHUUjTA-LI", window: window,
      webArea: web, address: address, title: "NASA Earth", nodes: [
        BrowserAccessibilityNode(reference: web, kind: .webArea, label: nil, value: nil,
          enabled: true, path: [0], actions: ["scroll-down", "scroll-right"]),
        BrowserAccessibilityNode(reference: search, kind: .search, label: "Search", value: nil,
          enabled: true, path: [0, 0], actions: ["set-value", "confirm"]),
        BrowserAccessibilityNode(reference: video, kind: .link, label: "Earth from space",
          value: "https://www.youtube.com/watch?v=abcdefghijk", enabled: true,
          path: [0, 1], actions: ["press"]),
      ])
  }
  func same(_ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference) -> Bool { first.isSameObject(as: second) }
  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws {}
  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws {}
}

func browserAccessibilitySessionTestBackend() -> BrowserAccessibilityBackend { SessionBackend() }
