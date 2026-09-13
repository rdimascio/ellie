import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct IOSDashboardList: View {
    @ObservedObject var store: DashboardStore
    @ObservedObject var enrollment: NativeEnrollmentStore
    @State private var creating = false
    @State private var name = ""
    @State private var importing = false
    @State private var exporting = false
    @State private var exportDocument: DashboardExportDocument?
    @State private var pendingImport: Data?
    @State private var confirmingImport = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.state.dashboards) { dashboard in
                        NavigationLink {
                            IOSDashboardDetail(store: store, dashboardID: dashboard.id)
                        } label: {
                            Label(dashboard.name, systemImage: dashboard.id == store.state.dashboards.first?.id ? "house" : "rectangle.3.group")
                        }
                        .accessibilityIdentifier("dashboard-\(dashboard.id)")
                    }
                } header: { Text("Dashboards") }
                footer: { Text("Layouts and notes stay on this iPhone until you export them.") }
                Section("Coordinator") {
                    NavigationLink { NativeEnrollmentView(store: enrollment) } label: { Label("Pair this iPhone", systemImage: "link") }
                }
            }
            .navigationTitle("Ellie")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Button("Import Dashboards", systemImage: "square.and.arrow.down") { importing = true }
                        Button("Export Dashboards", systemImage: "square.and.arrow.up") { prepareExport() }
                    } label: { Label("Dashboard files", systemImage: "ellipsis.circle") }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { name = ""; creating = true } label: { Label("New dashboard", systemImage: "plus") }
                        .accessibilityIdentifier("new-dashboard")
                }
            }
        }
        .alert("New dashboard", isPresented: $creating) {
            TextField("Name", text: $name).accessibilityIdentifier("dashboard-name")
            Button("Cancel", role: .cancel) {}
            Button("Create") { store.createDashboard(name: name) }
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json], allowsMultipleSelection: false) { result in
            do {
                guard let url = try result.get().first else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values.isRegularFile == true, (values.fileSize ?? .max) <= DashboardModel.maximumSerializedBytes else {
                    throw CocoaError(.fileReadTooLarge)
                }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: DashboardModel.maximumSerializedBytes + 1) ?? Data()
                guard data.count <= DashboardModel.maximumSerializedBytes else { throw CocoaError(.fileReadTooLarge) }
                _ = try DashboardModel.decode(data)
                pendingImport = data
                confirmingImport = true
            } catch { store.error = "This file is not a valid Ellie dashboard export. Your dashboards are unchanged." }
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .json, defaultFilename: "Ellie Dashboards") { result in
            if case .failure = result { store.error = "The dashboard export could not be saved. Choose another location and try again." }
            exportDocument = nil
        }
        .alert("Couldn’t complete that change", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
            Button("OK", role: .cancel) { store.error = nil }
        } message: { Text(store.error ?? "") }
        .confirmationDialog("Replace your dashboards?", isPresented: $confirmingImport, titleVisibility: .visible) {
            Button("Replace Dashboards", role: .destructive) {
                if let pendingImport { store.importData(pendingImport) }
                pendingImport = nil
            }
            Button("Cancel", role: .cancel) { pendingImport = nil }
        } message: {
            Text("Importing replaces every dashboard and note saved on this iPhone.")
        }
    }

    private func prepareExport() {
        do { exportDocument = DashboardExportDocument(data: try store.exportData()); exporting = true }
        catch { store.error = "Dashboards could not be prepared for export." }
    }
}

@MainActor
private struct IOSDashboardDetail: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var store: DashboardStore
    let dashboardID: String
    @State private var editing = false
    @State private var adding = false
    @State private var renaming = false
    @State private var deleting = false
    @State private var name = ""
    @State private var editedWidget: DashboardWidget?

    private var dashboard: Dashboard? { store.state.dashboards.first { $0.id == dashboardID } }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                if let dashboard {
                    ForEach(dashboard.widgets) { widget in
                        IOSWidgetCard(widget: widget, editing: editing,
                            edit: { editedWidget = widget },
                            earlier: { select(); store.moveWidget(id: widget.id, offset: -1) },
                            later: { select(); store.moveWidget(id: widget.id, offset: 1) },
                            remove: { select(); store.removeWidget(id: widget.id) },
                            isFirst: dashboard.widgets.first?.id == widget.id,
                            isLast: dashboard.widgets.last?.id == widget.id)
                    }
                    if dashboard.widgets.isEmpty {
                        ContentUnavailableView("A space of your own", systemImage: "rectangle.3.group", description: Text("Add a clock or a note to begin."))
                            .padding(.top, 80)
                    }
                }
            }
            .padding()
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle(dashboard?.name ?? "Dashboard")
        .navigationBarTitleDisplayMode(.large)
        .onAppear(perform: select)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { adding = true } label: { Label("Add widget", systemImage: "plus") }
                Button(editing ? "Done" : "Edit") { editing.toggle() }.accessibilityIdentifier("edit-dashboard")
                Menu {
                    Button("Rename Dashboard") { name = dashboard?.name ?? ""; renaming = true }
                    Button("Delete Dashboard", role: .destructive) { deleting = true }
                        .disabled(store.state.dashboards.count < 2)
                } label: { Label("Dashboard options", systemImage: "ellipsis") }
                    .accessibilityIdentifier("dashboard-options")
            }
        }
        .sheet(isPresented: $adding) { IOSWidgetGallery { select(); store.addWidget(kind: $0); adding = false } }
        .sheet(item: $editedWidget) { widget in
            IOSWidgetEditor(widget: widget) { title, size, config in
                select(); store.updateWidget(id: widget.id, title: title, size: size, config: config)
                if store.error == nil { editedWidget = nil }
            }
        }
        .alert("Rename dashboard", isPresented: $renaming) {
            TextField("Name", text: $name).accessibilityIdentifier("rename-dashboard-name")
            Button("Cancel", role: .cancel) {}
            Button("Save") { select(); store.renameDashboard(id: dashboardID, name: name) }
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Delete this dashboard?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete dashboard", role: .destructive) {
                select()
                store.deleteDashboard(id: dashboardID)
                if store.error == nil, !store.state.dashboards.contains(where: { $0.id == dashboardID }) { dismiss() }
            }
        }
    }

    private func select() { store.selectedID = dashboardID }
}

struct DashboardExportDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
