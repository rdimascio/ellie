import Foundation

enum BrowserScrollDirection: String, Equatable, Sendable {
    case up
    case down
    case left
    case right
}

enum BrowserVoiceIntent: Equatable, Sendable {
    case search(query: String)
    case scroll(BrowserScrollDirection)
    case openResult(index: Int)
    case play
    case pause
    case back
    case inspect
    case refresh

    var displayLabel: String {
        switch self {
        case .search(let query): "Search for: \(query)"
        case .scroll(let direction): "Scroll \(direction.rawValue)"
        case .openResult(let index): "Open result \(index)"
        case .play: "Play"
        case .pause: "Pause"
        case .back: "Back"
        case .inspect: "Inspect page"
        case .refresh: "Refresh page"
        }
    }
}

enum BrowserVoiceIntentParser {
    private static let maximumTranscriptUTF16 = 2_000
    private static let maximumQueryUTF16 = 200
    private static let maximumQueryBytes = 512
    private static let maximumResultIndex = 100

    static func parse(_ transcript: String) -> BrowserVoiceIntent? {
        guard transcript.utf16.count <= maximumTranscriptUTF16 else { return nil }
        let value = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !containsControl(value) else { return nil }

        let lowered = value.lowercased()
        let reservedCommand: String
        if let final = lowered.last, ".!?".contains(final) {
            reservedCommand = String(lowered.dropLast())
        } else {
            reservedCommand = lowered
        }
        guard reservedCommand != "search", reservedCommand != "search for" else { return nil }
        for prefix in ["search for ", "search "] where lowered.hasPrefix(prefix) {
            let query = String(value.dropFirst(prefix.count))
                .trimmingCharacters(in: .whitespaces)
            guard validQuery(query) else { return nil }
            return .search(query: query)
        }

        let command: String
        if let final = lowered.last, ".!?".contains(final) {
            command = String(lowered.dropLast())
        } else {
            command = lowered
        }
        if let direction = BrowserScrollDirection(rawValue: command) {
            return .scroll(direction)
        }
        if command.hasPrefix("scroll "),
            let direction = BrowserScrollDirection(rawValue: String(command.dropFirst(7)))
        {
            return .scroll(direction)
        }
        if let index = resultIndex(command) {
            return .openResult(index: index)
        }

        switch command {
        case "play": return .play
        case "pause": return .pause
        case "back", "go back": return .back
        case "inspect", "inspect page": return .inspect
        case "refresh", "refresh page": return .refresh
        default: return nil
        }
    }

    private static func validQuery(_ query: String) -> Bool {
        !query.isEmpty && query.utf16.count <= maximumQueryUTF16
            && query.utf8.count <= maximumQueryBytes && !containsControl(query)
    }

    private static func containsControl(_ value: String) -> Bool {
        value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }

    private static func resultIndex(_ command: String) -> Int? {
        let cardinal = [
            "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
            "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
        ]
        let ordinal = [
            "first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5,
            "sixth": 6, "seventh": 7, "eighth": 8, "ninth": 9, "tenth": 10,
        ]
        if command.hasPrefix("open result ") {
            let value = String(command.dropFirst(12))
            if let spoken = cardinal[value] { return spoken }
            guard value.range(of: #"^[1-9][0-9]*$"#, options: .regularExpression) != nil,
                let index = Int(value), (1...maximumResultIndex).contains(index)
            else { return nil }
            return index
        }
        guard command.hasPrefix("open the "), command.hasSuffix(" result") else { return nil }
        return ordinal[String(command.dropFirst(9).dropLast(7))]
    }
}
