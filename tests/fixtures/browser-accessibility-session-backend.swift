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
    var nodes = [
      BrowserAccessibilityNode(reference: web, kind: .webArea, label: nil, value: nil,
        enabled: true, path: [0], actions: ["scroll-down", "scroll-right"]),
      BrowserAccessibilityNode(reference: search, kind: .search, label: "Search", value: nil,
        enabled: true, path: [0, 0], actions: ["set-value", "confirm"]),
      BrowserAccessibilityNode(reference: video, kind: .link, label: "Earth from space",
        value: "https://www.youtube.com/watch?v=abcdefghijk", enabled: true,
        path: [0, 1], actions: ["press"]),
    ]
    #if ELLIE_AX_LARGE_SUMMARY
    nodes += (0..<20).map { index in
      BrowserAccessibilityNode(reference: BrowserAccessibilityElementReference(SessionToken()),
        kind: .text, label: String(repeating: "🌙", count: 200), value: nil,
        enabled: false, path: [0, index + 2], actions: [])
    }
    #endif
    #if ELLIE_AX_LARGE_ITEMS
    nodes += (0..<64).map { index in
      BrowserAccessibilityNode(reference: BrowserAccessibilityElementReference(SessionToken()),
        kind: .link, label: String(format: "Video %02d ", index)
          + String(repeating: "\"\\", count: 120) + "x",
        value: "https://www.youtube.com/watch?v=" + String(format: "%011d", index),
        enabled: true, path: [0, index + 2], actions: ["press"])
    }
    #endif
    return BrowserAccessibilitySnapshot(
      browser: .arc, processID: processID, launchIdentity: "fixture-launch",
      exactURL: "https://www.youtube.com/watch?v=iTHUUjTA-LI", window: window,
      webArea: web, address: address, title: "NASA Earth", nodes: nodes)
  }
  func same(_ first: BrowserAccessibilityElementReference,
    _ second: BrowserAccessibilityElementReference) -> Bool { first.isSameObject(as: second) }
  func setValue(_ value: String, on element: BrowserAccessibilityElementReference) throws {}
  func press(
    revalidate: () throws -> BrowserAccessibilityPressAuthorization,
    cancelled: () -> Bool
  ) throws {
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    _ = try revalidate()
    guard !cancelled() else { throw BrowserAccessibilityFailure.cancelled }
    _ = try revalidate()
  }
  func perform(_ action: String, on element: BrowserAccessibilityElementReference) throws {}
}

func browserAccessibilitySessionTestBackend() -> BrowserAccessibilityBackend { SessionBackend() }
