import Foundation
import XCTest
import WebKit
@testable import Ellie

final class LifeWebSessionTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_800_000_000)

  func testStrictSessionResponseUsesFixedLifeEntryAndBoundedExpiry() throws {
    let credential = fixtureCredential(expiresAt: milliseconds(20 * 60))
    let data = try JSONSerialization.data(withJSONObject: [
      "sessionToken": String(repeating: "a", count: 64),
      "expiresAt": milliseconds(10 * 60),
      "entryPath": "/life/",
    ])
    let session = try LifeWebSession.decode(data, credential: credential, now: now)
    XCTAssertEqual(session.entryURL.absoluteString, "https://ellie.test:7443/life/")
    XCTAssertEqual(session.expiresAt, milliseconds(10 * 60))
    let cookie = try session.cookie(for: credential.origin)
    XCTAssertEqual(cookie.name, "__Host-ellie_life")
    XCTAssertEqual(cookie.path, "/")
    XCTAssertEqual(cookie.domain, "ellie.test")
    XCTAssertTrue(cookie.isSecure)
    XCTAssertTrue(cookie.isHTTPOnly)
    XCTAssertEqual(cookie.sameSitePolicy, .strict)
    let renewal = session.renewalDate(now: now)
    XCTAssertTrue(renewal.renew)
    XCTAssertEqual(renewal.date, now.addingTimeInterval(9 * 60))

    for invalid in [
      ["sessionToken": String(repeating: "z", count: 64), "expiresAt": milliseconds(10 * 60), "entryPath": "/life/"] as [String: Any],
      ["sessionToken": String(repeating: "A", count: 64), "expiresAt": milliseconds(10 * 60), "entryPath": "/life/"] as [String: Any],
      ["sessionToken": String(repeating: "a", count: 64) + "\n", "expiresAt": milliseconds(10 * 60), "entryPath": "/life/"] as [String: Any],
      ["sessionToken": String(repeating: "a", count: 64), "expiresAt": milliseconds(31 * 60), "entryPath": "/life/"] as [String: Any],
      ["sessionToken": String(repeating: "a", count: 64), "expiresAt": milliseconds(10 * 60), "entryPath": "/"] as [String: Any],
      ["sessionToken": String(repeating: "a", count: 64), "expiresAt": milliseconds(10 * 60), "entryPath": "/life/", "extra": true] as [String: Any],
    ] {
      let encoded = try JSONSerialization.data(withJSONObject: invalid)
      XCTAssertThrowsError(try LifeWebSession.decode(encoded, credential: credential, now: now))
    }
  }

  func testSessionCannotOutliveNativeCredential() throws {
    let credential = fixtureCredential(expiresAt: milliseconds(5 * 60))
    let response = try JSONSerialization.data(withJSONObject: [
      "sessionToken": String(repeating: "b", count: 64),
      "expiresAt": milliseconds(6 * 60), "entryPath": "/life/",
    ])
    XCTAssertThrowsError(try LifeWebSession.decode(response, credential: credential, now: now))
  }

  func testVeryShortSessionExpiresInsteadOfLoopingRenewal() throws {
    let credential = fixtureCredential(expiresAt: milliseconds(20 * 60))
    let response = try JSONSerialization.data(withJSONObject: [
      "sessionToken": String(repeating: "b", count: 64),
      "expiresAt": milliseconds(90), "entryPath": "/life/",
    ])
    let session = try LifeWebSession.decode(response, credential: credential, now: now)
    let renewal = session.renewalDate(now: now)
    XCTAssertFalse(renewal.renew)
    XCTAssertEqual(renewal.date, now.addingTimeInterval(90))
  }

  func testMacEnrollmentCredentialRequiresExplicitLifeGrant() throws {
    let credential = fixtureCredential(expiresAt: milliseconds(20 * 60))
    XCTAssertEqual(credential.origin.absoluteString, "https://ellie.test:7443")
    XCTAssertThrowsError(
      try LifeWebSession.decodeHTTP(
        status: 403, data: Data("{}".utf8), credential: credential, now: now)
    ) { error in XCTAssertEqual(error as? LifeWebSessionFailure, .grantRequired) }
    XCTAssertThrowsError(
      try LifeWebSession.decodeHTTP(
        status: 401, data: Data("{}".utf8), credential: credential, now: now)
    ) { error in XCTAssertEqual(error as? LifeWebSessionFailure, .revoked) }
  }

  func testReadOnlyAuthorityStatusIsExact() throws {
    try LifeWebSession.checkHTTP(status: 200, data: Data(#"{"allowed":true}"#.utf8))
    for fixture in [
      (200, #"{"allowed":true,"extra":1}"#, LifeWebSessionFailure.unavailable),
      (200, #"{"allowed":false}"#, LifeWebSessionFailure.unavailable),
      (200, #"{"allowed":1}"#, LifeWebSessionFailure.unavailable),
      (401, #"{}"#, LifeWebSessionFailure.revoked),
      (403, #"{}"#, LifeWebSessionFailure.grantRequired),
      (503, #"{}"#, LifeWebSessionFailure.unavailable),
    ] {
      XCTAssertThrowsError(try LifeWebSession.checkHTTP(
        status: fixture.0, data: Data(fixture.1.utf8)
      )) { error in XCTAssertEqual(error as? LifeWebSessionFailure, fixture.2) }
    }
  }

  func testNavigationAllowsOnlyLifeSameOriginMainFrames() throws {
    let origin = try XCTUnwrap(URL(string: "https://ellie.test:7443"))
    XCTAssertTrue(LifeWebNavigationPolicy.allows(
      try XCTUnwrap(URL(string: "https://ellie.test:7443/life/assets/app.js")),
      mainFrame: true, origin: origin))
    XCTAssertTrue(LifeWebNavigationPolicy.allows(
      try XCTUnwrap(URL(string: "https://ellie.test:7443/api/life/plugins/weather/view")),
      mainFrame: false, origin: origin))
    XCTAssertTrue(LifeWebNavigationPolicy.allows(
      try XCTUnwrap(URL(string: "about:srcdoc")), mainFrame: false, origin: origin))
    for url in [
      "https://attacker.test/life/", "http://ellie.test:7443/life/",
      "https://ellie.test:7444/life/", "https://user:secret@ellie.test:7443/life/",
      "https://ellie.test:7443/admin",
    ] {
      XCTAssertFalse(LifeWebNavigationPolicy.allows(
        try XCTUnwrap(URL(string: url)), mainFrame: true, origin: origin))
    }
    XCTAssertFalse(LifeWebNavigationPolicy.allows(
      try XCTUnwrap(URL(string: "https://ellie.test:7443/life/")),
      mainFrame: false, origin: origin))
  }

  @MainActor
  func testLateAuthorizationFailureCannotReplaceAReconnectedView() async {
    let authorizer = HeldLifeAuthorizer()
    let model = LifeWebViewModel(
      credential: fixtureCredential(expiresAt: milliseconds(20 * 60)), authorizer: authorizer)
    let oldView = LifeCookieTestView(), newView = LifeCookieTestView()
    defer { model.stop(oldView); model.stop(newView) }
    let original = Task { await model.prepare(oldView) }
    await eventually { await authorizer.callCount == 1 }
    model.stop(oldView)
    let reconnected = Task { await model.prepare(newView) }
    await eventually { await authorizer.callCount == 2 }
    await authorizer.finish(2, with: .success(liveSession(token: "b")))
    await reconnected.value
    XCTAssertEqual(model.phase, .ready)
    model.stop(oldView) // A delayed old representable teardown must also be harmless.
    await authorizer.finish(1, with: .failure(.grantRequired))
    await original.value
    XCTAssertEqual(model.phase, .ready)
    XCTAssertEqual(newView.loadedRequests.count, 1)
    let cookies = await newView.configuration.websiteDataStore.httpCookieStore.allCookies()
    XCTAssertEqual(cookies.map(\.value), [String(repeating: "b", count: 64)])
  }

  @MainActor
  func testRenewalIsCancelledAndCannotInstallACookieAfterTeardown() async {
    let authorizer = HeldLifeAuthorizer(), clock = HeldLifeRenewalClock()
    let model = LifeWebViewModel(
      credential: fixtureCredential(expiresAt: milliseconds(20 * 60)), authorizer: authorizer,
      sleepUntil: { date in try await clock.sleep(until: date) })
    let oldView = LifeCookieTestView(), newView = LifeCookieTestView()
    defer { model.stop(oldView); model.stop(newView) }
    let original = Task { await model.prepare(oldView) }
    await eventually { await authorizer.callCount == 1 }
    await authorizer.finish(1, with: .success(liveSession(token: "a")))
    await original.value
    await eventually { await clock.waiting }
    await clock.fire()
    await eventually { await authorizer.callCount == 2 }
    model.stop(oldView)
    let reconnected = Task { await model.prepare(newView) }
    await eventually { await authorizer.callCount == 3 }
    await authorizer.finish(3, with: .success(liveSession(token: "b")))
    await reconnected.value
    await authorizer.finish(2, with: .success(liveSession(token: "c")))
    await eventually { await authorizer.finishedCalls.contains(2) }
    await Task.yield()
    let cancelled = await authorizer.cancelledCalls
    XCTAssertTrue(cancelled.contains(2), "teardown must cancel the task that owns active renewal")
    XCTAssertEqual(model.phase, .ready)
    let oldCookies = await oldView.configuration.websiteDataStore.httpCookieStore.allCookies()
    let newCookies = await newView.configuration.websiteDataStore.httpCookieStore.allCookies()
    XCTAssertTrue(oldCookies.isEmpty, "late renewal must not reinstall credentials after teardown")
    XCTAssertEqual(newCookies.map(\.value), [String(repeating: "b", count: 64)])
    XCTAssertEqual(newView.loadedRequests.count, 1)
  }

  private func liveSession(token: String) -> LifeWebSession {
    LifeWebSession(
      token: String(repeating: token, count: 64),
      expiresAt: Int64(Date().addingTimeInterval(600).timeIntervalSince1970 * 1_000),
      entryURL: URL(string: "https://ellie.test:7443/life/")!)
  }

  @MainActor
  private func eventually(_ predicate: () async -> Bool) async {
    let deadline = Date().addingTimeInterval(5)
    while !(await predicate()) {
      if Date() >= deadline { XCTFail("Native Life fixture did not reach its expected state"); return }
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  private func fixtureCredential(expiresAt: Int64) -> LifeWebCredential {
    LifeWebCredential(
      enrollment: NativeEnrollmentCredential(
        origin: URL(string: "https://ellie.test:7443")!,
        certificateSha256: String(repeating: "c", count: 64),
        client: NativeClient(
          id: "mac-life", role: "native_phone_controller", label: "Mac",
          grants: [], createdAt: milliseconds(-60), expiresAt: expiresAt),
        token: String(repeating: "d", count: 64)))
  }

  private func milliseconds(_ offset: TimeInterval) -> Int64 {
    Int64(now.addingTimeInterval(offset).timeIntervalSince1970 * 1_000)
  }
}

/** Exercise actual isolated WebKit cookie stores without making network requests. */
@MainActor
private final class LifeCookieTestView: WKWebView {
  var loadedRequests: [URLRequest] = []
  init() {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    super.init(frame: .zero, configuration: configuration)
  }
  required init?(coder: NSCoder) { fatalError("Fixture does not decode archives") }
  override func load(_ request: URLRequest) -> WKNavigation? {
    loadedRequests.append(request)
    return nil
  }
  override func loadHTMLString(_ string: String, baseURL: URL?) -> WKNavigation? { nil }
}

private actor HeldLifeAuthorizer: LifeWebSessionAuthorizing {
  private(set) var callCount = 0
  private(set) var finishedCalls: Set<Int> = []
  private(set) var cancelledCalls: Set<Int> = []
  private var pending: [Int: CheckedContinuation<LifeWebSession, Error>] = [:]
  func authorize(_ credential: LifeWebCredential) async throws -> LifeWebSession {
    callCount += 1
    let call = callCount
    defer {
      finishedCalls.insert(call)
      if Task.isCancelled { cancelledCalls.insert(call) }
    }
    return try await withCheckedThrowingContinuation { pending[call] = $0 }
  }
  func check(_ credential: LifeWebCredential) async throws {}
  func finish(_ call: Int, with result: Result<LifeWebSession, LifeWebSessionFailure>) {
    pending.removeValue(forKey: call)?.resume(with: result.mapError { $0 as Error })
  }
}

private actor HeldLifeRenewalClock {
  private var continuation: CheckedContinuation<Void, Never>?
  var waiting: Bool { continuation != nil }
  private var calls = 0
  func sleep(until date: Date) async throws {
    calls += 1
    if calls == 1 { await withCheckedContinuation { continuation = $0 } }
    else { try await Task.sleep(for: .seconds(3600)) }
  }
  func fire() { continuation?.resume(); continuation = nil }
}
