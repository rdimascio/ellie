import Combine
import SwiftUI
@preconcurrency import WebKit

@MainActor
final class PlaylistPlayerModel: ObservableObject {
    @Published var state: PlaylistPlayerState = .loading
}

struct NativePlaylist: View {
    let widget: DashboardWidget
    let configure: () -> Void
    @State private var showingPlayer = false

    private var playlistID: String? {
        widget.config["youtubePlaylistID"].flatMap { YouTubePlaylist.isValidID($0) ? $0 : nil }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            Image(systemName: playlistID == nil ? "rectangle.stack.badge.plus" : "play.rectangle.fill")
                .font(.system(size: 36, weight: .light)).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if let playlistID {
                Text("Ready to play").font(.system(size: 19, weight: .semibold))
                Text("YouTube is contacted only after you press Play.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Button { showingPlayer = true } label: { Label("Play Playlist", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent)
                    .sheet(isPresented: $showingPlayer) {
                        PlaylistPlayerSheet(playlistID: playlistID, title: widget.title)
                    }
            } else {
                Text("Choose a playlist").font(.system(size: 19, weight: .semibold))
                Text("Add a public YouTube playlist. Playback never starts automatically.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                Button("Set Up Playlist…", action: configure).buttonStyle(.bordered)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 155, alignment: .leading)
        .onChange(of: widget.config["youtubePlaylistID"]) { _, _ in showingPlayer = false }
    }
}

private struct PlaylistPlayerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = PlaylistPlayerModel()
    let playlistID: String
    let title: String

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(title, systemImage: "play.rectangle.fill").font(.headline).lineLimit(1)
                Spacer()
                Button("Close") { dismiss() }.keyboardShortcut(.cancelAction)
            }.padding(16)
            Divider()
            ZStack {
                if model.state.message == nil {
                    PlaylistWebView(playlistID: playlistID, model: model)
                }
                if model.state == .loading { ProgressView("Connecting to YouTube…").padding(20).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)) }
                if let message = model.state.message {
                    ContentUnavailableView("Playback unavailable", systemImage: "exclamationmark.triangle", description: Text(message))
                        .background(Color(nsColor: .windowBackgroundColor))
                }
            }
        }
        .frame(minWidth: 720, minHeight: 460)
    }
}

private struct PlaylistWebView: NSViewRepresentable {
    let playlistID: String
    @ObservedObject var model: PlaylistPlayerModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, policy: PlaylistNavigationPolicy(bundleIdentifier: Bundle.main.bundleIdentifier))
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.addUserScript(WKUserScript(
            source: "Object.defineProperty(navigator,'geolocation',{value:{getCurrentPosition:function(_,e){if(e)e({code:1,message:'Permission denied'})},watchPosition:function(_,e){if(e)e({code:1,message:'Permission denied'});return 0},clearWatch:function(){}},configurable:false});",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        configuration.userContentController.add(context.coordinator, name: "elliePlayer")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.allowsMagnification = false
        Self.installContentRules(on: view, playlistID: playlistID, coordinator: context.coordinator)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) { }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        coordinator.stop()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "elliePlayer")
        view.navigationDelegate = nil
        view.uiDelegate = nil
        view.loadHTMLString("", baseURL: nil)
    }

    private static func installContentRules(on view: WKWebView, playlistID: String, coordinator: Coordinator) {
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "ElliePlaylistMediaAllowlistV1", encodedContentRuleList: PlaylistNavigationPolicy.contentRuleListJSON
        ) { list, _ in
            Task { @MainActor in
                guard let list, coordinator.isActive else { coordinator.failSetup(); return }
                view.configuration.userContentController.add(list)
                coordinator.startTimeout()
                guard let policy = coordinator.policy, let html = policy.playerHTML(playlistID: playlistID) else {
                    coordinator.failSetup()
                    return
                }
                view.loadHTMLString(html, baseURL: policy.documentURL)
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let model: PlaylistPlayerModel
        let policy: PlaylistNavigationPolicy?
        private var timeoutTask: Task<Void, Never>?
        private(set) var isActive = true
        init(model: PlaylistPlayerModel, policy: PlaylistNavigationPolicy?) {
            self.model = model
            self.policy = policy
        }

        func startTimeout() {
            timeoutTask?.cancel()
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(15))
                guard !Task.isCancelled, let self, self.model.state == .loading else { return }
                self.model.state = .networkUnavailable
            }
        }
        func stop() { isActive = false; timeoutTask?.cancel(); timeoutTask = nil }
        func failSetup() { if isActive { model.state = .unavailable } }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            let origin = message.frameInfo.securityOrigin
            guard isActive, message.name == "elliePlayer", message.frameInfo.isMainFrame,
                  let policy, origin.protocol == "https", origin.host.lowercased() == policy.origin.host,
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
            let allowed = policy?.allows(url, mainFrame: navigationAction.targetFrame?.isMainFrame == true) == true
            decisionHandler(allowed ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            guard let url = navigationResponse.response.url,
                  policy?.allows(url, mainFrame: navigationResponse.isForMainFrame) == true,
                  navigationResponse.canShowMIMEType else { decisionHandler(.cancel); return }
            decisionHandler(.allow)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { model.state = .networkUnavailable }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { model.state = .networkUnavailable }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { timeoutTask?.cancel(); model.state = .playerStopped }
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
