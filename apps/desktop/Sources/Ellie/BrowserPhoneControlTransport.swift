import Foundation

enum BrowserPhoneSource: String, Equatable, Sendable { case webmcp, accessibility, companion }
enum BrowserPhoneCommandStatus: String, Equatable, Sendable {
  case completed, failed, unknown, cancelled, timedOut = "timed_out"
}
struct BrowserPhoneItem: Equatable, Identifiable, Sendable {
  let id: String
  let label: String
  let state: String?
}
enum BrowserPhoneYouTubePage: String, Equatable, Sendable {
  case home, results, browse, watch, login, unsupported
}
enum BrowserPhoneProvider: String, Equatable, Sendable { case youtube, netflix, youtubeTV = "youtube_tv", disneyplus }
enum BrowserPhonePlayback: String, Equatable, Sendable {
  case playing, paused, unavailable, ambiguous
}
struct BrowserPhoneRow: Equatable, Identifiable, Sendable {
  let id: String
  let label: String
}
struct BrowserPhoneSearchControl: Equatable, Sendable {
  let id: String
  let label: String
}
struct BrowserPhoneSite: Equatable, Sendable {
  let provider: BrowserPhoneProvider
  let page: BrowserPhoneYouTubePage
  let playback: BrowserPhonePlayback
  let currentTimeSeconds: Double?
  let horizontalScrollAvailable: Bool?
  let rows: [BrowserPhoneRow]?
  let searchControl: BrowserPhoneSearchControl?

  init(
    provider: BrowserPhoneProvider = .youtube, page: BrowserPhoneYouTubePage,
    playback: BrowserPhonePlayback, currentTimeSeconds: Double?,
    horizontalScrollAvailable: Bool? = nil, rows: [BrowserPhoneRow]? = nil,
    searchControl: BrowserPhoneSearchControl? = nil
  ) {
    self.provider = provider
    self.page = page
    self.playback = playback
    self.currentTimeSeconds = currentTimeSeconds
    self.horizontalScrollAvailable = horizontalScrollAvailable
    self.rows = rows
    self.searchControl = searchControl
  }
}
struct BrowserPhonePage: Equatable, Sendable {
  let nodeID: String
  let source: BrowserPhoneSource
  let revision: String
  let title: String?
  let summary: String?
  let items: [BrowserPhoneItem]
  let site: BrowserPhoneSite?

  init(
    nodeID: String, source: BrowserPhoneSource, revision: String, title: String?,
    summary: String?, items: [BrowserPhoneItem], site: BrowserPhoneSite? = nil
  ) {
    self.nodeID = nodeID
    self.source = source
    self.revision = revision
    self.title = title
    self.summary = summary
    self.items = items
    self.site = site
  }
}
enum BrowserPhoneResponse: Equatable, Sendable {
  case status(source: BrowserPhoneSource, connected: Bool, revision: String?)
  case page(BrowserPhonePage)
  case command(source: BrowserPhoneSource, status: BrowserPhoneCommandStatus, revision: String)
}
enum BrowserPhoneAction: Equatable, Sendable {
  case status
  case refresh
  case read(revision: String)
  case scroll(BrowserScrollDirection, revision: String)
  case scrollRow(String, BrowserScrollDirection, revision: String)
  case search(String, revision: String)
  case select(String, revision: String)
  case playback(BrowserVoiceIntent, revision: String)

  var requiresControl: Bool {
    switch self { case .status, .refresh, .read: false; default: true }
  }

  var isYouTubeAccessibilityControl: Bool {
    switch self { case .scroll, .playback: true; default: false }
  }
}

protocol BrowserPhoneControlTransporting: Sendable {
  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse
}

final class BrowserPhoneControlTransport: BrowserPhoneControlTransporting, @unchecked Sendable {
  private let transport: NativeEnrollmentTransport
  init(transport: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 45)) {
    self.transport = transport
  }

  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    let required = action.requiresControl ? "browser.control" : "browser.read"
    guard credential.client.grants.contains(where: {
      $0.target == nodeID && validNativeCapabilities($0.capabilities)
        && $0.capabilities.contains(required)
    }) else { throw PhoneControlFailure.rejected }
    let body = try JSONSerialization.data(withJSONObject: [
      "nodeId": nodeID, "action": try wireAction(action),
    ])
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await transport.requestEnvelope(
        path: "/native/v1/commands", method: "POST", body: body, bearer: credential.token,
        pending: pending, maximumBytes: 16_384)
    } catch is CancellationError { throw PhoneControlFailure.cancelled } catch let failure
      as NativeEnrollmentFailure
    {
      if failure == .trustFailed { throw PhoneControlFailure.unavailable }
      throw PhoneControlFailure.invalidResponse
    } catch {
      if Task.isCancelled { throw PhoneControlFailure.cancelled }
      throw PhoneControlFailure.unavailable
    }
    return try decodeBrowserPhoneHTTPResult(
      status: response.statusCode, data: data, action: action, nodeID: nodeID)
  }

  private func wireAction(_ action: BrowserPhoneAction) throws -> [String: Any] {
    switch action {
    case .status: return ["tool": "browser.status"]
    case .refresh: return ["tool": "browser.refresh"]
    case .read(let revision):
      guard validBrowserIdentifier(revision) else { throw PhoneControlFailure.rejected }
      return ["tool": "browser.read", "view": "summary", "revision": revision]
    case .scroll(let direction, let revision):
      guard validBrowserIdentifier(revision) else { throw PhoneControlFailure.rejected }
      return ["tool": "browser.scroll", "direction": direction.rawValue, "revision": revision]
    case .scrollRow(let rowID, let direction, let revision):
      guard validBrowserRowID(rowID), validBrowserIdentifier(revision),
        direction == .left || direction == .right
      else { throw PhoneControlFailure.rejected }
      return ["tool": "browser.scrollRow", "direction": direction.rawValue,
        "rowId": rowID, "revision": revision]
    case .search(let query, let revision):
      guard validBrowserIdentifier(revision), validBrowserQuery(query) else {
        throw PhoneControlFailure.rejected
      }
      return ["tool": "browser.search", "query": query, "revision": revision]
    case .select(let itemID, let revision):
      guard validBrowserIdentifier(itemID), validBrowserIdentifier(revision) else {
        throw PhoneControlFailure.rejected
      }
      return ["tool": "browser.select", "itemId": itemID, "revision": revision]
    case .playback(let intent, let revision):
      guard validBrowserIdentifier(revision), intent == .play || intent == .pause else {
        throw PhoneControlFailure.rejected
      }
      return ["tool": "browser.playback", "action": intent == .play ? "play" : "pause", "revision": revision]
    }
  }
}

func decodeBrowserPhoneHTTPResult(
  status: Int, data: Data, action: BrowserPhoneAction, nodeID: String
) throws -> BrowserPhoneResponse {
  if status == 200 { return try decodeBrowserPhoneResponse(data, nodeID: nodeID) }
  if status == 502 {
    if !action.requiresControl { throw PhoneControlFailure.browserObservationUnavailable }
    return .command(source: .webmcp, status: .unknown, revision: revision(action) ?? "unknown")
  }
  if status == 409 && !action.requiresControl && isBrowserReadSettling(data) {
    throw PhoneControlFailure.browserReadSettling
  }
  try requireBrowserStatus(status, data: data)
  throw PhoneControlFailure.invalidResponse
}

func isBrowserReadSettling(_ data: Data) -> Bool {
  guard data.count <= 512,
    let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["error", "code"]),
    object["error"] as? String
      == "A previous browser command is still settling. Wait and read again.",
    object["code"] as? String == "browser_read_settling"
  else { return false }
  return true
}

private func revision(_ action: BrowserPhoneAction) -> String? {
  switch action {
  case .status, .refresh: nil
  case .read(let value), .scroll(_, let value), .scrollRow(_, _, let value), .search(_, let value),
    .select(_, let value), .playback(_, let value): value
  }
}

private func requireBrowserStatus(_ status: Int, data: Data) throws {
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["error"]), let error = object["error"] as? String,
    (1...256).contains(error.utf8.count)
  else { throw PhoneControlFailure.invalidResponse }
  switch status {
  case 401: throw PhoneControlFailure.revoked
  case 400, 403, 404, 409: throw PhoneControlFailure.rejected
  case 503: throw PhoneControlFailure.unavailable
  default: throw PhoneControlFailure.invalidResponse
  }
}

func decodeBrowserPhoneResponse(_ data: Data, nodeID: String) throws -> BrowserPhoneResponse {
  guard data.count <= 16_384,
    let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(root.keys) == Set(["outcome", "result"]), let outcome = root["outcome"] as? String,
    let result = root["result"] as? [String: Any],
    Set(result.keys) == Set(["ok", "message", "browser"]),
    let ok = result["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(),
    let message = result["message"] as? String, validBrowserText(message, maximum: 4_000),
    let browser = result["browser"] as? [String: Any],
    let sourceValue = browser["source"] as? String,
    let source = BrowserPhoneSource(rawValue: sourceValue),
    let operation = browser["operation"] as? String, let status = browser["status"] as? String
  else { throw PhoneControlFailure.invalidResponse }
  if operation == "status" {
    if status == "connected" {
      guard Set(browser.keys) == Set(["source", "operation", "status", "revision", "origin"]),
        let revision = browser["revision"] as? String, validBrowserIdentifier(revision),
        let origin = browser["origin"] as? String, validBrowserOrigin(origin)
      else { throw PhoneControlFailure.invalidResponse }
      guard outcome == "completed", ok.boolValue else { throw PhoneControlFailure.invalidResponse }
      return .status(source: source, connected: true, revision: revision)
    }
    guard Set(browser.keys) == Set(["source", "operation", "status"]),
      ["unbound", "unsupported", "unavailable"].contains(status)
    else { throw PhoneControlFailure.invalidResponse }
    guard outcome == "failed", !ok.boolValue else { throw PhoneControlFailure.invalidResponse }
    return .status(source: source, connected: false, revision: nil)
  }
  guard let revision = browser["revision"] as? String, validBrowserIdentifier(revision) else {
    throw PhoneControlFailure.invalidResponse
  }
  if operation == "read" {
    guard status == "completed",
      Set(browser.keys) == Set(["source", "operation", "status", "revision", "view"]),
      let view = browser["view"] as? [String: Any],
      Set(view.keys).isSubset(of: ["title", "summary", "items", "site"]),
      view.keys.contains("items"), let rawItems = view["items"] as? [[String: Any]],
      rawItems.count <= 64
    else { throw PhoneControlFailure.invalidResponse }
    guard outcome == "completed", ok.boolValue else { throw PhoneControlFailure.invalidResponse }
    var seen = Set<String>()
    let items = try rawItems.map { row -> BrowserPhoneItem in
      guard Set(row.keys) == Set(row["state"] == nil ? ["id", "label"] : ["id", "label", "state"]),
        let id = row["id"] as? String, validBrowserIdentifier(id), seen.insert(id).inserted,
        let label = row["label"] as? String, validBrowserText(label, maximum: 500),
        row["state"] == nil || (row["state"] as? String).map({ validBrowserText($0, maximum: 100) }) == true
      else { throw PhoneControlFailure.invalidResponse }
      return BrowserPhoneItem(id: id, label: label, state: row["state"] as? String)
    }
    guard view["title"] == nil || view["title"] is String,
      view["summary"] == nil || view["summary"] is String
    else { throw PhoneControlFailure.invalidResponse }
    let title = view["title"] as? String
    let summary = view["summary"] as? String
    guard title.map({ validBrowserText($0, maximum: 500) }) ?? true,
      summary.map({ validBrowserText($0, maximum: 2_000) }) ?? true
    else { throw PhoneControlFailure.invalidResponse }
    let site: BrowserPhoneSite?
    if view.keys.contains("site") {
      let rawSite = view["site"]
      guard let value = rawSite as? [String: Any] else {
        throw PhoneControlFailure.invalidResponse
      }
      site = try decodeBrowserPhoneSite(value)
    } else {
      site = nil
    }
    if source == .companion && site?.provider != .netflix && site?.provider != .youtubeTV && site?.provider != .disneyplus && site?.provider != .youtube {
      throw PhoneControlFailure.invalidResponse
    }
    return .page(
      BrowserPhonePage(
        nodeID: nodeID, source: source, revision: revision, title: title, summary: summary,
        items: items, site: site))
  }
  guard operation == "command", Set(browser.keys) == Set(["source", "operation", "status", "revision"]),
    let commandStatus = BrowserPhoneCommandStatus(rawValue: status)
  else { throw PhoneControlFailure.invalidResponse }
  let expectedOutcome = commandStatus == .completed ? "completed" : commandStatus == .unknown || commandStatus == .timedOut ? "unknown" : "failed"
  guard outcome == expectedOutcome, ok.boolValue == (commandStatus == .completed) else {
    throw PhoneControlFailure.invalidResponse
  }
  return .command(source: source, status: commandStatus, revision: revision)
}

private func decodeBrowserPhoneSite(_ value: [String: Any]) throws -> BrowserPhoneSite {
  guard Set(value.keys).isSubset(of: ["provider", "page", "playback", "currentTimeSeconds", "horizontalScrollAvailable", "rows", "searchControl"]),
    Set(["provider", "page", "playback"]).isSubset(of: Set(value.keys)),
    let providerValue = value["provider"] as? String,
    let provider = BrowserPhoneProvider(rawValue: providerValue),
    let pageValue = value["page"] as? String,
    let page = BrowserPhoneYouTubePage(rawValue: pageValue),
    let playbackValue = value["playback"] as? String,
    let playback = BrowserPhonePlayback(rawValue: playbackValue),
    page == .watch || playback == .unavailable,
    (provider == .youtube && [.home, .results, .watch, .login, .unsupported].contains(page))
      || (provider == .netflix && [.browse, .results, .watch, .login, .unsupported].contains(page))
      || (provider == .youtubeTV && [.browse, .watch, .login, .unsupported].contains(page))
      || (provider == .disneyplus && [.browse, .login, .unsupported].contains(page))
  else { throw PhoneControlFailure.invalidResponse }
  let row: Bool?
  if let rawRow = value["horizontalScrollAvailable"] {
    guard provider == .netflix, page == .browse,
      let number = rawRow as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID()
    else { throw PhoneControlFailure.invalidResponse }
    row = number.boolValue
  } else { row = nil }
  let rows: [BrowserPhoneRow]?
  if let rawRows = value["rows"] {
    guard provider == .netflix, page == .browse,
      let entries = rawRows as? [[String: Any]], entries.count <= 8
    else { throw PhoneControlFailure.invalidResponse }
    var seen = Set<String>()
    rows = try entries.map { entry in
      guard Set(entry.keys) == Set(["id", "label"]),
        let id = entry["id"] as? String, validBrowserRowID(id), seen.insert(id).inserted,
        let label = entry["label"] as? String, validBrowserText(label, maximum: 100)
      else { throw PhoneControlFailure.invalidResponse }
      return BrowserPhoneRow(id: id, label: label)
    }
  } else { rows = nil }
  let searchControl: BrowserPhoneSearchControl?
  if let raw = value["searchControl"] {
    guard (provider == .netflix && (page == .browse || page == .results))
      || (provider == .youtube && (page == .home || page == .results)),
      let entry = raw as? [String: Any], Set(entry.keys) == Set(["id", "label"]),
      let id = entry["id"] as? String, validBrowserRowID(id),
      let label = entry["label"] as? String, validBrowserText(label, maximum: 100)
    else { throw PhoneControlFailure.invalidResponse }
    searchControl = BrowserPhoneSearchControl(id: id, label: label)
  } else { searchControl = nil }
  let time: Double?
  if let rawTime = value["currentTimeSeconds"] {
    guard playback == .playing || playback == .paused,
      let number = rawTime as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, (0...86_400).contains(number.doubleValue)
    else { throw PhoneControlFailure.invalidResponse }
    time = number.doubleValue
  } else {
    time = nil
  }
  return BrowserPhoneSite(
    provider: provider, page: page, playback: playback,
    currentTimeSeconds: time, horizontalScrollAvailable: row, rows: rows,
    searchControl: searchControl)
}

private func validBrowserRowID(_ value: String) -> Bool {
  let bytes = Array(value.utf8)
  return bytes.count == 36 && UUID(uuidString: value)?.uuidString.lowercased() == value
    && bytes[14] == 52 && [56, 57, 97, 98].contains(bytes[19])
}

private func validBrowserIdentifier(_ value: String) -> Bool {
  value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$"#, options: .regularExpression) != nil
}
private func validBrowserText(_ value: String, maximum: Int) -> Bool {
  !value.isEmpty && value.utf8.count <= maximum
    && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
}
private func validBrowserQuery(_ value: String) -> Bool {
  value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    && validBrowserText(value, maximum: 512) && value.utf16.count <= 200
}
private func validBrowserOrigin(_ value: String) -> Bool {
  guard value.utf8.count <= 2_048, let url = URL(string: value), url.scheme == "https",
    url.host != nil, url.user == nil, url.password == nil, url.path.isEmpty,
    url.query == nil, url.fragment == nil
  else { return false }
  return url.absoluteString == value
}
