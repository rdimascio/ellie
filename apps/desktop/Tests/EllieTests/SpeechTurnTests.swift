import Darwin
import Foundation
import XCTest

@testable import Ellie

final class SpeechTurnTests: XCTestCase {
  func testSpeechWireResponsesAreExactBoundedAndTurnScoped() throws {
    XCTAssertNoThrow(
      try SpeechTransport.decodeAvailability(Data(#"{"available":true}"#.utf8)))
    for invalid in [#"{"available":1}"#, #"{"available":true,"grant":"speech"}"#] {
      XCTAssertThrowsError(try SpeechTransport.decodeAvailability(Data(invalid.utf8)))
    }
    let turn = UUID().uuidString.lowercased()
    XCTAssertEqual(
      try SpeechTransport.decodeTranscript(
        Data("{\"turnId\":\"\(turn)\",\"text\":\"Open Safari\"}".utf8), turn: turn),
      "Open Safari")
    for invalid in [
      "{\"turnId\":\"\(UUID().uuidString.lowercased())\",\"text\":\"Open Safari\"}",
      "{\"turnId\":\"\(turn)\",\"text\":\"ok\",\"extra\":true}",
      "{\"turnId\":\"\(turn)\",\"text\":\"\(String(repeating: "x", count: 2_001))\"}",
    ] {
      XCTAssertThrowsError(try SpeechTransport.decodeTranscript(Data(invalid.utf8), turn: turn))
    }
    XCTAssertFalse(try SpeechTransport.decodeCancel(Data(#"{"ok":true,"cancelled":false}"#.utf8)))
    XCTAssertThrowsError(
      try SpeechTransport.decodeCancel(Data(#"{"ok":true,"cancelled":false,"turnId":"x"}"#.utf8)))
  }

  @MainActor
  func testVoiceIdentityMetadataCannotEnterReviewedCommandAuthority() throws {
    let turn = UUID().uuidString.lowercased()
    for metadata in [
      #""speakerId":"recognized-owner""#,
      #""voiceId":"synthesized-owner""#,
      #""confidence":1"#,
      #""authorized":true"#,
    ] {
      XCTAssertThrowsError(
        try SpeechTransport.decodeTranscript(
          Data("{\"turnId\":\"\(turn)\",\"text\":\"Open Safari\",\(metadata)}".utf8),
          turn: turn))
    }
    for transcript in [
      "Speaker recognized-owner: Open Safari",
      "Voice synthesized-owner says play",
      "[speaker_0] scroll down",
    ] {
      XCTAssertNil(SpeechTurnStore.reviewedApp(in: transcript), transcript)
      XCTAssertNil(BrowserVoiceIntentParser.parse(transcript), transcript)
    }
  }

  @MainActor
  func testInitializationAndAvailabilityNeverStartRecordingOrTranscription() async {
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport()
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    let initialAvailability = await transport.availabilityCalls
    let initialStarts = await recorder.startCalls
    XCTAssertEqual(initialAvailability, 0)
    XCTAssertEqual(initialStarts, 0)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    let availability = await transport.availabilityCalls
    let starts = await recorder.startCalls
    let transcriptions = await transport.transcriptionCalls
    XCTAssertEqual(availability, 1)
    XCTAssertEqual(starts, 0)
    XCTAssertEqual(transcriptions, 0)
  }

  @MainActor
  func testStopProducesEditableReviewWithoutOpeningAnAppAndDisposesOwnedAudio() async {
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(text: "Open Messages.")
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    let availability = await transport.availabilityCalls
    XCTAssertEqual(availability, 2)
    store.stop()
    await eventually { store.phase == .reviewing }
    XCTAssertEqual(store.transcript, "Open Messages.")
    XCTAssertEqual(store.reviewedApp, .messages)
    let transcriptions = await transport.transcriptionCalls
    let disposals = await recorder.disposals
    let directoryExists = await recorder.directoryExists
    XCTAssertEqual(transcriptions, 1)
    XCTAssertEqual(disposals, 1)
    XCTAssertFalse(directoryExists)
    store.transcript = "Open Calculator"
    XCTAssertNil(store.reviewedApp)
    store.transcript = "Open Safari"
    XCTAssertEqual(store.reviewedApp, .safari)
    store.discardReview()
    XCTAssertEqual(store.phase, .ready)
    store.transcript = "Open Safari" // Simulate a stale editor write after the review was removed.
    XCTAssertNil(store.reviewedApp, "discarded text cannot retain reviewed-command authority")
  }

  @MainActor
  func testRevokedAvailabilityNeverRequestsRecording() async {
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(availabilityFailure: .revoked)
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .revoked }
    store.record()
    let starts = await recorder.startCalls
    XCTAssertEqual(starts, 0)
  }

  @MainActor
  func testCancelWaitsForLateAvailabilityAndCannotStartRecorder() async {
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(suspendAvailability: true)
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { await transport.availabilityCalls == 1 }
    store.cancelAndDiscard()
    XCTAssertEqual(store.phase, .cancelling)
    await transport.finishAvailability()
    await eventually { store.phase == .idle }
    let starts = await recorder.startCalls
    XCTAssertEqual(starts, 0)
  }

  @MainActor
  func testCancelUploadingDisposesArtifactRejectsLateTextAndSignalsOwnedTurn() async {
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(text: "Open Safari", suspendTranscription: true)
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { await transport.transcriptionCalls == 1 }
    store.cancelAndDiscard()
    await transport.finishTranscription()
    await eventually { store.phase == .idle }
    XCTAssertEqual(store.transcript, "")
    let cancellations = await transport.cancelCalls
    let disposals = await recorder.disposals
    let directoryExists = await recorder.directoryExists
    XCTAssertEqual(cancellations, 1)
    XCTAssertEqual(disposals, 1)
    XCTAssertFalse(directoryExists)
  }

  @MainActor
  func testCredentialChangeBlocksStillValidOldCredentialAndClearsReviewedText() async {
    let old = credential()
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(text: "Private reviewed words")
    let store = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { store.phase == .reviewing }
    XCTAssertEqual(store.transcript, "Private reviewed words")

    store.credentialDidChange()
    XCTAssertEqual(store.phase, .credentialChanged)
    XCTAssertEqual(store.transcript, "")
    store.cancelAndDiscard() // A later scene-background callback must not re-enable the old store.
    store.checkAvailability()
    store.record()
    store.stop()
    XCTAssertEqual(store.phase, .credentialChanged)
    let availabilityTokens = await transport.availabilityTokens
    let transcriptionTokens = await transport.transcriptionTokens
    let startCalls = await recorder.startCalls
    XCTAssertEqual(availabilityTokens, [old.token, old.token])
    XCTAssertEqual(transcriptionTokens, [old.token])
    XCTAssertEqual(startCalls, 1)
  }

  @MainActor
  func testCredentialChangeDuringAvailabilityRejectsLateResultAndNewOldTokenUse() async {
    let old = credential()
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(suspendAvailability: true)
    let store = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { await transport.availabilityCalls == 1 }

    store.credentialDidChange()
    XCTAssertEqual(store.phase, .cancelling)
    store.checkAvailability()
    store.record()
    await transport.finishAvailability()
    await eventually { store.phase == .credentialChanged }
    store.checkAvailability()
    store.cancelAndDiscard()
    XCTAssertEqual(store.phase, .credentialChanged)
    XCTAssertEqual(store.transcript, "")
    let availabilityTokens = await transport.availabilityTokens
    let startCalls = await recorder.startCalls
    XCTAssertEqual(availabilityTokens, [old.token])
    XCTAssertEqual(startCalls, 0)
  }

  @MainActor
  func testCredentialChangeBeforeQueuedAvailabilityOrRecordStartsMakesNoOldRequest() async {
    let old = credential()
    let initialTransport = SpeechFakeTransport()
    let initial = SpeechTurnStore(credential: old, recorder: SpeechFakeRecorder(),
      transport: initialTransport)
    initial.checkAvailability()
    initial.credentialDidChange() // Same main-actor turn, before the queued task can start.
    await eventually { initial.phase == .credentialChanged }
    let initialCalls = await initialTransport.availabilityTokens
    XCTAssertTrue(initialCalls.isEmpty)

    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport()
    let ready = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    ready.checkAvailability()
    await eventually { ready.phase == .ready }
    ready.record()
    ready.credentialDidChange() // The recording task has not started.
    await eventually { ready.phase == .credentialChanged }
    let calls = await transport.availabilityTokens
    let starts = await recorder.startCalls
    XCTAssertEqual(calls, [old.token])
    XCTAssertEqual(starts, 0)
  }

  @MainActor
  func testCredentialChangeWhileRecorderStopsDisposesLateArtifactBeforeTranscription() async {
    let old = credential()
    let recorder = SpeechFakeRecorder(holdStop: true)
    let transport = SpeechFakeTransport()
    let store = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { await recorder.stopPending }

    store.credentialDidChange()
    await recorder.finishStop()
    await eventually { store.phase == .credentialChanged }
    XCTAssertEqual(store.transcript, "")
    let transcriptions = await transport.transcriptionTokens
    let disposals = await recorder.disposals
    let directoryExists = await recorder.directoryExists
    XCTAssertTrue(transcriptions.isEmpty)
    XCTAssertEqual(disposals, 1)
    XCTAssertFalse(directoryExists)
  }

  @MainActor
  func testLateArtifactDisposalFailureKeepsChangedCredentialBlockedForCleanup() async {
    let recorder = SpeechFakeRecorder(holdStop: true)
    let transport = SpeechFakeTransport()
    let store = SpeechTurnStore(credential: credential(), recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { await recorder.stopPending }

    await recorder.setFailDispose(true)
    store.credentialDidChange()
    await eventually { await recorder.cancelCalls == 1 }
    await recorder.finishStop() // stop() creates a new artifact after cancel() succeeded.
    await eventually { store.phase == .cleanupRequired }
    let directoryExists = await recorder.directoryExists
    let transcriptions = await transport.transcriptionTokens
    XCTAssertTrue(directoryExists, "late private audio must not be treated as removed")
    XCTAssertTrue(transcriptions.isEmpty)
    store.checkAvailability()
    XCTAssertEqual(store.phase, .cleanupRequired)

    store.retryCleanup()
    await eventually { store.phase == .credentialChanged }
    let remainingDirectory = await recorder.directoryExists
    XCTAssertFalse(remainingDirectory)
  }

  @MainActor
  func testCredentialChangeDuringTranscriptionDisposesAudioWithoutLatePrivateText() async {
    let old = credential()
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport(text: "Late private text", suspendTranscription: true)
    let store = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { await transport.transcriptionCalls == 1 }

    store.credentialDidChange()
    await transport.finishTranscription()
    await eventually { store.phase == .credentialChanged }
    XCTAssertEqual(store.transcript, "")
    let directoryExists = await recorder.directoryExists
    XCTAssertFalse(directoryExists)
    store.checkAvailability()
    let availabilityTokens = await transport.availabilityTokens
    let transcriptionTokens = await transport.transcriptionTokens
    XCTAssertEqual(availabilityTokens, [old.token, old.token])
    XCTAssertEqual(transcriptionTokens, [old.token])
  }

  @MainActor
  func testCredentialChangeCannotReenableOldCredentialAfterCleanupRetry() async {
    let old = credential()
    let recorder = SpeechFakeRecorder()
    let transport = SpeechFakeTransport()
    let store = SpeechTurnStore(credential: old, recorder: recorder, transport: transport)
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    await recorder.setFailCleanup(true)

    store.credentialDidChange()
    await eventually { store.phase == .cleanupRequired }
    store.checkAvailability()
    store.record()
    let beforeRetry = await transport.availabilityTokens
    XCTAssertEqual(beforeRetry, [old.token, old.token])

    await recorder.setFailCleanup(false)
    store.retryCleanup()
    await eventually { store.phase == .credentialChanged }
    store.checkAvailability()
    store.record()
    let afterRetry = await transport.availabilityTokens
    XCTAssertEqual(afterRetry, beforeRetry)
    let directoryExists = await recorder.directoryExists
    XCTAssertFalse(directoryExists)
  }

  func testWAVValidationEnforcesPCMShapeDurationAndBounds() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-speech-wav-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    let file = directory.appendingPathComponent("turn.wav")
    defer {
      try? FileManager.default.removeItem(at: file)
      _ = directory.path.withCString { Darwin.rmdir($0) }
    }
    try wav(samples: Data(repeating: 0, count: 32_000)).write(to: file)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    XCTAssertNoThrow(try SpeechTransport.readValidatedAudio(file))
    var wrongRate = wav(samples: Data(repeating: 0, count: 32_000))
    wrongRate[24] = 0x81
    XCTAssertThrowsError(try writeAndRead(wrongRate, at: file))
    XCTAssertFalse(SpeechTransport.validWAV(wav(samples: Data(repeating: 0, count: 960_002))))
    try Data(repeating: 0, count: SpeechTransport.maximumAudioBytes + 1).write(to: file)
    XCTAssertThrowsError(try SpeechTransport.readValidatedAudio(file))
  }

  func testWAVReadRejectsFIFOAndSymlinkWithoutBlockingOrFollowing() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-speech-special-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let target = directory.appendingPathComponent("target.wav")
    let link = directory.appendingPathComponent("link.wav")
    let fifo = directory.appendingPathComponent("audio.fifo")
    try wav(samples: Data(repeating: 0, count: 32_000)).write(to: target)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
    XCTAssertEqual(mkfifo(fifo.path, 0o600), 0)

    let started = ContinuousClock.now
    XCTAssertThrowsError(try SpeechTransport.readValidatedAudio(fifo))
    XCTAssertLessThan(started.duration(to: .now), .seconds(1))
    XCTAssertThrowsError(try SpeechTransport.readValidatedAudio(link))
    XCTAssertNoThrow(try SpeechTransport.readValidatedAudio(target))
  }

  @MainActor
  func testCleanupFailureRetainsOwnershipAndBlocksUntilExplicitRetry() async {
    let recorder = SpeechFakeRecorder()
    await recorder.setFailCleanup(true)
    let store = SpeechTurnStore(
      credential: credential(), recorder: recorder, transport: SpeechFakeTransport())
    store.checkAvailability()
    await eventually { store.phase == .ready }
    store.record()
    await eventually { store.phase == .recording }
    store.stop()
    await eventually { store.phase == .cleanupRequired }
    store.record()
    XCTAssertEqual(store.phase, .cleanupRequired)
    let existsBeforeRetry = await recorder.directoryExists
    XCTAssertTrue(existsBeforeRetry)

    await recorder.setFailCleanup(false)
    store.retryCleanup()
    await eventually { store.phase == .idle }
    let existsAfterRetry = await recorder.directoryExists
    XCTAssertFalse(existsAfterRetry)
  }

  func testMicrophoneDenialHasDistinctFixedGuidance() {
    XCTAssertNotEqual(
      SpeechTurnFailure.microphoneDenied.localizedDescription,
      SpeechTurnFailure.unavailable.localizedDescription)
    XCTAssertTrue(SpeechTurnFailure.microphoneDenied.localizedDescription.contains("Microphone"))
  }

  private func writeAndRead(_ data: Data, at url: URL) throws -> Data {
    try data.write(to: url)
    return try SpeechTransport.readValidatedAudio(url)
  }

  private func wav(samples: Data) -> Data {
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

  private func credential() -> NativeEnrollmentCredential {
    NativeEnrollmentCredential(
      origin: URL(string: "https://127.0.0.1:8444")!,
      certificateSha256: String(repeating: "a", count: 64),
      client: NativeClient(
        id: "phone", role: "native_phone_controller", label: "Phone",
        grants: [NativeGrant(target: "mac", capabilities: ["app.open"])],
        createdAt: 1, expiresAt: 2),
      token: String(repeating: "c", count: 64))
  }

  @MainActor private func eventually(_ condition: @escaping @MainActor () async -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(2)
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out")
  }
}

private actor SpeechFakeRecorder: SpeechRecording {
  let directory: URL
  let file: URL
  var startCalls = 0
  var disposals = 0
  var cancelCalls = 0
  var failCleanup = false
  private var failDispose = false
  private let holdStop: Bool
  private var stopContinuation: CheckedContinuation<Void, Never>?
  var stopPending: Bool { stopContinuation != nil }
  var directoryExists: Bool { FileManager.default.fileExists(atPath: directory.path) }

  init(holdStop: Bool = false) {
    self.holdStop = holdStop
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-speech-fake-\(UUID().uuidString)", isDirectory: true)
    file = directory.appendingPathComponent("turn.wav")
  }

  func start() async throws {
    startCalls += 1
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    try Data("synthetic".utf8).write(to: file)
  }
  func stop() async throws -> SpeechAudioArtifact {
    if holdStop {
      await withCheckedContinuation { stopContinuation = $0 }
      // Model a recorder that finishes its owned artifact after cancellation.
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data("synthetic".utf8).write(to: file)
    }
    return SpeechAudioArtifact(id: UUID(), url: file)
  }
  func finishStop() {
    stopContinuation?.resume()
    stopContinuation = nil
  }
  func cancel() async throws {
    cancelCalls += 1
    try cleanup()
  }
  func dispose(_ artifact: SpeechAudioArtifact) async throws {
    guard artifact.url.standardizedFileURL == file.standardizedFileURL else { return }
    disposals += 1
    if failDispose { throw SpeechTurnFailure.cleanupFailed }
    try cleanup()
  }
  func setFailCleanup(_ value: Bool) { failCleanup = value }
  func setFailDispose(_ value: Bool) { failDispose = value }
  private func cleanup() throws {
    if failCleanup { throw SpeechTurnFailure.cleanupFailed }
    try? FileManager.default.removeItem(at: file)
    _ = directory.path.withCString { Darwin.rmdir($0) }
  }
}

private actor SpeechFakeTransport: SpeechTransporting {
  var availabilityCalls = 0
  var transcriptionCalls = 0
  var cancelCalls = 0
  var availabilityTokens: [String] = []
  var transcriptionTokens: [String] = []
  private let text: String
  private let availabilityFailure: SpeechTurnFailure?
  private let suspendAvailability: Bool
  private let suspendTranscription: Bool
  private var availabilityContinuation: CheckedContinuation<Void, Never>?
  private var transcriptionContinuation: CheckedContinuation<Void, Never>?

  init(
    text: String = "Open Safari", availabilityFailure: SpeechTurnFailure? = nil,
    suspendAvailability: Bool = false, suspendTranscription: Bool = false
  ) {
    self.text = text
    self.availabilityFailure = availabilityFailure
    self.suspendAvailability = suspendAvailability
    self.suspendTranscription = suspendTranscription
  }

  func availability(for credential: NativeEnrollmentCredential) async throws {
    availabilityCalls += 1
    availabilityTokens.append(credential.token)
    if suspendAvailability {
      await withCheckedContinuation { availabilityContinuation = $0 }
    }
    if let availabilityFailure { throw availabilityFailure }
  }
  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String {
    transcriptionCalls += 1
    transcriptionTokens.append(credential.token)
    if suspendTranscription {
      await withCheckedContinuation { transcriptionContinuation = $0 }
    }
    return text
  }
  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async { cancelCalls += 1 }
  func finishAvailability() {
    availabilityContinuation?.resume()
    availabilityContinuation = nil
  }
  func finishTranscription() {
    transcriptionContinuation?.resume()
    transcriptionContinuation = nil
  }
}
