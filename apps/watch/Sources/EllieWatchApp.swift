import SwiftUI

@main
@MainActor
struct EllieWatchApp: App {
  @StateObject private var media = WatchMediaWatchStore()

  var body: some Scene {
    WindowGroup {
      WatchMediaView(media: media)
        .onAppear { media.activate() }
    }
  }
}
