import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct IOSDashboardList: View {
    @ObservedObject var store: DashboardStore
    @ObservedObject var enrollment: NativeEnrollmentStore
    @StateObject private var choresStore: ChoresStore
    @StateObject private var weatherStore: WeatherStore
    #if DEBUG
    var uiTestLifeDestination: ((NativeEnrollmentCredential) -> AnyView)? = nil
    #endif

    init(store: DashboardStore, enrollment: NativeEnrollmentStore, choresStore: ChoresStore? = nil,
         weatherStore: WeatherStore? = nil) {
        self.store = store
        self.enrollment = enrollment
        _choresStore = StateObject(wrappedValue: choresStore ?? ChoresStore())
        _weatherStore = StateObject(wrappedValue: weatherStore ?? WeatherStore())
    }

    #if DEBUG
    init(store: DashboardStore, enrollment: NativeEnrollmentStore, choresStore: ChoresStore? = nil,
         weatherStore: WeatherStore? = nil,
         uiTestLifeDestination: ((NativeEnrollmentCredential) -> AnyView)?) {
        self.store = store
        self.enrollment = enrollment
        _choresStore = StateObject(wrappedValue: choresStore ?? ChoresStore())
        _weatherStore = StateObject(wrappedValue: weatherStore ?? WeatherStore())
        self.uiTestLifeDestination = uiTestLifeDestination
    }
    #endif
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var creating = false
    @State private var name = ""
    @State private var importing = false
    @State private var exporting = false
    @State private var exportDocument: DashboardExportDocument?
    @State private var pendingImport: Data?
    @State private var confirmingImport = false

    var body: some View {
        NavigationStack {
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: 26) {
                        if dynamicTypeSize.isAccessibilitySize {
                            if case .enrolled(let credential) = enrollment.phase {
                                lifeEntry(for: credential)
                            }
                        } else {
                            homeInvitation(compact: geometry.size.width < 390)
                        }
                        HStack {
                            Text("Your dashboards").font(.headline)
                                .fixedSize(horizontal: false, vertical: true)
                            if !dynamicTypeSize.isAccessibilitySize {
                                Spacer()
                                Image(systemName: "square.grid.2x2").foregroundStyle(ElliePalette.muted)
                            }
                        }
                        VStack(spacing: 12) {
                            ForEach(store.state.dashboards) { dashboard in
                                NavigationLink {
                                    IOSDashboardDetail(store: store, choresStore: choresStore,
                                        weatherStore: weatherStore, dashboardID: dashboard.id)
                                } label: {
                                    HStack(spacing: dynamicTypeSize.isAccessibilitySize ? 0 : 16) {
                                        if !dynamicTypeSize.isAccessibilitySize {
                                            Image(systemName: dashboard.id == store.state.dashboards.first?.id ? "house" : "rectangle.3.group")
                                                .font(.title3)
                                                .foregroundStyle(ElliePalette.accent)
                                                .frame(width: 44, height: 44)
                                                .background(ElliePalette.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                                        }
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(dashboard.name).font(.headline).foregroundStyle(ElliePalette.foreground)
                                                .fixedSize(horizontal: false, vertical: true)
                                            Text("\(dashboard.widgets.count) widgets")
                                                .font(.caption).foregroundStyle(ElliePalette.muted)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        if !dynamicTypeSize.isAccessibilitySize {
                                            Spacer(minLength: 8)
                                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(ElliePalette.muted)
                                        }
                                    }
                                    .ellieCard()
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(dashboard.name)
                                .accessibilityIdentifier("dashboard-\(dashboard.id)")
                            }
                        }
                        NavigationLink {
                            NativeEnrollmentView(store: enrollment, dashboards: store)
                        } label: {
                            HStack(spacing: dynamicTypeSize.isAccessibilitySize ? 0 : 14) {
                                if !dynamicTypeSize.isAccessibilitySize {
                                    Image(systemName: "link").foregroundStyle(ElliePalette.accent)
                                }
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(coordinatorTitle).font(.subheadline.weight(.semibold)).foregroundStyle(ElliePalette.foreground)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Text("Your devices, working together")
                                        .font(.caption).foregroundStyle(ElliePalette.muted)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                if !dynamicTypeSize.isAccessibilitySize {
                                    Spacer(minLength: 8)
                                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(ElliePalette.muted)
                                }
                            }
                            .ellieCard()
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(coordinatorTitle)
                        .accessibilityIdentifier("coordinator-enrollment")
                        Label("Layouts and notes stay on this iPhone until you export or sync them.", systemImage: "lock")
                            .font(.caption).foregroundStyle(ElliePalette.muted)
                            .padding(.horizontal, 4)
                    }
                    .padding(20)
                }
                .accessibilityIdentifier("dashboard-list")
            }
            .ellieScreen()
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

    private var coordinatorTitle: String {
        if case .enrolled = enrollment.phase { return "Your coordinator" }
        return "Pair this iPhone"
    }

    private func homeInvitation(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if compact {
                EllieNativePresence().frame(width: 96, height: 100)
                invitationCopy
            } else {
                HStack(spacing: 12) {
                    invitationCopy.frame(maxWidth: .infinity, alignment: .leading)
                    EllieNativePresence().frame(width: 110, height: 125)
                }
            }
            if case .enrolled(let credential) = enrollment.phase {
                lifeEntry(for: credential)
            } else {
                Text("Connect your coordinator to bring Ellie with you.")
                    .font(.caption).foregroundStyle(ElliePalette.accent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(LinearGradient(colors: [ElliePalette.surface, Color(red: 0.12, green: 0.14, blue: 0.26)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 28))
        .overlay(RoundedRectangle(cornerRadius: 28).strokeBorder(ElliePalette.violet.opacity(0.3), lineWidth: 1))
    }

    private func lifeEntry(for credential: NativeEnrollmentCredential) -> some View {
        NavigationLink {
            lifeDestination(for: credential)
        } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    Text("Open Ellie Life")
                } else {
                    Label("Open Ellie Life", systemImage: "sparkle")
                }
            }
            .font(.subheadline.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.vertical, 12).padding(.horizontal, 16)
            .foregroundStyle(ElliePalette.background)
            .background(ElliePalette.accent, in: RoundedRectangle(cornerRadius: 13))
        }
        .accessibilityIdentifier("open-ellie-life")
    }

    private var invitationCopy: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("A little more\nheadspace.")
                .font(.largeTitle.weight(.medium))
                .tracking(-1)
                .foregroundStyle(ElliePalette.foreground)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("home-invitation-title")
            Text("Your spaces. Your devices.\nAll a little closer.")
                .font(.subheadline).foregroundStyle(ElliePalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func lifeDestination(for credential: NativeEnrollmentCredential) -> some View {
        #if DEBUG
        if let uiTestLifeDestination {
            uiTestLifeDestination(credential).id(credential.client.id)
        } else {
            LifeWebView(credential: LifeWebCredential(enrollment: credential))
                .id(credential.client.id)
        }
        #else
        LifeWebView(credential: LifeWebCredential(enrollment: credential))
            .id(credential.client.id)
        #endif
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
    @ObservedObject var choresStore: ChoresStore
    @ObservedObject var weatherStore: WeatherStore
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
                        IOSWidgetCard(widget: widget, choresStore: choresStore, weatherStore: weatherStore, editing: editing,
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
        .accessibilityIdentifier("ios-dashboard-detail-scroll")
        .ellieScreen()
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
            IOSWidgetEditor(widget: widget, weatherStore: weatherStore) { title, size, config in
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
