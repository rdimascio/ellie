import AVFoundation
import Darwin
import Foundation

actor IOSSpeechRecorder: SpeechRecording {
  private struct OwnedArtifact {
    let directory: URL
    let file: URL
  }
  private var recorder: AVAudioRecorder?
  private var activeDirectory: URL?
  private var activeFile: URL?
  private var artifacts: [UUID: OwnedArtifact] = [:]

  func start() async throws {
    guard recorder == nil, activeDirectory == nil else { throw SpeechTurnFailure.busy }
    let allowed = await AVCaptureDevice.requestAccess(for: .audio)
    try Task.checkCancellation()
    guard allowed else { throw SpeechTurnFailure.microphoneDenied }

    let root = FileManager.default.temporaryDirectory.standardizedFileURL
    let directory = root.appendingPathComponent(
      "ellie-ios-voice-\(UUID().uuidString)", isDirectory: true)
    let file = directory.appendingPathComponent("turn.wav")
    var createdRecorder: AVAudioRecorder?
    do {
      try FileManager.default.createDirectory(
        at: directory, withIntermediateDirectories: false,
        attributes: [.posixPermissions: 0o700])
      try AVAudioSession.sharedInstance().setCategory(.record, mode: .measurement)
      try AVAudioSession.sharedInstance().setActive(true)
      let recorder = try AVAudioRecorder(
        url: file,
        settings: [
          AVFormatIDKey: kAudioFormatLinearPCM,
          AVSampleRateKey: 16_000,
          AVNumberOfChannelsKey: 1,
          AVLinearPCMBitDepthKey: 16,
          AVLinearPCMIsFloatKey: false,
          AVLinearPCMIsBigEndianKey: false,
        ])
      createdRecorder = recorder
      guard recorder.record(forDuration: 30) else { throw SpeechTurnFailure.unavailable }
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
      self.recorder = recorder
      activeDirectory = directory
      activeFile = file
    } catch {
      createdRecorder?.stop()
      try cleanup(directory: directory, file: file)
      try? AVAudioSession.sharedInstance().setActive(false)
      throw error
    }
  }

  func stop() async throws -> SpeechAudioArtifact {
    guard let recorder, let directory = activeDirectory, let file = activeFile,
      owns(directory: directory, file: file)
    else { throw SpeechTurnFailure.invalidAudio }
    recorder.stop()
    self.recorder = nil
    try? AVAudioSession.sharedInstance().setActive(false)
    do {
      _ = try SpeechTransport.readValidatedAudio(file)
      let id = UUID()
      artifacts[id] = OwnedArtifact(directory: directory, file: file)
      activeDirectory = nil
      activeFile = nil
      return SpeechAudioArtifact(id: id, url: file)
    } catch {
      try cleanup(directory: directory, file: file)
      activeDirectory = nil
      activeFile = nil
      throw error
    }
  }

  func cancel() async throws {
    recorder?.stop()
    recorder = nil
    if let directory = activeDirectory, let file = activeFile,
      owns(directory: directory, file: file)
    {
      try cleanup(directory: directory, file: file)
    }
    activeDirectory = nil
    activeFile = nil
    try? AVAudioSession.sharedInstance().setActive(false)
    for (id, artifact) in artifacts {
      try cleanup(directory: artifact.directory, file: artifact.file)
      artifacts.removeValue(forKey: id)
    }
  }

  func dispose(_ artifact: SpeechAudioArtifact) async throws {
    guard let owned = artifacts[artifact.id],
      owned.file.standardizedFileURL == artifact.url.standardizedFileURL,
      owns(directory: owned.directory, file: owned.file)
    else { return }
    try cleanup(directory: owned.directory, file: owned.file)
    artifacts.removeValue(forKey: artifact.id)
  }

  private func owns(directory: URL, file: URL) -> Bool {
    let root = FileManager.default.temporaryDirectory.standardizedFileURL
    return directory.deletingLastPathComponent().standardizedFileURL == root
      && directory.lastPathComponent.hasPrefix("ellie-ios-voice-")
      && file.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL
      && file.lastPathComponent == "turn.wav"
  }

  private func cleanup(directory: URL, file: URL) throws {
    guard owns(directory: directory, file: file) else { throw SpeechTurnFailure.cleanupFailed }
    if unlink(file.path) != 0 && errno != ENOENT { throw SpeechTurnFailure.cleanupFailed }
    if directory.path.withCString({ Darwin.rmdir($0) }) != 0 && errno != ENOENT {
      throw SpeechTurnFailure.cleanupFailed
    }
  }
}
