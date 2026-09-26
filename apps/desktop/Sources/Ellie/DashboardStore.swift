import Combine
import Foundation

@MainActor
final class DashboardStore: ObservableObject {
    @Published private(set) var state: DashboardState
    @Published private(set) var selectedID: String?
    @Published var error: String?

    let fileURL: URL
    private let setFileAttributes: ([FileAttributeKey: Any], String) throws -> Void
    private var recoveryRequired = false

    var selectedDashboard: Dashboard? {
        state.dashboards.first { $0.id == selectedID }
    }

    @discardableResult
    func selectDashboard(id: String) -> Bool {
        guard state.dashboards.contains(where: { $0.id == id }) else {
            error = DashboardModelError.unknownDashboard.localizedDescription
            return false
        }
        selectedID = id
        return true
    }

    @discardableResult
    func selectDashboard(id: String?) -> Bool {
        guard let id else {
            // SwiftUI can transiently propose an empty List selection while rows
            // still exist. Keep the last valid dashboard selected in that case.
            guard state.dashboards.isEmpty else { return false }
            selectedID = nil
            return true
        }
        return selectDashboard(id: id)
    }

    init(
        fileURL: URL? = nil,
        setFileAttributes: @escaping ([FileAttributeKey: Any], String) throws -> Void = {
            try FileManager.default.setAttributes($0, ofItemAtPath: $1)
        }
    ) {
        self.fileURL = fileURL ?? Self.defaultFileURL()
        self.setFileAttributes = setFileAttributes
        if FileManager.default.fileExists(atPath: self.fileURL.path) {
            do {
                let values = try self.fileURL.resourceValues(forKeys: [
                    .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
                ])
                guard values.isRegularFile == true, values.isSymbolicLink != true else {
                    throw DashboardStoreError.unsafeStateFile
                }
                guard let fileSize = values.fileSize,
                      fileSize <= DashboardModel.maximumSerializedBytes else {
                    throw DashboardModelError.dataTooLarge
                }
                let handle = try FileHandle(forReadingFrom: self.fileURL)
                defer { try? handle.close() }
                let data = try handle.read(upToCount: DashboardModel.maximumSerializedBytes + 1) ?? Data()
                guard data.count <= DashboardModel.maximumSerializedBytes else {
                    throw DashboardModelError.dataTooLarge
                }
                state = try DashboardModel.decode(data)
                selectedID = state.dashboards.first?.id
                error = nil
            } catch {
                state = DashboardModel.initialState
                selectedID = state.dashboards.first?.id
                recoveryRequired = true
                self.error = "Saved dashboards could not be opened: \(error.localizedDescription) Import a valid export or reset to replace that file."
            }
        } else {
            state = DashboardModel.initialState
            selectedID = state.dashboards.first?.id
            error = nil
        }
    }

    func createDashboard(name: String) {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        performMutation { state in
            guard state.dashboards.count < DashboardModel.maximumDashboards else {
                throw DashboardModelError.tooManyDashboards
            }
            guard !state.dashboards.contains(where: { Self.namesCollide($0.name, cleanName) }) else {
                throw DashboardStoreError.duplicateDashboardName
            }
            let dashboard = Dashboard(id: Self.uniqueID(prefix: "dashboard"), name: cleanName, widgets: [])
            state.dashboards.append(dashboard)
            selectedID = dashboard.id
        }
    }

    func renameDashboard(id: String, name: String) {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        performMutation { state in
            guard let index = state.dashboards.firstIndex(where: { $0.id == id }) else {
                throw DashboardModelError.unknownDashboard
            }
            guard !state.dashboards.contains(where: {
                $0.id != id && Self.namesCollide($0.name, cleanName)
            }) else {
                throw DashboardStoreError.duplicateDashboardName
            }
            state.dashboards[index].name = cleanName
        }
    }

    func deleteDashboard(id: String) {
        performMutation { state in
            guard let index = state.dashboards.firstIndex(where: { $0.id == id }) else {
                throw DashboardModelError.unknownDashboard
            }
            state.dashboards.remove(at: index)
            if selectedID == id { selectedID = state.dashboards.first?.id }
        }
    }

    func addWidget(kind: WidgetKind) {
        performMutation { state in
            guard let dashboardIndex = selectedDashboardIndex(in: state) else {
                throw DashboardModelError.unknownDashboard
            }
            guard state.dashboards[dashboardIndex].widgets.count < DashboardModel.maximumWidgetsPerDashboard else {
                throw DashboardModelError.tooManyWidgets
            }
            let title = Self.defaultTitle(for: kind)
            let config = kind == .note ? ["text": ""] : [:]
            state.dashboards[dashboardIndex].widgets.append(DashboardWidget(
                id: Self.uniqueID(prefix: kind.rawValue), type: kind, title: title, size: .small, config: config
            ))
        }
    }

    func updateWidget(id: String, title: String, size: WidgetSize, config: [String: String]) {
        performMutation { state in
            guard let dashboardIndex = selectedDashboardIndex(in: state) else {
                throw DashboardModelError.unknownDashboard
            }
            guard let widgetIndex = state.dashboards[dashboardIndex].widgets.firstIndex(where: { $0.id == id }) else {
                throw DashboardModelError.unknownWidget
            }
            state.dashboards[dashboardIndex].widgets[widgetIndex].title = title
            state.dashboards[dashboardIndex].widgets[widgetIndex].size = size
            state.dashboards[dashboardIndex].widgets[widgetIndex].config = config
        }
    }

    func removeWidget(id: String) {
        performMutation { state in
            guard let dashboardIndex = selectedDashboardIndex(in: state) else {
                throw DashboardModelError.unknownDashboard
            }
            guard let widgetIndex = state.dashboards[dashboardIndex].widgets.firstIndex(where: { $0.id == id }) else {
                throw DashboardModelError.unknownWidget
            }
            state.dashboards[dashboardIndex].widgets.remove(at: widgetIndex)
        }
    }

    /// Moves a widget by a relative offset, normally `-1` or `1`.
    func moveWidget(id: String, offset: Int) {
        performMutation { state in
            guard let dashboardIndex = selectedDashboardIndex(in: state) else {
                throw DashboardModelError.unknownDashboard
            }
            guard let source = state.dashboards[dashboardIndex].widgets.firstIndex(where: { $0.id == id }) else {
                throw DashboardModelError.unknownWidget
            }
            let destination = source + offset
            guard state.dashboards[dashboardIndex].widgets.indices.contains(destination) else {
                throw DashboardModelError.positionOutOfBounds
            }
            let widget = state.dashboards[dashboardIndex].widgets.remove(at: source)
            state.dashboards[dashboardIndex].widgets.insert(widget, at: destination)
        }
    }

    func importData(_ data: Data) {
        do {
            let imported = try DashboardModel.decode(data)
            try persist(imported)
            state = imported
            selectedID = imported.dashboards.first?.id
            recoveryRequired = false
            error = nil
        } catch {
            self.error = "That file is not a valid Ellie dashboard export. Nothing was changed. \(error.localizedDescription)"
        }
    }

    func exportData() throws -> Data {
        do {
            error = nil
            return try DashboardModel.encode(state)
        } catch {
            self.error = "Dashboards could not be exported: \(error.localizedDescription)"
            throw error
        }
    }

    func reset() {
        replaceState(with: DashboardModel.initialState, allowsRecovery: true)
    }

    private func performMutation(_ mutation: (inout DashboardState) throws -> Void) {
        guard !recoveryRequired else {
            error = DashboardStoreError.recoveryRequired.localizedDescription
            return
        }
        var candidate = state
        let oldSelection = selectedID
        do {
            try mutation(&candidate)
            try DashboardModel.validate(candidate)
            try persist(candidate)
            state = candidate
            error = nil
        } catch {
            selectedID = oldSelection
            self.error = error.localizedDescription
        }
    }

    private func replaceState(with candidate: DashboardState, allowsRecovery: Bool = false) {
        guard !recoveryRequired || allowsRecovery else {
            error = DashboardStoreError.recoveryRequired.localizedDescription
            return
        }
        do {
            try DashboardModel.validate(candidate)
            try persist(candidate)
            state = candidate
            selectedID = candidate.dashboards.first?.id
            recoveryRequired = false
            error = nil
        } catch {
            self.error = "Dashboards could not be saved: \(error.localizedDescription)"
        }
    }

    private func selectedDashboardIndex(in state: DashboardState) -> Int? {
        guard let selectedID else { return nil }
        return state.dashboards.firstIndex { $0.id == selectedID }
    }

    private func persist(_ candidate: DashboardState) throws {
        let data = try DashboardModel.encode(candidate)
        let directory = fileURL.deletingLastPathComponent()
        let directoryExisted = FileManager.default.fileExists(atPath: directory.path)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        if !directoryExisted || fileURL.standardizedFileURL == Self.defaultFileURL().standardizedFileURL {
            try setFileAttributes([.posixPermissions: 0o700], directory.path)
        }
        let stagingURL = directory.appendingPathComponent(".dashboards-\(UUID().uuidString).tmp")
        do {
            try data.write(to: stagingURL, options: .atomic)
            try setFileAttributes([.posixPermissions: 0o600], stagingURL.path)
            // The staged file already has its final private metadata. Keep the
            // replacement as the commit boundary: a later throwing operation
            // could report failure after the durable state has already changed.
            if FileManager.default.fileExists(atPath: fileURL.path) {
                _ = try FileManager.default.replaceItemAt(
                    fileURL,
                    withItemAt: stagingURL,
                    backupItemName: nil,
                    options: .usingNewMetadataOnly
                )
            } else {
                try FileManager.default.moveItem(at: stagingURL, to: fileURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: stagingURL)
            throw error
        }
    }

    private static func defaultFileURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Ellie", isDirectory: true).appendingPathComponent("dashboardsv1.json")
    }

    private static func uniqueID(prefix: String) -> String {
        "\(prefix)-\(UUID().uuidString.lowercased())"
    }

    private static func namesCollide(_ first: String, _ second: String) -> Bool {
        let locale = Locale(identifier: "en_US_POSIX")
        return first.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive], locale: locale)
            == second.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive], locale: locale)
    }

    private static func defaultTitle(for kind: WidgetKind) -> String {
        switch kind {
        case .clock: "Clock"
        case .note: "Note"
        case .weather: "Weather"
        case .calendar: "Calendar"
        case .chores: "Chores"
        case .playlist: "Playlist"
        }
    }
}

private enum DashboardStoreError: LocalizedError {
    case unsafeStateFile, recoveryRequired, duplicateDashboardName

    var errorDescription: String? {
        switch self {
        case .unsafeStateFile:
            "The dashboard state path is not a regular file."
        case .recoveryRequired:
            "Saved dashboards are still unreadable. Import a valid export or reset before making changes."
        case .duplicateDashboardName:
            "Choose a dashboard name that is different from the existing dashboards."
        }
    }
}
