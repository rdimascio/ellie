import Foundation

enum WidgetKind: String, Codable, CaseIterable, Sendable {
    case clock, note, weather, calendar, chores, playlist
}

enum WidgetSize: String, Codable, CaseIterable, Sendable {
    case small, wide
}

struct DashboardWidget: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var type: WidgetKind
    var title: String
    var size: WidgetSize
    var config: [String: String]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, type, title, size, config
    }

    init(id: String, type: WidgetKind, title: String, size: WidgetSize, config: [String: String]) {
        self.id = id
        self.type = type
        self.title = title
        self.size = size
        self.config = config
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        try container.rejectUnknownKeys(CodingKeys.self)
        id = try container.decode(String.self, forKey: AnyCodingKey("id"))
        type = try container.decode(WidgetKind.self, forKey: AnyCodingKey("type"))
        title = try container.decode(String.self, forKey: AnyCodingKey("title"))
        size = try container.decode(WidgetSize.self, forKey: AnyCodingKey("size"))
        config = try container.decode([String: String].self, forKey: AnyCodingKey("config"))
    }
}

struct Dashboard: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var widgets: [DashboardWidget]

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case id, name, widgets
    }

    init(id: String, name: String, widgets: [DashboardWidget]) {
        self.id = id
        self.name = name
        self.widgets = widgets
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        try container.rejectUnknownKeys(CodingKeys.self)
        id = try container.decode(String.self, forKey: AnyCodingKey("id"))
        name = try container.decode(String.self, forKey: AnyCodingKey("name"))
        widgets = try container.decode([DashboardWidget].self, forKey: AnyCodingKey("widgets"))
    }
}

struct DashboardState: Codable, Equatable, Sendable {
    var version: Int
    var dashboards: [Dashboard]

    init(version: Int = 1, dashboards: [Dashboard]) {
        self.version = version
        self.dashboards = dashboards
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case version, dashboards
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        try container.rejectUnknownKeys(CodingKeys.self)
        version = try container.decode(Int.self, forKey: AnyCodingKey("version"))
        dashboards = try container.decode([Dashboard].self, forKey: AnyCodingKey("dashboards"))
    }
}

enum DashboardModel {
    static let schemaVersion = 1
    static let maximumDashboards = 12
    static let maximumWidgetsPerDashboard = 24
    static let maximumNoteLength = 2_000
    static let maximumSerializedBytes = 128 * 1_024

    static func formattedTime(_ date: Date, in timeZone: TimeZone, locale: Locale = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.setLocalizedDateFormatFromTemplate("jm")
        return formatter.string(from: date)
    }

    static let initialState = DashboardState(dashboards: [
        Dashboard(id: "home", name: "Home", widgets: [
            DashboardWidget(id: "clock", type: .clock, title: "Right now", size: .wide, config: [:]),
            DashboardWidget(id: "note", type: .note, title: "A little note", size: .small, config: ["text": ""]),
            DashboardWidget(id: "weather", type: .weather, title: "Weather", size: .small, config: [:]),
        ]),
    ])

    static func decode(_ data: Data) throws -> DashboardState {
        guard data.count <= maximumSerializedBytes else { throw DashboardModelError.dataTooLarge }
        let state: DashboardState
        do {
            state = try JSONDecoder().decode(DashboardState.self, from: data)
        } catch let error as DashboardModelError {
            throw error
        } catch {
            throw DashboardModelError.invalidJSON
        }
        try validate(state)
        return state
    }

    static func encode(_ state: DashboardState) throws -> Data {
        try validate(state)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(state)
        guard data.count <= maximumSerializedBytes else { throw DashboardModelError.dataTooLarge }
        return data
    }

    static func validate(_ state: DashboardState) throws {
        guard state.version == schemaVersion else { throw DashboardModelError.unsupportedVersion }
        guard state.dashboards.count <= maximumDashboards else { throw DashboardModelError.tooManyDashboards }
        guard Set(state.dashboards.map(\.id)).count == state.dashboards.count else {
            throw DashboardModelError.duplicateDashboardID
        }
        for dashboard in state.dashboards {
            try validateID(dashboard.id)
            try validateText(dashboard.name, maximum: 80)
            guard dashboard.widgets.count <= maximumWidgetsPerDashboard else {
                throw DashboardModelError.tooManyWidgets
            }
            guard Set(dashboard.widgets.map(\.id)).count == dashboard.widgets.count else {
                throw DashboardModelError.duplicateWidgetID
            }
            for widget in dashboard.widgets { try validate(widget) }
        }
    }

    private static func validate(_ widget: DashboardWidget) throws {
        try validateID(widget.id)
        try validateText(widget.title, maximum: 80)
        let allowedKeys: Set<String>
        switch widget.type {
        case .clock: allowedKeys = ["timeZone"]
        case .note: allowedKeys = ["text"]
        default: allowedKeys = []
        }
        guard Set(widget.config.keys).isSubset(of: allowedKeys) else { throw DashboardModelError.invalidConfig }
        for (key, value) in widget.config {
            let maximum = key == "text" ? maximumNoteLength : 100
            guard value.utf16.count <= maximum else { throw DashboardModelError.invalidConfig }
            if key == "timeZone", TimeZone(identifier: value) == nil { throw DashboardModelError.invalidTimeZone }
        }
    }

    private static func validateID(_ value: String) throws {
        let validCharacters = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
        guard !value.isEmpty, value.utf16.count <= 64,
              value.unicodeScalars.allSatisfy(validCharacters.contains),
              value.unicodeScalars.first.map(CharacterSet.alphanumerics.contains) == true
        else { throw DashboardModelError.invalidIdentifier }
    }

    private static func validateText(_ value: String, maximum: Int) throws {
        guard !value.isEmpty, value.utf16.count <= maximum,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines)
        else { throw DashboardModelError.invalidText }
    }
}

enum DashboardModelError: LocalizedError, Equatable {
    case invalidJSON, dataTooLarge, unsupportedVersion, tooManyDashboards, tooManyWidgets
    case duplicateDashboardID, duplicateWidgetID, invalidIdentifier, invalidText
    case invalidConfig, invalidTimeZone, unknownDashboard, unknownWidget, positionOutOfBounds

    var errorDescription: String? {
        switch self {
        case .invalidJSON: "Dashboard data is not valid JSON."
        case .dataTooLarge: "Dashboard data is too large."
        case .unsupportedVersion: "This dashboard version is not supported."
        case .tooManyDashboards: "A maximum of 12 dashboards is supported."
        case .tooManyWidgets: "A dashboard can contain at most 24 widgets."
        case .duplicateDashboardID: "Dashboard IDs must be unique."
        case .duplicateWidgetID: "Widget IDs must be unique within a dashboard."
        case .invalidIdentifier: "A dashboard or widget ID is invalid."
        case .invalidText: "A dashboard name or widget title is invalid."
        case .invalidConfig: "The widget configuration is invalid."
        case .invalidTimeZone: "The clock time zone is invalid."
        case .unknownDashboard: "The selected dashboard no longer exists."
        case .unknownWidget: "The selected widget no longer exists."
        case .positionOutOfBounds: "The widget cannot move any farther."
        }
    }
}

private struct AnyCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?
    init(_ string: String) { stringValue = string; intValue = nil }
    init?(stringValue: String) { self.init(stringValue) }
    init?(intValue: Int) { stringValue = String(intValue); self.intValue = intValue }
}

private extension KeyedDecodingContainer where Key == AnyCodingKey {
    func rejectUnknownKeys<T>(_ allowed: T.Type) throws where T: CodingKey & CaseIterable, T.AllCases: Collection {
        let names = Set(T.allCases.map(\.stringValue))
        guard allKeys.allSatisfy({ names.contains($0.stringValue) }) else {
            throw DashboardModelError.invalidJSON
        }
    }
}
