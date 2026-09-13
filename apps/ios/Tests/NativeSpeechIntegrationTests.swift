import Darwin
import XCTest

@testable import Ellie

final class NativeSpeechIntegrationTests: XCTestCase {
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
    await eventually { store.phase == .reviewing }

    XCTAssertEqual(store.transcript, "Open Safari")
    XCTAssertEqual(store.reviewedApp, .safari)
    let hasArtifact = await recorder.hasOwnedArtifact
    XCTAssertFalse(hasArtifact)
  }

  @MainActor
  func testProductionCancelStopsOwnedTurnAndLeavesNoRecording() async throws {
    let granted = try credential(id: "speech-granted", token: "e", label: "Speech Granted")
    let recorder = IntegrationSpeechRecorder(marker: 1)
    let store = SpeechTurnStore(
      credential: granted, recorder: recorder, transport: SpeechTransport())
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { store.phase == .uploading }
    try await Task.sleep(for: .milliseconds(300))
    store.cancelAndDiscard()
    await eventually(timeout: .seconds(5)) { store.phase == .idle }

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
    let recorder = IntegrationSpeechRecorder(marker: 1)
    try await recorder.start()
    let artifact = try await recorder.stop()
    let transport = SpeechTransport()
    let operation = Task {
      try await transport.transcribe(
        artifact, turnID: UUID(),
        credential: credential(id: "speech-granted", token: "e", label: "Speech Granted"))
    }
    try await Task.sleep(for: .milliseconds(300))
    operation.cancel()
    do {
      _ = try await operation.value
      XCTFail("Cancelled upload returned a transcript")
    } catch { XCTAssertEqual(error as? SpeechTurnFailure, .cancelled) }
    try await recorder.dispose(artifact)
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

  private func credential(id: String, token: Character, label: String) throws
    -> NativeEnrollmentCredential
  {
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    _ = try XCTUnwrap(
      (bundle.object(forInfoDictionaryKey: "EllieSpeechTestEnabled") as? String) == "YES"
        ? true : nil,
      "Production speech fixture is required")
    let origin = try XCTUnwrap(URL(string: try XCTUnwrap(bundle.object(forInfoDictionaryKey: originKey) as? String)))
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: pinKey) as? String)
    return NativeEnrollmentCredential(
      origin: origin, certificateSha256: pin,
      client: NativeClient(
        id: id, role: "native_phone_controller", label: label,
        grants: [NativeGrant(target: "speech-fixture-no-node", capabilities: ["app.open"])],
        createdAt: 1,
        expiresAt: 9_007_199_254_740_000),
      token: String(repeating: String(token), count: 64))
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
