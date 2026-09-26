import SwiftUI

struct PhoneControlView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var store: PhoneControlStore
  @StateObject private var browser: BrowserPhoneControlStore
  @ObservedObject private var watch = WatchMediaPhoneBridge.shared
  private let credential: NativeEnrollmentCredential

  init(
    credential: NativeEnrollmentCredential, store: PhoneControlStore? = nil,
    browser: BrowserPhoneControlStore? = nil
  ) {
    self.credential = credential
    _store = StateObject(wrappedValue: store ?? PhoneControlStore(credential: credential))
    _browser = StateObject(
      wrappedValue: browser ?? BrowserPhoneControlStore(credential: credential))
  }

  var body: some View {
    Form {
      if store.credentialChanged {
        Section {
          Label("Pairing changed. Reopen Mac controls.", systemImage: "lock.slash")
            .accessibilityIdentifier("phone-controls-credential-changed")
          Text("If a command was in progress, check the Mac before trying again.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      } else {
        Section("Mac") {
          if store.nodes.isEmpty {
            Text(store.phase == .ready
              ? "No Macs are available to this iPhone. Check its Mac grants and the coordinator's node status."
              : "Refresh to load the Macs granted to this iPhone.")
              .foregroundStyle(.secondary)
          } else {
            Picker("Target", selection: $store.selectedNodeID) {
              Text("Choose a Mac").tag(String?.none)
              ForEach(store.nodes) { node in
                Text("\(node.label)\(node.online ? "" : " — Offline")").tag(Optional(node.id))
              }
            }
            .accessibilityIdentifier("phone-target-picker")
            .disabled(isBusy)
          }
          Button("Refresh Macs", systemImage: "arrow.clockwise") { store.refresh() }
            .disabled(isBusy || store.requiresUnknownOutcomeReview)
        }

        Section("Application") {
          Picker("Application", selection: $store.selectedApp) {
            ForEach(PhoneControlApp.allCases) { app in Text(app.label).tag(app) }
          }
          .disabled(isBusy)
          Button("Open on selected Mac") { store.send() }
            .disabled(!store.canSend)
        }

        Section("Voice") {
          NavigationLink {
            SpeechTurnView(credential: credential, controls: store, browser: browser)
          } label: {
            Label("Record a command", systemImage: "waveform")
          }
        }

        Section("Browser") {
          NavigationLink("Control selected Mac browser") {
            BrowserControlView(controls: store, browser: browser)
          }
          .disabled(store.selectedNode == nil)
        }

        Section("Apple Watch") {
          if let target = watch.enabledTargetID {
            Label("Enabled for \(nodeLabel(target))", systemImage: "applewatch")
            Button("Disable Watch control", role: .destructive) { watch.disable() }
          } else {
            Button("Enable Watch control for selected Mac") {
              if let node = store.selectedNode { _ = watch.enable(credential: credential, node: node) }
            }
            .disabled(!watchTargetEligible || !watch.available || isBusy)
            Text("The Watch uses this iPhone's current browser grants. Open Ellie on Watch and tap Read; actions are never queued for later delivery.")
              .font(.footnote).foregroundStyle(.secondary)
            if store.selectedNode != nil && !watchTargetEligible {
              Text("Select an online Mac with browser reading and control granted to this iPhone.")
                .font(.footnote).foregroundStyle(.secondary)
            }
          }
          if !watch.available {
            Text("A paired Watch with Ellie installed is not available yet.")
              .font(.footnote).foregroundStyle(.secondary)
          }
        }

        status

        if isBusy {
          Section {
            Button("Stop waiting", role: .cancel) { store.cancel() }
              .disabled(store.phase == .cancelling)
          }
        }
      }
    }
    .ellieScreen()
    .navigationTitle("Mac controls")
    .onChange(of: store.selectedNodeID) { _, value in
      browser.clearIfTargetChanged(to: value)
      if watch.enabledTargetID != value { watch.disable() }
    }
    .onDisappear {
      store.cancel()
      browser.cancel()
    }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active {
        store.cancel()
        browser.cancel()
      }
    }
    .onChange(of: credential) { _, _ in
      browser.credentialDidChange()
      store.credentialDidChange()
      watch.disable()
    }
  }

  @ViewBuilder private var status: some View {
    switch store.phase {
    case .idle: EmptyView()
    case .loading: Section { ProgressView("Refreshing Macs…") }
    case .ready: EmptyView()
    case .sending: Section { ProgressView("Waiting for the selected Mac…") }
    case .cancelling: Section { ProgressView("Stopping…") }
    case .outcome(let outcome, let nodeID, let app):
      Section("Result") {
        switch outcome {
        case .completed:
          Label(
            "\(app.label) opened on \(nodeLabel(nodeID)).", systemImage: "checkmark.circle.fill")
        case .failed:
          Label("The selected Mac could not open \(app.label).", systemImage: "xmark.circle")
        case .unknown:
          Label(
            "The outcome is unknown. Check \(nodeLabel(nodeID)) before trying again.",
            systemImage: "questionmark.circle")
          Button("I checked the Mac") { store.acknowledgeUnknownOutcome() }
            .accessibilityIdentifier("phone-command-unknown-reviewed")
          Text("This only enables a separate new command. Nothing is sent automatically.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked:
      Section { Label("This iPhone’s coordinator session was revoked.", systemImage: "lock.slash") }
    }
  }

  private var isBusy: Bool {
    if case .loading = store.phase { return true }
    if case .sending = store.phase { return true }
    if case .cancelling = store.phase { return true }
    return false
  }

  private var watchTargetEligible: Bool {
    guard let node = store.selectedNode, node.online,
      node.capabilities.contains("browser.read"), node.capabilities.contains("browser.control")
    else { return false }
    return credential.client.grants.contains {
      $0.target == node.id && $0.capabilities.contains("browser.read")
        && $0.capabilities.contains("browser.control")
    }
  }

  private func nodeLabel(_ id: String) -> String {
    store.nodes.first(where: { $0.id == id })?.label ?? "the selected Mac"
  }
}
