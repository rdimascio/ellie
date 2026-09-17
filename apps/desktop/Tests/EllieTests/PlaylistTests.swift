import Foundation
import WebKit
import XCTest
@testable import Ellie

@MainActor
private final class BlobResultHandler: NSObject, WKScriptMessageHandler {
    var result: String?
    var finished: XCTestExpectation?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard result == nil, let value = message.body as? String, value.utf8.count <= 16 else { return }
        result = value
        finished?.fulfill()
    }
}

final class PlaylistTests: XCTestCase {
    private let syntheticID = "PLSynthetic_123456789"

    func testParsesOnlyBoundedCanonicalIDsAndOfficialPlaylistURLs() {
        XCTAssertEqual(YouTubePlaylist.parse(syntheticID), syntheticID)
        XCTAssertEqual(YouTubePlaylist.parse("https://www.youtube.com/playlist?list=\(syntheticID)"), syntheticID)
        XCTAssertEqual(YouTubePlaylist.parse("https://m.youtube.com/watch?v=synthetic123&list=\(syntheticID)"), syntheticID)
        XCTAssertNil(YouTubePlaylist.parse("https://example.com/playlist?list=\(syntheticID)"))
        XCTAssertNil(YouTubePlaylist.parse("javascript:alert(1)"))
        XCTAssertNil(YouTubePlaylist.parse("PLa/b"))
        XCTAssertNil(YouTubePlaylist.parse("PLé12345678901"))
        XCTAssertNil(YouTubePlaylist.parse("https://user@www.youtube.com/playlist?list=\(syntheticID)"))
        XCTAssertNil(YouTubePlaylist.parse("https://www.youtube.com:443/playlist?list=\(syntheticID)"))
        XCTAssertNil(YouTubePlaylist.parse("https://www.youtube.com/embed?list=\(syntheticID)"))
        XCTAssertNil(YouTubePlaylist.parse("https://www.youtube.com/playlist?list=\(syntheticID)&list=\(syntheticID)"))
        XCTAssertNil(YouTubePlaylist.parse(String(repeating: "P", count: 81)))
    }

    func testPlaylistConfigRoundTripsInDashboardV1AndRejectsUnknownOrInvalidValues() throws {
        let widget = DashboardWidget(id: "playlist", type: .playlist, title: "Listening", size: .wide,
            config: ["youtubePlaylistID": syntheticID])
        let state = DashboardState(dashboards: [Dashboard(id: "home", name: "Home", widgets: [widget])])
        XCTAssertEqual(try DashboardModel.decode(DashboardModel.encode(state)), state)

        let invalid = DashboardWidget(id: "playlist", type: .playlist, title: "Listening", size: .small,
            config: ["youtubePlaylistID": "not-a-playlist"])
        XCTAssertThrowsError(try DashboardModel.encode(DashboardState(dashboards: [Dashboard(id: "home", name: "Home", widgets: [invalid])])))
        let unknown = DashboardWidget(id: "playlist", type: .playlist, title: "Listening", size: .small,
            config: ["account": "none"])
        XCTAssertThrowsError(try DashboardModel.encode(DashboardState(dashboards: [Dashboard(id: "home", name: "Home", widgets: [unknown])])))
    }

    func testNavigationPolicyAllowsOnlyEmbedMainFrameAndRequiredHTTPSSubframes() {
        let policy = PlaylistNavigationPolicy(bundleIdentifier: "org.ellie.dashboard")!
        XCTAssertEqual(policy.origin.absoluteString, "https://org.ellie.dashboard")
        XCTAssertEqual(policy.documentURL.absoluteString, "https://org.ellie.dashboard/playlist-player")
        XCTAssertTrue(policy.allows(policy.documentURL, mainFrame: true))
        XCTAssertTrue(policy.allows(URL(string: "https://www.youtube-nocookie.com/embed")!, mainFrame: false))
        XCTAssertTrue(policy.allows(URL(string: "https://www.youtube-nocookie.com/embed/synthetic")!, mainFrame: false))
        XCTAssertTrue(policy.allows(URL(string: "about:blank")!, mainFrame: false))
        XCTAssertFalse(policy.allows(URL(string: "about:config")!, mainFrame: false))
        XCTAssertFalse(policy.allows(URL(string: "https://www.youtube-nocookie.com/watch?v=synthetic")!, mainFrame: false))
        XCTAssertFalse(policy.allows(URL(string: "https://www.youtube.com/watch?v=synthetic")!, mainFrame: true))
        XCTAssertFalse(policy.allows(URL(string: "http://www.youtube-nocookie.com/embed")!, mainFrame: true))
        XCTAssertFalse(policy.allows(URL(string: "https://ellie.local/playlist-player")!, mainFrame: true))
        XCTAssertFalse(policy.allows(URL(string: "https://youtube-nocookie.com.evil.example/embed")!, mainFrame: false))
        XCTAssertFalse(policy.allows(URL(string: "file:///tmp/media")!, mainFrame: false))
        XCTAssertNil(PlaylistNavigationPolicy(bundleIdentifier: nil))
        XCTAssertNil(PlaylistNavigationPolicy(bundleIdentifier: "org.ellie.dashboard/evil"))
    }

    func testPlayerErrorsDistinguishEmbeddingDisabledFromUnavailable() {
        XCTAssertEqual(PlaylistPlayerState.playerError(101), .embeddingDisabled)
        XCTAssertEqual(PlaylistPlayerState.playerError(150), .embeddingDisabled)
        XCTAssertEqual(PlaylistPlayerState.playerError(153), .clientIdentityMissing)
        XCTAssertEqual(PlaylistPlayerState.playerError(100), .unavailable)
        XCTAssertEqual(PlaylistPlayerState.playerError(nil), .unavailable)
    }

    func testSharedPlayerDocumentAcceptsOnlyValidatedPlaylistIDs() throws {
        let desktop = try XCTUnwrap(PlaylistNavigationPolicy(bundleIdentifier: "org.ellie.dashboard"))
        let ios = try XCTUnwrap(PlaylistNavigationPolicy(bundleIdentifier: "org.ellie.dashboard.ios"))
        let html = try XCTUnwrap(desktop.playerHTML(playlistID: syntheticID))
        XCTAssertTrue(html.contains("list:'\(syntheticID)'"))
        XCTAssertTrue(html.contains("origin:'https://org.ellie.dashboard'"))
        XCTAssertTrue(try XCTUnwrap(ios.playerHTML(playlistID: syntheticID)).contains("origin:'https://org.ellie.dashboard.ios'"))
        XCTAssertTrue(html.contains("https://www.youtube-nocookie.com"))
        XCTAssertTrue(html.contains("autoplay:1"))
        XCTAssertNil(desktop.playerHTML(playlistID: "bad');alert(1)//"))
        XCTAssertEqual(YouTubePlaylist.publicURL(for: syntheticID)?.absoluteString,
            "https://www.youtube.com/playlist?list=\(syntheticID)")
    }

    @MainActor
    func testProductionContentRuleGrammarCompilesWithoutLoadingProviderContent() async throws {
        let store = try XCTUnwrap(WKContentRuleListStore.default())
        let identifier = "ElliePlaylistRuleGrammarTest-\(UUID().uuidString)"
        let compileFinished = expectation(description: "WebKit compiles the production rule grammar")
        var compiled = false
        store.compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: PlaylistNavigationPolicy.contentRuleListJSON
        ) { list, error in
            compiled = list != nil && error == nil
            compileFinished.fulfill()
        }
        await fulfillment(of: [compileFinished], timeout: 5)

        let removalFinished = expectation(description: "WebKit removes only the test rule list")
        store.removeContentRuleList(forIdentifier: identifier) { _ in
            removalFinished.fulfill()
        }
        await fulfillment(of: [removalFinished], timeout: 5)
        XCTAssertTrue(compiled, "The exact production content-rule grammar must be supported by WebKit.")
    }

    @MainActor
    func testProductionRulesAllowOnlyTrustedPlayerBlobOrigin() async throws {
        let store = try XCTUnwrap(WKContentRuleListStore.default())
        let identifier = "ElliePlaylistBlobRuleTest-\(UUID().uuidString)"
        let compileFinished = expectation(description: "WebKit compiles production Blob rules")
        var compiledList: WKContentRuleList?
        store.compileContentRuleList(
            forIdentifier: identifier,
            encodedContentRuleList: PlaylistNavigationPolicy.contentRuleListJSON
        ) { list, _ in
            compiledList = list
            compileFinished.fulfill()
        }
        await fulfillment(of: [compileFinished], timeout: 5)

        let list = try XCTUnwrap(compiledList)
        let trusted = await blobFetchResult(
            origin: URL(string: "https://www.youtube-nocookie.com/embed")!,
            ruleList: list,
            label: "trusted player Blob"
        )
        let unrelated = await blobFetchResult(
            origin: URL(string: "https://unrelated.invalid/embed")!,
            ruleList: list,
            label: "unrelated Blob"
        )

        let removalFinished = expectation(description: "WebKit removes the Blob test rule list")
        store.removeContentRuleList(forIdentifier: identifier) { _ in removalFinished.fulfill() }
        await fulfillment(of: [removalFinished], timeout: 5)

        XCTAssertEqual(trusted, "success")
        XCTAssertEqual(unrelated, "blocked")
    }

    @MainActor
    private func blobFetchResult(origin: URL, ruleList: WKContentRuleList, label: String) async -> String? {
        let handler = BlobResultHandler()
        let finished = expectation(description: label)
        handler.finished = finished
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(ruleList)
        configuration.userContentController.add(handler, name: "result")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.loadHTMLString("""
        <script>
        const url = URL.createObjectURL(new Blob(['ok'], {type:'text/plain'}));
        fetch(url).then(response => response.text())
          .then(text => webkit.messageHandlers.result.postMessage(text === 'ok' ? 'success' : 'wrong'))
          .catch(() => webkit.messageHandlers.result.postMessage('blocked'));
        </script>
        """, baseURL: origin)
        await fulfillment(of: [finished], timeout: 5)
        view.stopLoading()
        configuration.userContentController.removeScriptMessageHandler(forName: "result")
        view.loadHTMLString("", baseURL: nil)
        return handler.result
    }
}
