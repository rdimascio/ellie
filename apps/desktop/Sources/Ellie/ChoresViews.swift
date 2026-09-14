import Charts
import SwiftUI

struct ChoresWidgetContent: View {
    @ObservedObject var store: ChoresStore
    let open: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let today = ChoreDay.from(context.date, timeZone: store.timeZone)
            let chores = store.chores(on: today)
            VStack(alignment: .leading, spacing: 12) {
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption).foregroundStyle(.red).lineLimit(3)
                }
                if chores.isEmpty {
                    Spacer(minLength: 0)
                    Text("Nothing due today").font(.system(size: 19, weight: .medium))
                    Text("Add a dated household task.").font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                } else {
                    Text("\(store.remaining(on: today).count) remaining today")
                        .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                    ForEach(chores.prefix(3)) { chore in
                        Button { store.setCompleted(id: chore.id, completed: chore.completedDay == nil) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: chore.completedDay == nil ? "circle" : "checkmark.circle.fill")
                                    .foregroundStyle(chore.completedDay == nil ? Color.secondary : Color.green)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(chore.title).strikethrough(chore.completedDay != nil).lineLimit(1)
                                    Text(chore.member).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer()
                            }.contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(chore.completedDay == nil ? "Complete" : "Undo") \(chore.title), assigned to \(chore.member)")
                    }
                    if chores.count > 3 { Text("\(chores.count - 3) more").font(.caption).foregroundStyle(.secondary) }
                }
                Button("Manage chores…", action: open).buttonStyle(.link)
            }
            .frame(maxWidth: .infinity, minHeight: 155, alignment: .leading)
        }
    }
}

struct ChoresSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: ChoresStore
    @State private var showingAdd = false
    @State private var deleting: Chore?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ChoresWeekChart(store: store).padding([.horizontal, .top], 24)
                ScrollView {
                    LazyVStack(spacing: 0) {
                        let ordered = orderedChores
                        if ordered.isEmpty {
                            ContentUnavailableView("No chores yet", systemImage: "checklist", description: Text("Add a task, person, and due day."))
                                .frame(minHeight: 220)
                        } else {
                            ForEach(ordered) { chore in
                                HStack(spacing: 12) {
                                    Button { store.setCompleted(id: chore.id, completed: chore.completedDay == nil) } label: {
                                        Image(systemName: chore.completedDay == nil ? "circle" : "checkmark.circle.fill")
                                            .foregroundStyle(chore.completedDay == nil ? Color.secondary : Color.green)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(chore.completedDay == nil ? "Complete \(chore.title)" : "Undo completion of \(chore.title)")
                                    .accessibilityIdentifier("chore-completion-\(chore.id)")
                                    .focusable(interactions: .activate)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(chore.title).strikethrough(chore.completedDay != nil)
                                        if !chore.body.isEmpty { Text(chore.body).font(.caption).lineLimit(2) }
                                        Text("\(chore.member) · Due \(formatted(chore.dueDay))")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button(role: .destructive) { deleting = chore } label: { Image(systemName: "trash") }
                                        .buttonStyle(.borderless).help("Delete \(chore.title)")
                                        .accessibilityLabel("Delete \(chore.title)")
                                        .accessibilityIdentifier("chore-delete-\(chore.id)")
                                        .focusable(interactions: .activate)
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 8)
                                if chore.id != ordered.last?.id { Divider().padding(.leading, 52) }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Chores")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button { showingAdd = true } label: { Label("Add chore", systemImage: "plus") } }
            }
        }
        .frame(minWidth: 640, minHeight: 560)
        .sheet(isPresented: $showingAdd) { AddChoreSheet(store: store) }
        .confirmationDialog("Delete \(deleting?.title ?? "this chore")?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete chore", role: .destructive) { if let deleting { store.delete(id: deleting.id) }; deleting = nil }
            Button("Cancel", role: .cancel) { deleting = nil }
        } message: { Text("This removes the task and its completion from this Mac.") }
        .alert("Couldn’t save this change", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("OK", role: .cancel) { store.error = nil }
        } message: { Text(store.error ?? "") }
    }

    private func formatted(_ day: ChoreDay) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = store.timeZone
        formatter.setLocalizedDateFormatFromTemplate("EEE MMM d")
        return formatter.string(from: day.date(in: store.timeZone))
    }

    private var orderedChores: [Chore] {
        store.state.chores.sorted {
            if $0.dueDay != $1.dueDay { return $0.dueDay < $1.dueDay }
            if ($0.completedDay != nil) != ($1.completedDay != nil) { return $0.completedDay == nil }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }
}

private struct ChoresWeekChart: View {
    @ObservedObject var store: ChoresStore
    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let today = ChoreDay.from(context.date, timeZone: store.timeZone)
            let values = store.completionsByDay(forWeekContaining: today)
            VStack(alignment: .leading, spacing: 8) {
                Text("Completed this week").font(.headline)
                Chart(values, id: \.day) { value in
                    BarMark(x: .value("Day", value.day.value), y: .value("Completed", value.count))
                        .foregroundStyle(value.day == today ? Color.accentColor : Color.secondary.opacity(0.45))
                }
                .chartXAxis {
                    AxisMarks(values: values.map(\.day.value)) { mark in
                        AxisGridLine()
                        AxisTick()
                        if let raw = mark.as(String.self), let day = try? ChoreDay(raw) { AxisValueLabel(weekday(day)) }
                    }
                }
                .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
                .frame(height: 130)
                Text("Monday–Sunday · \(store.state.householdTimeZone.replacingOccurrences(of: "_", with: " "))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func weekday(_ day: ChoreDay) -> String {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.setLocalizedDateFormatFromTemplate("EEEEE")
        return formatter.string(from: day.date(in: TimeZone(secondsFromGMT: 0)!))
    }
}

private struct AddChoreSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: ChoresStore
    @State private var title = ""
    @State private var member = ""
    @State private var details = ""
    @State private var dueDate: Date

    init(store: ChoresStore) {
        self.store = store
        _dueDate = State(initialValue: Date())
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Add chore").font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(24)
            Form {
                TextField("Task", text: $title).accessibilityLabel("Chore title")
                TextField("Assigned to", text: $member).accessibilityLabel("Household member")
                TextField("Details (optional)", text: $details, axis: .vertical).lineLimit(2...4)
                DatePicker("Due day", selection: $dueDate, displayedComponents: .date)
                    .environment(\.timeZone, store.timeZone)
                Text("The due day uses \(store.state.householdTimeZone.replacingOccurrences(of: "_", with: " ")).")
                    .font(.caption).foregroundStyle(.secondary)
            }.formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Add") {
                    store.add(title: title, member: member, body: details, dueDay: ChoreDay.from(dueDate, timeZone: store.timeZone))
                    if store.error == nil { dismiss() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!valid)
            }.padding(20)
        }.frame(width: 440)
    }

    private var valid: Bool {
        let cleanTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanMember = member.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanDetails = details.trimmingCharacters(in: .whitespacesAndNewlines)
        return title == cleanTitle && member == cleanMember && details == cleanDetails && !title.isEmpty && !member.isEmpty
            && title.utf16.count <= ChoresModel.maximumTitleLength && member.utf16.count <= ChoresModel.maximumMemberLength
            && details.utf16.count <= ChoresModel.maximumBodyLength
    }
}
