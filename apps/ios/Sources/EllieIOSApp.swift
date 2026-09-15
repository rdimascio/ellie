import SwiftUI

@main
@MainActor
struct EllieIOSApp: App {
    @StateObject private var store = DashboardStore()
    @StateObject private var enrollment = NativeEnrollmentStore()

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ellie-ui-reviewed-browser-fixture") {
                BrowserVoiceUITestFixtureView()
            } else {
                IOSDashboardList(store: store, enrollment: enrollment)
                    .tint(Color(red: 0.88, green: 0.37, blue: 0.16))
            }
            #else
            IOSDashboardList(store: store, enrollment: enrollment)
                .tint(Color(red: 0.88, green: 0.37, blue: 0.16))
            #endif
        }
    }
}
