import SwiftUI

extension WidgetKind {
  var displayName: String {
    switch self {
    case .clock: return "Clock"
    case .note: return "Note"
    case .weather: return "Weather"
    case .calendar: return "Calendar"
    case .chores: return "Chores"
    case .playlist: return "Playlist"
    }
  }
  var symbol: String {
    switch self {
    case .clock: return "clock"
    case .note: return "note.text"
    case .weather: return "cloud.sun"
    case .calendar: return "calendar"
    case .chores: return "checklist"
    case .playlist: return "play.rectangle"
    }
  }
  var summary: String {
    switch self {
    case .clock: return "The time, wherever home is."
    case .note: return "Keep a thought close by."
    case .weather: return "Current weather for a place you choose."
    case .calendar: return "Calendar connection coming next."
    case .chores: return "Local tasks for your household."
    case .playlist: return "A selected playlist that plays when you ask."
    }
  }
}

@MainActor
struct DashboardView: View {
  @Environment(\.openWindow) private var openWindow
  @ObservedObject var store: DashboardStore
  @ObservedObject var choresStore: ChoresStore
  @ObservedObject var weatherStore: WeatherStore
  @ObservedObject var agendaStore: AgendaStore
  @State private var editing = false
  @State private var gallery = false
  @State private var newDashboard = false
  @State private var renaming = false
  @State private var deleting = false
  @State private var name = ""
  @State private var editedWidget: DashboardWidget?
  @State private var showingChores = false

  var body: some View {
    NavigationSplitView {
      VStack(spacing: 0) {
        List(selection: $store.selectedID) {
          Section("Dashboards") {
            ForEach(store.state.dashboards) { dashboard in
              Label(
                dashboard.name,
                systemImage: dashboard.id == store.state.dashboards.first?.id
                  ? "house" : "rectangle.3.group"
              )
              .tag(dashboard.id)
              .contextMenu {
                Button("Rename…") {
                  store.selectedID = dashboard.id
                  name = dashboard.name
                  renaming = true
                }
                Button("Delete…", role: .destructive) {
                  store.selectedID = dashboard.id
                  deleting = true
                }
                .disabled(store.state.dashboards.count < 2)
              }
            }
          }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
          HStack {
            Button {
              name = ""
              newDashboard = true
            } label: {
              Label("New dashboard", systemImage: "plus")
            }
            .buttonStyle(.borderless)
            .help("Create a dashboard")
            Spacer()
            Menu {
              Button("Import…") { DashboardFiles.importFile(into: store) }
              Button("Export…") { DashboardFiles.exportFile(from: store) }
            } label: {
              Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help("Dashboard files")
          }
          .font(.system(size: 12))
          .padding(16)
          .background(.bar)
        }
      }
      .navigationSplitViewColumnWidth(min: 180, ideal: 220, max: 300)
    } detail: {
      if let dashboard = store.selectedDashboard {
        ScrollView {
          VStack(alignment: .leading, spacing: 30) {
            HStack(alignment: .bottom) {
              VStack(alignment: .leading, spacing: 8) {
                Text(dashboard.name)
                  .font(.system(size: 34, weight: .bold))
                  .tracking(-0.9)
                TimelineView(.periodic(from: .now, by: 60)) { context in
                  Text(context.date, format: .dateTime.weekday(.wide).month(.wide).day())
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary)
                }
              }
              Spacer()
              if editing {
                Button("Rename…") {
                  name = dashboard.name
                  renaming = true
                }
                .buttonStyle(.borderless)
              }
            }
            if dashboard.widgets.isEmpty {
              ContentUnavailableView {
                Label("A space of your own", systemImage: "rectangle.3.group")
              } description: {
                Text("Add a clock, a note, or a place for what comes next.")
              } actions: {
                Button("Add a widget") { gallery = true }
              }
              .frame(minHeight: 320)
            } else {
              ViewThatFits(in: .horizontal) {
                widgetRows(dashboard, columns: 2).frame(minWidth: 590)
                widgetRows(dashboard, columns: 1)
              }
            }
            HStack(spacing: 6) {
              Image(systemName: "internaldrive")
              Text("Saved on this Mac")
              Spacer()
              if editing { Text("Changes save automatically") }
            }
            .font(.system(size: 11))
            .foregroundStyle(.tertiary)
          }
          .padding(36)
          .frame(maxWidth: 1120)
          .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .navigationTitle(dashboard.name)
        .toolbar {
          ToolbarItemGroup {
            Button {
              openWindow(id: "devices")
            } label: {
              Label("Devices", systemImage: "desktopcomputer")
            }
            .help("Show connected Macs")
            Button {
              gallery = true
            } label: {
              Label("Add widget", systemImage: "plus")
            }
            .help("Add a widget")
            Button(editing ? "Done" : "Edit") { editing.toggle() }
              .keyboardShortcut("e", modifiers: .command)
              .help(editing ? "Finish editing" : "Edit dashboard")
            Menu {
              Button("Rename Dashboard…") {
                name = dashboard.name
                renaming = true
              }
              Button("Import Dashboards…") { DashboardFiles.importFile(into: store) }
              Button("Export Dashboards…") { DashboardFiles.exportFile(from: store) }
              Divider()
              Button("Delete Dashboard…", role: .destructive) { deleting = true }
                .disabled(store.state.dashboards.count < 2)
            } label: {
              Label("Dashboard options", systemImage: "ellipsis")
            }
          }
        }
      } else {
        ContentUnavailableView(
          "Create your first dashboard", systemImage: "rectangle.3.group",
          description: Text("Use the plus button in the sidebar to begin."))
      }
    }
    .sheet(isPresented: $gallery) {
      WidgetGallery { kind in
        store.addWidget(kind: kind)
        gallery = false
      }
    }
    .sheet(item: $editedWidget) { widget in
      WidgetInspector(widget: widget, weatherStore: weatherStore, agendaStore: agendaStore) {
        title, size, config in
        store.updateWidget(id: widget.id, title: title, size: size, config: config)
        if store.error == nil { editedWidget = nil }
      }
    }
    .sheet(isPresented: $showingChores) { ChoresSheet(store: choresStore) }
    .alert("New dashboard", isPresented: $newDashboard) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) {}
      Button("Create") { store.createDashboard(name: name) }.disabled(
        name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .alert("Rename dashboard", isPresented: $renaming) {
      TextField("Name", text: $name)
      Button("Cancel", role: .cancel) {}
      Button("Save") { if let id = store.selectedID { store.renameDashboard(id: id, name: name) } }
        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
    .confirmationDialog("Delete this dashboard?", isPresented: $deleting, titleVisibility: .visible)
    {
      Button("Delete dashboard", role: .destructive) {
        if let id = store.selectedID { store.deleteDashboard(id: id) }
      }
    } message: {
      Text(
        "Its widgets and notes will be removed from this Mac. Export a copy first if you want to keep them."
      )
    }
    .alert(
      "Couldn’t save this change",
      isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })
    ) {
      Button("OK", role: .cancel) { store.error = nil }
    } message: {
      Text(store.error ?? "")
    }
  }

  private func widgetRows(_ dashboard: Dashboard, columns: Int) -> some View {
    let rows = makeRows(dashboard.widgets, columns: columns)
    return VStack(spacing: 18) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack(alignment: .top, spacing: 18) {
          ForEach(row) { widget in
            NativeWidgetCard(
              widget: widget, choresStore: choresStore,
              openChores: { showingChores = true }, editing: editing,
              weatherStore: weatherStore, agendaStore: agendaStore,
              configure: { editedWidget = widget },
              earlier: { store.moveWidget(id: widget.id, offset: -1) },
              later: { store.moveWidget(id: widget.id, offset: 1) },
              remove: { store.removeWidget(id: widget.id) },
              isFirst: dashboard.widgets.first?.id == widget.id,
              isLast: dashboard.widgets.last?.id == widget.id
            )
            .frame(maxWidth: .infinity)
          }
          if columns == 2 && row.count == 1 && row[0].size == .small {
            Color.clear.frame(maxWidth: .infinity)
          }
        }
      }
      if editing {
        Button {
          gallery = true
        } label: {
          Label("Add a widget", systemImage: "plus.circle")
            .frame(maxWidth: .infinity).padding(22)
        }
        .buttonStyle(.borderless)
        .background(
          RoundedRectangle(cornerRadius: 18).strokeBorder(
            .quaternary, style: StrokeStyle(lineWidth: 1, dash: [5, 5])))
      }
    }
  }

  private func makeRows(_ widgets: [DashboardWidget], columns: Int) -> [[DashboardWidget]] {
    var rows: [[DashboardWidget]] = []
    for widget in widgets {
      if columns == 2 && widget.size == .small, let last = rows.last, last.count == 1,
        last[0].size == .small
      {
        rows[rows.count - 1].append(widget)
      } else {
        rows.append([widget])
      }
    }
    return rows
  }
}
