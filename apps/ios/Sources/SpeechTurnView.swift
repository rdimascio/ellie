import SwiftUI

struct SpeechTurnView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject private var controlStore: PhoneControlStore
  @StateObject private var speech: SpeechTurnStore

  init(
    credential: NativeEnrollmentCredential, controls: PhoneControlStore,
    speech: SpeechTurnStore? = nil
  ) {
    controlStore = controls
    _speech = StateObject(
      wrappedValue: speech
        ?? SpeechTurnStore(credential: credential, recorder: IOSSpeechRecorder()))
  }

  var body: some View {
    Form {
      Section("Voice command") {
        Text(
          "Record up to 30 seconds. Audio is sent only to your paired coordinator for transcription. Review the text before choosing an app."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        controlsBody
      }
      status
      if speech.phase == .reviewing {
        Section("Review transcript") {
          TextEditor(text: $speech.transcript)
            .frame(minHeight: 140)
            .accessibilityIdentifier("speech-transcript")
            .onChange(of: speech.transcript) { _, value in
              if value.utf16.count > 2_000 {
                var bounded = value
                while bounded.utf16.count > 2_000 { bounded.removeLast() }
                speech.transcript = bounded
              }
            }
          Text("\(speech.transcript.utf16.count) of 2,000 characters")
            .font(.caption).foregroundStyle(.secondary)
          if let app = speech.reviewedApp {
            Button("Use reviewed \(app.label) command") {
              controlStore.selectedApp = app
              speech.discardReview()
              dismiss()
            }
            .disabled(controlsBusy)
            Text("This selects \(app.label). Use the separate Open button to send the command.")
              .font(.footnote).foregroundStyle(.secondary)
          } else {
            Text("Say or enter “Open Safari,” “Open Arc,” or “Open Messages.”")
              .font(.footnote).foregroundStyle(.secondary)
          }
          Button("Discard transcript", role: .destructive) { speech.discardReview() }
        }
      }
    }
    .navigationTitle("Voice command")
    .onDisappear { speech.cancelAndDiscard() }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { speech.cancelAndDiscard() }
    }
  }

  @ViewBuilder private var controlsBody: some View {
    switch speech.phase {
    case .idle:
      Button("Check voice availability") { speech.checkAvailability() }
        .accessibilityIdentifier("speech-check")
    case .ready:
      Button("Record", systemImage: "mic.fill") { speech.record() }
        .accessibilityIdentifier("speech-record")
    case .recording:
      Button("Stop and transcribe", systemImage: "stop.fill") { speech.stop() }
        .accessibilityIdentifier("speech-stop")
      Button("Cancel recording", role: .cancel) { speech.cancelAndDiscard() }
    case .checking, .starting, .uploading:
      Button("Cancel", role: .cancel) { speech.cancelAndDiscard() }
    case .cancelling:
      Button("Cancelling…", role: .cancel) {}.disabled(true)
    case .reviewing:
      EmptyView()
    case .failed:
      Button("Check again") { speech.checkAvailability() }
    case .revoked:
      EmptyView()
    case .cleanupRequired:
      Button("Retry removing private recording", role: .destructive) { speech.retryCleanup() }
    }
  }

  @ViewBuilder private var status: some View {
    switch speech.phase {
    case .idle: EmptyView()
    case .checking: Section { ProgressView("Checking voice availability…") }
    case .ready: Section { Label("Voice service is available.", systemImage: "checkmark.circle") }
    case .starting: Section { ProgressView("Waiting for microphone access…") }
    case .recording: Section { Label("Recording…", systemImage: "waveform") }
    case .uploading: Section { ProgressView("Transcribing securely…") }
    case .cancelling: Section { ProgressView("Cancelling…") }
    case .reviewing: EmptyView()
    case .failed(let message):
      Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked:
      Section { Label("This iPhone’s coordinator session was revoked.", systemImage: "lock.slash") }
    case .cleanupRequired:
      Section {
        Label(SpeechTurnFailure.cleanupFailed.localizedDescription, systemImage: "externaldrive.badge.exclamationmark")
      }
    }
  }

  private var controlsBusy: Bool {
    switch controlStore.phase {
    case .loading, .sending, .cancelling: true
    default: false
    }
  }
}
