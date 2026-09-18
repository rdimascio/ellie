import SwiftUI

struct DashboardSyncView: View {
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject var dashboards: DashboardStore
  @StateObject private var sync: DashboardSyncStore
  @State private var replacing = false

  init(
    credential: NativeEnrollmentCredential, dashboards: DashboardStore,
    sync: DashboardSyncStore? = nil
  ) {
    self.dashboards = dashboards
    _sync = StateObject(wrappedValue: sync ?? DashboardSyncStore(credential: credential))
  }

  var body: some View {
    Form {
      Section {
        Text("Dashboards on this iPhone stay local until you choose an action here.")
          .foregroundStyle(.secondary)
        Button("Check Dashboard Access") { sync.checkAccess() }
          .disabled(isBusy || sync.phase == .privacyBlocked)
      }

      if !sync.grants.isEmpty {
        Section("Destination") {
          Picker("Profile", selection: Binding(get: { sync.profile }, set: sync.select)) {
            ForEach(sync.allowedProfiles) { profile in Text(profile.title).tag(profile) }
          }
          .disabled(isBusy || sync.draft != nil)
          if sync.profile == .private {
            Text("Private means this enrollment only. Re-pairing creates a different private profile.")
              .font(.footnote).foregroundStyle(.secondary)
          }
          Button("Read Server Copy") { sync.readServerCopy() }
            .disabled(isBusy || !sync.allowedProfiles.contains(sync.profile))
        }
      }

      Section("Local copy") {
        LabeledContent("Dashboards", value: "\(dashboards.state.dashboards.count)")
        Button("Prepare This Local Copy") { sync.prepare(dashboards.state) }
          .disabled(isBusy || sync.draft != nil || !canWrite || sync.phase == .privacyBlocked)
        Text("Preparing freezes a private pending copy before any save request is sent.")
          .font(.footnote).foregroundStyle(.secondary)
      }

      if let remote = sync.remote {
        Section("Server copy") {
          LabeledContent("Revision", value: "\(remote.revision)")
          LabeledContent("Dashboards", value: "\(remote.value.dashboards.count)")
          ForEach(remote.value.dashboards.prefix(12)) { dashboard in Text(dashboard.name) }
          Button("Replace Dashboards on This iPhone…", role: .destructive) { replacing = true }
            .disabled(isBusy)
        }
      }

      if let draft = sync.draft {
        Section("Prepared copy") {
          LabeledContent("Profile", value: draft.profile.title)
          LabeledContent("Based on revision", value: "\(draft.baseRevision)")
          LabeledContent("Dashboards", value: "\(draft.value.dashboards.count)")
          Button("Save Prepared Copy") { sync.savePrepared() }.disabled(!sync.canSave)
          Button("Check Save Result") { sync.checkSaveResult() }.disabled(isBusy)
          if sync.remote?.profile == draft.profile {
            Button("Use Current Revision for Prepared Copy") { sync.useCurrentRevisionForDraft() }
              .disabled(isBusy)
          }
          Button("Discard Prepared Copy", role: .destructive) { sync.discardDraft() }
            .disabled(isBusy)
        }
      }

      status
    }
    .ellieScreen()
    .navigationTitle("Dashboard Sync")
    .confirmationDialog(
      "Replace local dashboards?", isPresented: $replacing, titleVisibility: .visible
    ) {
      Button("Replace Local Dashboards", role: .destructive) {
        guard let remote = sync.remote, let data = try? DashboardModel.encode(remote.value) else { return }
        dashboards.importData(data)
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This replaces the dashboard file on this iPhone after validating and saving it atomically.")
    }
    .onChange(of: scenePhase) { _, phase in if phase == .background { sync.enterBackground() } }
    .onDisappear { sync.leaveView() }
  }

  private var isBusy: Bool { sync.phase == .loading || sync.phase == .saving }
  private var canWrite: Bool {
    sync.grants.contains {
      $0.profile == sync.profile && $0.kind == "dashboards" && $0.access == .write
    }
  }

  @ViewBuilder private var status: some View {
    switch sync.phase {
    case .loading: Section { ProgressView("Reading…") }
    case .saving: Section { ProgressView("Saving once…") }
    case .conflict(let revision):
      Section { Label("The server is now at revision \(revision). Your prepared copy is unchanged.", systemImage: "arrow.triangle.branch") }
    case .unknown:
      Section { Label("The save outcome is unknown. Check the result; Ellie will not send it again.", systemImage: "questionmark.circle") }
    case .matchedCurrentCopy(let revision):
      Section { Label("Revision \(revision) currently matches your prepared copy. This does not prove which client saved it.", systemImage: "equal.circle") }
    case .orphanedPending:
      Section {
        Label("A pending dashboard save belongs to a different coordinator enrollment.", systemImage: "lock.trianglebadge.exclamationmark")
        Text("This enrollment cannot read or send that private copy. Discard it explicitly to start dashboard sync with this enrollment.")
          .font(.footnote).foregroundStyle(.secondary)
        Button("Discard Saved Pending Copy", role: .destructive) {
          sync.discardOrphanedPending()
        }
      }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked: Section { Label("Dashboard access was revoked. Sync-only cached data was cleared.", systemImage: "lock.slash") }
    case .privacyBlocked:
      Section {
        Label(DashboardSyncFailure.cacheUnavailable.localizedDescription, systemImage: "externaldrive.badge.exclamationmark")
        Button("Retry Clearing Sync Data", role: .destructive) { sync.retryPrivacyCleanup() }
      }
    case .idle, .ready, .prepared: EmptyView()
    }
  }
}
