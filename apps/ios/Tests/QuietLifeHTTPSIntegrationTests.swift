import XCTest

@testable import Ellie

final class QuietLifeHTTPSIntegrationTests: XCTestCase {
  private let fixtureTarget = "quiet-fixture-no-node"

  override func setUp() {
    super.setUp()
    continueAfterFailure = false
  }

  private func credential(_ role: String) throws -> NativeEnrollmentCredential {
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    let origin = try XCTUnwrap(URL(string: try XCTUnwrap(
      bundle.object(forInfoDictionaryKey: "EllieATSTestOrigin") as? String)))
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "EllieATSTestPin") as? String)
    let token: String
    switch role {
    case "allowed": token = String(repeating: "9a", count: 32)
    case "denied": token = String(repeating: "9b", count: 32)
    case "revocable": token = String(repeating: "9c", count: 32)
    default: throw IOSQuietFailure.invalidRequest
    }
    return NativeEnrollmentCredential(origin: origin, certificateSha256: pin,
      client: NativeClient(id: "quiet-\(role)", role: "native_phone_controller",
        label: "Quiet \(role)", grants: [NativeGrant(target: fixtureTarget, capabilities: ["app.open"])],
        createdAt: 1, expiresAt: 9_007_199_254_740_000), token: token)
  }

  @MainActor
  func testPinnedSessionsReadVerifiedActivityAndReconcileOneReviewedVoiceTurnAfterRelaunch() async throws {
    let allowed = try credential("allowed")
    let sessions = IOSQuietSessionsStore()
    sessions.bind(allowed)
    sessions.refreshRecent()
    try await eventually { !sessions.busy && sessions.recent.count >= 1 }
    let selected = try XCTUnwrap(sessions.recent.first {
      $0.title.contains("family albums")
    })
    sessions.open(selected.id)
    try await eventually { !sessions.busy && sessions.detail?.session.id == selected.id }
    let detail = try XCTUnwrap(sessions.detail)
    XCTAssertEqual(detail.originalRequest, "Review the family albums 👩‍👩‍👧‍👧")
    let activity = try XCTUnwrap(detail.activity.first)
    XCTAssertEqual(activity.id, "quiet.task:album@fixture/one")
    XCTAssertEqual(activity.state, "succeeded")
    XCTAssertEqual(activity.progress, ["Checked the album register"])
    XCTAssertEqual(activity.finding?.summary, "Three albums verified.")
    XCTAssertEqual(activity.finding?.citations, ["Family album register 👩‍👩‍👧‍👧"])
    XCTAssertFalse(activity.findingStale)

    let journalDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ellie-quiet-https-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: journalDirectory) }
    let journal = PrivateBrowserMutationUncertaintyStore(
      fileURL: journalDirectory.appendingPathComponent("pending.json"))
    let before = try await control("stats", credential: allowed)
    try await control("arm-chat-response", credential: allowed)
    let first = IOSQuietVoiceStore(credential: allowed, journal: journal)
    first.restore()
    XCTAssertTrue(first.canSend)
    first.sendReviewed("What is the family plan?")
    try await waitForCounter("chat-response-held/\(before.nativeChatPosts + 1)", credential: allowed)
    XCTAssertEqual(first.phase, .sending)
    first.background()
    XCTAssertEqual(first.phase, .unknown)

    let relaunched = IOSQuietVoiceStore(credential: allowed, journal: journal)
    relaunched.restore()
    XCTAssertEqual(relaunched.phase, .unknown)
    relaunched.reconcile()
    try await eventually {
      if case .completed = relaunched.phase { return true }
      return false
    }
    guard case .completed(let answer) = relaunched.phase else {
      XCTFail("A durable read-only reply did not reconcile")
      return
    }
    XCTAssertEqual(answer.reply, "Family 👩‍👩‍👧‍👧\r\n日本語 read-only answer.")
    XCTAssertFalse(answer.needsMacReview)
    try await control("release-chat-response", credential: allowed)
    try await waitForCounter("chat-response-released/1", credential: allowed)
    let after = try await control("stats", credential: allowed)
    XCTAssertEqual(after.nativeChatPosts, before.nativeChatPosts + 1,
      "Relaunch must read durable status without a second POST")
    XCTAssertEqual(after.durableTurns, before.durableTurns + 1)
    XCTAssertTrue(relaunched.canSend == false)

    do {
      let denied = try credential("denied")
      _ = try await IOSPinnedQuietClient().sessions(denied, limit: 3, cursor: nil)
      XCTFail("Native enrollment alone authorized private Life sessions")
    } catch { XCTAssertEqual(error as? LifeWebSessionFailure, .grantRequired) }
  }

  @MainActor
  func testCancelledAndRevokedDelayedPinnedDetailNeverPublishesOrResends() async throws {
    let allowed = try credential("allowed")
    let denied = try credential("denied")
    let client = RecordingPinnedQuietClient()
    let store = IOSQuietSessionsStore(client: client)
    store.bind(allowed)
    store.refreshRecent()
    try await eventually { !store.busy && store.recent.count >= 1 }
    let id = try XCTUnwrap(store.recent.first { $0.title.contains("family albums") }?.id)
    let before = try await control("stats", credential: allowed)

    try await control("arm-detail", credential: allowed)
    store.open(id)
    try await waitForCounter("detail-started/\(before.detailStarted + 1)", credential: allowed)
    store.cancel()
    XCTAssertNil(store.detail)
    try await control("release-detail", credential: allowed)
    try await waitForCounter("detail-settled/\(before.detailSettled + 1)", credential: allowed)
    try await noLatePublication(store, client: client, completed: 1)
    XCTAssertNil(store.detail)

    store.refreshRecent()
    try await eventually { !store.busy && store.recent.contains(where: { $0.id == id }) }
    try await control("arm-detail", credential: allowed)
    store.open(id)
    try await waitForCounter("detail-started/\(before.detailStarted + 2)", credential: allowed)
    store.bind(denied)
    try await control("release-detail", credential: allowed)
    try await waitForCounter("detail-settled/\(before.detailSettled + 2)", credential: allowed)
    try await noLatePublication(store, client: client, completed: 2)
    XCTAssertTrue(store.recent.isEmpty)
    XCTAssertNil(store.detail)

    let revocable = try credential("revocable")
    store.bind(revocable)
    store.refreshRecent()
    try await eventually { !store.busy && store.recent.contains(where: { $0.id == id }) }
    try await control("arm-detail", credential: allowed)
    store.open(id)
    try await waitForCounter("detail-started/\(before.detailStarted + 3)", credential: allowed)
    try await NativeEnrollmentTransport(timeout: 6).logout(revocable)
    store.bind(nil)
    try await control("release-detail", credential: allowed)
    try await waitForCounter("detail-settled/\(before.detailSettled + 3)", credential: allowed)
    try await noLatePublication(store, client: client, completed: 3)
    XCTAssertTrue(store.recent.isEmpty)
    XCTAssertNil(store.detail)
    let after = try await control("stats", credential: allowed)
    XCTAssertEqual(after.nativeChatPosts, before.nativeChatPosts,
      "Cancelling or revoking reads cannot send a Life question")
  }

  @MainActor
  private func noLatePublication(_ store: IOSQuietSessionsStore,
    client: RecordingPinnedQuietClient, completed: Int) async throws {
    let deadline = ContinuousClock.now + .seconds(6)
    while ContinuousClock.now < deadline {
      if await client.completedDetails() >= completed { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    let observed = await client.completedDetails()
    XCTAssertEqual(observed, completed)
    let until = ContinuousClock.now + .milliseconds(250)
    while ContinuousClock.now < until {
      XCTAssertNil(store.detail, "A cancelled private Quiet detail was published late")
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  @MainActor
  private func eventually(_ condition: @escaping () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(6)
    while ContinuousClock.now < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Timed out waiting for a bounded Quiet Life state")
  }

  private func waitForCounter(_ action: String,
    credential: NativeEnrollmentCredential) async throws {
    let response = try await control(action, credential: credential)
    XCTAssertTrue(response.ok, "The held synthetic route did not reach its bounded witness")
  }

  @discardableResult
  private func control(_ action: String, credential: NativeEnrollmentCredential) async throws
    -> (ok: Bool, detailStarted: Int, detailSettled: Int, chatResponseHeld: Int,
        chatResponseReleased: Int, nativeChatPosts: Int, durableTurns: Int) {
    let url = credential.origin.appending(path: "/__ellie-test/quiet/\(action)")
    var request = URLRequest(url: url)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 6
    configuration.timeoutIntervalForResource = 6
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    let session = URLSession(configuration: configuration,
      delegate: QuietFixturePinnedDelegate(host: try XCTUnwrap(credential.origin.host),
        pin: credential.certificateSha256), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (body, response) = try await session.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    let value = try JSONDecoder().decode(QuietControlResponse.self, from: body)
    return (value.ok, value.detailStarted, value.detailSettled, value.chatResponseHeld,
      value.chatResponseReleased, value.nativeChatPosts, value.durableTurns)
  }
}

private struct QuietControlResponse: Decodable {
  let ok: Bool
  let detailStarted: Int
  let detailSettled: Int
  let chatResponseHeld: Int
  let chatResponseReleased: Int
  let nativeChatPosts: Int
  let durableTurns: Int
}

private actor RecordingPinnedQuietClient: IOSQuietClient {
  private let pinned = IOSPinnedQuietClient()
  private var completed = 0
  func sessions(_ credential: NativeEnrollmentCredential, limit: Int,
    cursor: String?) async throws -> IOSQuietPage {
    try await pinned.sessions(credential, limit: limit, cursor: cursor)
  }
  func detail(_ credential: NativeEnrollmentCredential, id: String) async throws -> IOSQuietDetail {
    do {
      let result = try await pinned.detail(credential, id: id)
      completed += 1
      return result
    } catch {
      completed += 1
      throw error
    }
  }
  func completedDetails() -> Int { completed }
}

private final class QuietFixturePinnedDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let host: String
  private let pin: String
  init(host: String, pin: String) { self.host = host; self.pin = pin }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == host,
      let trust = challenge.protectionSpace.serverTrust,
      evaluateNativeServerTrust(trust, host: host, expectedPin: pin, at: Date())
    else { completionHandler(.cancelAuthenticationChallenge, nil); return }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
