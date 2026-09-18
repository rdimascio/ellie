import Combine
import Darwin
import Foundation

struct SpeechAudioArtifact: Equatable, Sendable {
  let id: UUID
  let url: URL
}

protocol SpeechRecording: Sendable {
  func start() async throws
  func stop() async throws -> SpeechAudioArtifact
  func cancel() async throws
  func dispose(_ artifact: SpeechAudioArtifact) async throws
}

protocol SpeechTransporting: Sendable {
  func availability(for credential: NativeEnrollmentCredential) async throws
  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String
  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async
}

enum SpeechTurnFailure: Error, Equatable, LocalizedError {
  case notAuthorized, microphoneDenied, revoked, busy, unavailable, invalidAudio, invalidResponse, cancelled, cleanupFailed

  var errorDescription: String? {
    switch self {
    case .notAuthorized: "Voice access is not granted to this iPhone."
    case .microphoneDenied: "Microphone access is denied. Allow it in Settings to record a command."
    case .revoked: "This iPhone’s coordinator session is no longer authorized."
    case .busy: "The voice service is busy. Try again after the current turn finishes."
    case .unavailable: "The coordinator’s voice service is unavailable."
    case .invalidAudio: "The recording could not be prepared for transcription."
    case .invalidResponse: "The coordinator returned an invalid transcription response."
    case .cancelled: "The voice turn stopped."
    case .cleanupFailed: "The private recording could not be removed. Voice recording is blocked until cleanup succeeds."
    }
  }
}

@MainActor
final class SpeechTurnStore: ObservableObject {
  enum Phase: Equatable {
    case idle, checking, ready, starting, recording, uploading, cancelling, reviewing
    case failed(String)
    case revoked, credentialChanged
    case cleanupRequired
  }

  @Published private(set) var phase: Phase = .idle
  @Published var transcript = ""

  private let credential: NativeEnrollmentCredential
  private let recorder: any SpeechRecording
  private let transport: any SpeechTransporting
  private var task: Task<Void, Never>?
  private var limitTask: Task<Void, Never>?
  private var generation = 0
  private var activeTurnID: UUID?
  private var credentialInvalidated = false
  private var cancelledTurnCleanupFailed = false

  init(
    credential: NativeEnrollmentCredential, recorder: any SpeechRecording,
    transport: any SpeechTransporting = SpeechTransport()
  ) {
    self.credential = credential
    self.recorder = recorder
    self.transport = transport
  }

  var reviewedApp: PhoneControlApp? { Self.reviewedApp(in: transcript) }
  var isBusy: Bool { task != nil || phase == .recording || phase == .cancelling }

  func checkAvailability() {
    guard !credentialInvalidated, task == nil,
      phase != .recording, phase != .cancelling,
      phase != .revoked, phase != .cleanupRequired else { return }
    phase = .checking
    launch {
      try Task.checkCancellation()
      guard !self.credentialInvalidated else { throw CancellationError() }
      try await self.transport.availability(for: self.credential)
      return .ready
    }
  }

  func record() {
    guard !credentialInvalidated, task == nil, phase == .ready else { return }
    transcript = ""
    activeTurnID = UUID()
    phase = .checking
    launch {
      try Task.checkCancellation()
      guard !self.credentialInvalidated else { throw CancellationError() }
      try await self.transport.availability(for: self.credential)
      guard !Task.isCancelled else { throw CancellationError() }
      self.phase = .starting
      try await self.recorder.start()
      guard !Task.isCancelled else {
        try await self.recorder.cancel()
        throw CancellationError()
      }
      self.phase = .recording
      self.limitTask = Task {
        try? await Task.sleep(for: .seconds(30))
        if !Task.isCancelled { self.stop() }
      }
      return .recording
    }
  }

  func stop() {
    guard !credentialInvalidated, phase == .recording, task == nil,
      let turnID = activeTurnID else { return }
    limitTask?.cancel()
    limitTask = nil
    phase = .uploading
    launch {
      let artifact = try await self.recorder.stop()
      let text: String
      do {
        // stop() may finish after a pairing change. Dispose its artifact even when
        // transcription must not be admitted under the old credential.
        try Task.checkCancellation()
        guard !self.credentialInvalidated else { throw CancellationError() }
        text = try await self.transport.transcribe(
          artifact, turnID: turnID, credential: self.credential)
      } catch {
        do { try await self.recorder.dispose(artifact) }
        catch { throw SpeechTurnFailure.cleanupFailed }
        throw error
      }
      do { try await self.recorder.dispose(artifact) }
      catch { throw SpeechTurnFailure.cleanupFailed }
      guard !Task.isCancelled else { throw CancellationError() }
      self.transcript = text
      self.activeTurnID = nil
      return .reviewing
    }
  }

  func discardReview() {
    guard phase == .reviewing else { return }
    transcript = ""
    phase = .ready
  }

  func cancelAndDiscard() {
    switch phase {
    case .idle, .ready, .reviewing, .failed:
      transcript = ""
      phase = credentialInvalidated ? .credentialChanged : .idle
      return
    case .revoked, .credentialChanged:
      transcript = ""
      if credentialInvalidated { phase = .credentialChanged }
      return
    default: break
    }
    guard phase != .cancelling else { return }
    cancelledTurnCleanupFailed = false
    generation += 1
    let expected = generation
    let active = task
    let turnID = activeTurnID
    active?.cancel()
    task = nil
    limitTask?.cancel()
    limitTask = nil
    transcript = ""
    phase = .cancelling
    Task {
      var cleanupFailed = false
      do { try await recorder.cancel() } catch { cleanupFailed = true }
      if let turnID { await transport.cancel(turnID: turnID, credential: credential) }
      _ = await active?.value
      guard generation == expected else { return }
      if cleanupFailed || cancelledTurnCleanupFailed {
        phase = .cleanupRequired
        return
      }
      activeTurnID = nil
      phase = credentialInvalidated ? .credentialChanged : .idle
    }
  }

  func credentialDidChange() {
    guard !credentialInvalidated else { return }
    credentialInvalidated = true
    cancelAndDiscard()
  }

  func retryCleanup() {
    guard task == nil, phase == .cleanupRequired else { return }
    phase = .cancelling
    launch {
      do { try await self.recorder.cancel() }
      catch { throw SpeechTurnFailure.cleanupFailed }
      self.activeTurnID = nil
      return self.credentialInvalidated ? .credentialChanged : .idle
    }
  }

  static func reviewedApp(in transcript: String) -> PhoneControlApp? {
    let value = transcript.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard value.utf16.count <= 2_000 else { return nil }
    let pattern = #"^(open|launch|start)\s+(arc|safari|messages)[.!?]?$"#
    guard value.range(of: pattern, options: .regularExpression) != nil else { return nil }
    let name = value.split(whereSeparator: \.isWhitespace)[1]
      .trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
    return PhoneControlApp(rawValue: name)
  }

  private func launch(_ operation: @escaping @MainActor () async throws -> Phase) {
    generation += 1
    let expected = generation
    task = Task {
      defer { if expected == generation { task = nil } }
      do {
        try Task.checkCancellation()
        let next = try await operation()
        if expected == generation { phase = next }
      } catch {
        guard expected == generation else {
          // Cancellation waits for this task. Preserve a late artifact-disposal
          // failure before it decides whether private audio was removed.
          if phase == .cancelling, error as? SpeechTurnFailure == .cleanupFailed {
            cancelledTurnCleanupFailed = true
          }
          return
        }
        activeTurnID = nil
        if error is CancellationError || error as? SpeechTurnFailure == .cancelled {
          phase = credentialInvalidated ? .credentialChanged : .idle
        } else if error as? SpeechTurnFailure == .revoked {
          phase = .revoked
        } else if error as? SpeechTurnFailure == .cleanupFailed {
          phase = .cleanupRequired
        } else {
          phase = .failed(
            (error as? SpeechTurnFailure)?.localizedDescription
              ?? SpeechTurnFailure.unavailable.localizedDescription)
        }
      }
    }
  }
}

struct SpeechTransport: SpeechTransporting {
  static let maximumAudioBytes = 1_100_000
  static let maximumTranscriptBytes = 16_384
  private let transport: NativeEnrollmentTransport
  private let cancelTransport: NativeEnrollmentTransport

  init(
    transport: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 40),
    cancelTransport: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 3)
  ) {
    self.transport = transport
    self.cancelTransport = cancelTransport
  }

  func availability(for credential: NativeEnrollmentCredential) async throws {
    let (data, response) = try await envelope(
      path: "/native/v1/speech/availability", method: "GET", body: nil,
      credential: credential, maximumBytes: 1_024)
    try status(response.statusCode)
    try Self.decodeAvailability(data)
  }

  static func decodeAvailability(_ data: Data) throws {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["available"]), let available = object["available"] as? NSNumber,
      CFGetTypeID(available) == CFBooleanGetTypeID(), available.boolValue
    else { throw SpeechTurnFailure.invalidResponse }
  }

  func transcribe(
    _ artifact: SpeechAudioArtifact, turnID: UUID, credential: NativeEnrollmentCredential
  ) async throws -> String {
    let turn = turnID.uuidString.lowercased()
    let audio = try Self.readValidatedAudio(artifact.url)
    let (data, response) = try await envelope(
      path: "/native/v1/speech/transcriptions", method: "POST", body: audio,
      credential: credential, maximumBytes: Self.maximumTranscriptBytes, contentType: "audio/wav",
      headers: ["X-Ellie-Turn-ID": turn])
    try status(response.statusCode)
    return try Self.decodeTranscript(data, turn: turn)
  }

  static func decodeTranscript(_ data: Data, turn: String) throws -> String {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["turnId", "text"]), object["turnId"] as? String == turn,
      let text = object["text"] as? String, text.utf16.count <= 2_000,
      !text.utf16.contains(where: { (0xD800...0xDFFF).contains($0) })
    else { throw SpeechTurnFailure.invalidResponse }
    return text
  }

  func cancel(turnID: UUID, credential: NativeEnrollmentCredential) async {
    let turn = turnID.uuidString.lowercased()
    guard
      let (data, response) = try? await envelope(
        path: "/native/v1/speech/transcriptions/\(turn)/cancel", method: "POST",
        body: Data("{}".utf8), credential: credential, maximumBytes: 1_024,
        requestTransport: cancelTransport)
    else { return }
    guard response.statusCode == 200, (try? Self.decodeCancel(data)) != nil else { return }
  }

  static func decodeCancel(_ data: Data) throws -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["ok", "cancelled"]), let ok = object["ok"] as? NSNumber,
      let cancelled = object["cancelled"] as? NSNumber,
      CFGetTypeID(ok) == CFBooleanGetTypeID(), CFGetTypeID(cancelled) == CFBooleanGetTypeID(),
      ok.boolValue
    else { throw SpeechTurnFailure.invalidResponse }
    return cancelled.boolValue
  }

  private func envelope(
    path: String, method: String, body: Data?, credential: NativeEnrollmentCredential,
    maximumBytes: Int, contentType: String? = nil, headers: [String: String] = [:],
    requestTransport: NativeEnrollmentTransport? = nil
  ) async throws -> (Data, HTTPURLResponse) {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    do {
      return try await (requestTransport ?? transport).requestEnvelope(
        path: path, method: method, body: body, bearer: credential.token, pending: pending,
        maximumBytes: maximumBytes, contentType: contentType, additionalHeaders: headers)
    } catch is CancellationError { throw SpeechTurnFailure.cancelled } catch let failure
      as NativeEnrollmentFailure
    {
      if failure == .trustFailed { throw SpeechTurnFailure.unavailable }
      throw SpeechTurnFailure.invalidResponse
    } catch {
      if Task.isCancelled { throw SpeechTurnFailure.cancelled }
      throw SpeechTurnFailure.unavailable
    }
  }

  private func status(_ status: Int) throws {
    switch status {
    case 200: return
    case 401: throw SpeechTurnFailure.revoked
    case 403: throw SpeechTurnFailure.notAuthorized
    case 409: throw SpeechTurnFailure.busy
    case 499: throw SpeechTurnFailure.cancelled
    case 503: throw SpeechTurnFailure.unavailable
    default: throw SpeechTurnFailure.invalidResponse
    }
  }

  static func readValidatedAudio(_ url: URL) throws -> Data {
    var before = stat()
    guard lstat(url.path, &before) == 0, privateAudioFile(before) else {
      throw SpeechTurnFailure.invalidAudio
    }
    let descriptor = open(url.path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
    guard descriptor >= 0 else { throw SpeechTurnFailure.invalidAudio }
    defer { close(descriptor) }
    var opened = stat()
    guard fstat(descriptor, &opened) == 0, privateAudioFile(opened),
      opened.st_dev == before.st_dev, opened.st_ino == before.st_ino,
      opened.st_size >= 0, opened.st_size <= maximumAudioBytes
    else { throw SpeechTurnFailure.invalidAudio }
    var data = Data(count: Int(opened.st_size))
    let count = data.withUnsafeMutableBytes { bytes -> Int in
      guard let base = bytes.baseAddress else { return 0 }
      var offset = 0
      while offset < bytes.count {
        let amount = Darwin.read(descriptor, base.advanced(by: offset), bytes.count - offset)
        if amount <= 0 { return amount == 0 ? offset : -1 }
        offset += amount
      }
      return offset
    }
    var extra: UInt8 = 0
    guard count == data.count, Darwin.read(descriptor, &extra, 1) == 0, validWAV(data) else {
      throw SpeechTurnFailure.invalidAudio
    }
    return data
  }

  private static func privateAudioFile(_ value: stat) -> Bool {
    (value.st_mode & S_IFMT) == S_IFREG && value.st_uid == getuid() && value.st_nlink == 1
      && (value.st_mode & 0o777) == 0o600 && value.st_size <= maximumAudioBytes
  }

  static func validWAV(_ data: Data) -> Bool {
    guard data.count >= 44, String(data: data[0..<4], encoding: .ascii) == "RIFF",
      String(data: data[8..<12], encoding: .ascii) == "WAVE"
    else { return false }
    func u16(_ offset: Int) -> UInt16 {
      UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }
    func u32(_ offset: Int) -> UInt32 {
      UInt32(data[offset]) | UInt32(data[offset + 1]) << 8 | UInt32(data[offset + 2]) << 16
        | UInt32(data[offset + 3]) << 24
    }
    guard Int(u32(4)) + 8 == data.count else { return false }
    var offset = 12
    var format = false
    var samples: Int?
    while offset + 8 <= data.count {
      let name = String(data: data[offset..<(offset + 4)], encoding: .ascii)
      let length = Int(u32(offset + 4))
      let start = offset + 8
      guard length >= 0, start <= data.count, length <= data.count - start else { return false }
      if name == "fmt " {
        guard !format, length >= 16, u16(start) == 1, u16(start + 2) == 1,
          u32(start + 4) == 16_000,
          u32(start + 8) == 32_000, u16(start + 12) == 2, u16(start + 14) == 16
        else { return false }
        format = true
      } else if name == "data" {
        guard samples == nil, length > 0, length.isMultiple(of: 2), length <= 30 * 32_000 else {
          return false
        }
        samples = length
      }
      offset = start + length + (length.isMultiple(of: 2) ? 0 : 1)
    }
    return format && samples != nil && offset == data.count
  }
}
