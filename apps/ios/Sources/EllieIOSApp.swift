import SwiftUI

@main
@MainActor
struct EllieIOSApp: App {
    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ellie-ui-reviewed-browser-fixture") {
                BrowserVoiceUITestFixtureView()
            } else if ProcessInfo.processInfo.arguments.contains("--ellie-ui-browser-target-fixture") {
                BrowserTargetUITestFixtureView()
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
            .tint(Color(red: 0.88, green: 0.37, blue: 0.16))
    }
}
