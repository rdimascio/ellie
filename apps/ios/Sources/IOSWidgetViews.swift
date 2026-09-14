import SwiftUI

extension WidgetKind {
    var iosName: String { rawValue.capitalized }
    var iosSymbol: String {
        switch self { case .clock: "clock"; case .note: "note.text"; case .weather: "cloud.sun"; case .calendar: "calendar"; case .chores: "checklist"; case .playlist: "play.rectangle" }
    }
}

struct IOSWidgetCard: View {
    let widget: DashboardWidget; let editing: Bool; let edit: () -> Void; let earlier: () -> Void; let later: () -> Void; let remove: () -> Void; let isFirst: Bool; let isLast: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Label(widget.title, systemImage: widget.type.iosSymbol).font(.headline); Spacer() }
            if widget.type == .clock { IOSClock(timeZone: widget.config["timeZone"]) }
            else if widget.type == .note {
                let text = widget.config["text"] ?? ""
                Button(action: edit) {
                    Text(text.isEmpty ? "Add a note" : text)
                        .frame(maxWidth: .infinity, minHeight: 80, alignment: .topLeading)
                        .multilineTextAlignment(.leading)
                }.buttonStyle(.plain).accessibilityIdentifier("note-\(widget.id)")
            } else { ContentUnavailableView("Not connected", systemImage: widget.type.iosSymbol, description: Text("This widget is ready for a future provider connection.")) }
            if editing {
                HStack {
                    Button("Earlier", systemImage: "arrow.up", action: earlier).disabled(isFirst)
                    Button("Later", systemImage: "arrow.down", action: later).disabled(isLast)
                    Spacer()
                    Button("Edit", systemImage: "slider.horizontal.3", action: edit)
                    Button("Remove", systemImage: "trash", role: .destructive, action: remove)
                }.labelStyle(.iconOnly)
            }
        }
        .padding().background(widget.type == .clock ? Color(red: 0.105, green: 0.12, blue: 0.15) : Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20))
        .foregroundStyle(widget.type == .clock ? Color.white : Color.primary)
        .accessibilityElement(children: .contain)
    }
}

private struct IOSClock: View {
    let timeZone: String?
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
            VStack(alignment: .leading, spacing: 6) {
                Text(DashboardModel.formattedTime(context.date, in: zone)).font(.system(size: 58, weight: .ultraLight)).minimumScaleFactor(0.6)
                Text(zone.identifier == TimeZone.current.identifier ? "Local time" : zone.identifier.replacingOccurrences(of: "_", with: " ")).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct IOSWidgetGallery: View {
    @Environment(\.dismiss) private var dismiss
    let add: (WidgetKind) -> Void
    var body: some View {
        NavigationStack {
            List(WidgetKind.allCases, id: \.self) { kind in
                Button { add(kind) } label: { Label("Add \(kind.iosName)", systemImage: kind.iosSymbol) }
            }.navigationTitle("Add a widget").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }.presentationDetents([.medium, .large])
    }
}

struct IOSWidgetEditor: View {
    @Environment(\.dismiss) private var dismiss
    let widget: DashboardWidget; let save: (String, WidgetSize, [String: String]) -> Void
    @State private var title: String; @State private var size: WidgetSize; @State private var note: String; @State private var zone: String
    init(widget: DashboardWidget, save: @escaping (String, WidgetSize, [String: String]) -> Void) {
        self.widget = widget; self.save = save
        _title = State(initialValue: widget.title); _size = State(initialValue: widget.size); _note = State(initialValue: widget.config["text"] ?? ""); _zone = State(initialValue: widget.config["timeZone"] ?? "")
    }
    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                Picker("Size", selection: $size) { Text("Small").tag(WidgetSize.small); Text("Wide").tag(WidgetSize.wide) }.pickerStyle(.segmented)
                if widget.type == .note { Section("Note") { TextEditor(text: $note).frame(minHeight: 180); Text("\(note.count) of 2,000 characters").font(.caption).foregroundStyle(.secondary) } }
                if widget.type == .clock { Section("Time zone") { TextField("Europe/London", text: $zone).textInputAutocapitalization(.never).autocorrectionDisabled(); Text("Leave blank for this iPhone’s time zone.") } }
            }
            .navigationTitle("Edit \(widget.type.iosName)").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { guard let config = try? DashboardModel.configAfterEditing(widget, note: note, timeZone: zone) else { return }; save(title, size, config) }.disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.utf16.count > 80 || note.utf16.count > 2_000 || (widget.type == .clock && !zone.isEmpty && TimeZone(identifier: zone) == nil)) }
            }
        }
    }
}
