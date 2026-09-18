import Darwin
import XCTest

@testable import Ellie

final class BrowserPhoneControlTests: XCTestCase {
  func testRecoveryHTTPFailuresRemainReadOnlyAndTruthful() throws {
    let settling = Data(
      #"{"error":"A previous browser command is still settling. Wait and read again.","code":"browser_read_settling"}"#.utf8)
    for action in [BrowserPhoneAction.refresh, .read(revision: "observed-revision")] {
      XCTAssertThrowsError(
        try decodeBrowserPhoneHTTPResult(
          status: 409, data: settling, action: action, nodeID: "mac")) {
            XCTAssertEqual($0 as? PhoneControlFailure, .browserReadSettling)
          }
      XCTAssertThrowsError(
        try decodeBrowserPhoneHTTPResult(
          status: 502, data: Data(#"{"outcome":"unknown"}"#.utf8),
          action: action, nodeID: "mac")) {
            XCTAssertEqual($0 as? PhoneControlFailure, .browserObservationUnavailable)
          }
    }
    XCTAssertThrowsError(
      try decodeBrowserPhoneHTTPResult(
        status: 409, data: Data(#"{"error":"Device busy."}"#.utf8),
        action: .refresh, nodeID: "mac")) {
          XCTAssertEqual($0 as? PhoneControlFailure, .rejected)
        }
    XCTAssertEqual(
      try decodeBrowserPhoneHTTPResult(
        status: 502, data: Data(#"{"outcome":"unknown"}"#.utf8),
        action: .scroll(.down, revision: "observed-revision"), nodeID: "mac"),
      .command(source: .webmcp, status: .unknown, revision: "observed-revision"))
  }

  func testCanonicalStatusReadAndCommandResultsDecode() throws {
    let revision = String(repeating: "a", count: 64)
    let status = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser tab connected.","browser":{"source":"webmcp","operation":"status","status":"connected","revision":"\#(revision)","origin":"https://example.test"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(status, nodeID: "mac"),
      .status(source: .webmcp, connected: true, revision: revision))
    let read = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser view read.","browser":{"source":"webmcp","operation":"read","status":"completed","revision":"\#(revision)","view":{"title":"News","summary":"Top stories","items":[{"id":"item-1","label":"First"}]}}}}"#.utf8)
    guard case .page(let page) = try decodeBrowserPhoneResponse(read, nodeID: "mac") else {
      return XCTFail("Expected page")
    }
    XCTAssertEqual(page.items.map(\.id), ["item-1"])
    XCTAssertNil(page.site, "Older browser readers remain valid without site observation")
    let unknown = Data(
      #"{"outcome":"unknown","result":{"ok":false,"message":"Unverified.","browser":{"source":"webmcp","operation":"command","status":"unknown","revision":"\#(revision)"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(unknown, nodeID: "mac"),
      .command(source: .webmcp, status: .unknown, revision: revision))
    XCTAssertThrowsError(
      try decodeBrowserPhoneResponse(
        Data(String(decoding: read, as: UTF8.self).replacingOccurrences(of: "item-1", with: "item 1").utf8),
        nodeID: "mac"))
    XCTAssertThrowsError(
      try decodeBrowserPhoneResponse(
        Data(String(decoding: read, as: UTF8.self).replacingOccurrences(of: #""title":"News""#, with: #""title":1"#).utf8),
        nodeID: "mac"))
  }

  func testOptionalYouTubeObservationIsBoundedAndNeverInferredFromCommandStatus() throws {
    let revision = String(repeating: "a", count: 64)
    func read(_ site: String) -> Data {
      Data(
        #"{"outcome":"completed","result":{"ok":true,"message":"Browser view read.","browser":{"source":"accessibility","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[],"site":\#(site)}}}}"#.utf8)
    }
    let valid = [
      (#"{"provider":"youtube","page":"home","playback":"unavailable"}"#, BrowserPhoneYouTubePage.home),
      (#"{"provider":"youtube","page":"results","playback":"unavailable"}"#, .results),
      (#"{"provider":"youtube","page":"watch","playback":"playing","currentTimeSeconds":78.5}"#, .watch),
      (#"{"provider":"youtube","page":"login","playback":"unavailable"}"#, .login),
      (#"{"provider":"youtube","page":"unsupported","playback":"unavailable"}"#, .unsupported),
    ]
    for (site, expectedPage) in valid {
      guard case .page(let page) = try decodeBrowserPhoneResponse(read(site), nodeID: "mac")
      else { return XCTFail("Expected observed page") }
      XCTAssertEqual(page.site?.page, expectedPage)
    }
    guard case .page(let observedWatch) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"youtube","page":"watch","playback":"paused","currentTimeSeconds":86400}"#),
      nodeID: "mac")
    else { return XCTFail("Expected observed watch page") }
    XCTAssertEqual(observedWatch.site?.currentTimeSeconds, 86_400)

    for invalid in [
      #"null"#,
      #"{"provider":"other","page":"watch","playback":"paused"}"#,
      #"{"provider":"youtube","page":"results","playback":"playing"}"#,
      #"{"provider":"youtube","page":"home","playback":"unavailable","currentTimeSeconds":1}"#,
      #"{"provider":"youtube","page":"watch","playback":"playing","currentTimeSeconds":true}"#,
      #"{"provider":"youtube","page":"watch","playback":"playing","currentTimeSeconds":86401}"#,
      #"{"provider":"youtube","page":"watch","playback":"paused","extra":"unexpected"}"#,
    ] {
      XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(invalid), nodeID: "mac"))
    }
    let command = Data(
      #"{"outcome":"unknown","result":{"ok":false,"message":"Unverified.","browser":{"source":"accessibility","operation":"command","status":"unknown","revision":"\#(revision)"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(command, nodeID: "mac"),
      .command(source: .accessibility, status: .unknown, revision: revision))
  }

  func testNetflixCompanionObservationHasClosedProviderAndRowState() throws {
    let revision = String(repeating: "c", count: 64)
    func read(_ site: String) -> Data {
      Data(
        #"{"outcome":"completed","result":{"ok":true,"message":"Netflix page observed.","browser":{"source":"companion","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[],"site":\#(site)}}}}"#.utf8)
    }
    guard case .page(let page) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"netflix","page":"browse","playback":"unavailable","horizontalScrollAvailable":true}"#),
      nodeID: "mac")
    else { return XCTFail("Expected Netflix page") }
    XCTAssertEqual(page.source, .companion)
    XCTAssertEqual(page.site?.provider, .netflix)
    XCTAssertEqual(page.site?.horizontalScrollAvailable, true)
    guard case .page(let withRows) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"netflix","page":"browse","playback":"unavailable","rows":[{"id":"10000000-0000-4000-8000-000000000001","label":"Row 1: Featured"},{"id":"10000000-0000-4000-8000-000000000002","label":"Row 2"}]}"#), nodeID: "mac")
    else { return XCTFail("Expected Netflix rows") }
    XCTAssertEqual(withRows.site?.rows?.map(\.label), ["Row 1: Featured", "Row 2"])
    guard case .page(let withSearch) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"netflix","page":"results","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#),
      nodeID: "mac")
    else { return XCTFail("Expected Netflix search results") }
    XCTAssertEqual(withSearch.site?.page, .results)
    XCTAssertEqual(withSearch.site?.searchControl?.label, "Search")
    let missingSite = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Observed.","browser":{"source":"companion","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[]}}}}"#.utf8)
    XCTAssertThrowsError(try decodeBrowserPhoneResponse(missingSite, nodeID: "mac"))
    for invalid in [
      #"{"provider":"netflix","page":"home","playback":"unavailable"}"#,
      #"{"provider":"netflix","page":"login","playback":"playing"}"#,
      #"{"provider":"youtube","page":"results","playback":"unavailable","horizontalScrollAvailable":true}"#,
      #"{"provider":"youtube","page":"watch","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#,
      #"{"provider":"netflix","page":"watch","playback":"paused","horizontalScrollAvailable":true}"#,
      #"{"provider":"netflix","page":"browse","playback":"unavailable","horizontalScrollAvailable":1}"#,
      #"{"provider":"netflix","page":"watch","playback":"paused","rows":[]}"#,
      #"{"provider":"netflix","page":"browse","playback":"unavailable","rows":[{"id":"not-an-id","label":"Row"}]}"#,
      #"{"provider":"netflix","page":"browse","playback":"unavailable","rows":[{"id":"10000000-0000-1000-8000-000000000001","label":"Row"}]}"#,
      #"{"provider":"netflix","page":"watch","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#,
      #"{"provider":"netflix","page":"browse","playback":"unavailable","searchControl":{"id":"input[type=search]","label":"Search"}}"#,
      #"{"provider":"netflix","page":"browse","playback":"unavailable","rows":[{"id":"10000000-0000-4000-8000-000000000001","label":"Row"},{"id":"10000000-0000-4000-8000-000000000001","label":"Other"}]}"#,
    ] { XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(invalid), nodeID: "mac")) }
  }

  func testYouTubeTVCompanionObservationKeepsSearchAndRowsClosed() throws {
    let revision = String(repeating: "d", count: 64)
    func read(_ site: String) -> Data {
      Data(
        #"{"outcome":"completed","result":{"ok":true,"message":"Observed.","browser":{"source":"companion","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[],"site":\#(site)}}}}"#.utf8)
    }
    guard case .page(let page) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"youtube_tv","page":"watch","playback":"paused"}"#), nodeID: "mac")
    else { return XCTFail("Expected selected YouTube TV player") }
    XCTAssertEqual(page.site?.provider, .youtubeTV)
    XCTAssertEqual(page.site?.page, .watch)
    for invalid in [
      #"{"provider":"youtube_tv","page":"results","playback":"unavailable"}"#,
      #"{"provider":"youtube_tv","page":"browse","playback":"playing"}"#,
      #"{"provider":"youtube_tv","page":"browse","playback":"unavailable","rows":[]}"#,
      #"{"provider":"youtube_tv","page":"browse","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000001","label":"Search"}}"#,
    ] { XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(invalid), nodeID: "mac")) }
  }

  func testYouTubeCompanionSearchControlDecodesOnlyOnObservedHomeOrResults() throws {
    let revision = String(repeating: "a", count: 64)
    func read(_ site: String, source: String = "companion") -> Data {
      Data(
        #"{"outcome":"completed","result":{"ok":true,"message":"Observed.","browser":{"source":"\#(source)","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[],"site":\#(site)}}}}"#.utf8)
    }
    let control = #""searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}"#
    for page in ["home", "results"] {
      let site = "{\"provider\":\"youtube\",\"page\":\"\(page)\",\"playback\":\"unavailable\",\(control)}"
      guard case .page(let observed) = try decodeBrowserPhoneResponse(read(site), nodeID: "mac")
      else { return XCTFail("Expected selected YouTube observation") }
      XCTAssertEqual(observed.source, .companion)
      XCTAssertEqual(observed.site?.searchControl?.label, "Search")
    }
    for invalid in [
      #"{"provider":"youtube","page":"watch","playback":"paused","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#,
      #"{"provider":"youtube","page":"home","playback":"unavailable","searchControl":{"id":"input","label":"Search"}}"#,
      #"{"provider":"youtube_tv","page":"browse","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#,
    ] { XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(invalid), nodeID: "mac")) }
    let home = #"{"provider":"youtube","page":"home","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000003","label":"Search"}}"#
    for source in ["accessibility", "webmcp"] {
      XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(home, source: source), nodeID: "mac"))
    }
  }

  func testDisneyPlusCompanionObservationExcludesPlaybackAndSearchControls() throws {
    let revision = String(repeating: "e", count: 64)
    func read(_ site: String) -> Data {
      Data(
        #"{"outcome":"completed","result":{"ok":true,"message":"Observed.","browser":{"source":"companion","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[],"site":\#(site)}}}}"#.utf8)
    }
    guard case .page(let page) = try decodeBrowserPhoneResponse(
      read(#"{"provider":"disneyplus","page":"browse","playback":"unavailable"}"#), nodeID: "mac")
    else { return XCTFail("Expected selected Disney+ title page") }
    XCTAssertEqual(page.site?.provider, .disneyplus)
    XCTAssertEqual(page.site?.page, .browse)
    for invalid in [
      #"{"provider":"disneyplus","page":"watch","playback":"paused"}"#,
      #"{"provider":"disneyplus","page":"results","playback":"unavailable"}"#,
      #"{"provider":"disneyplus","page":"browse","playback":"playing"}"#,
      #"{"provider":"disneyplus","page":"browse","playback":"unavailable","rows":[]}"#,
      #"{"provider":"disneyplus","page":"browse","playback":"unavailable","searchControl":{"id":"10000000-0000-4000-8000-000000000001","label":"Search"}}"#,
    ] { XCTAssertThrowsError(try decodeBrowserPhoneResponse(read(invalid), nodeID: "mac")) }
  }

  @MainActor
  func testNetflixObservedControlsFailClosedBeforeDispatch() async {
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let cases: [(BrowserPhoneSite, BrowserVoiceIntent, Bool)] = [
      (BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil, horizontalScrollAvailable: true,
        rows: [BrowserPhoneRow(id: "10000000-0000-4000-8000-000000000001", label: "Row 1")]),
        .scroll(.right), false),
      (BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil, horizontalScrollAvailable: false), .scroll(.right), false),
      (BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .search(query: "title"), false),
      (BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil, searchControl: BrowserPhoneSearchControl(
          id: "10000000-0000-4000-8000-000000000003", label: "Search")),
        .search(query: "title"), true),
      (BrowserPhoneSite(provider: .netflix, page: .results, playback: .unavailable,
        currentTimeSeconds: nil, searchControl: BrowserPhoneSearchControl(
          id: "10000000-0000-4000-8000-000000000004", label: "Search")),
        .openResult(index: 1), true),
      (BrowserPhoneSite(provider: .netflix, page: .login, playback: .unavailable,
        currentTimeSeconds: nil), .openResult(index: 1), false),
      (BrowserPhoneSite(provider: .netflix, page: .watch, playback: .paused,
        currentTimeSeconds: 1), .play, true),
      (BrowserPhoneSite(provider: .youtubeTV, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .search(query: "news"), false),
      (BrowserPhoneSite(provider: .youtubeTV, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .scroll(.right), false),
      (BrowserPhoneSite(provider: .youtubeTV, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .scroll(.down), true),
      (BrowserPhoneSite(provider: .youtubeTV, page: .watch, playback: .paused,
        currentTimeSeconds: 1), .play, true),
      (BrowserPhoneSite(provider: .disneyplus, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .openResult(index: 1), true),
      (BrowserPhoneSite(provider: .disneyplus, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .search(query: "title"), false),
      (BrowserPhoneSite(provider: .disneyplus, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .scroll(.down), true),
      (BrowserPhoneSite(provider: .disneyplus, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), .scroll(.left), false),
      (BrowserPhoneSite(provider: .disneyplus, page: .login, playback: .unavailable,
        currentTimeSeconds: nil), .openResult(index: 1), false),
      (BrowserPhoneSite(provider: .disneyplus, page: .login, playback: .unavailable,
        currentTimeSeconds: nil), .scroll(.down), false),
    ]
    for (site, intent, allowed) in cases {
      let transport = BrowserPhoneFakeTransport(source: .companion, site: site)
      let store = BrowserPhoneControlStore(
        credential: credential(), transport: transport,
        uncertainty: BrowserPhoneFakeUncertaintyStore())
      XCTAssertTrue(store.refresh(on: node))
      await eventually { store.phase == .ready }
      XCTAssertEqual(store.canPerform(intent, on: node), allowed)
      if !allowed {
        XCTAssertFalse(store.perform(intent, on: node))
        let actions = await transport.actions
        XCTAssertEqual(actions.count, 2)
      }
    }
  }

  @MainActor
  func testNetflixRowChoiceIsExplicitAndConsumedBeforeTransport() async {
    let node = PhoneControlNode(id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let first = "10000000-0000-4000-8000-000000000001"
    let second = "10000000-0000-4000-8000-000000000002"
    let site = BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
      currentTimeSeconds: nil, rows: [
        BrowserPhoneRow(id: first, label: "Row 1: Featured"),
        BrowserPhoneRow(id: second, label: "Row 2: New"),
      ])
    let transport = BrowserPhoneFakeTransport(source: .companion, site: site)
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertFalse(store.canPerform(.scroll(.right), on: node))
    XCTAssertFalse(store.selectObservedRow("10000000-0000-4000-8000-000000000099", on: node))
    XCTAssertTrue(store.selectObservedRow(second, on: node))
    XCTAssertEqual(store.selectedRowID, second)
    XCTAssertTrue(store.canPerform(.scroll(.right), on: node))
    XCTAssertTrue(store.perform(.scroll(.right), on: node))
    XCTAssertNil(store.selectedRowID)
    XCTAssertFalse(store.canPerform(.scroll(.right), on: node))
    await eventually { await transport.actions.count == 3 }
    let actions = await transport.actions
    XCTAssertEqual(actions[2], .scrollRow(second, .right, revision: String(repeating: "a", count: 64)))
    await transport.finishCommand()
    await eventually { !store.isBusy }
  }

  @MainActor
  func testDisneyPlusVerticalBrowseNeedsFreshReadAfterUnknown() async {
    let node = PhoneControlNode(id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let site = BrowserPhoneSite(provider: .disneyplus, page: .browse,
      playback: .unavailable, currentTimeSeconds: nil)
    let transport = BrowserPhoneFakeTransport(source: .companion,
      commandStatus: .unknown, site: site)
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.canPerform(.scroll(.down), on: node))
    XCTAssertFalse(store.canPerform(.scroll(.right), on: node))
    XCTAssertFalse(store.canPerform(.play, on: node))
    XCTAssertTrue(store.perform(.scroll(.down), on: node))
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    XCTAssertFalse(store.perform(.scroll(.down), on: node))
    let actions = await transport.actions
    XCTAssertEqual(actions, [.refresh, .read(revision: String(repeating: "a", count: 64)),
      .scroll(.down, revision: String(repeating: "a", count: 64))])
  }

  @MainActor
  func testObservedYouTubeStateBlocksUnavailableControlsBeforeDispatch() async {
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let cases: [(BrowserPhoneSite, BrowserVoiceIntent, Bool)] = [
      (BrowserPhoneSite(page: .login, playback: .unavailable, currentTimeSeconds: nil), .search(query: "video"), false),
      (BrowserPhoneSite(page: .unsupported, playback: .unavailable, currentTimeSeconds: nil), .scroll(.down), false),
      (BrowserPhoneSite(page: .results, playback: .unavailable, currentTimeSeconds: nil), .play, false),
      (BrowserPhoneSite(page: .watch, playback: .ambiguous, currentTimeSeconds: nil), .play, false),
      (BrowserPhoneSite(page: .watch, playback: .unavailable, currentTimeSeconds: nil), .pause, false),
      (BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 1), .pause, false),
      (BrowserPhoneSite(page: .watch, playback: .paused, currentTimeSeconds: 1), .play, true),
      (BrowserPhoneSite(page: .watch, playback: .playing, currentTimeSeconds: 1), .pause, true),
    ]
    for (site, intent, allowed) in cases {
      let transport = BrowserPhoneFakeTransport(site: site)
      let store = BrowserPhoneControlStore(
        credential: credential(), transport: transport,
        uncertainty: BrowserPhoneFakeUncertaintyStore())
      XCTAssertTrue(store.refresh(on: node))
      await eventually { store.phase == .ready }
      XCTAssertEqual(store.canPerform(intent, on: node), allowed)
      if !allowed {
        XCTAssertFalse(store.perform(intent, on: node))
        let actions = await transport.actions
        XCTAssertEqual(actions.count, 2, "A rejected observed state cannot dispatch")
      }
    }
  }

  @MainActor
  func testYouTubeCompanionSearchAndAccessibilityControlsKeepDistinctSources() async {
    let node = PhoneControlNode(id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let site = BrowserPhoneSite(provider: .youtube, page: .home, playback: .unavailable,
      currentTimeSeconds: nil, searchControl: BrowserPhoneSearchControl(
        id: "10000000-0000-4000-8000-000000000003", label: "Search"))
    let transport = BrowserPhoneFakeTransport(source: .companion, commandStatus: .unknown,
      site: site, statusSource: .accessibility)
    let store = BrowserPhoneControlStore(credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.canPerform(.search(query: "public video"), on: node))
    XCTAssertTrue(store.perform(.search(query: "public video"), on: node))
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    XCTAssertFalse(store.canPerform(.search(query: "public video"), on: node))
    let actions = await transport.actions
    XCTAssertEqual(actions.count, 3)
    XCTAssertEqual(actions[2], .search("public video", revision: String(repeating: "a", count: 64)))

    let axTransport = BrowserPhoneFakeTransport(source: .companion, commandStatus: .unknown,
      site: site, statusSource: .accessibility)
    let axStore = BrowserPhoneControlStore(credential: credential(), transport: axTransport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(axStore.refresh(on: node))
    await eventually { axStore.phase == .ready }
    XCTAssertTrue(axStore.perform(.scroll(.down), on: node))
    await eventually { if case .unknown = axStore.phase { true } else { false } }

    let spoof = BrowserPhoneFakeTransport(source: .companion,
      site: BrowserPhoneSite(provider: .netflix, page: .browse, playback: .unavailable,
        currentTimeSeconds: nil), statusSource: .accessibility)
    let rejected = BrowserPhoneControlStore(credential: credential(), transport: spoof,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(rejected.refresh(on: node))
    await eventually { if case .failed = rejected.phase { true } else { false } }
    XCTAssertNil(rejected.page)
    XCTAssertFalse(rejected.canPerform(.search(query: "title"), on: node))

    let missingField = BrowserPhoneFakeTransport(source: .companion,
      site: BrowserPhoneSite(provider: .youtube, page: .home, playback: .unavailable,
        currentTimeSeconds: nil), statusSource: .accessibility)
    let noSearch = BrowserPhoneControlStore(credential: credential(), transport: missingField,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(noSearch.refresh(on: node))
    await eventually { noSearch.phase == .ready }
    XCTAssertFalse(noSearch.canPerform(.search(query: "title"), on: node))
    XCTAssertFalse(noSearch.perform(.search(query: "title"), on: node))
    let missingFieldActions = await missingField.actions
    XCTAssertEqual(missingFieldActions.count, 2,
      "A missing observed field cannot dispatch a synthetic search")

    let wrongStatusSource = BrowserPhoneFakeTransport(source: .companion, site: site,
      statusSource: .webmcp)
    let sourceMismatch = BrowserPhoneControlStore(credential: credential(),
      transport: wrongStatusSource, uncertainty: BrowserPhoneFakeUncertaintyStore())
    XCTAssertTrue(sourceMismatch.refresh(on: node))
    await eventually { if case .failed = sourceMismatch.phase { true } else { false } }
    XCTAssertNil(sourceMismatch.page)
    XCTAssertFalse(sourceMismatch.canPerform(.search(query: "title"), on: node))
    let wrongStatusActions = await wrongStatusSource.actions
    XCTAssertEqual(wrongStatusActions.count, 2,
      "A companion read cannot be accepted under a WebMCP status source")
  }

  func testCanonicalAccessibilityResultsDecodeWithoutWeakeningTheClosedSourceSet() throws {
    let revision = String(repeating: "b", count: 64)
    let status = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser tab connected.","browser":{"source":"accessibility","operation":"status","status":"connected","revision":"\#(revision)","origin":"https://example.test"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(status, nodeID: "mac"),
      .status(source: .accessibility, connected: true, revision: revision))
    let read = Data(
      #"{"outcome":"completed","result":{"ok":true,"message":"Browser view read.","browser":{"source":"accessibility","operation":"read","status":"completed","revision":"\#(revision)","view":{"items":[{"id":"ax-1","label":"Play"}]}}}}"#.utf8)
    guard case .page(let page) = try decodeBrowserPhoneResponse(read, nodeID: "mac") else {
      return XCTFail("Expected accessibility page")
    }
    XCTAssertEqual(page.source, .accessibility)
    XCTAssertEqual(page.revision, revision)
    XCTAssertEqual(page.items, [BrowserPhoneItem(id: "ax-1", label: "Play", state: nil)])
    let unknown = Data(
      #"{"outcome":"unknown","result":{"ok":false,"message":"Browser action was dispatched without independent effect confirmation.","browser":{"source":"accessibility","operation":"command","status":"unknown","revision":"\#(revision)"}}}"#.utf8)
    XCTAssertEqual(
      try decodeBrowserPhoneResponse(unknown, nodeID: "mac"),
      .command(source: .accessibility, status: .unknown, revision: revision))

    let unsupportedSource = Data(
      String(decoding: status, as: UTF8.self)
        .replacingOccurrences(of: #""source":"accessibility""#, with: #""source":"dom""#).utf8)
    XCTAssertThrowsError(try decodeBrowserPhoneResponse(unsupportedSource, nodeID: "mac"))
  }

  @MainActor
  func testStoreBindsOpaqueSelectionToFreshNodeAndNeverReplaysCancellation() async {
    let transport = BrowserPhoneFakeTransport()
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: persistence)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    let refreshActions = await transport.actions
    XCTAssertEqual(
      Array(refreshActions.prefix(2)),
      [.refresh, .read(revision: String(repeating: "a", count: 64))])
    XCTAssertEqual(store.page?.items.first?.id, "opaque-1")
    store.perform(.openResult(index: 1), on: node)
    XCTAssertNil(store.page, "Admitting a mutation immediately invalidates reviewed handles")
    XCTAssertFalse(store.canPerform(.play, on: node))
    await eventually { await transport.actions.count == 3 }
    store.cancel()
    await transport.finishCommand()
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let scope = try? browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertNotNil(scope.flatMap { persistence.pendingTokenValue(for: $0) })
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testDelayedReadCannotRepublishAfterTargetChange() async {
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { await transport.actions.count == 2 }
    store.clearIfTargetChanged(to: "other-mac")
    XCTAssertFalse(store.hasPendingBrowserCommand)
    await transport.finishRead()
    await eventually { store.phase == .idle }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 2)
  }

  @MainActor
  func testCancelledTargetChangedReadCannotClearObservedUncertainty() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let credential = credential()
    let scope = try browserMutationUncertaintyScope(credential: credential, targetID: "mac")
    let token = "00000000-0000-4000-8000-000000000007"
    XCTAssertTrue(try persistence.recordIfClear(token: token, for: scope))
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(
      credential: credential, transport: transport, uncertainty: persistence)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])

    XCTAssertTrue(store.refresh(on: node))
    await eventually { await transport.actions.count == 2 }
    store.clearIfTargetChanged(to: "other-mac")
    XCTAssertFalse(store.hasPendingBrowserCommand)
    await transport.finishRead()
    await eventually { store.phase == .idle }
    XCTAssertEqual(persistence.pendingTokenValue(for: scope), token)
    XCTAssertNil(store.page)
    store.clearIfTargetChanged(to: node.id)
    XCTAssertTrue(store.hasPendingBrowserCommand)
    XCTAssertFalse(store.showsSeparatePendingBrowserWarning)
  }

  @MainActor
  func testPendingWarningTracksAtoBtoAWhileCancelledReadSettles() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let credential = credential()
    let nodeA = PhoneControlNode(
      id: "mac-a", label: "First", online: true,
      capabilities: ["browser.read", "browser.control"])
    let scopeA = try browserMutationUncertaintyScope(
      credential: credential, targetID: nodeA.id)
    let token = "00000000-0000-4000-8000-000000000012"
    XCTAssertTrue(try persistence.recordIfClear(token: token, for: scopeA))
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(
      credential: credential, transport: transport, uncertainty: persistence)
    store.clearIfTargetChanged(to: nodeA.id)
    XCTAssertTrue(store.refresh(on: nodeA))
    await eventually { await transport.actions.count == 2 }

    persistence.failReads = true
    store.clearIfTargetChanged(to: "mac-b")
    XCTAssertEqual(store.phase, .cancelling)
    XCTAssertFalse(store.hasPendingBrowserCommand)
    XCTAssertTrue(store.showsPendingBrowserWarningError)
    XCTAssertTrue(store.isBusy)
    persistence.failReads = false
    store.clearIfTargetChanged(to: nodeA.id)
    XCTAssertEqual(store.phase, .cancelling)
    XCTAssertTrue(store.hasPendingBrowserCommand)
    XCTAssertFalse(store.showsPendingBrowserWarningError)
    XCTAssertTrue(store.showsSeparatePendingBrowserWarning)
    XCTAssertTrue(store.isBusy)
    XCTAssertFalse(store.canRefresh(on: nodeA))
    XCTAssertEqual(persistence.pendingTokenValue(for: scopeA), token)

    await transport.finishRead()
    await eventually { if case .unknown = store.phase { !store.isBusy } else { false } }
    XCTAssertTrue(store.hasPendingBrowserCommand)
    XCTAssertFalse(store.showsSeparatePendingBrowserWarning)
    XCTAssertNil(store.page)
    XCTAssertEqual(persistence.pendingTokenValue(for: scopeA), token)
    let actions = await transport.actions
    XCTAssertEqual(actions.count, 2)
  }

  @MainActor
  func testUnreadableMarkerKeepsKnownSameTargetWarningButNeverCarriesItToAnotherTarget()
    async throws
  {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let credential = credential()
    let nodeA = PhoneControlNode(
      id: "mac-a", label: "First", online: true,
      capabilities: ["browser.read", "browser.control"])
    let scopeA = try browserMutationUncertaintyScope(
      credential: credential, targetID: nodeA.id)
    XCTAssertTrue(try persistence.recordIfClear(
      token: "00000000-0000-4000-8000-000000000013", for: scopeA))
    let transport = BrowserPhoneFakeTransport(delayRead: true)
    let store = BrowserPhoneControlStore(
      credential: credential, transport: transport, uncertainty: persistence)
    store.clearIfTargetChanged(to: nodeA.id)
    XCTAssertTrue(store.refresh(on: nodeA))
    await eventually { await transport.actions.count == 2 }
    XCTAssertTrue(store.hasPendingBrowserCommand)
    store.cancel()
    persistence.failReads = true
    await transport.finishRead()
    await eventually { !store.isBusy }
    XCTAssertTrue(store.hasPendingBrowserCommand)
    XCTAssertNotNil(store.pendingBrowserWarningError)
    XCTAssertTrue(store.showsSeparatePendingBrowserWarning)
    guard case .failed = store.phase else { return XCTFail("Expected storage safety diagnostic") }

    store.clearIfTargetChanged(to: "mac-b")
    XCTAssertFalse(store.hasPendingBrowserCommand)
    XCTAssertNotNil(store.pendingBrowserWarningError)
    XCTAssertFalse(store.showsSeparatePendingBrowserWarning)
    guard case .failed = store.phase else { return XCTFail("Expected B storage diagnostic") }

    let recovered = BrowserPhoneControlStore(
      credential: credential, transport: BrowserPhoneFakeTransport(), uncertainty: persistence)
    recovered.clearIfTargetChanged(to: nodeA.id)
    XCTAssertNotNil(recovered.pendingBrowserWarningError)
    persistence.failReads = false
    XCTAssertTrue(recovered.refresh(on: nodeA))
    await eventually { recovered.phase == .ready }
    XCTAssertNil(recovered.pendingBrowserWarningError)
    XCTAssertFalse(recovered.hasPendingBrowserCommand)
  }

  @MainActor
  func testImmediateCancellationBeforeOperationTaskRunsCannotRecordOrDispatch() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let credential = credential()
    let transport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let store = BrowserPhoneControlStore(
      credential: credential, transport: transport, uncertainty: persistence)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }

    XCTAssertTrue(store.perform(.scroll(.down), on: node))
    store.cancel()
    await eventually { store.phase == .idle }
    let scope = try browserMutationUncertaintyScope(credential: credential, targetID: node.id)
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
    let actions = await transport.actions
    XCTAssertEqual(actions, [.refresh, .read(revision: String(repeating: "a", count: 64))])
  }

  @MainActor
  func testPostDispatchTransportFailureIsUnknownAndInvalidatesPage() async {
    let transport = BrowserPhoneFakeTransport(commandError: true)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    store.perform(.scroll(.down), on: node)
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testCredentialChangeRetainsPendingMutationAndBlocksOldBrowserStore() async throws {
    let oldCredential = credential()
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let transport = BrowserPhoneFakeTransport()
    let store = BrowserPhoneControlStore(
      credential: oldCredential, transport: transport, uncertainty: persistence)
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.scroll(.down), on: node))
    await eventually { await transport.actions.count == 3 }

    store.credentialDidChange()
    XCTAssertTrue(store.credentialChanged)
    XCTAssertNil(store.page)
    XCTAssertFalse(store.canRefresh(on: node))
    XCTAssertFalse(store.canPerform(.scroll(.down), on: node))
    await transport.finishCommand()
    await eventually { !store.isBusy }

    let scope = try browserMutationUncertaintyScope(
      credential: oldCredential, targetID: node.id)
    XCTAssertNotNil(try persistence.pendingToken(for: scope))
    XCTAssertFalse(store.refresh(on: node))
    XCTAssertFalse(store.perform(.scroll(.down), on: node))
    let actions = await transport.actions
    XCTAssertEqual(actions.count, 3, "The old credential must not read or dispatch again")
  }

  @MainActor
  func testCredentialChangeWhileStatusIsHeldCannotDispatchOldTokenRead() async {
    let transport = BrowserPhoneFakeTransport(delayStatus: true)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    XCTAssertTrue(store.refresh(on: node))
    await eventually { await transport.actions.count == 1 }

    store.credentialDidChange()
    await transport.finishStatus()
    await eventually { !store.isBusy }
    XCTAssertTrue(store.credentialChanged)
    XCTAssertNil(store.page)
    XCTAssertFalse(store.canRefresh(on: node))
    let actions = await transport.actions
    XCTAssertEqual(actions, [.refresh], "A late status must not issue a second old-token read")
  }

  @MainActor
  func testReviewedSearchSelectionAndPlaybackRequireExplicitReadsWithoutReplay() async {
    let transport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let search = BrowserVoiceIntent.search(query: "public video")

    XCTAssertFalse(store.canPerform(search, on: node))
    XCTAssertFalse(store.perform(search, on: node))
    let initialActionCount = await transport.actions.count
    XCTAssertEqual(initialActionCount, 0)

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.canPerform(search, on: node))
    XCTAssertTrue(store.perform(search, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let searchActionCount = await transport.actions.count
    XCTAssertEqual(searchActionCount, 3)

    XCTAssertFalse(store.perform(.openResult(index: 1), on: node))
    let rejectedSelectionActionCount = await transport.actions.count
    XCTAssertEqual(rejectedSelectionActionCount, 3)
    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.openResult(index: 1), on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertFalse(store.canPerform(.play, on: node))

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.play, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }
    XCTAssertFalse(store.canPerform(.pause, on: node))

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.pause, on: node))
    await eventually { if case .outcome = store.phase { true } else { false } }

    let actions = await transport.actions
    XCTAssertEqual(actions.count, 12)
    XCTAssertEqual(
      actions.filter {
        switch $0 {
        case .search, .select, .playback: return true
        default: return false
        }
      }.count, 4)
  }

  @MainActor
  func testEmptyObservedResultListRejectsSelectionWithoutCrashingOrDispatching() async {
    let transport = BrowserPhoneFakeTransport(items: [])
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])

    XCTAssertTrue(store.refresh(on: node))
    await eventually { store.phase == .ready }
    XCTAssertFalse(store.canPerform(.openResult(index: 1), on: node))
    XCTAssertFalse(store.perform(.openResult(index: 1), on: node))
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 2)
  }

  @MainActor
  func testAccessibilityPagePreservesSourceAndUnknownCommandInvalidatesIt() async {
    let transport = BrowserPhoneFakeTransport(source: .accessibility, commandStatus: .unknown)
    let store = BrowserPhoneControlStore(
      credential: credential(), transport: transport,
      uncertainty: BrowserPhoneFakeUncertaintyStore())
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.refresh(on: node)
    await eventually { store.phase == .ready }
    XCTAssertEqual(store.page?.source, .accessibility)
    store.perform(.scroll(.down), on: node)
    await eventually { if case .unknown = store.phase { true } else { false } }
    XCTAssertNil(store.page)
    let actionCount = await transport.actions.count
    XCTAssertEqual(actionCount, 3)
  }

  @MainActor
  func testUncertaintySurvivesStoreRecreationAndVerifiedReadResolvesOnlyObservedMarker()
    async throws
  {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let firstTransport = BrowserPhoneFakeTransport()
    let first = BrowserPhoneControlStore(
      credential: credential(), transport: firstTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000001" })
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    first.clearIfTargetChanged(to: node.id)
    XCTAssertTrue(first.refresh(on: node))
    await eventually { first.phase == .ready }
    XCTAssertTrue(first.perform(.openResult(index: 1), on: node))
    await eventually { await firstTransport.actions.count == 3 }

    let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000001")

    let secondTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let second = BrowserPhoneControlStore(
      credential: credential(), transport: secondTransport, uncertainty: persistence)
    XCTAssertEqual(second.phase, .idle)
    second.clearIfTargetChanged(to: node.id)
    guard case .unknown = second.phase else { return XCTFail("Expected restored uncertainty") }
    XCTAssertNil(second.page)
    XCTAssertFalse(second.canPerform(.play, on: node))
    let secondInitialActions = await secondTransport.actions.count
    XCTAssertEqual(secondInitialActions, 0)

    XCTAssertTrue(second.refresh(on: node))
    await eventually { second.phase == .ready }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
    XCTAssertFalse(second.hasPendingBrowserCommand)
    let secondReadActions = await secondTransport.actions.count
    XCTAssertEqual(secondReadActions, 2)

    await firstTransport.finishCommand()
    await eventually { if case .unknown = first.phase { true } else { false } }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
    let firstActions = await firstTransport.actions.count
    XCTAssertEqual(firstActions, 3)
  }

  @MainActor
  func testUncertaintyIsScopedToEnrollmentAndTargetAndFailedReadRetainsIt() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let firstCredential = credential()
    let markedScope = try browserMutationUncertaintyScope(
      credential: firstCredential, targetID: "mac-a")
    XCTAssertTrue(
      try persistence.recordIfClear(
        token: "00000000-0000-4000-8000-000000000002", for: markedScope))

    let otherTargetTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let otherTarget = BrowserPhoneControlStore(
      credential: firstCredential, transport: otherTargetTransport, uncertainty: persistence)
    let nodeB = PhoneControlNode(
      id: "mac-b", label: "Other", online: true,
      capabilities: ["browser.read", "browser.control"])
    otherTarget.clearIfTargetChanged(to: nodeB.id)
    XCTAssertEqual(otherTarget.phase, .idle)
    XCTAssertFalse(otherTarget.hasPendingBrowserCommand)
    XCTAssertTrue(otherTarget.refresh(on: nodeB))
    await eventually { otherTarget.phase == .ready }
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let otherCredential = credential(clientID: "other-phone")
    let otherEnrollment = BrowserPhoneControlStore(
      credential: otherCredential,
      transport: BrowserPhoneFakeTransport(commandStatus: .completed), uncertainty: persistence)
    otherEnrollment.clearIfTargetChanged(to: "mac-a")
    XCTAssertEqual(otherEnrollment.phase, .idle)
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let otherOrigin = BrowserPhoneControlStore(
      credential: credential(origin: "https://127.0.0.1:9444"),
      transport: BrowserPhoneFakeTransport(commandStatus: .completed), uncertainty: persistence)
    otherOrigin.clearIfTargetChanged(to: "mac-a")
    XCTAssertEqual(otherOrigin.phase, .idle)
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))

    let failingTransport = BrowserPhoneFakeTransport(readFailure: .unavailable)
    let restored = BrowserPhoneControlStore(
      credential: firstCredential, transport: failingTransport, uncertainty: persistence)
    let nodeA = PhoneControlNode(
      id: "mac-a", label: "Marked", online: true,
      capabilities: ["browser.read", "browser.control"])
    restored.clearIfTargetChanged(to: nodeA.id)
    guard case .unknown = restored.phase else { return XCTFail("Expected target warning") }
    XCTAssertTrue(restored.hasPendingBrowserCommand)
    restored.clearIfTargetChanged(to: nodeA.id)
    guard case .unknown = restored.phase else { return XCTFail("Warning was reset") }
    XCTAssertTrue(restored.refresh(on: nodeA))
    await eventually { if case .failed = restored.phase { true } else { false } }
    XCTAssertNotNil(persistence.pendingTokenValue(for: markedScope))
    XCTAssertNil(restored.page)
    XCTAssertTrue(restored.hasPendingBrowserCommand)
    XCTAssertTrue(restored.showsSeparatePendingBrowserWarning)
    if case .failed(let message) = restored.phase {
      XCTAssertFalse(message.isEmpty)
    } else {
      XCTFail("Expected read failure diagnostic")
    }
    restored.clearIfTargetChanged(to: nodeB.id)
    XCTAssertFalse(restored.hasPendingBrowserCommand)
    XCTAssertFalse(restored.showsSeparatePendingBrowserWarning)
    restored.clearIfTargetChanged(to: nodeA.id)
    XCTAssertTrue(restored.hasPendingBrowserCommand)
  }

  @MainActor
  func testReadCancellationAndRevocationKeepOnlyMatchingTargetWarning() async throws {
    let credential = credential()
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let scope = try browserMutationUncertaintyScope(credential: credential, targetID: node.id)
    XCTAssertTrue(try persistence.recordIfClear(
      token: "00000000-0000-4000-8000-000000000011", for: scope))

    for failure in [
      PhoneControlFailure.cancelled, .revoked, .browserReadSettling,
      .browserObservationUnavailable,
    ] {
      let transport = BrowserPhoneFakeTransport(readFailure: failure)
      let store = BrowserPhoneControlStore(
        credential: credential, transport: transport, uncertainty: persistence)
      store.clearIfTargetChanged(to: node.id)
      XCTAssertTrue(store.hasPendingBrowserCommand)
      XCTAssertTrue(store.refresh(on: node))
      await eventually {
        switch (failure, store.phase) {
        case (.cancelled, .idle), (.revoked, .revoked),
          (.browserReadSettling, .failed), (.browserObservationUnavailable, .failed): true
        default: false
        }
      }
      XCTAssertTrue(store.hasPendingBrowserCommand)
      XCTAssertTrue(store.showsSeparatePendingBrowserWarning)
      if failure == .browserReadSettling || failure == .browserObservationUnavailable {
        guard case .failed(let message) = store.phase else {
          return XCTFail("Recovery failure must expose a retryable read diagnostic")
        }
        XCTAssertTrue(message.contains("Read current page"))
      }
      XCTAssertNotNil(persistence.pendingTokenValue(for: scope))
      XCTAssertNil(store.page)
      let actions = await transport.actions.count
      XCTAssertEqual(actions, 2)
    }

    let otherNode = PhoneControlNode(
      id: "other-mac", label: "Other", online: true,
      capabilities: ["browser.read", "browser.control"])
    let noMarkerTransport = BrowserPhoneFakeTransport(readFailure: .unavailable)
    let noMarker = BrowserPhoneControlStore(
      credential: credential, transport: noMarkerTransport, uncertainty: persistence)
    noMarker.clearIfTargetChanged(to: otherNode.id)
    XCTAssertFalse(noMarker.hasPendingBrowserCommand)
    XCTAssertTrue(noMarker.refresh(on: otherNode))
    await eventually { if case .failed = noMarker.phase { true } else { false } }
    XCTAssertFalse(noMarker.hasPendingBrowserCommand)
    XCTAssertFalse(noMarker.showsSeparatePendingBrowserWarning)
    noMarker.clearIfTargetChanged(to: node.id)
    XCTAssertTrue(noMarker.hasPendingBrowserCommand)
    noMarker.clearIfTargetChanged(to: otherNode.id)
    XCTAssertFalse(noMarker.hasPendingBrowserCommand)
  }

  @MainActor
  func testPersistenceFailuresBlockDispatchAndUnknownOutcomesRetainMarker() async throws {
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])

    let unreadable = BrowserPhoneFakeUncertaintyStore()
    unreadable.failReads = true
    let blockedTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let blocked = BrowserPhoneControlStore(
      credential: credential(), transport: blockedTransport, uncertainty: unreadable)
    blocked.clearIfTargetChanged(to: node.id)
    guard case .failed = blocked.phase else { return XCTFail("Expected storage failure") }
    let blockedActions = await blockedTransport.actions.count
    XCTAssertEqual(blockedActions, 0)

    let unwritable = BrowserPhoneFakeUncertaintyStore()
    let writeTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let writeBlocked = BrowserPhoneControlStore(
      credential: credential(), transport: writeTransport, uncertainty: unwritable)
    XCTAssertTrue(writeBlocked.refresh(on: node))
    await eventually { writeBlocked.phase == .ready }
    unwritable.failRecords = true
    XCTAssertTrue(writeBlocked.perform(.scroll(.down), on: node))
    await eventually { if case .failed = writeBlocked.phase { true } else { false } }
    let writeActions = await writeTransport.actions.count
    XCTAssertEqual(writeActions, 2)

    for (status, commandError) in [
      (BrowserPhoneCommandStatus.unknown, false), (.cancelled, false), (.timedOut, false),
      (.completed, true),
    ] {
      let persistence = BrowserPhoneFakeUncertaintyStore()
      let transport = BrowserPhoneFakeTransport(
        commandError: commandError, commandStatus: status)
      let store = BrowserPhoneControlStore(
        credential: credential(), transport: transport, uncertainty: persistence)
      XCTAssertTrue(store.refresh(on: node))
      await eventually { store.phase == .ready }
      XCTAssertTrue(store.perform(.scroll(.down), on: node))
      await eventually { if case .unknown = store.phase { true } else { false } }
      let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
      XCTAssertNotNil(persistence.pendingTokenValue(for: scope))
      XCTAssertNil(store.page)
      let actions = await transport.actions.count
      XCTAssertEqual(actions, 3)
    }

    let uncleared = BrowserPhoneFakeUncertaintyStore()
    let definitiveTransport = BrowserPhoneFakeTransport(commandStatus: .completed)
    let definitive = BrowserPhoneControlStore(
      credential: credential(), transport: definitiveTransport, uncertainty: uncleared)
    XCTAssertTrue(definitive.refresh(on: node))
    await eventually { definitive.phase == .ready }
    uncleared.failClears = true
    XCTAssertTrue(definitive.perform(.scroll(.down), on: node))
    await eventually { if case .unknown = definitive.phase { true } else { false } }
    let definitiveScope = try browserMutationUncertaintyScope(
      credential: credential(), targetID: node.id)
    XCTAssertNotNil(uncleared.pendingTokenValue(for: definitiveScope))
  }

  @MainActor
  func testLateCompletionCannotClearAReplacementOperationToken() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let node = PhoneControlNode(
      id: "mac", label: "Studio", online: true,
      capabilities: ["browser.read", "browser.control"])
    let firstTransport = BrowserPhoneFakeTransport()
    let first = BrowserPhoneControlStore(
      credential: credential(), transport: firstTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000003" })
    XCTAssertTrue(first.refresh(on: node))
    await eventually { first.phase == .ready }
    XCTAssertTrue(first.perform(.scroll(.down), on: node))
    await eventually { await firstTransport.actions.count == 3 }

    let secondTransport = BrowserPhoneFakeTransport()
    let second = BrowserPhoneControlStore(
      credential: credential(), transport: secondTransport, uncertainty: persistence,
      operationToken: { "00000000-0000-4000-8000-000000000004" })
    second.clearIfTargetChanged(to: node.id)
    guard case .unknown = second.phase else { return XCTFail("Expected first marker") }
    XCTAssertTrue(second.refresh(on: node))
    await eventually { second.phase == .ready }
    XCTAssertTrue(second.perform(.scroll(.down), on: node))
    await eventually { await secondTransport.actions.count == 3 }
    let scope = try browserMutationUncertaintyScope(credential: credential(), targetID: node.id)
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000004")

    await firstTransport.finishCommand()
    await eventually { if case .unknown = first.phase { true } else { false } }
    XCTAssertEqual(
      persistence.pendingTokenValue(for: scope), "00000000-0000-4000-8000-000000000004")
    await secondTransport.finishCommand()
    await eventually { if case .outcome = second.phase { true } else { false } }
    XCTAssertNil(persistence.pendingTokenValue(for: scope))
  }

  @MainActor
  func testTargetChangeDuringMutationRestoresOnlyOriginalTargetWarning() async throws {
    let persistence = BrowserPhoneFakeUncertaintyStore()
    let transport = BrowserPhoneFakeTransport()
    let credential = credential()
    let store = BrowserPhoneControlStore(
      credential: credential, transport: transport, uncertainty: persistence)
    let nodeA = PhoneControlNode(
      id: "mac-a", label: "First", online: true,
      capabilities: ["browser.read", "browser.control"])
    store.clearIfTargetChanged(to: nodeA.id)
    XCTAssertTrue(store.refresh(on: nodeA))
    await eventually { store.phase == .ready }
    XCTAssertTrue(store.perform(.scroll(.down), on: nodeA))
    await eventually { await transport.actions.count == 3 }
    let scopeA = try browserMutationUncertaintyScope(
      credential: credential, targetID: nodeA.id)
    let tokenA = persistence.pendingTokenValue(for: scopeA)
    XCTAssertNotNil(tokenA)
    XCTAssertFalse(store.showsSeparatePendingBrowserWarning)

    store.clearIfTargetChanged(to: "mac-b")
    await transport.finishCommand()
    await eventually { store.phase == .idle }
    let scopeB = try browserMutationUncertaintyScope(
      credential: credential, targetID: "mac-b")
    XCTAssertNil(persistence.pendingTokenValue(for: scopeB))
    XCTAssertEqual(persistence.pendingTokenValue(for: scopeA), tokenA)
    store.clearIfTargetChanged(to: nodeA.id)
    guard case .unknown = store.phase else { return XCTFail("Expected first target warning") }
    XCTAssertFalse(store.canPerform(.play, on: nodeA))
    let actions = await transport.actions.count
    XCTAssertEqual(actions, 3)
  }

  @MainActor
  func testPrivateUncertaintyFileIsStrictScopedAndCompareAndClear() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-browser-uncertainty-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("markers.json")
    let first = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    let second = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    let scope = String(repeating: "a", count: 64)
    let token = "00000000-0000-4000-8000-000000000005"
    XCTAssertTrue(try first.recordIfClear(token: token, for: scope))
    XCTAssertEqual(try second.pendingToken(for: scope), token)
    XCTAssertEqual(
      try second.clear(
        token: "00000000-0000-4000-8000-000000000006", for: scope), .mismatch)
    XCTAssertEqual(try first.pendingToken(for: scope), token)
    XCTAssertEqual(try second.clear(token: token, for: scope), .cleared)
    XCTAssertNil(try first.pendingToken(for: scope))

    try Data(#"{"version":1,"markers":{"bad":"value"}}"#.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    XCTAssertThrowsError(try first.pendingToken(for: scope))

    let booleanVersion = #"{"markers":{"\#(scope)":"\#(token)"},"version":true}"#
    try Data(booleanVersion.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    XCTAssertThrowsError(try first.pendingToken(for: scope))

    let fractionalVersion = #"{"markers":{"\#(scope)":"\#(token)"},"version":1.5}"#
    try Data(fractionalVersion.utf8).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    XCTAssertThrowsError(try first.pendingToken(for: scope))
  }

  @MainActor
  func testPrivateUncertaintyFileCreatesMissingOwnedAncestorsWithoutChangingExistingMode() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-browser-uncertainty-parent-\(UUID().uuidString)", isDirectory: true)
    guard mkdir(root.path, 0o750) == 0 else { return XCTFail("Could not create fixture root") }
    defer { try? FileManager.default.removeItem(at: root) }
    guard chmod(root.path, 0o750) == 0 else { return XCTFail("Could not set owned fixture mode") }
    let file = root.appendingPathComponent("Application Support/Ellie/markers.json")
    let persistence = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    let scope = String(repeating: "b", count: 64)
    let token = "00000000-0000-4000-8000-000000000008"

    XCTAssertTrue(try persistence.recordIfClear(token: token, for: scope))
    XCTAssertEqual(try persistence.pendingToken(for: scope), token)
    var rootInfo = stat()
    var supportInfo = stat()
    var ellieInfo = stat()
    XCTAssertEqual(lstat(root.path, &rootInfo), 0)
    XCTAssertEqual(
      lstat(file.deletingLastPathComponent().deletingLastPathComponent().path, &supportInfo), 0)
    XCTAssertEqual(lstat(file.deletingLastPathComponent().path, &ellieInfo), 0)
    XCTAssertEqual(rootInfo.st_mode & 0o777, 0o750)
    XCTAssertEqual(supportInfo.st_mode & 0o777, 0o700)
    XCTAssertEqual(ellieInfo.st_mode & 0o777, 0o700)
  }

  @MainActor
  func testPrivateUncertaintyRecordContainsOnlyClosedScopeAndToken() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-browser-uncertainty-bytes-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("markers.json")
    let credential = credential(clientID: "private-client", origin: "https://127.0.0.1:9444")
    let scope = try browserMutationUncertaintyScope(credential: credential, targetID: "private-mac")
    let token = "00000000-0000-4000-8000-000000000009"
    let persistence = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    XCTAssertTrue(try persistence.recordIfClear(token: token, for: scope))

    var info = stat()
    XCTAssertEqual(lstat(file.path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
    let data = try Data(contentsOf: file)
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return XCTFail("Expected closed record")
    }
    XCTAssertEqual(Set(value.keys), ["version", "markers"])
    guard let markers = value["markers"] as? [String: String] else {
      return XCTFail("Expected marker map")
    }
    XCTAssertEqual(markers, [scope: token])
    let text = String(decoding: data, as: UTF8.self)
    XCTAssertFalse(text.contains("private-client"))
    XCTAssertFalse(text.contains("private-mac"))
    XCTAssertFalse(text.contains("127.0.0.1"))
    XCTAssertFalse(text.contains("scroll"))
    XCTAssertFalse(text.contains(credential.token))
  }

  @MainActor
  func testPostCommitDirectorySyncFailureReportsResolvedWithoutRetryingClear() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-browser-uncertainty-sync-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: root, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("markers.json")
    let scope = String(repeating: "c", count: 64)
    let token = "00000000-0000-4000-8000-000000000010"
    let normal = PrivateBrowserMutationUncertaintyStore(fileURL: file)
    XCTAssertTrue(try normal.recordIfClear(token: token, for: scope))
    let syncFailure = PrivateBrowserMutationUncertaintyStore(
      fileURL: file, synchronizeDirectory: { _ in throw FixtureUncertaintyError.unavailable })
    XCTAssertEqual(try syncFailure.clear(token: token, for: scope), .clearedButSyncUncertain)
    XCTAssertNil(try normal.pendingToken(for: scope))
    XCTAssertThrowsError(try syncFailure.recordIfClear(token: token, for: scope))
    XCTAssertEqual(try normal.pendingToken(for: scope), token)
  }

  private func credential(
    clientID: String = "phone", origin: String = "https://127.0.0.1:8444"
  ) -> NativeEnrollmentCredential {
    let grants = [
      NativeGrant(target: "mac", capabilities: ["browser.read", "browser.control"])
    ]
    return NativeEnrollmentCredential(
      origin: URL(string: origin)!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: clientID, role: "native_phone_controller", label: "Phone", grants: grants,
        createdAt: 1, expiresAt: 2), token: String(repeating: "c", count: 64))
  }

  @MainActor private func eventually(_ condition: @escaping @MainActor () async -> Bool) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out")
  }
}

private actor BrowserPhoneFakeTransport: BrowserPhoneControlTransporting {
  var actions: [BrowserPhoneAction] = []
  private let delayStatus: Bool
  private let delayRead: Bool
  private let readFailure: PhoneControlFailure?
  private let commandError: Bool
  private let source: BrowserPhoneSource
  private let statusSource: BrowserPhoneSource?
  private let commandStatus: BrowserPhoneCommandStatus?
  private let items: [BrowserPhoneItem]
  private let site: BrowserPhoneSite?
  private var commandContinuation: CheckedContinuation<Void, Never>?
  private var statusContinuation: CheckedContinuation<Void, Never>?
  private var readContinuation: CheckedContinuation<Void, Never>?
  init(
    delayStatus: Bool = false, delayRead: Bool = false,
    readFailure: PhoneControlFailure? = nil, commandError: Bool = false,
    source: BrowserPhoneSource = .webmcp, commandStatus: BrowserPhoneCommandStatus? = nil,
    items: [BrowserPhoneItem] = [BrowserPhoneItem(id: "opaque-1", label: "First", state: nil)],
    site: BrowserPhoneSite? = nil, statusSource: BrowserPhoneSource? = nil
  ) {
    self.delayStatus = delayStatus
    self.delayRead = delayRead
    self.readFailure = readFailure
    self.commandError = commandError
    self.source = source
    self.statusSource = statusSource
    self.commandStatus = commandStatus
    self.items = items
    self.site = site
  }
  func execute(
    _ action: BrowserPhoneAction, nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> BrowserPhoneResponse {
    actions.append(action)
    let revision = String(repeating: "a", count: 64)
    switch action {
    case .status, .refresh:
      if delayStatus { await withCheckedContinuation { statusContinuation = $0 } }
      return .status(source: statusSource ?? source, connected: true, revision: revision)
    case .read:
      if delayRead { await withCheckedContinuation { readContinuation = $0 } }
      if let readFailure { throw readFailure }
      return .page(
        BrowserPhonePage(
          nodeID: nodeID, source: source, revision: revision, title: "Page", summary: nil,
          items: items, site: site))
    default:
      if commandError { throw PhoneControlFailure.unavailable }
      if let commandStatus {
        return .command(source: site?.provider == .youtube && action.isYouTubeAccessibilityControl
          ? .accessibility : source, status: commandStatus, revision: revision)
      }
      await withCheckedContinuation { commandContinuation = $0 }
      return .command(source: site?.provider == .youtube && action.isYouTubeAccessibilityControl
        ? .accessibility : source, status: .completed, revision: revision)
    }
  }
  func finishCommand() {
    commandContinuation?.resume()
    commandContinuation = nil
  }
  func finishStatus() {
    statusContinuation?.resume()
    statusContinuation = nil
  }
  func finishRead() {
    readContinuation?.resume()
    readContinuation = nil
  }
}

@MainActor
private final class BrowserPhoneFakeUncertaintyStore: BrowserMutationUncertaintyPersisting {
  private var markers: [String: String] = [:]
  var failReads = false
  var failRecords = false
  var failClears = false

  func pendingToken(for scope: String) throws -> String? {
    if failReads { throw FixtureUncertaintyError.unavailable }
    return markers[scope]
  }

  func recordIfClear(token: String, for scope: String) throws -> Bool {
    if failRecords { throw FixtureUncertaintyError.unavailable }
    guard markers[scope] == nil else { return false }
    markers[scope] = token
    return true
  }

  func clear(
    token: String, for scope: String
  ) throws -> BrowserMutationUncertaintyClearResult {
    if failClears { throw FixtureUncertaintyError.unavailable }
    guard markers[scope] == token else { return .mismatch }
    markers.removeValue(forKey: scope)
    return .cleared
  }

  func pendingTokenValue(for scope: String) -> String? {
    return markers[scope]
  }
}

private enum FixtureUncertaintyError: Error { case unavailable }
