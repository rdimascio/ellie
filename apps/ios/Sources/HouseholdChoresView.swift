import SwiftUI

private struct HouseholdChoreForm: Identifiable {
  let id = UUID()
  let chore: Chore?
}

struct HouseholdChoresView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var sync: HouseholdChoresSyncStore
  @State private var form: HouseholdChoreForm?
  @State private var deleting: Chore?
  @State private var discarding = false
  @State private var showingFullCopy = false

  init(
    credential: NativeEnrollmentCredential,
    sync: HouseholdChoresSyncStore? = nil
  ) {
    _sync = StateObject(wrappedValue: sync ?? HouseholdChoresSyncStore(credential: credential))
  }

  var body: some View {
    List {
      Section {
        Text("Household chores are separate from chores saved on this iPhone. Access requires an explicit shared-chores grant from the coordinator.")
          .font(.footnote).foregroundStyle(.secondary)
        Button("Check Household Chore Access") { sync.checkAccess() }
          .disabled(sync.isBusy || sync.phase == .privacyBlocked || sync.phase == .orphanedPending)
          .accessibilityIdentifier("ios-household-chores-access")
        if sync.canRead {
          LabeledContent("Access", value: sync.canWrite ? "Read and write" : "Read only")
          Button("Read Current Household Chores") { sync.readServerCopy() }
            .disabled(sync.isBusy || sync.draft != nil)
            .accessibilityIdentifier("ios-household-chores-read")
        }
      }

      if let remote = sync.remote {
        Section("Household copy · revision \(remote.revision)") {
          if remote.value.chores.isEmpty { Text("No household chores yet") }
          ForEach(remote.value.chores.sorted(by: choreOrder)) { chore in
            HStack(spacing: 10) {
              Button {
                sync.prepareCompletion(id: chore.id, completed: chore.completedDay == nil)
              } label: {
                Image(systemName: chore.completedDay == nil ? "circle" : "checkmark.circle.fill")
                  .frame(width: 44, height: 44)
              }
              .buttonStyle(.plain)
              .disabled(!canPrepare)
              .accessibilityLabel(chore.completedDay == nil
                ? "Prepare completion of \(chore.title)" : "Prepare undo of \(chore.title)")
              VStack(alignment: .leading, spacing: 3) {
                Text(chore.title).strikethrough(chore.completedDay != nil)
                Text("\(chore.member) · Due \(chore.dueDay.value)")
                  .font(.caption).foregroundStyle(.secondary)
                if !chore.body.isEmpty {
                  Text(chore.body).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
              }
              Spacer(minLength: 0)
              Button("Edit") { form = HouseholdChoreForm(chore: chore) }
                .disabled(!canPrepare)
              Button(role: .destructive) { deleting = chore } label: {
                Image(systemName: "trash")
              }
              .disabled(!canPrepare)
              .accessibilityLabel("Prepare deletion of \(chore.title)")
            }
          }
          if sync.canWrite {
            Button("Add Household Chore") { form = HouseholdChoreForm(chore: nil) }
              .disabled(!canPrepare)
              .accessibilityIdentifier("ios-household-chores-add")
          }
        }

      }

      if let draft = sync.draft {
        Section("Review household change") {
          ForEach(changedChores) { chore in
            proposedRow(chore, label: changeLabel(chore) ?? "Proposed household chore")
          }
          ForEach(removedChores) { chore in
            Text("Remove \(chore.title) · \(chore.member)")
              .font(.caption.weight(.semibold)).foregroundStyle(.red)
          }
          if sync.remote == nil {
            Text("The previous server copy is unavailable here. Check Result to compare; no change will be resent.")
              .font(.footnote).foregroundStyle(.secondary)
          }
          Button("Save Prepared Change Once") { sync.savePrepared() }
            .disabled(!sync.canSave)
            .accessibilityIdentifier("ios-household-chores-save")
          if sync.phase != .prepared {
            Button("Check Result Without Resending") { sync.checkResult() }
              .disabled(sync.isBusy)
              .accessibilityIdentifier("ios-household-chores-check-result")
          }
          if sync.phase == .prepared {
            Button("Cancel Prepared Change", role: .cancel) { sync.discardPending() }
              .disabled(sync.isBusy)
          } else {
            Button("Discard Pending Change", role: .destructive) { discarding = true }
              .disabled(sync.isBusy)
          }
          DisclosureGroup("Full proposed household copy (\(draft.value.chores.count))",
            isExpanded: $showingFullCopy) {
            ForEach(draft.value.chores.sorted(by: choreOrder)) { chore in
              proposedRow(chore, label: nil)
            }
          }
          Text("Based on revision \(draft.baseRevision). One conditional save replaces that revision only if it is still current.")
            .font(.footnote).foregroundStyle(.secondary)
        }
      }

      status
    }
    .ellieScreen()
    .navigationTitle("Household Chores")
    .sheet(item: $form) { item in
      HouseholdChoreEditor(sync: sync, chore: item.chore,
        timeZone: TimeZone(identifier: sync.remote?.value.householdTimeZone ?? "UTC")
          ?? TimeZone(secondsFromGMT: 0)!)
    }
    .confirmationDialog("Prepare deletion of \(deleting?.title ?? "this chore")?",
      isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
      Button("Prepare deletion", role: .destructive) {
        if let deleting { sync.prepareDelete(id: deleting.id) }
        deleting = nil
      }
      Button("Cancel", role: .cancel) { deleting = nil }
    } message: { Text("You will review the revised household copy before one save request.") }
    .confirmationDialog("Discard prepared household change?", isPresented: $discarding) {
      Button("Discard", role: .destructive) { sync.discardPending() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("An earlier save may have succeeded. Read the current household copy after discarding before preparing another change.")
    }
    .onChange(of: scenePhase) { _, phase in if phase == .background { sync.enterBackground() } }
    .onDisappear { sync.leaveView() }
  }

  private var canPrepare: Bool {
    sync.canWrite && sync.remote != nil && sync.draft == nil && !sync.isBusy
      && sync.phase != .privacyBlocked
  }

  @ViewBuilder private var status: some View {
    switch sync.phase {
    case .loading:
      Section {
        ProgressView("Reading…")
        Button("Cancel Read") { sync.cancelCurrentRequest() }
          .accessibilityIdentifier("ios-household-chores-cancel")
      }
    case .saving:
      Section {
        ProgressView("Saving once…")
        Button("Cancel Save", role: .destructive) { sync.cancelCurrentRequest() }
          .accessibilityIdentifier("ios-household-chores-cancel")
        Text("Cancellation can leave the result unknown. Ellie will not resend the change.")
          .font(.footnote).foregroundStyle(.secondary)
      }
    case .conflict(let revision):
      Section {
        Label("The household copy is now at revision \(revision). Your prepared change is unchanged.",
          systemImage: "arrow.triangle.branch")
        Text("Check Result to compare copies, then discard and prepare a new change from a fresh read. Nothing is merged or resent automatically.")
          .font(.footnote).foregroundStyle(.secondary)
      }
    case .unknown:
      Section { Label("The save outcome is unknown. Check Result; Ellie will not send it again.",
        systemImage: "questionmark.circle") }
    case .matchedCurrentCopy(let revision):
      Section { Label("Revision \(revision) currently matches the prepared copy. This does not prove which client saved it.",
        systemImage: "equal.circle") }
    case .orphanedPending:
      Section {
        Label("A pending chore change belongs to a different coordinator enrollment.",
          systemImage: "lock.trianglebadge.exclamationmark")
        Button("Discard Saved Pending Change", role: .destructive) { discarding = true }
      }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked: Section { Label("Household chore access is not granted. Connected copies were cleared.",
      systemImage: "lock.slash") }
    case .privacyBlocked:
      Section {
        Label(ChoresSyncFailure.cacheUnavailable.localizedDescription,
          systemImage: "externaldrive.badge.exclamationmark")
        Button("Retry Clearing Sync Data", role: .destructive) { sync.retryPrivacyCleanup() }
      }
    case .idle, .ready, .prepared: EmptyView()
    }
  }

  private func choreOrder(_ lhs: Chore, _ rhs: Chore) -> Bool {
    if lhs.dueDay != rhs.dueDay { return lhs.dueDay < rhs.dueDay }
    return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
  }

  private func changeLabel(_ chore: Chore) -> String? {
    guard let old = sync.remote?.value.chores.first(where: { $0.id == chore.id }) else {
      return sync.remote == nil ? nil : "New household chore"
    }
    return old == chore ? nil : "Changed household chore"
  }

  private var removedChores: [Chore] {
    guard let remote = sync.remote, let draft = sync.draft else { return [] }
    let proposedIDs = Set(draft.value.chores.map(\.id))
    return remote.value.chores.filter { !proposedIDs.contains($0.id) }.sorted(by: choreOrder)
  }

  private var changedChores: [Chore] {
    guard let remote = sync.remote, let draft = sync.draft else { return [] }
    let old = Dictionary(uniqueKeysWithValues: remote.value.chores.map { ($0.id, $0) })
    return draft.value.chores.filter { old[$0.id] != $0 }.sorted(by: choreOrder)
  }

  private func proposedRow(_ chore: Chore, label: String?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      if let label {
        Text(label).font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
      }
      Text("\(chore.title) · \(chore.member) · Due \(chore.dueDay.value)")
      if !chore.body.isEmpty { Text(chore.body).font(.caption) }
      if let completed = chore.completedDay {
        Text("Completed \(completed.value)").font(.caption)
      }
    }
  }
}

private struct HouseholdChoreEditor: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject var sync: HouseholdChoresSyncStore
  let chore: Chore?
  let timeZone: TimeZone
  @State private var title: String
  @State private var member: String
  @State private var details: String
  @State private var dueDate: Date

  init(sync: HouseholdChoresSyncStore, chore: Chore?, timeZone: TimeZone) {
    self.sync = sync
    self.chore = chore
    self.timeZone = timeZone
    _title = State(initialValue: chore?.title ?? "")
    _member = State(initialValue: chore?.member ?? "")
    _details = State(initialValue: chore?.body ?? "")
    _dueDate = State(initialValue: chore?.dueDay.date(in: timeZone) ?? Date())
  }

  var body: some View {
    NavigationStack {
      Form {
        TextField("Task", text: $title)
        TextField("Assigned to", text: $member)
        TextField("Details (optional)", text: $details, axis: .vertical).lineLimit(2...4)
        DatePicker("Due day", selection: $dueDate, displayedComponents: .date)
          .environment(\.timeZone, timeZone)
        Text("The change is prepared privately first. Saving it is a separate, single request.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      .navigationTitle(chore == nil ? "Add Household Chore" : "Edit Household Chore")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Prepare") {
            let day = ChoreDay.from(dueDate, timeZone: timeZone)
            let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanMember = member.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
            if let chore {
              sync.prepareEdit(id: chore.id, title: cleanTitle, member: cleanMember,
                body: cleanDetails, dueDay: day)
            } else {
              sync.prepareAdd(title: cleanTitle, member: cleanMember, body: cleanDetails,
                dueDay: day)
            }
            if sync.phase == .prepared { dismiss() }
          }
          .disabled(!valid)
        }
      }
    }
  }

  private var valid: Bool {
    let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanMember = member.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
    return !cleanTitle.isEmpty && !cleanMember.isEmpty
      && cleanTitle.utf16.count <= ChoresModel.maximumTitleLength
      && cleanMember.utf16.count <= ChoresModel.maximumMemberLength
      && cleanDetails.utf16.count <= ChoresModel.maximumBodyLength
  }
}
