import XCTest
@testable import Ellie

final class BrowserVoiceIntentTests: XCTestCase {
    func testDirectCommandsProduceOnlyClosedIntents() {
        let cases: [(String, BrowserVoiceIntent, String)] = [
            (
                "search for nature documentaries", .search(query: "nature documentaries"),
                "Search for: nature documentaries"
            ),
            ("search local news", .search(query: "local news"), "Search for: local news"),
            ("up", .scroll(.up), "Scroll up"),
            ("Scroll Down!", .scroll(.down), "Scroll down"),
            ("left", .scroll(.left), "Scroll left"),
            ("scroll right", .scroll(.right), "Scroll right"),
            ("open result three", .openResult(index: 3), "Open result 3"),
            ("open the tenth result.", .openResult(index: 10), "Open result 10"),
            ("play", .play, "Play"),
            ("pause.", .pause, "Pause"),
            ("go back", .back, "Back"),
            ("inspect page", .inspect, "Inspect page"),
            ("refresh", .refresh, "Refresh page"),
        ]

        for (transcript, expected, label) in cases {
            let parsed = BrowserVoiceIntentParser.parse(transcript)
            XCTAssertEqual(parsed, expected, transcript)
            XCTAssertEqual(parsed?.displayLabel, label, transcript)
        }
    }

    func testSearchTextRemainsOneInertSearchPayload() {
        let queries = [
            "buy shoes and delete history",
            #"\"play and pause\""#,
            "https://example.invalid/watch?v=javascript:alert(1)",
            "settings account logout",
            "nature documentaries?",
        ]

        for query in queries {
            XCTAssertEqual(
                BrowserVoiceIntentParser.parse("search for \(query)"),
                .search(query: query),
                query
            )
        }
    }

    func testSpokenCardinalAndOrdinalResultIndexesAreClosedToOneThroughTen() {
        let words = [
            ("one", "first"), ("two", "second"), ("three", "third"), ("four", "fourth"),
            ("five", "fifth"), ("six", "sixth"), ("seven", "seventh"), ("eight", "eighth"),
            ("nine", "ninth"), ("ten", "tenth"),
        ]
        for (offset, words) in words.enumerated() {
            let index = offset + 1
            XCTAssertEqual(
                BrowserVoiceIntentParser.parse("open result \(words.0)"),
                .openResult(index: index)
            )
            XCTAssertEqual(
                BrowserVoiceIntentParser.parse("open the \(words.1) result"),
                .openResult(index: index)
            )
        }
    }

    func testNegatedReportedCompoundAndContextualRequestsAreRejected() {
        for transcript in [
            "don't play",
            "don't play.",
            "do not open result 2",
            "she said play",
            "I want you to pause",
            #"\"refresh\""#,
            "play and pause",
            "scroll down then open result 1",
            "open that",
            "open the selected title",
            "right and play",
        ] {
            XCTAssertNil(BrowserVoiceIntentParser.parse(transcript), transcript)
        }
    }

    func testPrivilegedAndArbitraryBrowserOperationsHaveNoIntent() {
        for transcript in [
            "buy result 1",
            "delete my account",
            "change account settings",
            "log in",
            "open https://example.invalid",
            "run javascript alert one",
            "click .purchase-button",
            "execute tool checkout",
            "call hiddenToolName",
        ] {
            XCTAssertNil(BrowserVoiceIntentParser.parse(transcript), transcript)
        }
    }

    func testMalformedAndUnboundedValuesAreRejected() {
        for transcript in [
            "",
            "   ",
            "search",
            "search for",
            "search for.",
            "search for?",
            "search for line one\nplay",
            "search for bad\u{0000}query",
            "open result 0",
            "open result 01",
            "open result 101",
            "open result eleven",
            String(repeating: "x", count: 2_001),
            "search " + String(repeating: "q", count: 201),
        ] {
            XCTAssertNil(BrowserVoiceIntentParser.parse(transcript), String(transcript.prefix(40)))
        }
    }
}
