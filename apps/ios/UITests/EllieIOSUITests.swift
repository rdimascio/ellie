import XCTest

final class EllieIOSUITests: XCTestCase {
    func testReviewedBrowserVoiceNavigationAndBackgroundCancellationNeverReplay() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-reviewed-browser-fixture"]
        app.launch()

        let check = app.buttons["speech-check"]
        XCTAssertTrue(check.waitForExistence(timeout: 5))
        check.tap()
        let record = app.buttons["speech-record"]
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        record.tap()
        let stop = app.buttons["speech-stop"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()

        let transcript = app.textViews["speech-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 5))
        XCTAssertEqual(transcript.value as? String, "Search for public video")

        let initialRead = app.buttons["speech-browser-read"]
        XCTAssertTrue(initialRead.waitForExistence(timeout: 5))
        let readEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: initialRead)
        XCTAssertEqual(XCTWaiter.wait(for: [readEnabled], timeout: 5), .completed)
        initialRead.tap()
        let run = app.buttons["speech-browser-run"]
        XCTAssertTrue(run.waitForExistence(timeout: 5))
        XCTAssertTrue(run.isEnabled)
        run.tap()

        let updatedRead = app.buttons["speech-browser-read-updated"]
        XCTAssertTrue(updatedRead.waitForExistence(timeout: 5))
        updatedRead.tap()
        let continuation = app.buttons["speech-browser-continue"]
        XCTAssertTrue(continuation.waitForExistence(timeout: 5))
        continuation.tap()
        XCTAssertTrue(app.navigationBars["Browser control"].waitForExistence(timeout: 5))

        let result = app.buttons["browser-result-1"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        result.tap()
        let mutationCount = app.staticTexts["browser-fixture-mutation-count"]
        XCTAssertTrue(mutationCount.waitForExistence(timeout: 5))
        XCTAssertEqual(mutationCount.label, "Fixture mutations: 2")

        XCUIDevice.shared.press(.home)
        let backgrounded = XCTNSPredicateExpectation(
            predicate: NSPredicate { value, _ in
                guard let application = value as? XCUIApplication else { return false }
                switch application.state {
                case .runningBackground, .runningBackgroundSuspended: return true
                case .unknown, .notRunning, .runningForeground: return false
                @unknown default: return false
                }
            },
            object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [backgrounded], timeout: 5), .completed)
        app.activate()
        XCTAssertTrue(
            app.descendants(matching: .any)["browser-status-unknown"].waitForExistence(timeout: 5))
        XCTAssertEqual(mutationCount.label, "Fixture mutations: 2")
        let noReplay = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "Fixture mutations: 2"),
            object: mutationCount)
        noReplay.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [noReplay], timeout: 1), .completed)
    }

    func testCoordinatorNavigationDoesNotStartEnrollment() {
        let app = XCUIApplication()
        app.launch()
        let coordinator = app.buttons["coordinator-enrollment"]
        XCTAssertTrue(coordinator.waitForExistence(timeout: 5))
        coordinator.tap()
        XCTAssertTrue(app.navigationBars["Coordinator"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Scan enrollment code"].waitForExistence(timeout: 5))
        returnToDashboardList(from: "Coordinator", in: app)
    }

    func testNotesPersistAndDashboardDeletionReturnsToList() throws {
        let app = XCUIApplication()
        app.launch()
        openDashboard(named: "Home", identifiedBy: "dashboard-home", in: app)
        app.buttons["Add a note"].tap()
        let note = "Remember the blue mug"
        let noteEditor = app.textViews.firstMatch
        try typeTextReliably(note, into: noteEditor, in: app)
        let countLabel = "\(note.count) of 2,000 characters"
        guard app.staticTexts[countLabel].waitForExistence(timeout: 2) else {
            XCTFail("Expected the note editor state to contain the complete note")
            throw InputFailure.valueMismatch
        }
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["note-note"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["note-note"].label, note)
        app.terminate()
        app.launch()
        openDashboard(named: "Home", identifiedBy: "dashboard-home", in: app)
        XCTAssertTrue(app.buttons["note-note"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["note-note"].label, note)
        returnToDashboardList(from: "Home", in: app)

        app.buttons["new-dashboard"].tap()
        try typeTextReliably("Kitchen", into: app.textFields["Name"], in: app)
        app.buttons["Create"].tap()
        openDashboard(named: "Kitchen", in: app)
        app.buttons["dashboard-options"].tap()
        app.buttons["Rename Dashboard"].tap()
        let field = app.textFields["Name"]
        try typeTextReliably(" Notes", into: field, in: app, startingWith: "Kitchen")
        app.alerts["Rename dashboard"].buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Kitchen Notes"].waitForExistence(timeout: 5))
        app.buttons["dashboard-options"].tap()
        app.buttons["Delete Dashboard"].tap()
        app.buttons["Delete dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.staticTexts["Kitchen Notes"].exists)
    }

    private func openDashboard(named name: String, identifiedBy identifier: String? = nil, in app: XCUIApplication) {
        let link = identifier.map { app.buttons[$0] }
            ?? app.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5), "Expected the \(name) dashboard link")
        link.tap()
        XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5), "Expected the \(name) dashboard detail")
    }

    private func returnToDashboardList(from title: String, in app: XCUIApplication) {
        let back = app.navigationBars[title].buttons["Ellie"]
        XCTAssertTrue(back.waitForExistence(timeout: 5), "Expected the dashboard-list back button")
        back.tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 5), "Expected the dashboard list")
    }

    private func typeTextReliably(_ text: String, into element: XCUIElement, in app: XCUIApplication, startingWith initial: String = "") throws {
        guard element.waitForExistence(timeout: 5) else {
            XCTFail("Expected an editable input")
            throw InputFailure.notReady
        }
        element.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 2) else {
            XCTFail("Expected the keyboard before entering text")
            throw InputFailure.notReady
        }
        let characters = Array(text)
        var expected = initial
        for start in stride(from: 0, to: characters.count, by: 4) {
            let chunk = String(characters[start ..< min(start + 4, characters.count)])
            element.typeText(chunk)
            expected += chunk
            let actual = element.value as? String
            guard actual == expected else {
                XCTFail("Expected input value \(expected); observed \(String(describing: actual))")
                throw InputFailure.valueMismatch
            }
        }
    }

    private enum InputFailure: Error { case notReady, valueMismatch }
}
