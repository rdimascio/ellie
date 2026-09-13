import SwiftUI

struct PhoneControlView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var store: PhoneControlStore
  private let credential: NativeEnrollmentCredential

  init(credential: NativeEnrollmentCredential, store: PhoneControlStore? = nil) {
    self.credential = credential
    _store = StateObject(wrappedValue: store ?? PhoneControlStore(credential: credential))
  }

  var body: some View {
    Form {
      Section("Mac") {
        if store.nodes.isEmpty {
          Text("Refresh to load the Macs granted to this iPhone.")
            .foregroundStyle(.secondary)
        } else {
          Picker("Target", selection: $store.selectedNodeID) {
            Text("Choose a Mac").tag(String?.none)
            ForEach(store.nodes) { node in
              Text("\(node.label)\(node.online ? "" : " — Offline")").tag(Optional(node.id))
            }
          }
          .disabled(isBusy)
        }
        Button("Refresh Macs", systemImage: "arrow.clockwise") { store.refresh() }
          .disabled(isBusy)
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
          SpeechTurnView(credential: credential, controls: store)
        } label: {
          Label("Record a command", systemImage: "waveform")
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
    .navigationTitle("Mac controls")
    .onDisappear { store.cancel() }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { store.cancel() }
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

  private func nodeLabel(_ id: String) -> String {
    store.nodes.first(where: { $0.id == id })?.label ?? "the selected Mac"
  }
}
