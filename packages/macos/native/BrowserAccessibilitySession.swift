import Darwin
import Foundation

private let maximumFrameBytes = 16_384

private func readChunk() throws -> Data? {
  var bytes = [UInt8](repeating: 0, count: 4_096)
  while true {
    let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
    if count > 0 { return Data(bytes.prefix(count)) }
    if count == 0 { return nil }
    if errno != EINTR { throw BrowserAccessibilityFailure.unavailable }
  }
}

private struct Request: Decodable {
  let id: String
  let type: String
  let nativeHostParentPid: Int32?
  let browserStartSeconds: UInt64?
  let browserStartMicroseconds: UInt64?
  let browserCodeHash: String?
  let exactURL: String?
  let documentRevision: String?
  let sessionID: String?
  let generation: String?
  let operation: String?
  let direction: String?
  let query: String?
  let itemID: String?
  let action: String?
}

private struct Item: Encodable { let id: String; let label: String }
private struct Response: Encodable {
  let id: String
  let status: String
  let sessionID: String?
  let generation: String?
  let documentRevision: String?
  let title: String?
  let summary: String?
  let items: [Item]?
  let operation: String?
}

private final class Session {
  let id = UUID().uuidString.lowercased()
  let page: BrowserAccessibilityAuthorizedPage
  let browser: BrowserAccessibilityBrowser
  let browserIdentity: BrowserProcessIdentity
  init(
    page: BrowserAccessibilityAuthorizedPage, browser: BrowserAccessibilityBrowser,
    browserIdentity: BrowserProcessIdentity
  ) {
    self.page = page
    self.browser = browser
    self.browserIdentity = browserIdentity
  }
}

private func revalidate(_ session: Session) throws {
  #if !ELLIE_AX_TEST_BACKEND
  let current = try MacBrowserAccessibilityBackend().browserProcessIdentity(
    browser: session.browser, processID: session.browserIdentity.processID)
  guard current == session.browserIdentity else { throw BrowserAccessibilityFailure.stale }
  #endif
}

private func parentPID(_ pid: Int32) -> Int32? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size, info.pbi_ppid > 0 else {
    return nil
  }
  return Int32(info.pbi_ppid)
}

private func ancestry(_ initial: Int32) -> [Int32] {
  guard initial > 0 else { return [] }
  var result: [Int32] = []
  var current = initial
  for _ in 0..<6 {
    guard current > 0, !result.contains(current) else { break }
    result.append(current)
    guard let parent = parentPID(current), parent != current else { break }
    current = parent
  }
  return result
}

private func write(_ response: Response) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  let data = try encoder.encode(response)
  guard data.count <= maximumFrameBytes else { throw BrowserAccessibilityFailure.invalid }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

private func decodeRequest(_ data: Data) throws -> Request {
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let type = object["type"] as? String
  else { throw BrowserAccessibilityFailure.invalid }
  let expected: Set<String>
  switch type {
  case "bind": expected = ["id", "type", "nativeHostParentPid", "browserStartSeconds",
    "browserStartMicroseconds", "browserCodeHash", "exactURL", "documentRevision"]
  case "read": expected = ["id", "type", "sessionID"]
  case "perform":
    guard let operation = object["operation"] as? String else {
      throw BrowserAccessibilityFailure.invalid
    }
    switch operation {
    case "scroll": expected = ["id", "type", "sessionID", "generation", "documentRevision", "operation", "direction"]
    case "search": expected = ["id", "type", "sessionID", "generation", "documentRevision", "operation", "query"]
    case "select": expected = ["id", "type", "sessionID", "generation", "documentRevision", "operation", "itemID"]
    case "playback": expected = ["id", "type", "sessionID", "generation", "documentRevision", "operation", "action"]
    default: throw BrowserAccessibilityFailure.invalid
    }
  default: throw BrowserAccessibilityFailure.invalid
  }
  guard Set(object.keys) == expected else { throw BrowserAccessibilityFailure.invalid }
  return try JSONDecoder().decode(Request.self, from: data)
}

@main
enum BrowserAccessibilitySessionMain {
  static func main() {
    #if ELLIE_AX_TEST_BACKEND
    let adapter = BrowserAccessibilityAdapter(backend: browserAccessibilitySessionTestBackend())
    #else
    let adapter = BrowserAccessibilityAdapter()
    #endif
    var session: Session?
    do {
      var pending = Data()
      while let chunk = try readChunk() {
        pending.append(chunk)
        guard pending.count <= maximumFrameBytes else { throw BrowserAccessibilityFailure.invalid }
        while let newline = pending.firstIndex(of: 0x0a) {
          let frame = pending.prefix(upTo: newline)
          pending.removeSubrange(...newline)
          guard !frame.isEmpty, frame.count <= maximumFrameBytes else {
            throw BrowserAccessibilityFailure.invalid
          }
          let request = try decodeRequest(Data(frame))
          guard request.id.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$"#,
            options: .regularExpression) != nil else { throw BrowserAccessibilityFailure.invalid }
          switch request.type {
          case "bind":
            guard session == nil, let candidate = request.nativeHostParentPid,
              let seconds = request.browserStartSeconds,
              let microseconds = request.browserStartMicroseconds, microseconds < 1_000_000,
              let codeHashText = request.browserCodeHash,
              (codeHashText.count == 40 || codeHashText.count == 64),
              codeHashText.range(of: #"^[0-9a-f]+$"#, options: .regularExpression) != nil,
              let codeHash = Data(hexadecimal: codeHashText),
              let url = request.exactURL, let revision = request.documentRevision
            else { throw BrowserAccessibilityFailure.invalid }
            var bound: (
              BrowserAccessibilityAuthorizedPage, BrowserAccessibilityBrowser,
              BrowserProcessIdentity
            )?
            for pid in ancestry(candidate) {
              for browser in [BrowserAccessibilityBrowser.arc, .safari] {
                #if !ELLIE_AX_TEST_BACKEND
                let verifier = MacBrowserAccessibilityBackend()
                guard let identity = try? verifier.browserProcessIdentity(
                  browser: browser, processID: pid),
                  identity.startSeconds == seconds, identity.startMicroseconds == microseconds,
                  identity.codeHash == codeHash
                else { continue }
                #else
                let identity = BrowserProcessIdentity(
                  processID: pid, startSeconds: seconds, startMicroseconds: microseconds,
                  codeHash: codeHash)
                #endif
                if let page = try? adapter.bindAuthorizedPage(
                  browser: browser, processID: pid, exactURL: url, documentRevision: revision)
                {
                  guard bound == nil else { throw BrowserAccessibilityFailure.ambiguous }
                  bound = (page, browser, identity)
                }
              }
            }
            guard let bound else { throw BrowserAccessibilityFailure.unauthorized }
            let created = Session(
              page: bound.0, browser: bound.1, browserIdentity: bound.2)
            session = created
            try write(Response(id: request.id, status: "bound", sessionID: created.id,
              generation: nil, documentRevision: revision, title: nil, summary: nil,
              items: nil, operation: nil))
          case "read":
            guard let current = session, request.sessionID == current.id else {
              throw BrowserAccessibilityFailure.stale
            }
            try revalidate(current)
            let view = try adapter.read(current.page)
            try write(Response(id: request.id, status: "completed", sessionID: current.id,
              generation: view.generation, documentRevision: view.documentRevision,
              title: view.title, summary: view.summary,
              items: view.items.map { Item(id: $0.id, label: $0.label) }, operation: "read"))
          case "perform":
            guard let current = session, request.sessionID == current.id,
              let generation = request.generation, let revision = request.documentRevision,
              let operation = request.operation
            else { throw BrowserAccessibilityFailure.stale }
            try revalidate(current)
            let command: BrowserAccessibilityCommand
            switch operation {
            case "scroll":
              guard let raw = request.direction, let direction = BrowserAccessibilityDirection(rawValue: raw) else {
                throw BrowserAccessibilityFailure.invalid
              }
              command = .scroll(direction, generation: generation, documentRevision: revision)
            case "search":
              guard let query = request.query else { throw BrowserAccessibilityFailure.invalid }
              command = .search(query: query, generation: generation, documentRevision: revision)
            case "select":
              guard let item = request.itemID else { throw BrowserAccessibilityFailure.invalid }
              command = .select(itemID: item, generation: generation, documentRevision: revision)
            case "playback":
              guard let raw = request.action, let action = BrowserAccessibilityPlayback(rawValue: raw) else {
                throw BrowserAccessibilityFailure.invalid
              }
              command = .playback(action, generation: generation, documentRevision: revision)
            default: throw BrowserAccessibilityFailure.invalid
            }
            let outcome = try adapter.perform(command, on: current.page)
            try write(Response(id: request.id, status: outcome.status.rawValue,
              sessionID: current.id, generation: nil,
              documentRevision: outcome.documentRevision, title: nil, summary: nil,
              items: nil, operation: outcome.operation.rawValue))
          default: throw BrowserAccessibilityFailure.invalid
          }
        }
      }
      guard pending.isEmpty else { throw BrowserAccessibilityFailure.invalid }
    } catch {
      // The helper is a private protocol boundary. Never echo AX or parsing details.
      try? write(Response(id: "failure", status: "unavailable", sessionID: nil,
        generation: nil, documentRevision: nil, title: nil, summary: nil, items: nil,
        operation: nil))
      exit(1)
    }
  }
}

private extension Data {
  init?(hexadecimal: String) {
    guard hexadecimal.count.isMultiple(of: 2) else { return nil }
    var bytes: [UInt8] = []
    bytes.reserveCapacity(hexadecimal.count / 2)
    var index = hexadecimal.startIndex
    while index < hexadecimal.endIndex {
      let next = hexadecimal.index(index, offsetBy: 2)
      guard let byte = UInt8(hexadecimal[index..<next], radix: 16) else { return nil }
      bytes.append(byte)
      index = next
    }
    self.init(bytes)
  }
}
