import XCTest

final class EllieIOSUITests: XCTestCase {
    func testScannerSheetDismissalKeepsDecodedReviewUntilExplicitCancel() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-native-scanner-sheet-fixture"]
        app.launch()

        let scan = app.buttons["Scan enrollment code"]
        XCTAssertTrue(scan.waitForExistence(timeout: 5))
        scan.tap()
        let dismiss = app.buttons["scanner-fixture-dismiss"]
        XCTAssertTrue(dismiss.waitForExistence(timeout: 5))
        dismiss.tap()
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "Dismissing the sheet returns to idle")
        XCTAssertFalse(app.buttons["Pair this iPhone"].exists)

        scan.tap()
        let decode = app.buttons["scanner-fixture-decode"]
        XCTAssertTrue(decode.waitForExistence(timeout: 5))
        decode.tap()
        let sheetGone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: decode)
        XCTAssertEqual(XCTWaiter.wait(for: [sheetGone], timeout: 5), .completed)
        let pair = app.buttons["Pair this iPhone"]
        XCTAssertTrue(pair.waitForExistence(timeout: 5),
            "A decoded code must remain on the production review screen after sheet dismissal")
        let reviewedLabel = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label CONTAINS %@ OR value == %@", "Fixture phone", "Fixture phone"
            )).firstMatch
        XCTAssertTrue(reviewedLabel.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(
            app.descendants(matching: .any)["Open applications on fixture-mac"].exists)

        app.buttons["Cancel"].tap()
        XCTAssertTrue(scan.waitForExistence(timeout: 5), "Explicit Cancel returns review to idle")
        XCTAssertFalse(pair.exists)
    }

    func testBrowserMutationUnknownSurvivesProcessRelaunchUntilExplicitRead() {
        let identifier = UUID().uuidString.lowercased()
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-browser-unknown-relaunch-fixture", identifier]
        defer {
            if app.state != .notRunning { app.terminate() }
            app.launchArguments = ["--ellie-ui-browser-unknown-cleanup", identifier]
            app.launch()
            let cleanup = app.staticTexts["browser-fixture-cleanup"]
            XCTAssertTrue(cleanup.waitForExistence(timeout: 5))
            XCTAssertEqual(cleanup.label, "Fixture cleanup: complete")
            app.terminate()
        }
        app.launch()

        selectFixtureMacA(in: app)
        let browser = app.buttons["Control selected Mac browser"]
        XCTAssertTrue(browser.waitForExistence(timeout: 5))
        let browserEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: browser)
        XCTAssertEqual(XCTWaiter.wait(for: [browserEnabled], timeout: 5), .completed)
        browser.tap()
        let read = app.buttons["Read current page"]
        XCTAssertTrue(read.waitForExistence(timeout: 5))
        read.tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        let result = app.buttons["browser-result-1"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        result.tap()

        let mutations = app.staticTexts["browser-fixture-mutation-count"]
        let marker = app.staticTexts["browser-fixture-persisted-marker"]
        XCTAssertTrue(mutations.waitForExistence(timeout: 5))
        XCTAssertTrue(marker.waitForExistence(timeout: 5))
        XCTAssertEqual(XCTWaiter.wait(for: [
            XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label == %@", "Fixture mutations: 1"),
                object: mutations),
            XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label == %@", "Fixture marker: present"),
                object: marker),
        ], timeout: 5), .completed)
        app.terminate()

        app.launchArguments = [
            "--ellie-ui-browser-unknown-relaunch-fixture", identifier,
            "--ellie-ui-browser-unknown-fail-read-once",
        ]
        app.launch()
        XCTAssertTrue(app.navigationBars["Mac controls"].waitForExistence(timeout: 5))
        selectFixtureMacA(in: app)
        let reopened = app.buttons["Control selected Mac browser"]
        XCTAssertTrue(reopened.waitForExistence(timeout: 5))
        let reopenedEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: reopened)
        XCTAssertEqual(XCTWaiter.wait(for: [reopenedEnabled], timeout: 5), .completed)
        reopened.tap()
        XCTAssertTrue(app.descendants(matching: .any)["browser-status-unknown"]
            .waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Mac A page"].exists)
        let relaunchedMutations = app.staticTexts["browser-fixture-mutation-count"]
        let relaunchedMarker = app.staticTexts["browser-fixture-persisted-marker"]
        XCTAssertEqual(relaunchedMutations.label, "Fixture mutations: 0")
        XCTAssertEqual(relaunchedMarker.label, "Fixture marker: present")
        let noReplay = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "Fixture mutations: 0"),
            object: relaunchedMutations)
        noReplay.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [noReplay], timeout: 1), .completed)

        app.buttons["Read current page"].tap()
        XCTAssertTrue(app.staticTexts["The coordinator is unavailable."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["browser-status-pending-warning"]
            .waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["browser-status-unknown"].exists)
        XCTAssertEqual(relaunchedMarker.label, "Fixture marker: present")
        XCTAssertEqual(relaunchedMutations.label, "Fixture mutations: 0")

        let retryRead = app.buttons["Read current page"]
        let retryEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: retryRead)
        XCTAssertEqual(XCTWaiter.wait(for: [retryEnabled], timeout: 5), .completed)
        app.buttons["Read current page"].tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["browser-status-unknown"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["browser-status-pending-warning"].exists)
        XCTAssertEqual(relaunchedMutations.label, "Fixture mutations: 0")
        let markerCleared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture marker: absent"),
            object: relaunchedMarker)
        XCTAssertEqual(XCTWaiter.wait(for: [markerCleared], timeout: 5), .completed)
        let down = app.buttons["Down"]
        let downEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: down)
        XCTAssertEqual(XCTWaiter.wait(for: [downEnabled], timeout: 5), .completed)
        down.tap()
        let explicitMutation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture mutations: 1"),
            object: relaunchedMutations)
        XCTAssertEqual(XCTWaiter.wait(for: [explicitMutation], timeout: 5), .completed)
    }

    private func selectFixtureMacA(in app: XCUIApplication) {
        let target = app.descendants(matching: .any)["phone-target-picker"]
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        let macA = app.buttons["Fixture Mac A"]
        XCTAssertTrue(macA.waitForExistence(timeout: 5))
        macA.tap()
    }

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
        let backgroundCount = app.staticTexts["browser-fixture-background-count"]
        XCTAssertTrue(backgroundCount.waitForExistence(timeout: 5))
        XCTAssertEqual(backgroundCount.label, "Fixture backgrounds: 0")

        XCUIDevice.shared.press(.home)
        let stateHistory = ApplicationStateHistory()
        let backgrounded = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                let state = app.state
                stateHistory.record(state)
                switch state {
                case .runningBackground, .runningBackgroundSuspended: return true
                case .unknown, .notRunning, .runningForeground: return false
                @unknown default: return false
                }
            },
            object: NSObject())
        let stateResult = XCTWaiter.wait(for: [backgrounded], timeout: 5)
        let stateDiagnostic =
            "XCUIApplication background observation: result=\(stateResult.rawValue), "
            + "states=\(stateHistory.summary)"
        print(stateDiagnostic)
        XCTContext.runActivity(named: "XCUIApplication background observation") { activity in
            let attachment = XCTAttachment(string: stateDiagnostic)
            attachment.lifetime = .keepAlways
            activity.add(attachment)
        }
        app.activate()
        XCTAssertTrue(backgroundCount.waitForExistence(timeout: 5))
        let recordedBackground = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture backgrounds: 1"),
            object: backgroundCount)
        XCTAssertEqual(XCTWaiter.wait(for: [recordedBackground], timeout: 5), .completed)
        XCTAssertTrue(
            app.descendants(matching: .any)["browser-status-unknown"].waitForExistence(timeout: 5))
        XCTAssertEqual(mutationCount.label, "Fixture mutations: 2")
        let noReplay = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "Fixture mutations: 2"),
            object: mutationCount)
        noReplay.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [noReplay], timeout: 1), .completed)
    }

    func testChangingMacThroughPhoneControlClearsObservedBrowserPage() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-browser-target-fixture"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Mac controls"].waitForExistence(timeout: 5))
        let browser = app.buttons["Control selected Mac browser"]
        let browserEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: browser)
        XCTAssertEqual(XCTWaiter.wait(for: [browserEnabled], timeout: 5), .completed)
        browser.tap()

        let read = app.buttons["Read current page"]
        XCTAssertTrue(read.waitForExistence(timeout: 5))
        read.tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["browser-result-1"].exists)
        XCTAssertEqual(app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
        XCTAssertEqual(
            app.staticTexts["browser-fixture-read-history"].label,
            "Fixture reads: ui-fixture-mac-a")

        app.navigationBars["Browser control"].buttons["Mac controls"].tap()
        let target = app.descendants(matching: .any)["phone-target-picker"]
        XCTAssertTrue(target.waitForExistence(timeout: 5))
        target.tap()
        let macB = app.buttons["Fixture Mac B"]
        XCTAssertTrue(macB.waitForExistence(timeout: 5))
        macB.tap()
        app.buttons["Control selected Mac browser"].tap()

        XCTAssertTrue(app.navigationBars["Browser control"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Mac A page"].exists)
        XCTAssertFalse(app.buttons["browser-result-1"].exists)
        XCTAssertEqual(app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
        XCTAssertEqual(
            app.staticTexts["browser-fixture-read-history"].label,
            "Fixture reads: ui-fixture-mac-a")

        app.buttons["Read current page"].tap()
        XCTAssertTrue(app.staticTexts["Mac B page"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["browser-result-1"].exists)
        XCTAssertEqual(app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
        XCTAssertEqual(
            app.staticTexts["browser-fixture-read-history"].label,
            "Fixture reads: ui-fixture-mac-a,ui-fixture-mac-b")
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

private final class ApplicationStateHistory {
    private let lock = NSLock()
    private var states: [String] = []

    func record(_ state: XCUIApplication.State) {
        lock.lock()
        defer { lock.unlock() }
        states.append("\(name(of: state))(\(state.rawValue))")
        if states.count > 16 {
            states.removeFirst(states.count - 16)
        }
    }

    var summary: String {
        lock.lock()
        defer { lock.unlock() }
        return states.joined(separator: ", ")
    }

    private func name(of state: XCUIApplication.State) -> String {
        switch state {
        case .unknown: return "unknown"
        case .notRunning: return "notRunning"
        case .runningBackgroundSuspended: return "runningBackgroundSuspended"
        case .runningBackground: return "runningBackground"
        case .runningForeground: return "runningForeground"
        @unknown default: return "unrecognized"
        }
    }
}
