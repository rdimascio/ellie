import Foundation

struct ChoreDay: Codable, Hashable, Comparable, Sendable, CustomStringConvertible {
    let value: String

    init(_ value: String) throws {
        guard Self.components(from: value) != nil else { throw ChoresModelError.invalidDate }
        self.value = value
    }

    var description: String { value }

    static func < (lhs: ChoreDay, rhs: ChoreDay) -> Bool { lhs.value < rhs.value }

    init(from decoder: Decoder) throws {
        try self.init(decoder.singleValueContainer().decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }

    static func from(_ date: Date, timeZone: TimeZone) -> ChoreDay {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return try! ChoreDay(String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!))
    }

    func date(in timeZone: TimeZone) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parsed = Self.components(from: value)!
        return calendar.date(from: DateComponents(year: parsed.year, month: parsed.month, day: parsed.day))!
    }

    private static func components(from value: String) -> DateComponents? {
        let bytes = Array(value.utf8)
        guard bytes.count == 10, bytes[4] == 45, bytes[7] == 45,
              bytes.enumerated().allSatisfy({ index, byte in index == 4 || index == 7 || (48...57).contains(byte) })
        else { return nil }
        let pieces = value.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
              let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2]),
              (1...9999).contains(year), (1...12).contains(month), (1...31).contains(day)
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var components = DateComponents()
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return nil }
        let roundTrip = calendar.dateComponents([.year, .month, .day], from: date)
        return roundTrip.year == year && roundTrip.month == month && roundTrip.day == day ? components : nil
    }
}

struct Chore: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var title: String
    var member: String
    var body: String
    var dueDay: ChoreDay
    var completedDay: ChoreDay?

    private enum CodingKeys: String, CodingKey, CaseIterable { case id, title, member, body, dueDay, completedDay }

    init(id: String, title: String, member: String, body: String = "", dueDay: ChoreDay, completedDay: ChoreDay? = nil) {
        self.id = id
        self.title = title
        self.member = member
        self.body = body
        self.dueDay = dueDay
        self.completedDay = completedDay
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: ChoreCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.stringValue))
        guard container.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else { throw ChoresModelError.invalidJSON }
        id = try container.decode(String.self, forKey: .init("id"))
        title = try container.decode(String.self, forKey: .init("title"))
        member = try container.decode(String.self, forKey: .init("member"))
        body = try container.decode(String.self, forKey: .init("body"))
        dueDay = try container.decode(ChoreDay.self, forKey: .init("dueDay"))
        completedDay = try container.decodeIfPresent(ChoreDay.self, forKey: .init("completedDay"))
    }
}

struct ChoresState: Codable, Equatable, Sendable {
    var version: Int = 1
    var householdTimeZone: String
    var chores: [Chore]

    private enum CodingKeys: String, CodingKey, CaseIterable { case version, householdTimeZone, chores }

    init(version: Int = 1, householdTimeZone: String, chores: [Chore]) {
        self.version = version
        self.householdTimeZone = householdTimeZone
        self.chores = chores
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: ChoreCodingKey.self)
        let allowed = Set(CodingKeys.allCases.map(\.stringValue))
        guard container.allKeys.allSatisfy({ allowed.contains($0.stringValue) }) else { throw ChoresModelError.invalidJSON }
        version = try container.decode(Int.self, forKey: .init("version"))
        householdTimeZone = try container.decode(String.self, forKey: .init("householdTimeZone"))
        chores = try container.decode([Chore].self, forKey: .init("chores"))
    }
}

enum ChoresModel {
    static let schemaVersion = 1
    static let maximumChores = 500
    static let maximumTitleLength = 120
    static let maximumMemberLength = 60
    static let maximumBodyLength = 500
    static let maximumSerializedBytes = 256 * 1_024

    static func emptyState(timeZone: TimeZone = .current) -> ChoresState {
        ChoresState(householdTimeZone: timeZone.identifier, chores: [])
    }

    static func decode(_ data: Data) throws -> ChoresState {
        guard data.count <= maximumSerializedBytes else { throw ChoresModelError.dataTooLarge }
        let state: ChoresState
        do { state = try JSONDecoder().decode(ChoresState.self, from: data) }
        catch let error as ChoresModelError { throw error }
        catch { throw ChoresModelError.invalidJSON }
        try validate(state)
        return state
    }

    static func encode(_ state: ChoresState) throws -> Data {
        try validate(state)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        guard data.count <= maximumSerializedBytes else { throw ChoresModelError.dataTooLarge }
        return data
    }

    static func validate(_ state: ChoresState) throws {
        guard state.version == schemaVersion else { throw ChoresModelError.unsupportedVersion }
        guard TimeZone(identifier: state.householdTimeZone) != nil else { throw ChoresModelError.invalidTimeZone }
        guard state.chores.count <= maximumChores else { throw ChoresModelError.tooManyChores }
        guard Set(state.chores.map(\.id)).count == state.chores.count else { throw ChoresModelError.duplicateID }
        for chore in state.chores {
            guard UUID(uuidString: chore.id) != nil else { throw ChoresModelError.invalidIdentifier }
            try validateText(chore.title, maximum: maximumTitleLength)
            try validateText(chore.member, maximum: maximumMemberLength)
            try validateBody(chore.body)
        }
    }

    static func weekDays(containing day: ChoreDay, timeZone: TimeZone) -> [ChoreDay] {
        var calendar = Calendar(identifier: .gregorian)
        // Civil-date arithmetic uses UTC so daylight-saving transitions cannot alter a day.
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.firstWeekday = 2
        let date = day.date(in: calendar.timeZone)
        let weekday = calendar.component(.weekday, from: date)
        let daysFromMonday = (weekday + 5) % 7
        let monday = calendar.date(byAdding: .day, value: -daysFromMonday, to: date)!
        return (0..<7).compactMap { offset in
            guard let date = calendar.date(byAdding: .day, value: offset, to: monday) else { return nil }
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
            return try? ChoreDay(String(format: "%04d-%02d-%02d", year, month, day))
        }
    }

    private static func validateText(_ value: String, maximum: Int) throws {
        guard !value.isEmpty, value.utf16.count <= maximum,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else { throw ChoresModelError.invalidText }
    }

    private static func validateBody(_ value: String) throws {
        guard value.utf16.count <= maximumBodyLength,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.subtracting(.newlines).contains)
        else { throw ChoresModelError.invalidText }
    }
}

enum ChoresModelError: LocalizedError, Equatable {
    case invalidJSON, dataTooLarge, unsupportedVersion, invalidTimeZone, tooManyChores
    case duplicateID, invalidIdentifier, invalidText, invalidDate, unknownChore

    var errorDescription: String? {
        switch self {
        case .invalidJSON: "Chore data is not valid JSON."
        case .dataTooLarge: "Chore data is too large."
        case .unsupportedVersion: "This chore data version is not supported."
        case .invalidTimeZone: "The household time zone is invalid."
        case .tooManyChores: "A maximum of 500 chores is supported."
        case .duplicateID: "Chore IDs must be unique."
        case .invalidIdentifier: "A chore ID is invalid."
        case .invalidText: "A chore title or member is invalid."
        case .invalidDate: "A chore date must be a real Gregorian date in canonical YYYY-MM-DD format."
        case .unknownChore: "That chore no longer exists."
        }
    }
}

private struct ChoreCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil
    init(_ string: String) { stringValue = string }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { return nil }
}
