import Combine
import Darwin
import Foundation

struct AgendaSource: Codable, Equatable {
  let id: String
  let name: String
}
struct AgendaCalendar: Codable, Equatable {
  let id: String
  let name: String
  let color: String?
}
struct AgendaEvent: Codable, Equatable, Identifiable {
  let id: String
  let calendarID: String
  let title: String
  let start: Date?
  let end: Date?
  let timeZone: String?
  let startDate: String?
  let endDate: String?
  var isAllDay: Bool { startDate != nil }

  func isRelevant(at now: Date, displayTimeZone: TimeZone) -> Bool {
    if let end { return end > now }
    guard let endDate else { return false }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = displayTimeZone
    let parts = calendar.dateComponents([.year, .month, .day], from: now)
    return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!) < endDate
  }

  func displayStart(in timeZone: TimeZone) -> Date? {
    if let start { return start }
    guard let startDate else { return nil }
    let values = startDate.split(separator: "-").compactMap { Int($0) }
    guard values.count == 3 else { return nil }
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar.date(from: DateComponents(year: values[0], month: values[1], day: values[2]))
  }
}
struct AgendaSnapshot: Codable, Equatable {
  let version: Int
  let source: AgendaSource
  let generatedAt: Date
  var calendars: [AgendaCalendar]
  var events: [AgendaEvent]
  func relevantEvents(at now: Date, displayTimeZone: TimeZone = .current) -> [AgendaEvent] {
    events.filter { $0.isRelevant(at: now, displayTimeZone: displayTimeZone) }.sorted { lhs, rhs in
      let left = lhs.displayStart(in: displayTimeZone) ?? .distantFuture
      let right = rhs.displayStart(in: displayTimeZone) ?? .distantFuture
      if left != right { return left < right }
      if lhs.isAllDay != rhs.isAllDay { return lhs.isAllDay }
      return (lhs.calendarID, lhs.id) < (rhs.calendarID, rhs.id)
    }
  }
}

enum AgendaModel {
  static let maximumBytes = 128 * 1024
  static func decode(_ data: Data, now: Date = .now) throws -> AgendaSnapshot {
    guard data.count <= maximumBytes else { throw AgendaError.invalid }
    try rejectUnknownFields(data)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      for options: ISO8601DateFormatter.Options in [
        [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime],
      ] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = options
        if let date = formatter.date(from: value) { return date }
      }
      throw AgendaError.invalid
    }
    var value = try decoder.decode(AgendaSnapshot.self, from: data)
    try validate(value, now: now)
    value.calendars.sort { ($0.name, $0.id) < ($1.name, $1.id) }
    value.events.sort { eventKey($0) < eventKey($1) }
    return value
  }
  static func encode(_ value: AgendaSnapshot, now: Date = .now) throws -> Data {
    try validate(value, now: now)
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(value)
    guard data.count <= maximumBytes else { throw AgendaError.invalid }
    return data
  }
  static func validate(_ value: AgendaSnapshot, now: Date) throws {
    guard value.version == 1, validID(value.source.id), validText(value.source.name, 80),
      value.generatedAt >= Date(timeIntervalSince1970: 1_577_836_800),
      value.generatedAt <= now.addingTimeInterval(300),
      value.calendars.count <= 32, value.events.count <= 500
    else { throw AgendaError.invalid }
    var calendarIDs = Set<String>()
    for calendar in value.calendars {
      guard validID(calendar.id), validText(calendar.name, 80),
        calendarIDs.insert(calendar.id).inserted,
        calendar.color.map(validColor) ?? true
      else { throw AgendaError.invalid }
    }
    var eventIDs = Set<String>()
    for event in value.events {
      guard validID(event.id), eventIDs.insert(event.id).inserted,
        calendarIDs.contains(event.calendarID), validText(event.title, 160)
      else { throw AgendaError.invalid }
      if let start = event.start, let end = event.end, let zone = event.timeZone {
        guard event.startDate == nil, event.endDate == nil, TimeZone(identifier: zone) != nil,
          start >= Date(timeIntervalSince1970: 946_684_800), end > start,
          end.timeIntervalSince(start) <= 7 * 86_400
        else { throw AgendaError.invalid }
      } else if let start = event.startDate, let end = event.endDate {
        guard event.start == nil, event.end == nil, event.timeZone == nil, validDay(start),
          validDay(end), start < end,
          dayDistance(start, end) <= 366
        else { throw AgendaError.invalid }
      } else {
        throw AgendaError.invalid
      }
    }
  }
  private static func eventKey(_ e: AgendaEvent) -> (String, String, String) {
    let start = e.startDate ?? e.start.map { ISO8601DateFormatter().string(from: $0) } ?? ""
    return (start, e.calendarID, e.id)
  }
  private static func rejectUnknownFields(_ data: Data) throws {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys).isSubset(of: ["version", "source", "generatedAt", "calendars", "events"]),
      let source = root["source"] as? [String: Any], Set(source.keys).isSubset(of: ["id", "name"]),
      let calendars = root["calendars"] as? [[String: Any]],
      calendars.allSatisfy({ Set($0.keys).isSubset(of: ["id", "name", "color"]) }),
      let events = root["events"] as? [[String: Any]],
      events.allSatisfy({
        Set($0.keys).isSubset(of: [
          "id", "calendarID", "title", "start", "end", "timeZone", "startDate", "endDate",
        ])
      }),
      let generatedAt = root["generatedAt"] as? String,
      validTimestamp(generatedAt),
      events.allSatisfy({ event in
        [event["start"], event["end"]].compactMap { $0 }.allSatisfy {
          guard let value = $0 as? String else { return false }
          return validTimestamp(value)
        }
      })
    else { throw AgendaError.invalid }
  }

  private static func validTimestamp(_ value: String) -> Bool {
    value.range(
      of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$"#,
      options: .regularExpression
    ) != nil
  }
  private static func validID(_ s: String) -> Bool {
    !s.isEmpty && s.utf8.count <= 64
      && s.utf8.allSatisfy {
        $0 == 45 || $0 == 95 || (48...57).contains($0) || (65...90).contains($0)
          || (97...122).contains($0)
      }
  }
  private static func validText(_ s: String, _ max: Int) -> Bool {
    !s.isEmpty && s == s.trimmingCharacters(in: .whitespacesAndNewlines) && s.utf16.count <= max
      && !s.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
  }
  private static func validColor(_ s: String) -> Bool {
    s.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil
  }
  private static func validDay(_ s: String) -> Bool { day(s) != nil }
  private static func dayDistance(_ a: String, _ b: String) -> Int {
    Calendar(identifier: .gregorian).dateComponents([.day], from: day(a)!, to: day(b)!).day ?? .max
  }
  private static func day(_ s: String) -> Date? {
    guard s.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
      return nil
    }
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.calendar = Calendar(identifier: .gregorian)
    f.timeZone = TimeZone(secondsFromGMT: 0)
    f.dateFormat = "yyyy-MM-dd"
    return f.date(from: s).flatMap { f.string(from: $0) == s ? $0 : nil }
  }
}

enum AgendaError: Error { case invalid, unsafeFile }

@MainActor final class AgendaStore: ObservableObject {
  @Published private(set) var snapshot: AgendaSnapshot?
  @Published private(set) var isImporting = false
  @Published private(set) var canClear = false
  @Published var message: String?
  let fileURL: URL
  private let now: () -> Date
  private var generation = UUID()
  private var recoveryRequired = false
  init(fileURL: URL? = nil, now: @escaping () -> Date = Date.init) {
    self.fileURL =
      fileURL
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Ellie/agendav1.json")
    self.now = now
    if Self.pathExists(self.fileURL) {
      canClear = true
      do {
        snapshot = try AgendaModel.decode(Self.readPrivateCache(self.fileURL), now: now())
      } catch {
        recoveryRequired = true
        message = "The saved agenda could not be opened. Clear it before importing another."
      }
    }
  }
  func importData(_ data: Data) {
    let token = UUID()
    generation = token
    isImporting = true
    Task { @MainActor in
      do {
        let candidate = try AgendaModel.decode(data, now: now())
        guard generation == token else { return }
        try persist(candidate)
        guard generation == token else { return }
        snapshot = candidate
        canClear = true
        recoveryRequired = false
        message = nil
      } catch {
        if generation == token {
          message =
            snapshot == nil
            ? "This is not a valid Ellie agenda snapshot."
            : "Import failed. Showing the saved snapshot."
        }
      }
      if generation == token { isImporting = false }
    }
  }
  func disconnect() {
    generation = UUID()
    isImporting = false
    snapshot = nil
    do {
      try Self.unlinkOwnedCache(fileURL)
      recoveryRequired = false
      canClear = false
      message = nil
    } catch {
      canClear = Self.pathExists(fileURL)
      recoveryRequired = canClear
      message = "Agenda disconnected, but its saved file could not be removed safely."
    }
  }
  func freshness(at date: Date) -> String {
    guard let snapshot else { return "Not connected" }
    return max(0, date.timeIntervalSince(snapshot.generatedAt)) > 86_400
      ? "Stale snapshot · stored offline" : "Imported snapshot · stored offline"
  }
  private func persist(_ value: AgendaSnapshot) throws {
    guard !recoveryRequired else { throw AgendaError.invalid }
    let data = try AgendaModel.encode(value, now: now())
    let dir = fileURL.deletingLastPathComponent()
    if !Self.pathExists(dir) {
      try FileManager.default.createDirectory(
        at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    }
    var ds = stat()
    guard lstat(dir.path, &ds) == 0, (ds.st_mode & S_IFMT) == S_IFDIR, ds.st_uid == getuid() else {
      throw AgendaError.unsafeFile
    }
    guard chmod(dir.path, 0o700) == 0 else { throw AgendaError.unsafeFile }
    if Self.pathExists(fileURL) {
      var st = stat()
      guard lstat(fileURL.path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid()
      else { throw AgendaError.unsafeFile }
    }
    let temp = dir.appendingPathComponent(".agenda-\(UUID().uuidString).tmp")
    let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw AgendaError.unsafeFile }
    var written = 0
    let result = data.withUnsafeBytes { bytes -> Bool in
      while written < bytes.count {
        let n = Darwin.write(fd, bytes.baseAddress!.advanced(by: written), bytes.count - written)
        if n <= 0 { return false }
        written += n
      }
      return fsync(fd) == 0
    }
    _ = close(fd)
    guard result, rename(temp.path, fileURL.path) == 0 else {
      _ = unlink(temp.path)
      throw AgendaError.unsafeFile
    }
  }
  static func safeRead(_ url: URL) throws -> Data {
    try openAndRead(url, requiresPrivateFile: false)
  }

  private static func readPrivateCache(_ url: URL) throws -> Data {
    var parent = stat()
    guard lstat(url.deletingLastPathComponent().path, &parent) == 0,
      (parent.st_mode & S_IFMT) == S_IFDIR,
      parent.st_uid == getuid(),
      (parent.st_mode & 0o077) == 0
    else { throw AgendaError.unsafeFile }
    return try openAndRead(url, requiresPrivateFile: true)
  }

  private static func openAndRead(_ url: URL, requiresPrivateFile: Bool) throws -> Data {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw AgendaError.unsafeFile }
    defer { close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0,
      (st.st_mode & S_IFMT) == S_IFREG,
      st.st_size >= 0,
      st.st_size <= AgendaModel.maximumBytes
    else { throw AgendaError.unsafeFile }
    if requiresPrivateFile {
      guard st.st_uid == getuid(), (st.st_mode & 0o077) == 0 else { throw AgendaError.unsafeFile }
    }
    return try readBounded(fd)
  }
  private static func readBounded(_ fd: Int32) throws -> Data {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 8192)
    while data.count <= AgendaModel.maximumBytes {
      let n = Darwin.read(fd, &buffer, min(buffer.count, AgendaModel.maximumBytes + 1 - data.count))
      if n < 0 { throw AgendaError.unsafeFile }
      if n == 0 { return data }
      data.append(buffer, count: n)
    }
    throw AgendaError.invalid
  }
  private static func unlinkOwnedCache(_ url: URL) throws {
    var st = stat()
    if lstat(url.path, &st) != 0 {
      if errno == ENOENT { return }
      throw AgendaError.unsafeFile
    }
    guard (st.st_mode & S_IFMT) == S_IFREG, st.st_uid == getuid() else {
      throw AgendaError.unsafeFile
    }
    guard unlink(url.path) == 0 else { throw AgendaError.unsafeFile }
  }
  private static func pathExists(_ url: URL) -> Bool {
    var st = stat()
    return lstat(url.path, &st) == 0
  }
}
