import Combine
import SwiftUI
@preconcurrency import WebKit

@MainActor
private final class IOSPlaylistPlayerModel: ObservableObject {
    @Published var state: PlaylistPlayerState = .loading
}

struct IOSPlaylistWidget: View {
    let widget: DashboardWidget
    let configure: () -> Void
    @State private var showingPlayer = false

    private var playlistID: String? {
        widget.config["youtubePlaylistID"].flatMap { YouTubePlaylist.isValidID($0) ? $0 : nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let playlistID {
                Text("YouTube playlist is ready").font(.subheadline)
                Text("Playback starts only when you open the player.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Play Playlist") { showingPlayer = true }
                    .accessibilityIdentifier("playlist-play-\(widget.id)")
                    .sheet(isPresented: $showingPlayer) {
                        IOSPlaylistPlayerSheet(playlistID: playlistID, title: widget.title)
                    }
            } else {
                Text("Choose a YouTube playlist to play here.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Set Up Playlist", action: configure)
                    .accessibilityIdentifier("playlist-setup-\(widget.id)")
            }
        }
        .onChange(of: widget.config["youtubePlaylistID"]) { _, _ in showingPlayer = false }
    }
}

private struct IOSPlaylistPlayerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = IOSPlaylistPlayerModel()
    let playlistID: String
    let title: String

    var body: some View {
        NavigationStack {
            ZStack {
                IOSPlaylistWebView(playlistID: playlistID, model: model)
                if model.state == .loading {
                    ProgressView("Connecting to YouTube…")
                        .padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
                if let message = model.state.message {
                    VStack(spacing: 12) {
                        ContentUnavailableView("Playback unavailable", systemImage: "exclamationmark.triangle",
                            description: Text(message))
                        if let url = YouTubePlaylist.publicURL(for: playlistID) {
                            Link("Open in YouTube", destination: url)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Close") { dismiss() } } }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { dismiss() } }
    }
}

private struct IOSPlaylistWebView: UIViewRepresentable {
    let playlistID: String
    @ObservedObject var model: IOSPlaylistPlayerModel

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(
            source: "Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:function(_,e){if(e)e({code:1,message:'Permission denied'})},watchPosition:function(_,e){if(e)e({code:1,message:'Permission denied'});return 0},clearWatch:function(){}},configurable:false});",
            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        configuration.userContentController.add(context.coordinator, name: "elliePlayer")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "ElliePlaylistMediaAllowlistV1",
            encodedContentRuleList: PlaylistNavigationPolicy.contentRuleListJSON
        ) { list, _ in
            Task { @MainActor in
                guard context.coordinator.isActive else { return }
                guard let list, let html = PlaylistNavigationPolicy.playerHTML(playlistID: playlistID)
                else { context.coordinator.failSetup(); return }
                view.configuration.userContentController.add(list)
                context.coordinator.startTimeout()
                view.loadHTMLString(html, baseURL: PlaylistNavigationPolicy.documentOrigin)
            }
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.stop()
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "elliePlayer")
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.loadHTMLString("", baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let model: IOSPlaylistPlayerModel
        private var timeoutTask: Task<Void, Never>?
        private(set) var isActive = true

        init(model: IOSPlaylistPlayerModel) { self.model = model }
        func startTimeout() {
            timeoutTask?.cancel()
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, self.isActive, self.model.state == .loading else { return }
                self.model.state = .networkUnavailable
            }
        }
        func stop() { isActive = false; timeoutTask?.cancel(); timeoutTask = nil }
        func failSetup() { if isActive { model.state = .unavailable } }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard isActive, message.name == "elliePlayer", message.frameInfo.isMainFrame,
                  origin.protocol == "https", origin.host == "ellie.local",
                  let body = message.body as? [String: Any], body.count <= 2,
                  let type = body["type"] as? String, type.utf8.count <= 16 else { return }
            if type == "ready" { timeoutTask?.cancel(); model.state = .ready }
            else if type == "network" { timeoutTask?.cancel(); model.state = .networkUnavailable }
            else if type == "error" {
                timeoutTask?.cancel()
                let number = body["value"] as? NSNumber
                let code = number.flatMap { (0...999).contains($0.intValue) && $0.doubleValue == Double($0.intValue) ? $0.intValue : nil }
                model.state = .playerError(code)
            }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.shouldPerformDownload { decisionHandler(.cancel); return }
            guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
            decisionHandler(PlaylistNavigationPolicy.allows(url,
                mainFrame: navigationAction.targetFrame?.isMainFrame == true) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard let url = navigationResponse.response.url,
                  PlaylistNavigationPolicy.allows(url, mainFrame: navigationResponse.isForMainFrame),
                  navigationResponse.canShowMIMEType else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if isActive { model.state = .networkUnavailable }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if isActive { model.state = .networkUnavailable }
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            if isActive { timeoutTask?.cancel(); model.state = .playerStopped }
        }
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                     initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                     decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
                     completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
            if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
                completionHandler(.performDefaultHandling, nil)
            } else { completionHandler(.cancelAuthenticationChallenge, nil) }
        }
    }
}
