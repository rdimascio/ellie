import XCTest

final class EllieIOSUITests: XCTestCase {
    func testNotesPersistAndDashboardDeletionReturnsToList() {
        let app = XCUIApplication()
        app.launch()
        app.staticTexts["Home"].tap()
        app.buttons["Add a note"].tap()
        let note = "Remember the blue mug"
        app.textViews.firstMatch.tap()
        app.textViews.firstMatch.typeText(note)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.buttons["note-note"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["note-note"].label, note)
        app.terminate()
        app.launch()
        app.staticTexts["Home"].tap()
        XCTAssertTrue(app.buttons["note-note"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["note-note"].label, note)
        app.navigationBars.buttons.firstMatch.tap()

        app.buttons["new-dashboard"].tap()
        app.textFields["Name"].typeText("Kitchen")
        app.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["Kitchen"].waitForExistence(timeout: 2))
        app.staticTexts["Kitchen"].tap()
        app.buttons["Dashboard options"].tap()
        app.buttons["Rename Dashboard"].tap()
        let field = app.textFields["Name"]
        field.tap(); field.typeText(" Notes")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Kitchen Notes"].waitForExistence(timeout: 2))
        app.buttons["Dashboard options"].tap()
        app.buttons["Delete Dashboard"].tap()
        app.buttons["Delete dashboard"].tap()
        XCTAssertTrue(app.navigationBars["Ellie"].waitForExistence(timeout: 2))
        XCTAssertFalse(app.staticTexts["Kitchen Notes"].exists)
    }
}
