import AppKit
import SwiftUI
import UniformTypeIdentifiers

@main
@MainActor
struct EllieApp: App {
    @StateObject private var store: DashboardStore
    @StateObject private var weatherStore: WeatherStore
    @StateObject private var choresStore: ChoresStore

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let stateURL: URL?
        if let index = arguments.firstIndex(of: "--state-path"), index + 1 < arguments.count {
            stateURL = URL(fileURLWithPath: arguments[index + 1])
        } else {
            stateURL = nil
        }
        let choresURL: URL?
        if let index = arguments.firstIndex(of: "--chores-state-path"), index + 1 < arguments.count {
            choresURL = URL(fileURLWithPath: arguments[index + 1])
        } else {
            choresURL = nil
        }
        _store = StateObject(wrappedValue: DashboardStore(fileURL: stateURL))
        let weatherURL = stateURL?.deletingLastPathComponent().appendingPathComponent("weatherv1.json")
        _weatherStore = StateObject(wrappedValue: WeatherStore(fileURL: weatherURL))
        _choresStore = StateObject(wrappedValue: ChoresStore(fileURL: choresURL))
    }

    var body: some Scene {
        WindowGroup("Ellie") {
            DashboardView(store: store, weatherStore: weatherStore, choresStore: choresStore)
                .frame(minWidth: 720, minHeight: 520)
                .tint(Color(red: 0.88, green: 0.37, blue: 0.16))
        }
        .defaultSize(width: 1180, height: 780)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Dashboard") { store.createDashboard(name: "Untitled") }
                    .keyboardShortcut("n")
            }
            CommandGroup(after: .newItem) {
                Divider()
                Button("Import Dashboards…") { DashboardFiles.importFile(into: store) }
                    .keyboardShortcut("i", modifiers: [.command, .shift])
                Button("Export Dashboards…") { DashboardFiles.exportFile(from: store) }
                    .keyboardShortcut("e", modifiers: [.command, .shift])
            }
            SidebarCommands()
        }
    }
}

@MainActor
enum DashboardFiles {
    static func importFile(into store: DashboardStore) {
        let panel = NSOpenPanel()
        panel.title = "Import dashboards"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard values.isRegularFile == true, (values.fileSize ?? Int.max) <= 128 * 1024 else {
                store.error = "Choose a dashboard export smaller than 128 KB."
                return
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: 128 * 1024 + 1) ?? Data()
            guard data.count <= 128 * 1024 else {
                store.error = "Choose a dashboard export smaller than 128 KB."
                return
            }
            _ = try DashboardModel.decode(data)
            let confirmation = NSAlert()
            confirmation.messageText = "Replace your dashboards?"
            confirmation.informativeText = "Importing replaces all dashboards on this Mac. Export a copy first if you want to keep the current layouts and notes."
            confirmation.addButton(withTitle: "Cancel")
            confirmation.addButton(withTitle: "Replace Dashboards")
            guard confirmation.runModal() == .alertSecondButtonReturn else { return }
            store.importData(data)
        } catch { store.error = "This file could not be opened as an Ellie dashboard export. Your dashboards are unchanged." }
    }

    static func exportFile(from store: DashboardStore) {
        let panel = NSSavePanel()
        panel.title = "Export dashboards"
        panel.nameFieldStringValue = "Ellie Dashboards.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let data = try store.exportData()
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { store.error = "The export could not be saved. Choose another location." }
    }
}
