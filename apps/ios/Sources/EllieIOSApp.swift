import SwiftUI

@main
@MainActor
struct EllieIOSApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ellie-ui-home-appearance-fixture") {
                HomeAppearanceUITestFixtureView(accessibilityLayout:
                    ProcessInfo.processInfo.arguments.contains("--ellie-ui-home-accessibility"))
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-reviewed-browser-fixture") {
                BrowserVoiceUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-native-scanner-sheet-fixture") {
                NativeScannerSheetUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-browser-target-fixture") {
                BrowserTargetUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-browser-unknown-relaunch-fixture") {
                if let identifier = BrowserUnknownRelaunchUITestStorage.identifier(
                    from: ProcessInfo.processInfo.arguments,
                    after: "--ellie-ui-browser-unknown-relaunch-fixture") {
                    BrowserUnknownRelaunchUITestFixtureView(identifier: identifier)
                } else {
                    Text("Invalid UI fixture identifier")
                }
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-browser-unknown-cleanup") {
                if let identifier = BrowserUnknownRelaunchUITestStorage.identifier(
                    from: ProcessInfo.processInfo.arguments,
                    after: "--ellie-ui-browser-unknown-cleanup") {
                    BrowserUnknownRelaunchUITestCleanupView(identifier: identifier)
                } else {
                    Text("Invalid UI fixture identifier")
                }
            } else {
                EllieIOSNormalRoot()
            }
            #else
            EllieIOSNormalRoot()
            #endif
        }
    }
}

@MainActor
private struct EllieIOSNormalRoot: View {
    @StateObject private var store = DashboardStore()
    @StateObject private var enrollment = NativeEnrollmentStore()

    var body: some View {
        IOSDashboardList(store: store, enrollment: enrollment)
            .tint(ElliePalette.accent)
            .preferredColorScheme(.dark)
    }
}
