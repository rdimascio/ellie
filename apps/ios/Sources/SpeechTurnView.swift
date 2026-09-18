import SwiftUI

struct SpeechTurnView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject private var controlStore: PhoneControlStore
  @ObservedObject private var browserStore: BrowserPhoneControlStore
  @StateObject private var speech: SpeechTurnStore
  @StateObject private var lifeReview: IOSQuietVoiceStore
  private let credential: NativeEnrollmentCredential
  private let lifeConversationID: String?

  init(
    credential: NativeEnrollmentCredential, controls: PhoneControlStore,
    browser: BrowserPhoneControlStore,
    speech: SpeechTurnStore? = nil,
    lifeReview: IOSQuietVoiceStore? = nil,
    lifeConversationID: String? = nil
  ) {
    self.credential = credential
    controlStore = controls
    browserStore = browser
    _speech = StateObject(
      wrappedValue: speech
        ?? SpeechTurnStore(credential: credential, recorder: IOSSpeechRecorder()))
    _lifeReview = StateObject(wrappedValue: lifeReview ?? IOSQuietVoiceStore(credential: credential))
    self.lifeConversationID = lifeConversationID
  }

  var body: some View {
    Form {
      Section("Voice command") {
        Text(
          "Record up to 30 seconds. Audio is sent only to your paired coordinator for transcription. Review the text before choosing an action."
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        controlsBody
      }
      status
      browserStatus
      if browserStore.showsSeparatePendingBrowserWarning {
        Section("Browser result") {
          Label(
            BrowserPhoneControlStore.pendingCommandWarningMessage,
            systemImage: "questionmark.circle")
            .accessibilityIdentifier("browser-status-pending-warning")
        }
      }
      if browserStore.showsPendingBrowserWarningError,
        let warningError = browserStore.pendingBrowserWarningError
      {
        Section("Browser result") {
          Label(warningError, systemImage: "exclamationmark.triangle")
            .accessibilityIdentifier("browser-status-pending-storage-error")
        }
      }
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
          Button("Send reviewed message to Life") {
            lifeReview.sendReviewed(speech.transcript, conversationID: lifeConversationID)
          }
          .accessibilityIdentifier("speech-life-send")
          .disabled(!lifeReview.canSend || controlsBusy || browserStore.isBusy)
          Text("Life can answer questions here. Review actions on your Mac; sending this message does not approve one.")
            .font(.footnote).foregroundStyle(.secondary)
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
            if case .search = intent, let site = browserStore.page?.site,
              (site.provider == .netflix || site.provider == .youtube),
              let control = site.searchControl {
              Text("Run will use the observed \(control.label) field on \(controlStore.selectedNode?.label ?? "the selected Mac"). Read again to observe any result.")
                .font(.footnote)
                .accessibilityIdentifier(
                  site.provider == .netflix ? "speech-netflix-search-review" : "speech-youtube-search-review")
            }
            if case .scroll(let direction) = intent,
              direction == .left || direction == .right,
              let site = browserStore.page?.site, site.provider == .netflix,
              site.page == .browse, let rows = site.rows, !rows.isEmpty
            {
              Text("Choose a row on \(controlStore.selectedNode?.label ?? "the selected Mac") before running this command.")
                .font(.footnote).foregroundStyle(.secondary)
              ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                Button {
                  browserStore.selectObservedRow(row.id, on: controlStore.selectedNode)
                } label: {
                  HStack {
                    Text(row.label)
                    Spacer()
                    if browserStore.selectedRowID == row.id { Image(systemName: "checkmark") }
                  }
                }
                .accessibilityIdentifier("speech-netflix-row-\(index + 1)")
                .disabled(controlsBusy || browserStore.isBusy)
              }
              if let chosen = rows.first(where: { $0.id == browserStore.selectedRowID }) {
                Text("Run will scroll \(chosen.label) on \(controlStore.selectedNode?.label ?? "the selected Mac").")
                  .font(.footnote)
                  .accessibilityIdentifier("speech-netflix-row-review")
              }
            }
            Button("Run \(intent.displayLabel) on selected Mac") {
              if browserStore.perform(intent, on: controlStore.selectedNode) {
                speech.discardReview()
              }
            }
            .accessibilityIdentifier("speech-browser-run")
            .disabled(
              controlsBusy || !browserStore.canPerform(intent, on: controlStore.selectedNode))
            if !browserStore.canPerform(intent, on: controlStore.selectedNode) {
              Button("Read current browser page", systemImage: "doc.text.magnifyingglass") {
                browserStore.refresh(on: controlStore.selectedNode)
              }
              .accessibilityIdentifier("speech-browser-read")
              .disabled(controlsBusy || !browserStore.canRefresh(on: controlStore.selectedNode))
            }
            Text(
              "The reviewed command uses the current browser page. Reading is separate and never sends the command."
            )
              .font(.footnote).foregroundStyle(.secondary)
          } else {
            Text("Say an app command or a reviewed browser command such as “Scroll down” or “Search for local news.”")
              .font(.footnote).foregroundStyle(.secondary)
          }
          Button("Discard transcript", role: .destructive) { speech.discardReview() }
            .accessibilityIdentifier("speech-discard")
        }
      }
      lifeReviewStatus
      browserContinuation
    }
    .ellieScreen()
    .navigationTitle("Voice command")
    .onDisappear {
      speech.cancelAndDiscard()
      browserStore.cancel()
      lifeReview.background()
    }
    .onAppear { lifeReview.restore() }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active {
        speech.cancelAndDiscard()
        browserStore.cancel()
        lifeReview.background()
      }
    }
    .onChange(of: credential) { _, _ in
      speech.cancelAndDiscard()
      lifeReview.credentialDidChange()
    }
  }

  @ViewBuilder private var lifeReviewStatus: some View {
    switch lifeReview.phase {
    case .idle: EmptyView()
    case .checking: Section("Life") { ProgressView("Checking Life conversation…") }
    case .sending: Section("Life") { ProgressView("Sending reviewed message…") }
    case .unknown:
      Section("Life") {
        Label("The message may have reached Life. Check its status before sending another.",
          systemImage: "questionmark.circle")
        Button("Check message status") { lifeReview.reconcile() }
          .accessibilityIdentifier("speech-life-check-status")
        stopTrackingQuestion
      }
    case .notFound:
      Section("Life") {
        Label("No durable request was found yet. The message may still have reached Life.",
          systemImage: "questionmark.circle")
          .accessibilityIdentifier("speech-life-not-found")
        Button("Check again") { lifeReview.reconcile() }
        stopTrackingQuestion
      }
    case .storageUnavailable:
      Section("Life") {
        Label("Private request safety storage is unavailable. Sending is paused.",
          systemImage: "externaldrive.badge.exclamationmark")
      }
    case .revoked:
      Section("Life") { Label("Life access was revoked.", systemImage: "lock.slash") }
    case .completed(let outcome):
      Section("Life reply") {
        Text(outcome.reply ?? "No reply is available.")
          .accessibilityIdentifier("speech-life-reply")
        Text("Read-only reply. This iPhone made no changes.")
          .font(.footnote).foregroundStyle(.secondary)
        if outcome.needsMacReview {
          Text("Review the requested action in Ellie Life on your Mac. This iPhone made no change.")
        }
        Button("New message") {
          speech.discardReview()
          lifeReview.reset()
        }
      }
    case .interrupted:
      Section("Life") {
        Label("This request was interrupted. It was not sent again.",
          systemImage: "exclamationmark.triangle")
        Button("New message") {
          speech.discardReview()
          lifeReview.reset()
        }
      }
    case .failed(let message):
      Section("Life") { Label(message, systemImage: "exclamationmark.triangle") }
    }
  }

  private var stopTrackingQuestion: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("A reply may still appear in Life. Stopping tracking clears only this iPhone's local request; it does not cancel the Life question.")
        .font(.footnote).foregroundStyle(.secondary)
      Button("Stop tracking this question", role: .destructive) {
        lifeReview.stopTracking()
        speech.discardReview()
      }
      .accessibilityIdentifier("speech-life-stop-tracking")
    }
  }

  @ViewBuilder private var browserStatus: some View {
    switch browserStore.phase {
    case .idle: EmptyView()
    case .ready:
      Section {
        Label("Current browser page is ready for review.", systemImage: "checkmark.circle")
      }
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

  @ViewBuilder private var browserContinuation: some View {
    if speech.phase != .reviewing, showsBrowserContinuation {
      Section("Continue in browser") {
        if browserStore.page != nil {
          NavigationLink {
            BrowserControlView(controls: controlStore, browser: browserStore)
          } label: {
            Label("Review observed results and controls", systemImage: "list.bullet.rectangle")
          }
          .accessibilityIdentifier("speech-browser-continue")
        } else {
          Button("Read updated browser page", systemImage: "doc.text.magnifyingglass") {
            browserStore.refresh(on: controlStore.selectedNode)
          }
          .accessibilityIdentifier("speech-browser-read-updated")
          .disabled(controlsBusy || !browserStore.canRefresh(on: controlStore.selectedNode))
        }
        Text(
          "Read the updated page before selecting an observed result or using Play and Pause."
        )
        .font(.footnote).foregroundStyle(.secondary)
      }
    }
  }

  private var showsBrowserContinuation: Bool {
    if browserStore.page != nil { return true }
    switch browserStore.phase {
    case .outcome, .unknown, .failed: return true
    default: return false
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
