import XCTest

@testable import Ellie

final class NativeGoogleHTTPSIntegrationTests: XCTestCase {
  private let fixtureTarget = "google-fixture-no-node"

  private func credential(_ role: String) throws -> NativeEnrollmentCredential {
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    let origin = try XCTUnwrap(URL(string: try XCTUnwrap(
      bundle.object(forInfoDictionaryKey: "EllieATSTestOrigin") as? String)))
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "EllieATSTestPin") as? String)
    let token: String
    switch role {
    case "allowed": token = String(repeating: "12", count: 32)
    case "denied": token = String(repeating: "34", count: 32)
    case "revocable": token = String(repeating: "78", count: 32)
    default: throw IOSGmailFailure.invalidResponse
    }
    return NativeEnrollmentCredential(origin: origin, certificateSha256: pin,
      client: NativeClient(id: "google-\(role)", role: "native_phone_controller",
        label: "Google \(role)", grants: [NativeGrant(target: fixtureTarget, capabilities: ["app.open"])],
        createdAt: 1, expiresAt: 9_007_199_254_740_000), token: token)
  }

  @MainActor
  func testPinnedNativeLifeQuestionUsesSeparateGrantAndDurableReadOnlyStatus() async throws {
    let allowed = try credential("allowed")
    let client = IOSPinnedQuietVoiceClient()
    let epoch = try await client.epoch(allowed)
    let requestID = "ae2bbc9c-57c0-4a8a-97fc-e6ba10179bc2"
    let body = try IOSPinnedQuietVoiceClient.encodedBody(requestID: requestID,
      epoch: epoch, message: "What is the family plan?", conversationID: nil)
    let sent = try await client.send(allowed, body: body)
    XCTAssertEqual(sent.status, "completed")
    XCTAssertEqual(sent.reply, "Family 👩‍👩‍👧‍👧\r\n日本語 read-only answer.")
    XCTAssertFalse(sent.needsMacReview)
    let status = try await client.status(allowed, requestID: requestID)
    XCTAssertEqual(status, sent, "a status read observes the same durable reply without resending")
    do {
      _ = try await client.epoch(credential("denied"))
      XCTFail("Native enrollment alone authorized a Life question")
    } catch { XCTAssertEqual(error as? LifeWebSessionFailure, .grantRequired) }
  }

  func testPinnedClientsReadSelectedCalendarAndExplicitGmailBodies() async throws {
    let phone = try credential("allowed")
    let agendaClient = IOSPinnedAgendaClient()
    let calendars = try await agendaClient.connections(phone)
    let calendar = try XCTUnwrap(calendars.first { $0.state == "connected" })
    let snapshot = try await agendaClient.agenda(phone, id: calendar.id)
    XCTAssertEqual(snapshot.selectedCalendarId, "selected@example.test")
    XCTAssertEqual(snapshot.events.map(\.title), ["Selected family visit 👩‍👩‍👧‍👦"])
    XCTAssertFalse(snapshot.events.contains { $0.title == "Wrong primary event" })

    let gmail = IOSPinnedGmailClient()
    let accounts = try await gmail.accounts(phone)
    let account = try XCTUnwrap(accounts.first { $0.state == "connected" })
    let preview = try await gmail.preview(phone, accountID: account.id)
    XCTAssertEqual(preview.count, 4)
    let unicode = try XCTUnwrap(preview.first { $0.subject == "Family 👩‍👩‍👧‍👦" })
    XCTAssertEqual(unicode.snippet, "Preview 👩‍👩‍👧‍👦")
    let body = try await gmail.detail(phone, accountID: account.id, messageID: unicode.id)
    XCTAssertEqual(body.status, "plain")
    XCTAssertEqual(body.text, "Line one\r\nLine two 👩‍👩‍👧‍👦\n")
    let truncated = try XCTUnwrap(preview.first { $0.subject == "Truncated body" })
    let partial = try await gmail.detail(phone, accountID: account.id, messageID: truncated.id)
    XCTAssertEqual(partial.status, "truncated")
    XCTAssertEqual(partial.text, "Partial text")
    XCTAssertTrue(partial.additionalPartsOmitted)
    let unavailable = try XCTUnwrap(preview.first { $0.subject == "HTML-only message" })
    let missing = try await gmail.detail(phone, accountID: account.id, messageID: unavailable.id)
    XCTAssertEqual(missing.status, "unavailable")
    XCTAssertNil(missing.text)
  }

  func testLifeAccountGrantIsIndependentOfNativeEnrollment() async throws {
    let denied = try credential("denied")
    do {
      _ = try await IOSPinnedAgendaClient().connections(denied)
      XCTFail("Native enrollment alone authorized Calendar")
    } catch { XCTAssertEqual(error as? LifeWebSessionFailure, .grantRequired) }
    do {
      _ = try await IOSPinnedGmailClient().accounts(denied)
      XCTFail("Native enrollment alone authorized Gmail")
    } catch { XCTAssertEqual(error as? LifeWebSessionFailure, .grantRequired) }
  }

  @MainActor
  func testLateGmailBodyCannotPublishAfterCancelCredentialChangeOrRevocation() async throws {
    let allowed = try credential("allowed")
    let denied = try credential("denied")
    let client = RecordingPinnedGmailClient()
    let store = IOSGmailInboxStore(client: client)
    store.bind(allowed)
    store.refresh()
    try await eventually { !store.busy && store.accounts.count == 1 }
    let account = try XCTUnwrap(store.accounts.first)
    store.selectAccount(account.id)
    try await eventually { !store.busy && store.messages.count == 4 }
    let held = try XCTUnwrap(store.messages.first { $0.subject == "Delayed body" })
    store.selectMessage(held.id)
    try await control("held-started/1", credential: allowed)
    store.cancelRead()
    try await control("release", credential: allowed)
    try await control("settled/1", credential: allowed)
    try await noLatePublication(store, client: client, completed: 1)
    XCTAssertNil(store.detail)
    XCTAssertNil(store.selectedMessageID)

    store.selectMessage(held.id)
    try await control("held-started/2", credential: allowed)
    store.bind(denied)
    try await control("release", credential: allowed)
    try await control("settled/2", credential: allowed)
    try await noLatePublication(store, client: client, completed: 2)
    XCTAssertTrue(store.accounts.isEmpty)
    XCTAssertTrue(store.messages.isEmpty)
    XCTAssertNil(store.detail)
    XCTAssertNil(store.selectedMessageID)

    let revocable = try credential("revocable")
    store.bind(revocable)
    store.refresh()
    try await eventually { !store.busy && store.accounts.count == 1 }
    let resumedAccount = try XCTUnwrap(store.accounts.first)
    store.selectAccount(resumedAccount.id)
    try await eventually { !store.busy && store.messages.count == 4 }
    store.selectMessage(held.id)
    try await control("held-started/3", credential: allowed)
    try await NativeEnrollmentTransport(timeout: 6).logout(revocable)
    try await control("release", credential: allowed)
    try await control("settled/3", credential: allowed)
    try await noLatePublication(store, client: client, completed: 3)
    XCTAssertNil(store.detail)
    XCTAssertNil(store.selectedMessageID)
    XCTAssertTrue(store.messages.isEmpty)
  }

  @MainActor
  private func noLatePublication(_ store: IOSGmailInboxStore,
    client: RecordingPinnedGmailClient, completed: Int) async throws {
    let deadline = ContinuousClock.now + .seconds(6)
    while ContinuousClock.now < deadline {
      if await client.completedDetails() >= completed { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    let observed = await client.completedDetails()
    XCTAssertEqual(observed, completed,
      "Pinned Gmail detail call did not settle after server response")
    // Store invalidation clears busy immediately. Observe after the real pinned
    // client's completion, giving its MainActor continuation a bounded turn.
    let observationEnd = ContinuousClock.now + .milliseconds(250)
    while ContinuousClock.now < observationEnd {
      XCTAssertNil(store.detail, "A cancelled private body was published late")
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
    XCTFail("Timed out waiting for a bounded Google fixture state")
  }

  private func control(_ action: String, credential: NativeEnrollmentCredential) async throws {
    let url = credential.origin.appending(path: "/__ellie-test/google/\(action)")
    var request = URLRequest(url: url)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 6
    configuration.timeoutIntervalForResource = 6
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    let session = URLSession(configuration: configuration,
      delegate: GoogleFixturePinnedDelegate(host: try XCTUnwrap(credential.origin.host),
        pin: credential.certificateSha256), delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (body, response) = try await session.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    XCTAssertEqual(body, Data(#"{"ok":true}"#.utf8))
  }
}

private actor RecordingPinnedGmailClient: IOSGmailClient {
  private let pinned = IOSPinnedGmailClient()
  private var completed = 0

  func accounts(_ credential: NativeEnrollmentCredential) async throws -> [IOSGmailAccount] {
    try await pinned.accounts(credential)
  }
  func preview(_ credential: NativeEnrollmentCredential,
    accountID: String) async throws -> [IOSGmailMessage] {
    try await pinned.preview(credential, accountID: accountID)
  }
  func detail(_ credential: NativeEnrollmentCredential, accountID: String,
    messageID: String) async throws -> IOSGmailDetail {
    do {
      let result = try await pinned.detail(credential, accountID: accountID, messageID: messageID)
      completed += 1
      return result
    } catch {
      completed += 1
      throw error
    }
  }
  func completedDetails() -> Int { completed }
}

private final class GoogleFixturePinnedDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
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
