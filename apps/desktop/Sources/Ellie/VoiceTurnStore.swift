import AVFoundation
import AppKit
import Combine
import Darwin
import Foundation

protocol VoiceRecording: Sendable {
    func start() async throws
    func stop() async throws -> VoiceRecordingArtifact
    func dispose(_ artifact: VoiceRecordingArtifact) async
    func cancel() async
}

struct VoiceRecordingArtifact: Sendable, Equatable { let id: UUID; let url: URL }

protocol VoiceTranscribing: Sendable {
    func transcribe(_ audio: URL) async throws -> String
    func cancel() async
}

enum VoiceTurnPhase: Equatable { case idle, starting, recording, transcribing, cancelling, reviewing }

@MainActor
final class VoiceTurnStore: ObservableObject {
    @Published private(set) var phase: VoiceTurnPhase = .idle
    @Published var transcript = ""
    @Published private(set) var error: String?
    private let recorder: any VoiceRecording
    private let transcriber: any VoiceTranscribing
    private var task: Task<Void, Never>?
    private var limitTask: Task<Void, Never>?
    private var revision = UUID()

    init(recorder: any VoiceRecording = LocalVoiceRecorder(), transcriber: any VoiceTranscribing = LocalWhisperTranscriber()) {
        self.recorder = recorder; self.transcriber = transcriber
    }

    func start() {
        guard phase == .idle else { return }
        phase = .starting
        error = nil; revision = UUID(); let current = revision
        task = Task {
            do {
                try await recorder.start()
                guard current == revision, !Task.isCancelled else { await recorder.cancel(); return }
                phase = .recording
                limitTask = Task { try? await Task.sleep(for: .seconds(30)); if !Task.isCancelled { self.stop() } }
            } catch { if current == revision { phase = .idle; self.error = "Ellie could not start recording. Check microphone permission and local voice settings." } }
        }
    }

    func stop() {
        guard phase == .recording else { return }
        limitTask?.cancel(); limitTask = nil
        phase = .transcribing; let current = revision
        task = Task {
            do {
                let artifact = try await recorder.stop()
                let text: String
                do { text = try await transcriber.transcribe(artifact.url) }
                catch { await recorder.dispose(artifact); throw error }
                await recorder.dispose(artifact)
                guard current == revision, !Task.isCancelled else { return }
                transcript = String(text.prefix(2_000)).trimmingCharacters(in: .whitespacesAndNewlines)
                phase = .reviewing
            } catch {
                guard current == revision else { return }
                phase = .idle; self.error = "Local transcription did not complete. Ellie attempted to remove its temporary recording and transcript."
            }
        }
    }

    func cancel() {
        guard phase != .idle && phase != .cancelling else { return }
        revision = UUID(); let cancellation = revision; let active = task; active?.cancel(); task = nil; limitTask?.cancel(); limitTask = nil; phase = .cancelling; transcript = ""; error = nil
        Task { await recorder.cancel(); await transcriber.cancel(); _ = await active?.value; if self.revision == cancellation { self.phase = .idle } }
    }

    var reviewedApp: NativeApp? {
        guard phase == .reviewing else { return nil }
        return Self.parse(transcript)
    }
    static func parse(_ value: String) -> NativeApp? {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let pattern = #"^(open|launch|start)\s+(arc|safari|messages)[.!?]?$"#
        guard value.range(of: pattern, options: .regularExpression) != nil else { return nil }
        let appName = value.split(whereSeparator: \.isWhitespace)[1].trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
        return NativeApp.allCases.first { $0.title.lowercased() == appName }
    }
}

actor LocalVoiceRecorder: VoiceRecording {
    private var recorder: AVAudioRecorder?
    private var directory: URL?
    private var recordingURL: URL?
    private var artifacts: [UUID: (directory: URL, url: URL)] = [:]
    func start() async throws {
        guard recorder == nil else { throw VoiceError.busy }
        let allowed = await AVCaptureDevice.requestAccess(for: .audio)
        try Task.checkCancellation()
        guard allowed else { throw VoiceError.permission }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ellie-voice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent("turn.wav")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false]
        let recorder: AVAudioRecorder
        do { recorder = try AVAudioRecorder(url: url, settings: settings) }
        catch { cleanup(directory: directory, file: url); throw error }
        guard recorder.record(forDuration: 30) else { cleanup(directory: directory, file: url); throw VoiceError.recording }
        do { try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path) }
        catch { recorder.stop(); try? FileManager.default.removeItem(at: url); _ = directory.path.withCString { Darwin.rmdir($0) }; throw error }
        self.directory = directory; self.recordingURL = url; self.recorder = recorder
    }
    func stop() async throws -> VoiceRecordingArtifact {
        guard let recorder, let directory else { throw VoiceError.recording }
        recorder.stop(); self.recorder = nil; self.directory = nil; self.recordingURL = nil
        let url = recorder.url
        let size: Int
        do { size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? .max }
        catch { cleanup(directory: directory, file: url); throw error }
        guard size <= 1_100_000 else { cleanup(directory: directory, file: url); throw VoiceError.limit }
        let id = UUID(); artifacts[id] = (directory, url)
        return VoiceRecordingArtifact(id: id, url: url)
    }
    func dispose(_ artifact: VoiceRecordingArtifact) async {
        guard let owned = artifacts[artifact.id], owned.url.standardizedFileURL == artifact.url.standardizedFileURL,
              owned.url.deletingLastPathComponent().standardizedFileURL == owned.directory.standardizedFileURL,
              owned.directory.lastPathComponent.hasPrefix("ellie-voice-") else { return }
        artifacts.removeValue(forKey: artifact.id)
        try? FileManager.default.removeItem(at: owned.url)
        _ = owned.directory.path.withCString { Darwin.rmdir($0) }
    }
    func cancel() async { recorder?.stop(); recorder = nil; if let directory { cleanup(directory: directory, file: recordingURL) }; directory = nil; recordingURL = nil }
    private func cleanup(directory: URL, file: URL?) {
        guard directory.lastPathComponent.hasPrefix("ellie-voice-"), directory.deletingLastPathComponent().standardizedFileURL == FileManager.default.temporaryDirectory.standardizedFileURL else { return }
        if let file, file.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL { try? FileManager.default.removeItem(at: file) }
        _ = directory.path.withCString { Darwin.rmdir($0) }
    }
}

struct LocalVoiceConfiguration: Sendable {
    let node: URL, bridge: URL, whisper: URL, model: URL
    let timeout: Duration, maximumOutputBytes: Int
}

private final class VoiceOutputCollector: @unchecked Sendable {
    private let lock = NSLock(); private var data = Data(); private var exceeded = false; private var eof = false
    func append(_ bytes: Data, maximum: Int) { lock.lock(); defer { lock.unlock() }; if data.count + bytes.count > maximum { exceeded = true } else { data.append(bytes) } }
    func result() -> (Data, Bool) { lock.lock(); defer { lock.unlock() }; return (data, exceeded) }
    func markEOF() { lock.lock(); eof = true; lock.unlock() }
    func reachedEOF() -> Bool { lock.lock(); defer { lock.unlock() }; return eof }
}

actor LocalWhisperTranscriber: VoiceTranscribing {
    private var process: Process?
    private var lastPID: pid_t?
    private let configuration: @Sendable () -> LocalVoiceConfiguration?
    init(configuration: @escaping @Sendable () -> LocalVoiceConfiguration? = { LocalWhisperTranscriber.savedConfiguration() }) { self.configuration = configuration }
    nonisolated private static func savedConfiguration() -> LocalVoiceConfiguration? {
        let defaults = UserDefaults.standard
        guard let node = defaults.string(forKey: "voice.node"), let executable = defaults.string(forKey: "voice.executable"), let model = defaults.string(forKey: "voice.model"), node.hasPrefix("/"), executable.hasPrefix("/"), model.hasPrefix("/"), let bridge = Bundle.main.url(forResource: "voice-transcribe", withExtension: "mjs") else { return nil }
        return LocalVoiceConfiguration(node: URL(fileURLWithPath: node), bridge: bridge, whisper: URL(fileURLWithPath: executable), model: URL(fileURLWithPath: model), timeout: .seconds(35), maximumOutputBytes: 16_384)
    }
    func transcribe(_ audio: URL) async throws -> String {
        guard let config = configuration() else { throw VoiceError.configuration }
        let pipe = Pipe()
        let process = Process(); process.executableURL = config.node; process.arguments = [config.bridge.path, "--audio", audio.path, "--model", config.model.path, "--executable", config.whisper.path]; process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { self.process = nil; try? pipe.fileHandleForReading.close(); throw error }
        lastPID = process.processIdentifier
        let groupResult = Darwin.setpgid(process.processIdentifier, process.processIdentifier)
        guard groupResult == 0 || Darwin.getpgid(process.processIdentifier) == process.processIdentifier else {
            process.terminate(); for _ in 0..<10 { if !process.isRunning { break }; await Task.detached { try? await Task.sleep(for: .milliseconds(50)) }.value }
            if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
            self.process = nil; try? pipe.fileHandleForReading.close(); throw VoiceError.process
        }
        self.process = process
        let collector = VoiceOutputCollector()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let bytes = handle.availableData
            if bytes.isEmpty { collector.markEOF(); handle.readabilityHandler = nil }
            else { collector.append(bytes, maximum: config.maximumOutputBytes); if collector.result().1 { process.terminate() } }
        }
        let clock = ContinuousClock(), deadline = clock.now + config.timeout
        var reachedEOF = false
        do {
            try await withTaskCancellationHandler {
                while process.isRunning {
                    guard !collector.result().1 else { throw VoiceError.limit }
                    guard clock.now < deadline else { throw VoiceError.process }
                    try Task.checkCancellation()
                    try await Task.sleep(for: .milliseconds(100))
                }
            } onCancel: { process.terminate() }
            while !collector.reachedEOF() && clock.now < deadline { try Task.checkCancellation(); try await Task.sleep(for: .milliseconds(20)) }
            reachedEOF = collector.reachedEOF()
        } catch {
            let grace = clock.now + .seconds(1)
            await terminate(process, deadline: grace < deadline ? grace : deadline)
            pipe.fileHandleForReading.readabilityHandler = nil; try? pipe.fileHandleForReading.close()
            self.process = nil
            throw error
        }
        await terminate(process, deadline: deadline)
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close(); self.process = nil
        let (data, exceeded) = collector.result()
        guard process.terminationStatus == 0, reachedEOF else { throw VoiceError.process }
        guard !exceeded, let reply = try? JSONDecoder().decode(VoiceReply.self, from: data) else { throw VoiceError.limit }; return reply.text
    }
    func cancel() async {
        guard let process else { return }
        await terminate(process, deadline: ContinuousClock.now + .seconds(1))
        if self.process?.processIdentifier == process.processIdentifier { self.process = nil }
    }
    func isRunningForTests() -> Bool { process?.isRunning == true }
    func lastPIDForTests() -> pid_t? { lastPID }
    private func terminate(_ process: Process, deadline: ContinuousClock.Instant) async {
        let group = -process.processIdentifier
        if Darwin.kill(group, SIGTERM) != 0, process.isRunning { process.terminate() }
        while ContinuousClock.now < deadline { if Darwin.kill(group, 0) != 0 && !process.isRunning { return }; await Task.detached { try? await Task.sleep(for: .milliseconds(50)) }.value }
        if Darwin.kill(group, SIGKILL) != 0, process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        for _ in 0..<4 { if Darwin.kill(group, 0) != 0 && !process.isRunning { return }; await Task.detached { try? await Task.sleep(for: .milliseconds(50)) }.value }
    }
}

private struct VoiceReply: Decodable { let text: String }

private enum VoiceError: Error { case busy, permission, recording, limit, configuration, process }

@MainActor
enum VoiceSettings {
    static func choose() {
        guard let node = chooseFile(title: "Choose Node.js 24", executable: true),
              let whisper = chooseFile(title: "Choose whisper-cli", executable: true),
              let model = chooseFile(title: "Choose a local GGML model", executable: false) else { return }
        let defaults = UserDefaults.standard
        defaults.set(node.path, forKey: "voice.node")
        defaults.set(whisper.path, forKey: "voice.executable")
        defaults.set(model.path, forKey: "voice.model")
    }
    private static func chooseFile(title: String, executable: Bool) -> URL? {
        let panel = NSOpenPanel(); panel.title = title; panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url,
              FileManager.default.isReadableFile(atPath: url.path),
              (!executable || FileManager.default.isExecutableFile(atPath: url.path)) else { return nil }
        return url
    }
}
