import XCTest

final class EllieIOSUITests: XCTestCase {
    func testGmailRequiresExplicitBodyReadAndCancelsLateOrRevokedResults() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-gmail-read-fixture"]
        app.launch()
        defer { app.terminate() }
        let reads = app.staticTexts["ios-gmail-fixture-reads"]
        XCTAssertEqual(reads.label, "Fixture body reads: 0")
        app.buttons["ios-gmail-refresh"].tap()
        let account = app.buttons["ios-gmail-account-fixture_gmail"]
        XCTAssertTrue(account.waitForExistence(timeout: 5))
        account.tap()
        let message = app.buttons["ios-gmail-message-fixture_message"]
        XCTAssertTrue(message.waitForExistence(timeout: 5))
        XCTAssertEqual(reads.label, "Fixture body reads: 0",
            "listing and preview must not fetch full message bodies")
        app.buttons["Hold next body"].tap()
        message.tap()
        let oneRead = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture body reads: 1"), object: reads)
        XCTAssertEqual(XCTWaiter.wait(for: [oneRead], timeout: 5), .completed)
        app.buttons["ios-gmail-cancel"].tap()
        app.buttons["Release held body"].tap()
        let form = app.scrollViews.firstMatch
        XCTAssertTrue(form.waitForExistence(timeout: 5))
        let bodies = app.descendants(matching: .any).matching(identifier: "ios-gmail-body")
        for _ in 0..<4 { form.swipeUp() }
        let cancelledBody = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true"), object: bodies.firstMatch)
        cancelledBody.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [cancelledBody], timeout: 1), .completed,
            "cancelled response must not restore private body")
        XCTAssertEqual(bodies.count, 0)
        for _ in 0..<4 where !message.isHittable { form.swipeDown() }
        XCTAssertTrue(message.isHittable)
        message.tap()
        for _ in 0..<4 where bodies.count == 0 { form.swipeUp() }
        XCTAssertTrue(bodies.firstMatch.waitForExistence(timeout: 5),
            "An explicit second read must expose the body in the lazy Gmail Form")
        XCTAssertEqual(bodies.count, 1)
        XCTAssertEqual(bodies.firstMatch.label, "Transient fixture message body")
        app.buttons["Hold next body"].tap()
        for _ in 0..<4 where !message.isHittable { form.swipeDown() }
        XCTAssertTrue(message.isHittable)
        message.tap()
        let thirdRead = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture body reads: 3"), object: reads)
        XCTAssertEqual(XCTWaiter.wait(for: [thirdRead], timeout: 5), .completed)
        app.buttons["Revoke fixture"].tap()
        for _ in 0..<4 { form.swipeDown() }
        let notice = app.staticTexts["ios-gmail-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 5))
        XCTAssertTrue(notice.label.contains("access was removed"))
        for _ in 0..<4 { form.swipeUp() }
        XCTAssertFalse(bodies.firstMatch.exists)
        XCTAssertFalse(message.exists)
    }

    func testCalendarRequiresExplicitReadAndKeepsFailedReadVisiblyCached() throws {
        let app = XCUIApplication()
        let session = UUID().uuidString
        app.launchArguments = ["--ellie-ui-home-appearance-fixture", "--ellie-ui-calendar-session", session]
        defer {
            app.terminate()
            app.launchArguments.append("--ellie-ui-calendar-cleanup")
            app.launch()
            app.terminate()
        }
        app.launch()
        let calls = app.staticTexts["home-fixture-agenda-calls"]
        XCTAssertEqual(calls.label, "Fixture agenda requests: 0")
        app.buttons["home-fixture-load-pairing"].tap()
        openDashboard(named: "Home", in: app)
        let refresh = try revealWeatherControl(app.buttons["ios-agenda-refresh"], in: app)
        XCTAssertEqual(calls.label, "Fixture agenda requests: 0",
            "Opening the native calendar widget must not read an account")
        refresh.tap()
        XCTAssertTrue(app.buttons["ios-agenda-account"].waitForExistence(timeout: 5))
        try revealWeatherControl(app.buttons["ios-agenda-account"], in: app).tap()
        app.buttons["Fixture Google account"].tap()
        try revealWeatherControl(app.buttons["ios-agenda-refresh"], in: app).tap()
        XCTAssertTrue(app.staticTexts["Fixture calendar event"].waitForExistence(timeout: 5))
        XCTAssertEqual(calls.label, "Fixture agenda requests: 3")
        app.buttons["home-fixture-agenda-fail-next"].tap()
        try revealWeatherControl(app.buttons["ios-agenda-refresh"], in: app).tap()
        XCTAssertTrue(app.staticTexts["ios-agenda-message"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["ios-agenda-message"].label.contains("Offline"))
        XCTAssertTrue(app.staticTexts["Fixture calendar event"].exists,
            "A failed read retains the same-session snapshot with a cached label")
        app.terminate()
        app.launch()
        app.buttons["home-fixture-load-pairing"].tap()
        openDashboard(named: "Home", in: app)
        XCTAssertEqual(calls.label, "Fixture agenda requests: 0")
        XCTAssertFalse(app.staticTexts["Fixture calendar event"].exists,
            "A relaunch must not redisplay old private event data before explicit Refresh")
    }

    func testWeatherRequiresOptInUsesChosenPlaceAndCanBeDisabled() throws {
        let app = XCUIApplication()
        let weatherSession = UUID().uuidString
        app.launchArguments = ["--ellie-ui-home-appearance-fixture", "--ellie-ui-weather-session", weatherSession]
        defer {
            app.terminate()
            app.launchArguments.append("--ellie-ui-weather-cleanup")
            app.launch()
            app.terminate()
        }
        app.launch()
        let calls = app.staticTexts["home-fixture-weather-calls"]
        XCTAssertEqual(calls.label, "Fixture weather requests: 0")
        openDashboard(named: "Home", in: app)
        try revealWeatherControl(app.buttons["ios-weather-setup"], in: app).tap()
        XCTAssertEqual(calls.label, "Fixture weather requests: 0")
        app.buttons["Cancel"].tap()
        XCTAssertEqual(calls.label, "Fixture weather requests: 0",
            "Opening and cancelling setup must not opt in")
        try revealWeatherControl(app.buttons["ios-weather-setup"], in: app).tap()
        try setWeatherEnable(in: app, expectedValue: "1")
        try typeTextReliably("London QA", into: revealWeatherControl(app.textFields["ios-weather-name"], in: app, editor: true), in: app)
        try typeTextReliably("51.5074", into: revealWeatherControl(app.textFields["ios-weather-latitude"], in: app, editor: true), in: app)
        try typeTextReliably("-0.1278", into: revealWeatherControl(app.textFields["ios-weather-longitude"], in: app, editor: true), in: app)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["ios-weather-place"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["ios-weather-place"].label, "London QA")
        XCTAssertTrue(app.staticTexts["Partly cloudy"].waitForExistence(timeout: 5))
        XCTAssertEqual(calls.label, "Fixture weather requests: 1")
        app.buttons["home-fixture-weather-fail-next"].tap()
        let refresh = try revealWeatherControl(app.buttons["ios-weather-refresh"], in: app)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"), object: refresh)], timeout: 5), .completed)
        refresh.tap()
        XCTAssertTrue(app.staticTexts["ios-weather-error"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["ios-weather-freshness"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["ios-weather-freshness"].label.contains("Cached forecast"),
            "A failed refresh must keep the prior value and mark it cached")
        XCTAssertEqual(calls.label, "Fixture weather requests: 2")
        app.terminate()
        app.launch()
        openDashboard(named: "Home", in: app)
        XCTAssertEqual(app.staticTexts["ios-weather-place"].label, "London QA")
        XCTAssertTrue(app.staticTexts["Partly cloudy"].exists,
            "The private cache should survive an app relaunch")
        XCTAssertTrue(app.staticTexts["ios-weather-freshness"].label.contains("Cached forecast"),
            "A restored value must identify itself as cached even when less than 30 minutes old")
        XCTAssertEqual(calls.label, "Fixture weather requests: 0",
            "Fresh persisted weather must not cause an implicit second request")
        returnToDashboardList(from: "Home", in: app)
        let other = "Weather QA \(UUID().uuidString.prefix(8))"
        app.buttons["new-dashboard"].tap()
        try typeTextReliably(other, into: app.textFields["Name"], in: app)
        app.buttons["Create"].tap()
        openDashboard(named: other, in: app)
        app.buttons["Add widget"].tap()
        app.buttons["Add Weather"].tap()
        XCTAssertTrue(app.staticTexts["ios-weather-place"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["ios-weather-place"].label, "London QA")
        XCTAssertEqual(calls.label, "Fixture weather requests: 0",
            "A second dashboard must reuse the same fresh cached forecast")
        try revealWeatherControl(app.buttons["ios-weather-settings"], in: app).tap()
        try setWeatherEnable(in: app, expectedValue: "0")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["ios-weather-setup"].waitForExistence(timeout: 5))
        XCTAssertEqual(calls.label, "Fixture weather requests: 0",
            "Disabling must not send another forecast request")
        returnToDashboardList(from: other, in: app)
        openDashboard(named: "Home", in: app)
        XCTAssertTrue(app.buttons["ios-weather-setup"].waitForExistence(timeout: 5),
            "Disabling shared weather must clear the first dashboard too")
    }

    private enum WeatherControlError: Error { case unavailable }

    private func setWeatherEnable(in app: XCUIApplication, expectedValue: String) throws {
        let row = try revealWeatherControl(app.switches["ios-weather-enable"], in: app, editor: true)
        let toggle = row.switches.firstMatch
        guard toggle.waitForExistence(timeout: 5), toggle.isHittable else {
            throw weatherControlFailure("Physical weather opt-in switch was not reachable in the open editor", in: app)
        }
        toggle.tap()
        let value = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", expectedValue), object: row)
        guard XCTWaiter.wait(for: [value], timeout: 5) == .completed else {
            throw weatherControlFailure("Weather opt-in switch did not reach value \(expectedValue) in the open editor", in: app)
        }
    }

    private func weatherControlFailure(_ message: String, in app: XCUIApplication) -> WeatherControlError {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "weather-control-first-unmet-screenshot"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "weather-control-first-unmet-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTFail(message)
        return .unavailable
    }

    private func revealWeatherControl(_ element: XCUIElement, in app: XCUIApplication,
                                      editor: Bool = false) throws -> XCUIElement {
        let navigation = app.navigationBars["Edit Weather"]
        let container = editor
            ? app.descendants(matching: .any).matching(identifier: "ios-widget-editor-form").firstMatch
            : app.scrollViews["ios-dashboard-detail-scroll"]
        guard container.waitForExistence(timeout: 5), !editor || navigation.exists else {
            throw weatherControlFailure("Expected the active weather editor or dashboard scroll container", in: app)
        }
        for _ in 0..<4 {
            if element.exists && element.isHittable { return element }
            guard !editor || (navigation.exists && container.exists) else {
                throw weatherControlFailure("Weather editor disappeared before its control was reachable", in: app)
            }
            container.swipeUp()
        }
        if !editor {
            for _ in 0..<4 {
                if element.exists && element.isHittable { return element }
                container.swipeDown()
            }
        }
        guard element.exists && element.isHittable, !editor || (navigation.exists && container.exists) else {
            throw weatherControlFailure("Expected weather control \(element.identifier) in the active \(editor ? "editor" : "dashboard")", in: app)
        }
        return element
    }

    func testHomeLifeEntryRequiresExplicitTapAndFollowsEnrollment() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-home-appearance-fixture"]
        app.launch()

        let life = app.buttons["open-ellie-life"]
        let opens = app.staticTexts["home-fixture-life-opens"]
        let reads = app.staticTexts["home-fixture-vault-reads"]
        let transport = app.staticTexts["home-fixture-transport-calls"]
        XCTAssertTrue(opens.waitForExistence(timeout: 5))
        XCTAssertEqual(opens.label, "Fixture Life opens: 0")
        XCTAssertEqual(reads.label, "Fixture vault reads: 0")
        XCTAssertEqual(transport.label, "Fixture transport calls: 0")
        XCTAssertFalse(life.exists)
        keepHomeScreenshot(app, name: "native-home-normal")

        app.buttons["home-fixture-load-pairing"].tap()
        XCTAssertTrue(life.waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(identifier: "open-ellie-life").count, 1)
        XCTAssertEqual(reads.label, "Fixture vault reads: 1")
        XCTAssertEqual(opens.label, "Fixture Life opens: 0")
        XCTAssertFalse(app.staticTexts["home-fixture-life-destination"].exists)
        fullyExposeHomeControl(life, in: app)
        keepHomeScreenshot(app, name: "native-home-normal-life-entry")
        life.tap()
        let destination = app.staticTexts["home-fixture-life-destination"]
        XCTAssertTrue(destination.waitForExistence(timeout: 5))
        XCTAssertEqual(destination.label, "Synthetic Life destination: home-fixture-phone")
        let opened = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture Life opens: 1"), object: opens)
        XCTAssertEqual(XCTWaiter.wait(for: [opened], timeout: 5), .completed)
        XCTAssertEqual(transport.label, "Fixture transport calls: 0")

        returnToDashboardList(from: "Fixture Life", in: app)
        app.buttons["home-fixture-remove-pairing"].tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: life)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 5), .completed)
        XCTAssertEqual(opens.label, "Fixture Life opens: 1")
        XCTAssertEqual(transport.label, "Fixture transport calls: 0")
    }

    func testNarrowHomeKeepsNavigationReachableAtRegularAndAccessibilitySizes() {
        let app = XCUIApplication()
        for accessibility in [false, true] {
            app.launchArguments = ["--ellie-ui-home-appearance-fixture", "--ellie-ui-home-narrow"]
            if accessibility { app.launchArguments.append("--ellie-ui-home-accessibility") }
            app.launch()
            let appearance = accessibility ? "accessibility5" : "regular"

            let scroll = app.scrollViews["dashboard-list"]
            XCTAssertTrue(scroll.waitForExistence(timeout: 5))
            XCTAssertEqual(scroll.frame.width, 320, accuracy: 1)
            let title = app.staticTexts["home-invitation-title"]
            if accessibility {
                XCTAssertFalse(title.exists, "Promotional copy must not push accessibility navigation below the fold")
                XCTAssertTrue(homeViewport(in: app).contains(app.buttons["dashboard-home"].frame),
                    "The first dashboard must be fully visible without scrolling at accessibility size 5")
            } else {
                XCTAssertTrue(title.waitForExistence(timeout: 5))
                XCTAssertTrue(title.label.contains("A little more"))
                XCTAssertTrue(title.label.contains("headspace."))
                XCTAssertGreaterThanOrEqual(title.frame.minX, scroll.frame.minX)
                XCTAssertLessThanOrEqual(title.frame.maxX, scroll.frame.maxX)
            }
            keepHomeScreenshot(app, name: "native-home-320-\(appearance)-\(accessibility ? "overview" : "invitation")")

            for identifier in ["dashboard-home", "coordinator-enrollment"] {
                let control = app.buttons[identifier]
                fullyExposeHomeControl(control, in: app)
                XCTAssertGreaterThanOrEqual(control.frame.height, 44)
                XCTAssertGreaterThanOrEqual(control.frame.minX, scroll.frame.minX)
                XCTAssertLessThanOrEqual(control.frame.maxX, scroll.frame.maxX)
                if identifier == "dashboard-home" {
                    XCTAssertEqual(control.label, "Home")
                    if accessibility {
                        XCTAssertLessThan(control.frame.height, scroll.frame.width * 0.75,
                            "A short Home label and widget count must not form the tall, character-wrapped card seen in the failed capture")
                    }
                    keepHomeScreenshot(app, name: "native-home-320-\(appearance)-dashboard")
                } else {
                    XCTAssertEqual(control.label, "Pair this iPhone")
                }
            }
            keepHomeScreenshot(app, name: "native-home-320-\(appearance)-navigation")
            app.buttons["coordinator-enrollment"].tap()
            XCTAssertTrue(app.navigationBars["Coordinator"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["Scan enrollment code"].waitForExistence(timeout: 5))
            XCTAssertEqual(app.staticTexts["home-fixture-vault-reads"].label, "Fixture vault reads: 0")
            XCTAssertEqual(app.staticTexts["home-fixture-transport-calls"].label, "Fixture transport calls: 0")
            if accessibility {
                returnToDashboardList(from: "Coordinator", in: app)
                app.buttons["home-fixture-load-pairing"].tap()
                let life = app.buttons["open-ellie-life"]
                XCTAssertTrue(life.waitForExistence(timeout: 5))
                fullyExposeHomeControl(life, in: app)
                XCTAssertEqual(life.label, "Open Ellie Life")
                XCTAssertEqual(app.staticTexts["home-fixture-life-opens"].label, "Fixture Life opens: 0")
                XCTAssertEqual(app.staticTexts["home-fixture-transport-calls"].label, "Fixture transport calls: 0")
                keepHomeScreenshot(app, name: "native-home-320-accessibility5-life-entry")
            }
            app.terminate()
        }
    }

    private func keepHomeScreenshot(_ app: XCUIApplication, name: String) {
        guard app.launchArguments.contains("--ellie-ui-home-appearance-fixture") else {
            XCTFail("Appearance screenshots require the isolated home fixture")
            return
        }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func homeViewport(in app: XCUIApplication) -> CGRect {
        let scroll = app.scrollViews["dashboard-list"].frame
        let footer = app.descendants(matching: .any)["home-fixture-controls"]
        XCTAssertTrue(footer.exists)
        let top = max(scroll.minY, app.navigationBars["Ellie"].frame.maxY)
        let bottom = min(scroll.maxY, footer.frame.minY)
        XCTAssertGreaterThan(bottom, top)
        return CGRect(x: scroll.minX, y: top, width: scroll.width, height: max(0, bottom - top))
            .insetBy(dx: 1, dy: 4)
    }

    private func fullyExposeHomeControl(_ control: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["dashboard-list"]
        XCTAssertTrue(control.waitForExistence(timeout: 5))
        for _ in 0..<12 {
            let viewport = homeViewport(in: app)
            let frame = control.frame
            if viewport.contains(frame) && control.isHittable { break }
            guard frame.height <= viewport.height else { break }
            let upward = frame.maxY > viewport.maxY
            let distance = min(max(upward ? frame.maxY - viewport.maxY : viewport.minY - frame.minY, 20),
                viewport.height * 0.5)
            let startY = upward ? viewport.maxY - 20 : viewport.minY + 20
            let endY = startY + (upward ? -distance : distance)
            let origin = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let start = origin.withOffset(CGVector(dx: viewport.midX - scroll.frame.minX, dy: startY - scroll.frame.minY))
            let end = origin.withOffset(CGVector(dx: viewport.midX - scroll.frame.minX, dy: endY - scroll.frame.minY))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(control.isHittable)
        XCTAssertTrue(homeViewport(in: app).contains(control.frame),
            "The complete target card must be below the navigation bar and above the fixture controls before capture")
    }

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

        let recoveryRead = app.buttons["Read current page"]
        XCTAssertTrue(recoveryRead.waitForExistence(timeout: 5))
        recoveryRead.tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.descendants(matching: .any)["browser-status-unknown"].exists)
        XCTAssertEqual(mutationCount.label, "Fixture mutations: 2")
        XCTAssertTrue(app.buttons["Play"].isEnabled)
    }

    func testReviewedNetflixVoiceScrollRequiresExplicitRowChoiceAndRun() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ellie-ui-reviewed-browser-fixture", "--ellie-ui-browser-netflix-voice-rows"
        ]
        app.launch()
        let count = app.staticTexts["browser-fixture-mutation-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        func reviewScroll() {
            let check = app.buttons["speech-check"]
            if check.exists { check.tap() }
            let record = app.buttons["speech-record"]
            XCTAssertTrue(record.waitForExistence(timeout: 5))
            record.tap()
            let stop = app.buttons["speech-stop"]
            XCTAssertTrue(stop.waitForExistence(timeout: 5))
            stop.tap()
            let transcript = app.textViews["speech-transcript"]
            XCTAssertTrue(transcript.waitForExistence(timeout: 5))
            XCTAssertEqual(transcript.value as? String, "Scroll right")
        }
        func row(_ index: Int) -> XCUIElement {
            let target = app.buttons["speech-netflix-row-\(index)"]
            for _ in 0..<4 where !target.exists { app.swipeUp() }
            XCTAssertTrue(target.waitForExistence(timeout: 5))
            return target
        }
        reviewScroll()
        let run = app.buttons["speech-browser-run"]
        XCTAssertTrue(run.waitForExistence(timeout: 5))
        XCTAssertFalse(run.isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        app.buttons["speech-browser-read"].tap()
        XCTAssertTrue(row(2).waitForExistence(timeout: 5))
        XCTAssertFalse(run.isEnabled)
        row(2).tap()
        XCTAssertTrue(app.staticTexts["speech-netflix-row-review"].label.contains(
            "Row 2: New on Fixture Mac A"))
        XCTAssertTrue(run.isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        run.tap()
        waitForFixtureMutations(1, in: app)
        XCTAssertFalse(app.buttons["speech-netflix-row-2"].exists)

        reviewScroll()
        XCTAssertFalse(run.isEnabled, "the old row choice cannot authorize a later turn")
        app.buttons["speech-browser-read"].tap()
        XCTAssertTrue(row(1).waitForExistence(timeout: 5))
        XCTAssertFalse(run.isEnabled, "a fresh read still needs an explicit row choice")
        XCTAssertEqual(count.label, "Fixture mutations: 1")
    }

    func testReviewedNetflixVoiceSearchNeedsObservedFieldThenFreshResultsRead() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ellie-ui-reviewed-browser-fixture", "--ellie-ui-browser-complete-actions",
            "--ellie-ui-browser-netflix-voice-search"
        ]
        app.launch()
        let count = app.staticTexts["browser-fixture-mutation-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        app.buttons["speech-check"].tap()
        XCTAssertTrue(app.buttons["speech-record"].waitForExistence(timeout: 5))
        app.buttons["speech-record"].tap()
        XCTAssertTrue(app.buttons["speech-stop"].waitForExistence(timeout: 5))
        app.buttons["speech-stop"].tap()
        XCTAssertEqual(app.textViews["speech-transcript"].value as? String,
                       "Search for public video")
        let run = app.buttons["speech-browser-run"]
        XCTAssertTrue(run.waitForExistence(timeout: 5))
        XCTAssertFalse(run.isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        app.buttons["speech-browser-read"].tap()
        let review = app.staticTexts["speech-netflix-search-review"]
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        XCTAssertTrue(review.label.contains("Search field on Fixture Mac A"))
        XCTAssertTrue(run.isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        run.tap()
        waitForFixtureMutations(1, in: app)
        let updatedRead = app.buttons["speech-browser-read-updated"]
        XCTAssertTrue(updatedRead.waitForExistence(timeout: 5))
        updatedRead.tap()
        let continueButton = app.buttons["speech-browser-continue"]
        XCTAssertTrue(continueButton.waitForExistence(timeout: 5))
        continueButton.tap()
        XCTAssertTrue(app.staticTexts["browser-observed-site"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["browser-observed-site"].label,
                       "Observed Netflix search results")
        let result = revealBrowserButton("browser-result-1", in: app, forTap: true)
        result.tap()
        waitForFixtureMutations(2, in: app)
    }

    func testReviewedVoiceRequiresFreshPageBetweenSearchSelectionAndPlayback() {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ellie-ui-reviewed-browser-fixture", "--ellie-ui-browser-complete-actions"
        ]
        app.launch()

        let count = app.staticTexts["browser-fixture-mutation-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        app.buttons["speech-check"].tap()
        XCTAssertTrue(app.buttons["speech-record"].waitForExistence(timeout: 5))
        app.buttons["speech-record"].tap()
        XCTAssertTrue(app.buttons["Cancel recording"].waitForExistence(timeout: 5))
        app.buttons["Cancel recording"].tap()
        XCTAssertTrue(app.buttons["speech-check"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.textViews["speech-transcript"].exists)
        XCTAssertEqual(count.label, "Fixture mutations: 0")

        app.buttons["speech-check"].tap()
        XCTAssertTrue(app.buttons["speech-record"].waitForExistence(timeout: 5))
        app.buttons["speech-record"].tap()
        XCTAssertTrue(app.buttons["speech-stop"].waitForExistence(timeout: 5))
        app.buttons["speech-stop"].tap()
        XCTAssertTrue(app.textViews["speech-transcript"].waitForExistence(timeout: 5))
        app.buttons["Discard transcript"].tap()
        XCTAssertFalse(app.textViews["speech-transcript"].exists)
        XCTAssertEqual(count.label, "Fixture mutations: 0")

        // A separate reviewed turn is required after discard. Its transcript remains inert
        // until the page has been observed and the person taps Run.
        XCTAssertTrue(app.buttons["speech-record"].waitForExistence(timeout: 5))
        app.buttons["speech-record"].tap()
        XCTAssertTrue(app.buttons["speech-stop"].waitForExistence(timeout: 5))
        app.buttons["speech-stop"].tap()
        let transcript = app.textViews["speech-transcript"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 5))
        XCTAssertEqual(transcript.value as? String, "Search for public video")
        let run = app.buttons["speech-browser-run"]
        XCTAssertTrue(run.waitForExistence(timeout: 5))
        XCTAssertFalse(run.isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        app.buttons["speech-browser-read"].tap()
        let runEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: run)
        XCTAssertEqual(XCTWaiter.wait(for: [runEnabled], timeout: 5), .completed)
        XCTAssertEqual(count.label, "Fixture mutations: 0")
        run.tap()
        XCTAssertTrue(app.buttons["speech-browser-read-updated"].waitForExistence(timeout: 5))
        waitForFixtureMutations(1, in: app)
        XCTAssertFalse(app.buttons["speech-browser-continue"].exists)

        let updatedRead = app.buttons["speech-browser-read-updated"]
        let updatedReadEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: updatedRead)
        XCTAssertEqual(XCTWaiter.wait(for: [updatedReadEnabled], timeout: 5), .completed)
        updatedRead.tap()
        XCTAssertTrue(app.buttons["speech-browser-continue"].waitForExistence(timeout: 5))
        app.buttons["speech-browser-continue"].tap()
        XCTAssertTrue(app.navigationBars["Browser control"].waitForExistence(timeout: 5))
        let observedSite = app.staticTexts["browser-observed-site"]
        let observedPlayback = app.staticTexts["browser-observed-playback"]
        XCTAssertEqual(observedSite.label, "Observed YouTube results page")
        XCTAssertFalse(observedPlayback.exists)
        XCTAssertFalse(revealBrowserButton("Play", in: app).isEnabled)
        XCTAssertFalse(revealBrowserButton("Pause", in: app).isEnabled)
        let result = revealBrowserButton("browser-result-1", in: app, forTap: true)
        XCTAssertTrue(result.isEnabled)
        result.tap()
        waitForFixturePageToClear(in: app)
        waitForFixtureMutations(2, in: app)
        XCTAssertFalse(app.buttons["Play"].exists)
        XCTAssertFalse(observedSite.exists)

        revealBrowserButton("Read current page", in: app, forTap: true).tap()
        XCTAssertEqual(observedSite.label, "Observed YouTube watch page")
        XCTAssertEqual(observedPlayback.label, "Observed playback: paused")
        let play = revealBrowserButton("Play", in: app, forTap: true)
        XCTAssertTrue(play.isEnabled)
        XCTAssertFalse(revealBrowserButton("Pause", in: app).isEnabled)
        play.tap()
        waitForFixturePageToClear(in: app)
        waitForFixtureMutations(3, in: app)
        XCTAssertFalse(app.buttons["Pause"].exists)

        revealBrowserButton("Read current page", in: app, forTap: true).tap()
        XCTAssertEqual(observedPlayback.label, "Observed playback: playing")
        let pause = revealBrowserButton("Pause", in: app, forTap: true)
        XCTAssertTrue(pause.isEnabled)
        XCTAssertFalse(revealBrowserButton("Play", in: app).isEnabled)
        pause.tap()
        waitForFixturePageToClear(in: app)
        waitForFixtureMutations(4, in: app)
        XCTAssertFalse(observedPlayback.exists)
        revealBrowserButton("Read current page", in: app, forTap: true).tap()
        XCTAssertTrue(observedPlayback.waitForExistence(timeout: 5))
        XCTAssertEqual(observedPlayback.label, "Observed playback: paused")
        XCTAssertTrue(revealBrowserButton("Play", in: app).isEnabled)
        XCTAssertEqual(count.label, "Fixture mutations: 4")
    }

    func testReadOnlyBrowserPageDoesNotOfferEnabledMutationControls() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-browser-read-only-fixture"]
        app.launch()
        let browser = app.buttons["Control selected Mac browser"]
        XCTAssertTrue(browser.waitForExistence(timeout: 5))
        let browserEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: browser)
        XCTAssertEqual(XCTWaiter.wait(for: [browserEnabled], timeout: 5), .completed)
        browser.tap()
        XCTAssertFalse(app.buttons["Search"].exists)
        app.buttons["Read current page"].tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.descendants(matching: .any)["browser-read-only-grant-warning"].exists)
        for label in ["Search", "Up", "Down", "Left", "Right", "Play", "Pause"] {
            XCTAssertFalse(revealBrowserButton(label, in: app).isEnabled,
                "\(label) requires browser.control")
        }
        XCTAssertFalse(revealBrowserButton("browser-result-1", in: app).isEnabled)
        XCTAssertEqual(
            app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
    }

    func testUnavailableObservedPlaybackDisablesMediaActionsWithoutDispatch() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-browser-unavailable-playback-fixture"]
        app.launch()
        let browser = app.buttons["Control selected Mac browser"]
        XCTAssertTrue(browser.waitForExistence(timeout: 5))
        let browserEnabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: browser)
        XCTAssertEqual(XCTWaiter.wait(for: [browserEnabled], timeout: 5), .completed)
        browser.tap()
        app.buttons["Read current page"].tap()
        let observed = app.staticTexts["browser-observed-playback"]
        XCTAssertTrue(observed.waitForExistence(timeout: 5))
        XCTAssertEqual(observed.label, "Playback state is unavailable")
        XCTAssertFalse(revealBrowserButton("Play", in: app).isEnabled)
        XCTAssertFalse(revealBrowserButton("Pause", in: app).isEnabled)
        XCTAssertEqual(
            app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
    }

    func testNetflixRowsRequireExplicitChoiceBeforeHorizontalScroll() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-browser-netflix-rows-fixture"]
        app.launch()
        let browser = app.buttons["Control selected Mac browser"]
        XCTAssertTrue(browser.waitForExistence(timeout: 5))
        let enabled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isEnabled == true"), object: browser)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed)
        browser.tap()
        app.buttons["Read current page"].tap()
        XCTAssertTrue(app.staticTexts["Mac A page"].waitForExistence(timeout: 5))
        XCTAssertFalse(revealBrowserButton("Right", in: app).isEnabled)
        XCTAssertEqual(app.staticTexts["browser-fixture-mutation-count"].label, "Fixture mutations: 0")
        let row = revealBrowserButton("browser-netflix-row-2", in: app, forTap: true)
        XCTAssertTrue(row.label.contains("Row 2: New"))
        row.tap()
        let right = revealBrowserButton("Right", in: app, forTap: true)
        XCTAssertTrue(right.isEnabled)
        right.tap()
        waitForFixtureMutations(1, in: app)
        XCTAssertFalse(app.buttons["Right"].exists)
        XCTAssertFalse(app.buttons["browser-netflix-row-2"].exists)
    }

    private func waitForFixtureMutations(_ expected: Int, in app: XCUIApplication) {
        let count = app.staticTexts["browser-fixture-mutation-count"]
        XCTAssertTrue(count.waitForExistence(timeout: 5))
        let observed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture mutations: \(expected)"),
            object: count)
        XCTAssertEqual(XCTWaiter.wait(for: [observed], timeout: 5), .completed)
    }

    private func revealBrowserButton(_ identifier: String, in app: XCUIApplication,
                                     forTap: Bool = false) -> XCUIElement {
        let button = app.buttons[identifier]
        let list = app.collectionViews.firstMatch
        let visible = { button.exists && (!forTap || button.isHittable) }
        if !visible() {
            XCTAssertTrue(list.exists, "Expected the browser form's scrollable list")
            for _ in 0..<4 {
                if visible() { break }
                list.swipeUp()
            }
            for _ in 0..<4 {
                if visible() { break }
                list.swipeDown()
            }
        }
        XCTAssertTrue(visible(), "Expected browser control \(identifier) in the bounded form")
        return button
    }

    private func waitForFixturePageToClear(in app: XCUIApplication) {
        // Return to the top of the lazy form so absence is about page invalidation,
        // not merely an off-screen row that UIKit has not materialized.
        _ = revealBrowserButton("Read current page", in: app, forTap: true)
        let page = app.staticTexts["Mac A page"]
        let cleared = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: page)
        XCTAssertEqual(XCTWaiter.wait(for: [cleared], timeout: 5), .completed)
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
        revealHomeControl(coordinator, in: app)
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

    func testPlaylistSetupPersistsAndKeepsPlaybackAttended() throws {
        let app = XCUIApplication()
        app.launch()
        let name = "Playlist \(UUID().uuidString.prefix(8))"
        app.buttons["new-dashboard"].tap()
        try typeTextReliably(name, into: app.textFields["Name"], in: app)
        app.buttons["Create"].tap()
        openDashboard(named: name, in: app)
        app.buttons["Add widget"].tap()
        app.buttons["Add Playlist"].tap()
        let setup = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@", "playlist-setup-")).firstMatch
        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Play Playlist"].exists, "An unconfigured widget must not open media")
        setup.tap()
        let playlist = app.textFields["playlist-input"]
        let identifier = "PLC77007E23FF423C6"
        try typeTextReliably("https://www.youtube.com/playlist?list=\(identifier)",
            into: playlist, in: app)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["Play Playlist"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Close"].exists, "Saving must not start the player")

        app.terminate()
        app.launch()
        openDashboard(named: name, in: app)
        XCTAssertTrue(app.buttons["Play Playlist"].waitForExistence(timeout: 5))
        returnToDashboardList(from: name, in: app)
        openDashboard(named: name, in: app)
        app.buttons["dashboard-options"].tap()
        app.buttons["Delete Dashboard"].tap()
        app.buttons["Delete dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 5))
    }

    func testSyntheticHouseholdChoreReviewCancelAndUnknownNeverReplay() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-household-chores-fixture"]
        app.launch()
        defer { app.terminate() }

        let puts = app.staticTexts["household-chores-fixture-puts"]
        let reads = app.staticTexts["household-chores-fixture-reads"]
        XCTAssertTrue(puts.waitForExistence(timeout: 5))
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 0")
        XCTAssertEqual(reads.label, "Fixture chore GETs: 0")
        app.buttons["ios-household-chores-access"].tap()
        let read = app.buttons["ios-household-chores-read"]
        XCTAssertTrue(read.waitForExistence(timeout: 5))
        revealHouseholdControl(read, in: app).tap()
        XCTAssertTrue(app.staticTexts["Household laundry"].waitForExistence(timeout: 5))
        XCTAssertEqual(reads.label, "Fixture chore GETs: 1")

        let edit = app.buttons["ios-household-chore-edit-11111111-1111-4111-8111-111111111111"]
        revealHouseholdControl(edit, in: app).tap()
        try typeTextReliably("Take blue basket", into: app.descendants(matching: .any)["ios-household-chore-details"], in: app)
        app.buttons["ios-household-chore-prepare"].tap()
        XCTAssertTrue(app.staticTexts["Changed household chore"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Take blue basket"].exists,
            "The review must show the edited details before any PUT")
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 0")
        revealHouseholdControl(app.buttons["Cancel Prepared Change"], in: app).tap()
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 0")
        XCTAssertFalse(app.staticTexts["Changed household chore"].exists)

        revealHouseholdControl(app.buttons["ios-household-chores-read"], in: app).tap()
        XCTAssertEqual(reads.label, "Fixture chore GETs: 2",
            "Discard requires a fresh household read before another edit")
        revealHouseholdControl(edit, in: app).tap()
        try typeTextReliably("Take blue basket", into: app.descendants(matching: .any)["ios-household-chore-details"], in: app)
        app.buttons["ios-household-chore-prepare"].tap()
        XCTAssertTrue(app.staticTexts["Take blue basket"].waitForExistence(timeout: 5))
        revealHouseholdControl(app.buttons["ios-household-chores-save"], in: app).tap()
        let sent = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture chore PUTs: 1"), object: puts)
        XCTAssertEqual(XCTWaiter.wait(for: [sent], timeout: 5), .completed)
        revealHouseholdControl(app.buttons["ios-household-chores-cancel"], in: app).tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "save outcome is unknown")).firstMatch.waitForExistence(timeout: 5))
        app.buttons["household-chores-fixture-release"].tap()
        let revision = app.staticTexts["household-chores-fixture-revision"]
        let committed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture chore revision: 8"), object: revision)
        XCTAssertEqual(XCTWaiter.wait(for: [committed], timeout: 5), .completed)
        revealHouseholdControl(app.buttons["ios-household-chores-check-result"], in: app).tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "currently matches the prepared copy")).firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(reads.label, "Fixture chore GETs: 3")
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 1",
            "Cancellation and recovery must not send the prepared change again")
        XCTAssertFalse(app.buttons["ios-household-chores-save"].isEnabled)
    }

    func testSyntheticHouseholdChoreDeleteCancelThenConfirmSendsOnlyOnce() {
        let app = XCUIApplication()
        app.launchArguments = ["--ellie-ui-household-chores-fixture"]
        app.launch()
        defer { app.terminate() }

        let puts = app.staticTexts["household-chores-fixture-puts"]
        XCTAssertTrue(puts.waitForExistence(timeout: 5))
        app.buttons["ios-household-chores-access"].tap()
        revealHouseholdControl(app.buttons["ios-household-chores-read"], in: app).tap()
        let chore = app.staticTexts["Household laundry"]
        XCTAssertTrue(chore.waitForExistence(timeout: 5))

        let delete = app.buttons["Prepare deletion of Household laundry"]
        revealHouseholdControl(delete, in: app).tap()
        XCTAssertTrue(app.buttons["Prepare deletion"].waitForExistence(timeout: 5))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(chore.exists)
        XCTAssertFalse(app.staticTexts["Remove Household laundry · Alex"].exists)
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 0")

        revealHouseholdControl(delete, in: app).tap()
        app.buttons["Prepare deletion"].tap()
        XCTAssertTrue(app.staticTexts["Remove Household laundry · Alex"].waitForExistence(timeout: 5),
            "The chosen deletion must be reviewable before a shared write")
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 0")
        revealHouseholdControl(app.buttons["ios-household-chores-save"], in: app).tap()
        let sent = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Fixture chore PUTs: 1"), object: puts)
        XCTAssertEqual(XCTWaiter.wait(for: [sent], timeout: 5), .completed)
        app.buttons["household-chores-fixture-release"].tap()
        XCTAssertTrue(app.staticTexts["No household chores yet"].waitForExistence(timeout: 5))
        XCTAssertFalse(chore.exists)
        XCTAssertEqual(puts.label, "Fixture chore PUTs: 1")
    }

    private func revealHouseholdControl(_ control: XCUIElement, in app: XCUIApplication) -> XCUIElement {
        let list = app.collectionViews.firstMatch.exists
            ? app.collectionViews.firstMatch : app.scrollViews.firstMatch
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        for _ in 0..<6 {
            if control.exists && control.isHittable { return control }
            list.swipeUp()
        }
        for _ in 0..<6 {
            if control.exists && control.isHittable { return control }
            list.swipeDown()
        }
        XCTAssertTrue(control.exists && control.isHittable,
            "Expected the synthetic household chore control to be reachable")
        return control
    }

    func testLocalChoresAddCancelEditCompleteRelaunchAndDelete() throws {
        let app = XCUIApplication()
        app.launch()
        let dashboardName = "Chores \(UUID().uuidString.prefix(8))"
        let secondDashboard = "Shared chores \(UUID().uuidString.prefix(8))"
        let task = "Bins \(UUID().uuidString.prefix(8))"
        app.buttons["new-dashboard"].tap()
        try typeTextReliably(dashboardName, into: app.textFields["Name"], in: app)
        app.buttons["Create"].tap()
        openDashboard(named: dashboardName, in: app)
        app.buttons["Add widget"].tap()
        app.buttons["Add Chores"].tap()
        XCTAssertTrue(app.staticTexts["Saved on this iPhone only · Not synced"].waitForExistence(timeout: 5))
        app.buttons["ios-manage-chores"].tap()
        app.buttons["ios-chore-add"].tap()
        try typeTextReliably(task + " ", into: app.textFields["ios-chore-title"], in: app)
        try typeTextReliably("Sam", into: app.textFields["ios-chore-assignee"], in: app)
        app.buttons["ios-chore-save"].tap()

        let edit = app.buttons["Edit \(task)"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        let id = edit.identifier.replacingOccurrences(of: "ios-chore-edit-", with: "")
        XCTAssertFalse(id.isEmpty)
        edit.tap()
        try typeTextReliably(" Jr", into: app.textFields["ios-chore-assignee"], in: app, startingWith: "Sam")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Edit \(task)"].waitForExistence(timeout: 5), "Cancelling must keep the saved task")
        XCTAssertTrue((app.buttons["Edit \(task)"].value as? String)?.hasPrefix("Sam · Due ") == true,
            "Cancelling must not change the saved assignee or due day")
        app.buttons["Done"].tap()
        returnToDashboardList(from: dashboardName, in: app)

        app.buttons["new-dashboard"].tap()
        try typeTextReliably(secondDashboard, into: app.textFields["Name"], in: app)
        app.buttons["Create"].tap()
        openDashboard(named: secondDashboard, in: app)
        app.buttons["Add widget"].tap()
        app.buttons["Add Chores"].tap()
        app.buttons["ios-manage-chores"].tap()
        XCTAssertTrue(app.buttons["Edit \(task)"].waitForExistence(timeout: 5),
            "A second dashboard must show the same local chore")
        app.buttons["Edit \(task)"].tap()
        try typeTextReliably(" Jr", into: app.textFields["ios-chore-assignee"], in: app, startingWith: "Sam")
        app.buttons["ios-chore-save"].tap()
        XCTAssertTrue((app.buttons["Edit \(task)"].value as? String)?.hasPrefix("Sam Jr · Due ") == true)
        let toggle = app.buttons["ios-chore-toggle-\(id)"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(toggle.frame.width, 44)
        XCTAssertGreaterThanOrEqual(toggle.frame.height, 44)
        let delete = app.buttons["ios-chore-delete-\(id)"]
        XCTAssertGreaterThanOrEqual(delete.frame.width, 44)
        XCTAssertGreaterThanOrEqual(delete.frame.height, 44)
        toggle.tap()
        XCTAssertEqual(toggle.label, "Undo completion of \(task)")
        XCTAssertTrue(app.otherElements["ios-chores-week-chart"].exists)
        app.buttons["Done"].tap()
        returnToDashboardList(from: secondDashboard, in: app)
        openDashboard(named: dashboardName, in: app)
        app.buttons["ios-manage-chores"].tap()
        XCTAssertTrue((app.buttons["Edit \(task)"].value as? String)?.hasPrefix("Sam Jr · Due ") == true,
            "Changes from the second dashboard must be visible in the first without relaunch")
        app.buttons["Done"].tap()

        app.terminate()
        app.launch()
        openDashboard(named: dashboardName, in: app)
        app.buttons["ios-manage-chores"].tap()
        XCTAssertTrue(app.buttons["Edit \(task)"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["ios-chore-toggle-\(id)"].label, "Undo completion of \(task)")
        app.buttons["ios-chore-delete-\(id)"].tap()
        app.buttons["Delete chore"].tap()
        let removed = app.buttons["Edit \(task)"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: removed)], timeout: 5), .completed,
            "Confirming deletion must remove the chore")
        app.buttons["Done"].tap()
        app.terminate()
        app.launch()
        openDashboard(named: dashboardName, in: app)
        app.buttons["ios-manage-chores"].tap()
        XCTAssertFalse(app.buttons["Edit \(task)"].exists,
            "A deleted chore must stay absent after relaunch")
        app.buttons["Done"].tap()
        returnToDashboardList(from: dashboardName, in: app)
        openDashboard(named: dashboardName, in: app)
        app.buttons["dashboard-options"].tap()
        app.buttons["Delete Dashboard"].tap()
        app.buttons["Delete dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 5))
        openDashboard(named: secondDashboard, in: app)
        app.buttons["dashboard-options"].tap()
        app.buttons["Delete Dashboard"].tap()
        app.buttons["Delete dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 5))
    }

    private func openDashboard(named name: String, identifiedBy identifier: String? = nil, in app: XCUIApplication) {
        let link = identifier.map { app.buttons[$0] }
            ?? app.buttons.matching(NSPredicate(format: "label == %@", name)).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 5), "Expected the \(name) dashboard link")
        revealHomeControl(link, in: app)
        link.tap()
        XCTAssertTrue(app.navigationBars[name].waitForExistence(timeout: 5), "Expected the \(name) dashboard detail")
    }

    private func revealHomeControl(_ control: XCUIElement, in app: XCUIApplication) {
        let scroll = app.scrollViews["dashboard-list"]
        for _ in 0..<12 {
            if control.isHittable { break }
            scroll.swipeUp()
        }
        XCTAssertTrue(control.isHittable, "Expected the home control to remain reachable by scrolling")
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
