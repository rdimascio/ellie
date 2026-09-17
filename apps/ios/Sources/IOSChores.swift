import Charts
import SwiftUI

@MainActor
struct IOSChoresWidget: View {
    @ObservedObject var store: ChoresStore
    @State private var managing = false

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let today = ChoreDay.from(context.date, timeZone: store.timeZone)
            let due = store.chores(on: today)
            VStack(alignment: .leading, spacing: 10) {
                Text("Saved on this iPhone only · Not synced")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text(due.isEmpty ? "Nothing due today" : "\(store.remaining(on: today).count) remaining today")
                    .font(.subheadline.weight(.semibold))
                ForEach(due.prefix(2)) { chore in
                    Button { store.setCompleted(id: chore.id, completed: chore.completedDay == nil) } label: {
                        Label {
                            Text("\(chore.title) · \(chore.member)")
                                .lineLimit(2)
                        } icon: {
                            Image(systemName: chore.completedDay == nil ? "circle" : "checkmark.circle.fill")
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(chore.completedDay == nil ? "Complete \(chore.title)" : "Undo completion of \(chore.title)")
                    .accessibilityIdentifier("ios-chore-widget-toggle-\(chore.id)")
                }
                Button("Manage chores") { managing = true }
                    .accessibilityIdentifier("ios-manage-chores")
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $managing) { IOSChoresSheet(store: store) }
    }
}

private struct ChoreFormRoute: Identifiable {
    let id = UUID()
    let chore: Chore?
}

@MainActor
struct IOSChoresSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: ChoresStore
    @State private var form: ChoreFormRoute?
    @State private var deleting: Chore?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("These chores are saved privately on this iPhone. They do not sync with other devices or your household.")
                        .font(.caption).foregroundStyle(.secondary)
                    if let error = store.error {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.caption).foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Section("Completed this week") {
                    IOSChoresWeekChart(store: store)
                }
                Section("Tasks") {
                    if orderedChores.isEmpty {
                        ContentUnavailableView("No chores yet", systemImage: "checklist",
                            description: Text("Add a task, assignee, and due day."))
                    }
                    ForEach(orderedChores) { chore in
                        HStack(spacing: 12) {
                            Button { store.setCompleted(id: chore.id, completed: chore.completedDay == nil) } label: {
                                Image(systemName: chore.completedDay == nil ? "circle" : "checkmark.circle.fill")
                                    .font(.title3)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(chore.completedDay == nil ? "Complete \(chore.title)" : "Undo completion of \(chore.title)")
                            .accessibilityIdentifier("ios-chore-toggle-\(chore.id)")
                            Button { form = ChoreFormRoute(chore: chore) } label: {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(chore.title).strikethrough(chore.completedDay != nil)
                                    Text("\(chore.member) · Due \(chore.dueDay.value)")
                                        .font(.caption).foregroundStyle(.secondary)
                                    if !chore.body.isEmpty {
                                        Text(chore.body).font(.caption).foregroundStyle(.secondary)
                                            .lineLimit(2)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Edit \(chore.title)")
                            .accessibilityValue("\(chore.member) · Due \(chore.dueDay.value)")
                            .accessibilityIdentifier("ios-chore-edit-\(chore.id)")
                            Button(role: .destructive) { deleting = chore } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Delete \(chore.title)")
                            .accessibilityIdentifier("ios-chore-delete-\(chore.id)")
                        }
                    }
                }
            }
            .navigationTitle("Chores")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { form = ChoreFormRoute(chore: nil) } label: { Label("Add chore", systemImage: "plus") }
                        .accessibilityIdentifier("ios-chore-add")
                }
            }
        }
        .sheet(item: $form) { route in IOSChoreEditor(store: store, chore: route.chore) }
        .confirmationDialog("Delete \(deleting?.title ?? "this chore")?", isPresented: Binding(
            get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
                Button("Delete chore", role: .destructive) {
                    if let deleting { store.delete(id: deleting.id) }
                    deleting = nil
                }
                Button("Cancel", role: .cancel) { deleting = nil }
            } message: { Text("This removes the task and its completion from this iPhone.") }
    }

    private var orderedChores: [Chore] {
        store.state.chores.sorted {
            if $0.dueDay != $1.dueDay { return $0.dueDay < $1.dueDay }
            if ($0.completedDay != nil) != ($1.completedDay != nil) { return $0.completedDay == nil }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }
}

@MainActor
private struct IOSChoresWeekChart: View {
    @ObservedObject var store: ChoresStore

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let today = ChoreDay.from(context.date, timeZone: store.timeZone)
            let values = store.completionsByDay(forWeekContaining: today)
            VStack(alignment: .leading, spacing: 6) {
                Chart(values, id: \.day) { value in
                    BarMark(x: .value("Day", value.day.value), y: .value("Completed", value.count))
                        .foregroundStyle(value.day == today ? Color.accentColor : Color.secondary.opacity(0.5))
                }
                .frame(height: 130)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Completed this week: " + values.map { "\($0.day.value), \($0.count)" }.joined(separator: "; "))
                Text("Monday–Sunday · \(store.state.householdTimeZone.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityIdentifier("ios-chores-week-chart")
        }
    }
}

@MainActor
private struct IOSChoreEditor: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: ChoresStore
    let chore: Chore?
    @State private var title: String
    @State private var member: String
    @State private var details: String
    @State private var dueDate: Date

    init(store: ChoresStore, chore: Chore?) {
        self.store = store
        self.chore = chore
        _title = State(initialValue: chore?.title ?? "")
        _member = State(initialValue: chore?.member ?? "")
        _details = State(initialValue: chore?.body ?? "")
        _dueDate = State(initialValue: chore?.dueDay.date(in: store.timeZone) ?? Date())
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Task", text: $title)
                    .accessibilityIdentifier("ios-chore-title")
                TextField("Assigned to", text: $member)
                    .accessibilityIdentifier("ios-chore-assignee")
                TextField("Details (optional)", text: $details, axis: .vertical)
                    .lineLimit(2...4)
                    .accessibilityIdentifier("ios-chore-details")
                DatePicker("Due day", selection: $dueDate, displayedComponents: .date)
                    .environment(\.timeZone, store.timeZone)
                    .accessibilityIdentifier("ios-chore-due-day")
                Text("Due dates and completion days use \(store.state.householdTimeZone.replacingOccurrences(of: "_", with: " ")).")
                    .font(.caption).foregroundStyle(.secondary)
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .font(.caption).foregroundStyle(.red)
                }
            }
            .navigationTitle(chore == nil ? "Add chore" : "Edit chore")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let day = ChoreDay.from(dueDate, timeZone: store.timeZone)
                        if let chore {
                            store.update(id: chore.id, title: title, member: member, body: details, dueDay: day)
                        } else {
                            store.add(title: title, member: member, body: details, dueDay: day)
                        }
                        if store.error == nil { dismiss() }
                    }
                    .disabled(!valid)
                    .accessibilityIdentifier("ios-chore-save")
                }
            }
        }
    }

    private var valid: Bool {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanMember = member.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        return title == cleanTitle && member == cleanMember && details == cleanDetails
            && !title.isEmpty && !member.isEmpty
            && title.utf16.count <= ChoresModel.maximumTitleLength
            && member.utf16.count <= ChoresModel.maximumMemberLength
            && details.utf16.count <= ChoresModel.maximumBodyLength
    }
}
