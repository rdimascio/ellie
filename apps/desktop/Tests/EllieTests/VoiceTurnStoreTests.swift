import Foundation
import Darwin
import XCTest
@testable import Ellie

final class VoiceTurnStoreTests: XCTestCase {
    @MainActor
    func testRecordingTranscriptionRequiresEditableReviewAndAllowlist() async {
        let recorder = FakeRecorder(), transcriber = FakeTranscriber(text: "Open Safari")
        let store = VoiceTurnStore(recorder: recorder, transcriber: transcriber)
        store.start(); await wait { store.phase == .recording }
        store.stop(); await wait { store.phase == .reviewing }
        XCTAssertEqual(store.transcript, "Open Safari")
        XCTAssertEqual(store.reviewedApp, .safari)
        store.transcript = "Open Safari."
        XCTAssertEqual(store.reviewedApp, .safari)
        store.transcript = "Open Calculator"
        XCTAssertNil(store.reviewedApp)
    }

    @MainActor
    func testCancelClearsTranscriptAndLateResultCannotRestoreIt() async {
        let recorder = FakeRecorder(), transcriber = FakeTranscriber(text: "Open Arc", delay: .seconds(2))
        let store = VoiceTurnStore(recorder: recorder, transcriber: transcriber)
        store.start(); await wait { store.phase == .recording }
        store.stop(); store.cancel()
        await wait { store.phase == .idle }; XCTAssertTrue(store.transcript.isEmpty)
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.phase, .idle); XCTAssertTrue(store.transcript.isEmpty)
    }

    func testNativeTranscriberBoundsOutputAndKillsTermIgnoringProcess() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ellie-voice-process-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer {
            for name in ["audio.wav", "large.sh", "hang.sh", "orphan.sh"] { try? FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
            _ = directory.path.withCString { Darwin.rmdir($0) }
        }
        let audio = directory.appendingPathComponent("audio.wav"); try Data().write(to: audio)
        let large = try script("#!/bin/sh\ni=0; while [ $i -lt 20000 ]; do printf x; i=$((i+1)); done\n", name: "large.sh", in: directory)
        let bounded = LocalWhisperTranscriber(configuration: { LocalVoiceConfiguration(node: large, bridge: audio, whisper: audio, model: audio, timeout: .seconds(2), maximumOutputBytes: 512) })
        do { _ = try await bounded.transcribe(audio); XCTFail("Oversized output must fail") } catch {}

        let hang = try script("#!/bin/sh\ntrap '' TERM\nwhile :; do :; done\n", name: "hang.sh", in: directory)
        let cancellable = LocalWhisperTranscriber(configuration: { LocalVoiceConfiguration(node: hang, bridge: audio, whisper: audio, model: audio, timeout: .seconds(35), maximumOutputBytes: 512) })
        let turn = Task { try await cancellable.transcribe(audio) }
        try await Task.sleep(for: .milliseconds(50)); let ownedPID = await cancellable.lastPIDForTests(); let cancelStart = ContinuousClock.now; turn.cancel(); _ = try? await turn.value
        XCTAssertLessThan(cancelStart.duration(to: .now), .seconds(2))
        let stillRunning = await cancellable.isRunningForTests()
        XCTAssertFalse(stillRunning)
        let pid = try XCTUnwrap(ownedPID)
        XCTAssertEqual(Darwin.kill(pid, 0), -1)
        XCTAssertEqual(Darwin.kill(-pid, 0), -1)

        let orphan = try script("#!/bin/sh\nprintf '{\"text\":\"Open Arc\"}'\n(trap '' TERM; while :; do :; done) &\nexit 0\n", name: "orphan.sh", in: directory)
        let inheritedPipe = LocalWhisperTranscriber(configuration: { LocalVoiceConfiguration(node: orphan, bridge: audio, whisper: audio, model: audio, timeout: .seconds(2), maximumOutputBytes: 512) })
        let start = ContinuousClock.now
        do { _ = try await inheritedPipe.transcribe(audio); XCTFail("A parent exit without a valid bounded reply must fail") } catch {}
        XCTAssertLessThan(start.duration(to: .now), .seconds(3))
    }

    @MainActor
    func testNewTurnCannotStartUntilNoncooperativeOldTurnFinishesCleanup() async {
        let recorder = FakeRecorder(), transcriber = GatedTranscriber()
        let store = VoiceTurnStore(recorder: recorder, transcriber: transcriber)
        store.start(); await wait { store.phase == .recording }; store.stop(); await wait { store.phase == .transcribing }
        store.cancel(); store.start()
        XCTAssertEqual(store.phase, .cancelling)
        let firstStarts = await recorder.starts()
        XCTAssertEqual(firstStarts, 1)
        await transcriber.release(); await wait { store.phase == .idle }
        store.start(); await wait { store.phase == .recording }
        let secondStarts = await recorder.starts()
        XCTAssertEqual(secondStarts, 2)
        store.cancel(); await wait { store.phase == .idle }
    }

    private func script(_ contents: String, name: String, in directory: URL) throws -> URL {
        let url = directory.appendingPathComponent(name)
        try Data(contents.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        return url
    }

    @MainActor private func wait(_ condition: () -> Bool) async { for _ in 0..<100 { if condition() { return }; try? await Task.sleep(for: .milliseconds(10)) }; XCTFail("Timed out") }
}

private actor FakeRecorder: VoiceRecording {
    private var owned: [UUID: URL] = [:]
    private var startCount = 0
    func start() async throws { startCount += 1 }
    func starts() -> Int { startCount }
    func stop() async throws -> VoiceRecordingArtifact {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ellie-voice-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let id = UUID(), url = directory.appendingPathComponent("synthetic.wav"); try Data().write(to: url); owned[id] = directory
        return VoiceRecordingArtifact(id: id, url: url)
    }
    func dispose(_ artifact: VoiceRecordingArtifact) async {
        if let directory = owned.removeValue(forKey: artifact.id) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("synthetic.wav"))
            _ = directory.path.withCString { Darwin.rmdir($0) }
        }
    }
    func cancel() async {
        for directory in owned.values {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent("synthetic.wav"))
            _ = directory.path.withCString { Darwin.rmdir($0) }
        }
        owned.removeAll()
    }
}
private actor GatedTranscriber: VoiceTranscribing {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func transcribe(_ audio: URL) async throws -> String {
        if released { return "Open Arc" }
        await withCheckedContinuation { continuation = $0 }
        return "Open Arc"
    }
    func cancel() async {}
    func release() { released = true; continuation?.resume(); continuation = nil }
}
private actor FakeTranscriber: VoiceTranscribing {
    let text: String; let delay: Duration
    init(text: String, delay: Duration = .zero) { self.text = text; self.delay = delay }
    func transcribe(_ audio: URL) async throws -> String { try await Task.sleep(for: delay); return text }
    func cancel() async {}
}
