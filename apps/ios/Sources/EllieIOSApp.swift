import SwiftUI

@main
@MainActor
struct EllieIOSApp: App {
    init() { WatchMediaPhoneBridge.shared.activate() }

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ellie-ui-home-appearance-fixture") {
                HomeAppearanceUITestFixtureView(
                    accessibilityLayout: ProcessInfo.processInfo.arguments.contains("--ellie-ui-home-accessibility"),
                    narrowLayout: ProcessInfo.processInfo.arguments.contains("--ellie-ui-home-narrow"))
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-reviewed-browser-fixture") {
                BrowserVoiceUITestFixtureView(
                    completeActions: ProcessInfo.processInfo.arguments.contains(
                        "--ellie-ui-browser-complete-actions"),
                    netflixRows: ProcessInfo.processInfo.arguments.contains(
                        "--ellie-ui-browser-netflix-voice-rows"))
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-native-scanner-sheet-fixture") {
                NativeScannerSheetUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-browser-target-fixture") {
                BrowserTargetUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-browser-netflix-rows-fixture") {
                BrowserTargetUITestFixtureView(netflixRows: true)
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-browser-read-only-fixture") {
                BrowserTargetUITestFixtureView(readOnly: true)
            } else if ProcessInfo.processInfo.arguments.contains(
                "--ellie-ui-browser-unavailable-playback-fixture") {
                BrowserTargetUITestFixtureView(unavailablePlayback: true)
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
            .onChange(of: enrollment.phase) { _, phase in
                if case .enrolled(let credential) = phase {
                    WatchMediaPhoneBridge.shared.retainOnly(credential)
                } else {
                    WatchMediaPhoneBridge.shared.disable()
                }
            }
    }
}
