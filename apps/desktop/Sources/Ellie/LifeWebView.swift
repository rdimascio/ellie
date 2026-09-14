import SwiftUI
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum LifeWebTrustPolicy {
  static func matchesEndpoint(_ space: URLProtectionSpace, origin: URL) -> Bool {
    origin.scheme == "https" && space.protocol == "https"
      && space.host == origin.host && space.port == (origin.port ?? 443)
  }
}

@MainActor
final class LifeWebViewModel: ObservableObject {
  enum Phase: Equatable { case loading, ready, grantRequired, revoked, expired, unavailable }
  @Published private(set) var phase: Phase = .loading
  private let credential: LifeWebCredential
  private let authorizer: any LifeWebSessionAuthorizing
  private let sleepUntil: @Sendable (Date) async throws -> Void
  private var expiryTask: Task<Void, Never>?
  private var statusTask: Task<Void, Never>?
  private var foregroundTask: Task<Void, Never>?
  private weak var activeView: WKWebView?
  private var checking = false
  private var generation = 0
  private var lastStatusCheck = Date.distantPast

  init(
    credential: LifeWebCredential,
    authorizer: any LifeWebSessionAuthorizing = NativeLifeWebSessionAuthorizer(),
    sleepUntil: @escaping @Sendable (Date) async throws -> Void = { date in
      try await Task.sleep(for: .seconds(max(0, date.timeIntervalSinceNow)))
    }
  ) {
    self.credential = credential
    self.authorizer = authorizer
    self.sleepUntil = sleepUntil
  }

  func prepare(_ webView: WKWebView, renewing: Bool = false) async {
    guard !Task.isCancelled else { return }
    if renewing {
      guard activeView === webView else { return }
    } else {
      if let previous = activeView { stop(previous) }
      generation += 1
      activeView = webView
      phase = .loading
    }
    let expected = generation
    do {
      let session = try await authorizer.authorize(credential)
      guard current(expected, in: webView) else { return }
      let cookie = try session.cookie(for: credential.origin)
      await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
      guard current(expected, in: webView) else {
        // Cookie insertion can finish after teardown's asynchronous deletion.
        // A discarded WebView owns its own ephemeral store; clear it again.
        if activeView !== webView { Self.clear(webView) }
        return
      }
      phase = .ready
      lastStatusCheck = Date()
      if !renewing { webView.load(URLRequest(url: session.entryURL)) }
      expiryTask?.cancel()
      let scheduled = session.renewalDate(now: Date())
      let waitForExpiry = sleepUntil
      expiryTask = Task { @MainActor [weak self, weak webView] in
        try? await waitForExpiry(scheduled.date)
        guard !Task.isCancelled, let self, let webView,
          self.current(expected, in: webView) else { return }
        // Retain this task through renewal so teardown can cancel its request.
        if scheduled.renew { await self.prepare(webView, renewing: true) }
        else { self.finish(.expired, in: webView, expected: expected) }
      }
      if statusTask == nil { startStatusChecks(in: webView) }
    } catch LifeWebSessionFailure.grantRequired {
      finish(.grantRequired, in: webView, expected: expected)
    } catch LifeWebSessionFailure.revoked {
      finish(.revoked, in: webView, expected: expected)
    } catch {
      finish(.unavailable, in: webView, expected: expected)
    }
  }

  fileprivate func failedAuthentication(in webView: WKWebView) {
    finish(.revoked, in: webView, expected: generation)
  }

  fileprivate func retry() { phase = .loading }

  fileprivate func checkAfterForeground(_ webView: WKWebView) {
    guard Date().timeIntervalSince(lastStatusCheck) >= 30, foregroundTask == nil else { return }
    let expected = generation
    foregroundTask = Task { [weak self, weak webView] in
      guard let self, let webView else { return }
      await self.checkAccess(in: webView, expected: expected)
      if expected == self.generation { self.foregroundTask = nil }
    }
  }

  private func startStatusChecks(in webView: WKWebView) {
    let expected = generation
    statusTask = Task { @MainActor [weak self, weak webView] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        guard !Task.isCancelled, let self, let webView, expected == self.generation else { return }
        await self.checkAccess(in: webView, expected: expected)
      }
    }
  }

  private func checkAccess(in webView: WKWebView, expected: Int) async {
    guard current(expected, in: webView), phase == .ready, !checking else { return }
    checking = true
    defer { if expected == generation { checking = false } }
    do {
      try await authorizer.check(credential)
      guard current(expected, in: webView) else { return }
      lastStatusCheck = Date()
    } catch {
      let failure: Phase = error as? LifeWebSessionFailure == .grantRequired ? .grantRequired
        : error as? LifeWebSessionFailure == .revoked ? .revoked : .unavailable
      finish(failure, in: webView, expected: expected)
    }
  }

  private func current(_ expected: Int, in webView: WKWebView) -> Bool {
    expected == generation && activeView === webView && !Task.isCancelled
  }

  private func finish(_ failure: Phase, in webView: WKWebView, expected: Int) {
    guard current(expected, in: webView) else { return }
    stop(webView)
    phase = failure
  }

  func stop(_ webView: WKWebView) {
    if activeView === webView {
      generation += 1
      activeView = nil
      expiryTask?.cancel(); expiryTask = nil
      statusTask?.cancel(); statusTask = nil
      foregroundTask?.cancel(); foregroundTask = nil
      checking = false
    }
    Self.clear(webView)
  }

  fileprivate static func clear(_ webView: WKWebView) {
    webView.stopLoading()
    webView.loadHTMLString("", baseURL: nil)
    let store = webView.configuration.websiteDataStore
    store.httpCookieStore.getAllCookies { cookies in
      for cookie in cookies where cookie.name == "__Host-ellie_life" {
        store.httpCookieStore.delete(cookie)
      }
    }
    store.removeData(
      ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(),
      modifiedSince: Date(timeIntervalSince1970: 0), completionHandler: {})
  }
}

struct LifeWebView: View {
  @StateObject private var model: LifeWebViewModel
  private let credential: LifeWebCredential

  init(credential: LifeWebCredential) {
    self.credential = credential
    _model = StateObject(wrappedValue: LifeWebViewModel(credential: credential))
  }

  var body: some View {
    Group {
      switch model.phase {
      case .grantRequired:
        ContentUnavailableView {
          Label("Life access needs approval", systemImage: "person.badge.key")
        } description: {
          Text("Ask the Ellie coordinator owner to grant this paired device access.")
        } actions: { Button("Check access again") { model.retry() } }
      case .revoked:
        ContentUnavailableView {
          Label("Life session ended", systemImage: "lock")
        } description: {
          Text("Reconnect the device enrollment before opening Life again.")
        }
      case .expired:
        ContentUnavailableView {
          Label("Life session expired", systemImage: "clock.badge.exclamationmark")
        } description: {
          Text("Your paired credential is still private. Reconnect to open a fresh session.")
        } actions: {
          Button("Reconnect") { model.retry() }
        }
      case .unavailable:
        ContentUnavailableView {
          Label("Ellie Life is unavailable", systemImage: "wifi.exclamationmark")
        } description: {
          Text("Check the paired coordinator and try again.")
        } actions: { Button("Try again") { model.retry() } }
      case .loading, .ready:
        LifePlatformWebView(credential: credential, model: model)
          .overlay { if model.phase == .loading { ProgressView("Opening Ellie Life…") } }
      }
    }
    .navigationTitle("Life")
  }
}

#if os(macOS)
private struct LifePlatformWebView: NSViewRepresentable {
  let credential: LifeWebCredential
  let model: LifeWebViewModel
  func makeCoordinator() -> Coordinator { Coordinator(credential: credential, model: model) }
  func makeNSView(context: Context) -> WKWebView { context.coordinator.makeView() }
  func updateNSView(_ view: WKWebView, context: Context) {}
  static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { coordinator.clear(view) }
}
#else
private struct LifePlatformWebView: UIViewRepresentable {
  let credential: LifeWebCredential
  let model: LifeWebViewModel
  func makeCoordinator() -> Coordinator { Coordinator(credential: credential, model: model) }
  func makeUIView(context: Context) -> WKWebView { context.coordinator.makeView() }
  func updateUIView(_ view: WKWebView, context: Context) {}
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.clear(view) }
}
#endif

private final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
  private let credential: LifeWebCredential
  private weak var model: LifeWebViewModel?
  private var task: Task<Void, Never>?
  private var foregroundObserver: NSObjectProtocol?
  init(credential: LifeWebCredential, model: LifeWebViewModel) {
    self.credential = credential
    self.model = model
  }
  @MainActor func makeView() -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    task = Task { await model?.prepare(view) }
    #if os(macOS)
    let notification = NSApplication.didBecomeActiveNotification
    #else
    let notification = UIApplication.didBecomeActiveNotification
    #endif
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: notification, object: nil, queue: .main
    ) { [weak self, weak view] _ in
      guard let self, let view else { return }
      Task { @MainActor in self.model?.checkAfterForeground(view) }
    }
    return view
  }
  @MainActor func clear(_ view: WKWebView) {
    task?.cancel()
    task = nil
    if let foregroundObserver { NotificationCenter.default.removeObserver(foregroundObserver) }
    foregroundObserver = nil
    model?.stop(view)
    view.navigationDelegate = nil
    view.uiDelegate = nil
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { decisionHandler(.cancel); return }
    if action.navigationType == .linkActivated, action.targetFrame?.isMainFrame != true,
      url.scheme == "https", url.user == nil, url.password == nil
    {
      #if os(macOS)
      NSWorkspace.shared.open(url)
      #else
      UIApplication.shared.open(url)
      #endif
      decisionHandler(.cancel)
      return
    }
    guard
      LifeWebNavigationPolicy.allows(url, mainFrame: action.targetFrame?.isMainFrame == true,
        origin: credential.origin)
    else { decisionHandler(.cancel); return }
    decisionHandler(.allow)
  }
  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      LifeWebTrustPolicy.matchesEndpoint(challenge.protectionSpace, origin: credential.origin),
      let trust = challenge.protectionSpace.serverTrust,
      evaluateNativeServerTrust(
        trust, host: challenge.protectionSpace.host,
        expectedPin: credential.certificateSha256, at: Date())
    else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    if let http = response.response as? HTTPURLResponse, http.statusCode == 401 {
      Task { @MainActor in model?.failedAuthentication(in: webView) }
      decisionHandler(.cancel)
    } else { decisionHandler(.allow) }
  }
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? { nil }
}
