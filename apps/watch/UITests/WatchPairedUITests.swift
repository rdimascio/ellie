import XCTest

/// The paired cases require the DEBUG Ellie iPhone fixture. The read-unknown presentation case
/// is a Watch-only DEBUG fixture. The paired runner selects its cases explicitly and rejects
/// skipped or zero-test results.
final class WatchPairedUITests: XCTestCase {
  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  func testTargetAReadThenOnePlayIsUnknownWithoutReplay() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()
    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    guard waitForEnabled(read, timeout: 25) else {
      XCTFail("WCSession did not reach the paired iPhone: \(app.staticTexts["watch-media-status"].value ?? "missing")")
      return
    }
    read.tap()
    let title = app.staticTexts["watch-observed-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 25),
                  "Watch transport: \(app.staticTexts["watch-transport-diagnostic"].label); "
                    + "session: \(app.staticTexts["watch-media-status"].value ?? "missing")")
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
    guard waitForEnabled(read, timeout: 25) else {
      XCTFail("WCSession did not reach the paired iPhone: \(app.staticTexts["watch-media-status"].value ?? "missing")")
      return
    }
    XCTAssertFalse(app.buttons["watch-play"].isEnabled)
    read.tap()
    let title = app.staticTexts["watch-observed-title"]
    XCTAssertTrue(title.waitForExistence(timeout: 25))
    XCTAssertEqual(title.label, "Fixture film B")
    XCTAssertEqual(app.staticTexts["watch-observed-target"].label, "YouTube · Fixture Mac B")
    XCTAssertFalse(app.buttons["watch-pause"].isEnabled)
  }

  func testStoppedPhoneProcessDoesNotRestoreAction() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()
    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    let reconnected = waitForEnabled(read, timeout: 15)
    let status = app.staticTexts["watch-media-status"]
    if reconnected {
      XCTAssertTrue(waitForLabel(status, contains: "Read the current page", timeout: 5),
                    "A reachable iPhone must ask for a fresh read, not retain an unreachable label")
    } else {
      XCTAssertTrue(waitForLabel(status, contains: "unreachable", timeout: 5),
                    "A stopped iPhone process may remain unreachable; action authority still stays cleared")
    }
    XCTAssertFalse(app.staticTexts["watch-observed-title"].exists)
    XCTAssertFalse(app.buttons["watch-play"].isEnabled)
    XCTAssertFalse(app.buttons["watch-pause"].isEnabled)
  }

  func testReadUnknownShowsNoFreshObservationWithoutMutationClaim() {
    let app = XCUIApplication()
    app.launchArguments = ["--ellie-watch-paired-diagnostic"]
    app.launch()

    let read = app.buttons["watch-read"]
    XCTAssertTrue(read.waitForExistence(timeout: 15))
    guard waitForEnabled(read, timeout: 25) else {
      XCTFail(
        "WCSession did not reach the paired iPhone: "
          + "\(app.staticTexts["watch-media-status"].value ?? "missing")")
      return
    }
    read.tap()
    let status = app.staticTexts["watch-media-status"]
    XCTAssertTrue(waitForLabel(status, contains: "did not return a fresh page", timeout: 15))
    XCTAssertEqual(status.label, "The iPhone did not return a fresh page. Read again.")
    XCTAssertFalse(status.label.contains("may have run"))
    XCTAssertFalse(app.staticTexts["watch-observed-title"].exists)
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
