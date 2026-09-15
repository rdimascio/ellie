import SwiftUI

struct SpeechTurnView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject private var controlStore: PhoneControlStore
  @ObservedObject private var browserStore: BrowserPhoneControlStore
  @StateObject private var speech: SpeechTurnStore

  init(
    credential: NativeEnrollmentCredential, controls: PhoneControlStore,
    browser: BrowserPhoneControlStore,
    speech: SpeechTurnStore? = nil
  ) {
    controlStore = controls
    browserStore = browser
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
      browserStatus
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
          } else if let intent = BrowserVoiceIntentParser.parse(speech.transcript) {
            Button("Run \(intent.displayLabel) on selected Mac") {
              browserStore.perform(intent, on: controlStore.selectedNode)
              speech.discardReview()
            }
            .disabled(controlsBusy || browserStore.isBusy || controlStore.selectedNode == nil)
            Text("The command uses the current reviewed browser page. Read the page first for controls and results.")
              .font(.footnote).foregroundStyle(.secondary)
          } else {
            Text("Say an app command or a reviewed browser command such as “Scroll down” or “Search for local news.”")
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

  @ViewBuilder private var browserStatus: some View {
    switch browserStore.phase {
    case .idle, .ready: EmptyView()
    case .checking: Section { ProgressView("Checking browser connection…") }
    case .reading: Section { ProgressView("Reading current page…") }
    case .sending(let label): Section { ProgressView("Sending \(label)…") }
    case .cancelling: Section { ProgressView("Stopping…") }
    case .outcome(let message): Section("Browser result") { Label(message, systemImage: "checkmark.circle") }
    case .unknown(let message): Section("Browser result") { Label(message, systemImage: "questionmark.circle") }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked:
      Section { Label("This iPhone’s coordinator session was revoked.", systemImage: "lock.slash") }
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
