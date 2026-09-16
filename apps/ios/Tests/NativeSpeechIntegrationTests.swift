import Darwin
import XCTest

@testable import Ellie

final class NativeSpeechIntegrationTests: XCTestCase {
  private enum FixtureCheckpoint: String {
    case cancelStarted = "cancel/started"
    case cancelSettled = "cancel/settled"
    case disconnectStarted = "disconnect/started"
    case disconnectSettled = "disconnect/settled"

    var failureMessage: String {
      switch self {
      case .cancelStarted: "The cancellation fixture did not observe the upload starting."
      case .cancelSettled: "The cancellation fixture did not observe the upload settling."
      case .disconnectStarted: "The disconnect fixture did not observe the upload starting."
      case .disconnectSettled: "The disconnect fixture did not observe the upload settling."
      }
    }
  }

  private enum ReviewObservationFailure: Error {
    case timeout(String)
    case unexpected(String)

    var diagnostic: String {
      switch self {
      case .timeout(let phase): "expected reviewing; observed \(phase) at the review deadline"
      case .unexpected(let phase): "expected reviewing; observed \(phase)"
      }
    }
  }

  private let originKey = "EllieATSTestOrigin"
  private let pinKey = "EllieATSTestPin"

  @MainActor
  func testProductionSpeechTransportAndStateUseTheNativeListenerWithoutAppAuthority() async throws {
    let granted = try credential(id: "speech-granted", token: "e", label: "Speech Granted")
    XCTAssertEqual(
      granted.client.grants,
      [NativeGrant(target: "speech-fixture-no-node", capabilities: ["app.open"])]
    )
    let recorder = IntegrationSpeechRecorder(marker: 0)
    let store = SpeechTurnStore(
      credential: granted, recorder: recorder, transport: SpeechTransport())

    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    do {
      try await waitForReviewedSpeech(store)
    } catch let failure as ReviewObservationFailure {
      let cleanup = await settleReviewFailure(store, recorder: recorder)
      XCTFail("\(failure.diagnostic); \(cleanup)")
      return
    }

    XCTAssertEqual(store.transcript, "Open Safari")
    XCTAssertEqual(store.reviewedApp, .safari)
    let hasArtifact = await recorder.hasOwnedArtifact
    XCTAssertFalse(hasArtifact)
  }

  @MainActor
  func testProductionCancelStopsOwnedTurnAndLeavesNoRecording() async throws {
    let granted = try credential(
      id: "speech-cancel", token: "cd", label: "Speech Cancel")
    let recorder = IntegrationSpeechRecorder(marker: 3)
    let store = SpeechTurnStore(
      credential: granted, recorder: recorder, transport: SpeechTransport())
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { store.phase == .uploading }
    do {
      try await fixtureStatus(.cancelStarted, credential: granted)
    } catch let probeFailure {
      await settleAfterFixtureFailure(store)
      throw probeFailure
    }
    store.cancelAndDiscard()
    await eventually(timeout: .seconds(5)) { store.phase == .idle }
    do {
      try await fixtureStatus(.cancelSettled, credential: granted)
    } catch let probeFailure {
      await settleAfterFixtureFailure(store)
      throw probeFailure
    }

    XCTAssertEqual(store.transcript, "")
    let hasArtifact = await recorder.hasOwnedArtifact
    XCTAssertFalse(hasArtifact)
  }

  func testProductionSpeechRequiresItsOwnFreshGrantAndSession() async throws {
    let transport = SpeechTransport()
    do {
      try await transport.availability(
        for: credential(id: "speech-denied", token: "d", label: "Speech Denied"))
      XCTFail("An ungranted native client received speech authority")
    } catch { XCTAssertEqual(error as? SpeechTurnFailure, .notAuthorized) }
    do {
      try await transport.availability(
        for: credential(id: "speech-revoked", token: "f", label: "Speech Revoked"))
      XCTFail("A revoked speech grant remained active")
    } catch { XCTAssertEqual(error as? SpeechTurnFailure, .notAuthorized) }
    do {
      try await transport.availability(
        for: credential(id: "session-revoked", token: "b", label: "Session Revoked"))
      XCTFail("A revoked native session remained active")
    } catch { XCTAssertEqual(error as? SpeechTurnFailure, .revoked) }
  }

  func testCancelledUploadDisconnectsWithoutReplay() async throws {
    let granted = try credential(
      id: "speech-disconnect", token: "de", label: "Speech Disconnect")
    let recorder = IntegrationSpeechRecorder(marker: 4)
    try await recorder.start()
    let artifact = try await recorder.stop()
    let transport = SpeechTransport()
    let operation = Task {
      try await transport.transcribe(
        artifact, turnID: UUID(),
        credential: granted)
    }
    do {
      try await fixtureStatus(.disconnectStarted, credential: granted)
      operation.cancel()
      do {
        _ = try await operation.value
        XCTFail("Cancelled upload returned a transcript")
      } catch { XCTAssertEqual(error as? SpeechTurnFailure, .cancelled) }
      try await fixtureStatus(.disconnectSettled, credential: granted)
      try await recorder.dispose(artifact)
    } catch let probeFailure {
      operation.cancel()
      _ = await operation.result
      do { try await recorder.dispose(artifact) }
      catch { XCTFail("The disconnect fixture could not remove its owned recording.") }
      throw probeFailure
    }
  }

  func testLostCommittedTranscriptResponseIsFixedFailureAndNeverReplayed() async throws {
    let recorder = IntegrationSpeechRecorder(marker: 0)
    try await recorder.start()
    let artifact = try await recorder.stop()
    let transport = SpeechTransport()
    do {
      _ = try await transport.transcribe(
        artifact, turnID: UUID(uuidString: "77777777-7777-4777-8777-777777777777")!,
        credential: credential(id: "speech-granted", token: "e", label: "Speech Granted"))
      XCTFail("A deliberately dropped transcript response appeared successful")
    } catch { XCTAssertEqual(error as? SpeechTurnFailure, .unavailable) }
    try await recorder.dispose(artifact)
  }

  func testProductionSpeechAllowsAResultAfterTenSecondsWithinTheAbsoluteDeadline() async throws {
    let recorder = IntegrationSpeechRecorder(marker: 2)
    try await recorder.start()
    let artifact = try await recorder.stop()
    let clock = ContinuousClock()
    let started = clock.now
    let result = try await SpeechTransport().transcribe(
      artifact, turnID: UUID(),
      credential: credential(id: "speech-granted", token: "e", label: "Speech Granted"))
    let elapsed = started.duration(to: clock.now)
    XCTAssertEqual(result, "Open Safari")
    XCTAssertGreaterThanOrEqual(elapsed, .seconds(10))
    XCTAssertLessThan(elapsed, .seconds(35))
    try await recorder.dispose(artifact)
  }

  private func credential(id: String, token: String, label: String) throws
    -> NativeEnrollmentCredential
  {
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    _ = try XCTUnwrap(
      (bundle.object(forInfoDictionaryKey: "EllieSpeechTestEnabled") as? String) == "YES"
        ? true : nil,
      "Production speech fixture is required")
    let origin = try XCTUnwrap(
      URL(string: try XCTUnwrap(bundle.object(forInfoDictionaryKey: originKey) as? String)))
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: pinKey) as? String)
    return NativeEnrollmentCredential(
      origin: origin, certificateSha256: pin,
      client: NativeClient(
        id: id, role: "native_phone_controller", label: label,
        grants: [NativeGrant(target: "speech-fixture-no-node", capabilities: ["app.open"])],
        createdAt: 1,
        expiresAt: 9_007_199_254_740_000),
      token: String(repeating: token, count: 64 / token.count))
  }

  private func fixtureStatus(
    _ checkpoint: FixtureCheckpoint, credential: NativeEnrollmentCredential
  ) async throws {
    let url = credential.origin.appending(path: "/__ellie-test/speech/\(checkpoint.rawValue)")
    var request = URLRequest(url: url)
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 6
    configuration.timeoutIntervalForResource = 6
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    let delegate = FixturePinnedDelegate(
      host: try XCTUnwrap(credential.origin.host), pin: credential.certificateSha256)
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let (body, response) = try await session.data(for: request)
    let responseIsExpected =
      (response as? HTTPURLResponse)?.statusCode == 200
      && body == Data(#"{"ok":true}"#.utf8)
    _ = try XCTUnwrap(responseIsExpected ? true : nil, checkpoint.failureMessage)
  }

  @MainActor
  private func waitForReviewedSpeech(_ store: SpeechTurnStore) async throws {
    // The HTTPS request has a 40-second absolute timeout. The additional two seconds cover
    // recorder actor handoff and disposal around that request, not a longer network deadline.
    let transportRequestBudget: Duration = .seconds(40)
    let recorderObservationAllowance: Duration = .seconds(2)
    let deadline = ContinuousClock.now + transportRequestBudget + recorderObservationAllowance
    while true {
      let phase = store.phase
      if ContinuousClock.now >= deadline {
        throw ReviewObservationFailure.timeout(reviewPhaseName(phase))
      }
      switch phase {
      case .reviewing: return
      case .uploading: break
      default:
        throw ReviewObservationFailure.unexpected(reviewPhaseName(phase))
      }
      try? await Task.sleep(for: .milliseconds(20))
    }
  }

  @MainActor
  private func settleReviewFailure(
    _ store: SpeechTurnStore, recorder: IntegrationSpeechRecorder
  ) async -> String {
    switch store.phase {
    case .uploading, .checking, .starting, .recording, .cancelling:
      store.cancelAndDiscard()
    case .idle, .ready, .reviewing, .failed, .revoked, .cleanupRequired:
      break
    }
    let deadline = ContinuousClock.now + .seconds(5)
    while ContinuousClock.now < deadline && !isSettledReviewFailure(store.phase) {
      try? await Task.sleep(for: .milliseconds(20))
    }
    let terminal = isSettledReviewFailure(store.phase)
    let phase = reviewPhaseName(store.phase)
    let ownedBeforeCleanup = await recorder.hasOwnedArtifact
    var ownedCleanup = "not needed"
    if ownedBeforeCleanup && terminal {
      do {
        try await recorder.cancel()
        ownedCleanup = "completed"
      } catch {
        ownedCleanup = "failed"
      }
    } else if ownedBeforeCleanup {
      ownedCleanup = "deferred while turn is active"
    }
    let ownedAfterCleanup = await recorder.hasOwnedArtifact
    return "settled=\(terminal), phase=\(phase), artifactBeforeCleanup=\(ownedBeforeCleanup), "
      + "ownedCleanup=\(ownedCleanup), artifactAfterCleanup=\(ownedAfterCleanup)"
  }

  @MainActor
  private func isSettledReviewFailure(_ phase: SpeechTurnStore.Phase) -> Bool {
    switch phase {
    case .idle, .ready, .reviewing, .failed, .revoked, .cleanupRequired: true
    case .checking, .starting, .recording, .uploading, .cancelling: false
    }
  }

  @MainActor
  private func reviewPhaseName(_ phase: SpeechTurnStore.Phase) -> String {
    switch phase {
    case .idle: "idle"
    case .checking: "checking"
    case .ready: "ready"
    case .starting: "starting"
    case .recording: "recording"
    case .uploading: "uploading"
    case .cancelling: "cancelling"
    case .reviewing: "reviewing"
    case .failed: "failed"
    case .revoked: "revoked"
    case .cleanupRequired: "cleanupRequired"
    }
  }

  @MainActor
  private func settleAfterFixtureFailure(_ store: SpeechTurnStore) async {
    store.cancelAndDiscard()
    let deadline = ContinuousClock.now + .seconds(40)
    while ContinuousClock.now < deadline {
      if store.phase == .idle { return }
      try? await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("The cancellation fixture's owned turn did not settle after its probe failed.")
  }

  @MainActor
  private func eventually(
    timeout: Duration = .seconds(3), _ condition: @escaping @MainActor () async -> Bool
  ) async {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Timed out waiting for speech state")
  }
}

private final class FixturePinnedDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let host: String
  private let pin: String

  init(host: String, pin: String) {
    self.host = host
    self.pin = pin
  }

  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == host, let trust = challenge.protectionSpace.serverTrust,
      evaluateNativeServerTrust(trust, host: host, expectedPin: pin, at: Date())
    else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

private actor IntegrationSpeechRecorder: SpeechRecording {
  private let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "ellie-speech-integration-\(UUID().uuidString)", isDirectory: true)
  private let marker: UInt8
  private var artifact: SpeechAudioArtifact?

  init(marker: UInt8) { self.marker = marker }

  var hasOwnedArtifact: Bool {
    FileManager.default.fileExists(atPath: directory.path)
  }

  func start() async throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let file = directory.appendingPathComponent("turn.wav")
    var samples = Data(repeating: 0, count: 3_200)
    samples[0] = marker
    try wav(samples).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    artifact = SpeechAudioArtifact(id: UUID(), url: file)
  }

  func stop() async throws -> SpeechAudioArtifact {
    guard let artifact else { throw SpeechTurnFailure.invalidAudio }
    return artifact
  }

  func cancel() async throws { try removeOwnedArtifact() }

  func dispose(_ candidate: SpeechAudioArtifact) async throws {
    guard candidate == artifact else { throw SpeechTurnFailure.cleanupFailed }
    try removeOwnedArtifact()
  }

  private func removeOwnedArtifact() throws {
    if let artifact, unlink(artifact.url.path) != 0, errno != ENOENT {
      throw SpeechTurnFailure.cleanupFailed
    }
    if rmdir(directory.path) != 0, errno != ENOENT {
      throw SpeechTurnFailure.cleanupFailed
    }
    artifact = nil
  }

  private func wav(_ samples: Data) -> Data {
    var data = Data("RIFF".utf8)
    append(UInt32(36 + samples.count), to: &data)
    data.append(Data("WAVEfmt ".utf8))
    append(UInt32(16), to: &data)
    append(UInt16(1), to: &data)
    append(UInt16(1), to: &data)
    append(UInt32(16_000), to: &data)
    append(UInt32(32_000), to: &data)
    append(UInt16(2), to: &data)
    append(UInt16(16), to: &data)
    data.append(Data("data".utf8))
    append(UInt32(samples.count), to: &data)
    data.append(samples)
    return data
  }

  private func append<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
    var little = value.littleEndian
    withUnsafeBytes(of: &little) { data.append(contentsOf: $0) }
  }
}
