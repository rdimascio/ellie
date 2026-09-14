import XCTest

final class EllieIOSUITests: XCTestCase {
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

    func testNotesPersistAndDashboardDeletionReturnsToList() {
        let app = XCUIApplication()
        app.launch()
        openDashboard(named: "Home", identifiedBy: "dashboard-home", in: app)
        app.buttons["Add a note"].tap()
        let note = "Remember the blue mug"
        let noteEditor = app.textViews.firstMatch
        noteEditor.tap()
        typeTextReliably(note, into: noteEditor)
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
        typeTextReliably("Kitchen", into: app.textFields["Name"])
        app.buttons["Create"].tap()
        openDashboard(named: "Kitchen", in: app)
        app.buttons["dashboard-options"].tap()
        app.buttons["Rename Dashboard"].tap()
        let field = app.textFields["Name"]
        field.tap()
        typeTextReliably(" Notes", into: field, startingWith: "Kitchen")
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

    private func typeTextReliably(_ text: String, into element: XCUIElement, startingWith initial: String = "") {
        element.typeText(text)
        let expected = initial + text
        XCTAssertEqual(element.value as? String, expected, "Expected input value \(expected)")
    }
}
