import XCTest

/// These tests must run on an installed paired Watch Simulator with the DEBUG Ellie iPhone
/// fixture already launched. The paired runner rejects skipped or zero-test results.
final class WatchPairedUITests: XCTestCase {
  func testTargetAReadThenOnePlayIsUnknownWithoutReplay() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()
    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    XCTAssertTrue(waitForEnabled(read, timeout: 25),
                  "WCSession did not reach the paired iPhone: \(app.staticTexts["watch-media-status"].value ?? "missing")")
    read.tap()
    let title = app.staticTexts["watch-observed-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 15))
    XCTAssertEqual(title.label, "Fixture film A")
    XCTAssertEqual(app.staticTexts["watch-observed-target"].label, "YouTube · Fixture Mac A")
    let play = app.buttons["watch-play"]
    XCTAssertTrue(waitForEnabled(play, timeout: 5))
    play.tap()
    let status = app.staticTexts["watch-media-status"]
    XCTAssertTrue(waitForLabel(status, contains: "may have run", timeout: 15))
    XCTAssertFalse(play.isEnabled, "An unknown command must consume its observed authority")
    XCTAssertFalse(app.buttons["watch-pause"].isEnabled)
    XCTAssertFalse(title.exists, "An unknown reply must not claim a fresh page")
  }

  func testTargetBNeedsFreshReadAndShowsSelectedMac() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()
    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    XCTAssertTrue(waitForEnabled(read, timeout: 25),
                  "WCSession did not reach the paired iPhone: \(app.staticTexts["watch-media-status"].value ?? "missing")")
    XCTAssertFalse(app.buttons["watch-play"].isEnabled)
    read.tap()
    let title = app.staticTexts["watch-observed-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 15))
    XCTAssertEqual(title.label, "Fixture film B")
    XCTAssertEqual(app.staticTexts["watch-observed-target"].label, "YouTube · Fixture Mac B")
    XCTAssertFalse(app.buttons["watch-pause"].isEnabled)
  }

  func testUnreachablePhoneHasNoAction() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()
    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    XCTAssertTrue(waitForLabel(app.staticTexts["watch-media-status"],
                               contains: "unreachable", timeout: 15))
    XCTAssertFalse(waitForEnabled(read, timeout: 3), "No paired iPhone app is running")
    XCTAssertFalse(app.buttons["watch-play"].isEnabled)
    XCTAssertFalse(app.buttons["watch-pause"].isEnabled)
  }

  private func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "enabled == true"), object: element)], timeout: timeout) == .completed
  }

  private func waitForLabel(_ element: XCUIElement, contains text: String,
                            timeout: TimeInterval) -> Bool {
    XCTWaiter.wait(for: [XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label CONTAINS %@", text), object: element)], timeout: timeout) == .completed
  }
}
