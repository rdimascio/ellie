import SwiftUI

struct WatchMediaView: View {
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject var media: WatchMediaWatchStore

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        Text("Ellie media").font(.headline)
        if let observed = media.observation {
          Text("YouTube · \(observed.targetLabel)").font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("watch-observed-target")
          Text(observed.title ?? "Title not observed").font(.body).lineLimit(3)
            .accessibilityIdentifier("watch-observed-title")
          Text(observed.playback == "playing" ? "Playing" : observed.playback == "paused" ? "Paused" : "Player state unavailable")
            .font(.caption)
        }
        Text(media.status).font(.caption).foregroundStyle(.secondary)
          .accessibilityIdentifier("watch-media-status")
        Button("Read current page", systemImage: "arrow.clockwise") { media.read() }
          .disabled(media.waiting || !media.reachable)
          .accessibilityIdentifier("watch-read")
        HStack {
          Button("Play", systemImage: "play.fill") { media.play() }
            .disabled(!media.canPlay)
            .accessibilityIdentifier("watch-play")
          Button("Pause", systemImage: "pause.fill") { media.pause() }
            .disabled(!media.canPause)
            .accessibilityIdentifier("watch-pause")
        }
        .labelStyle(.iconOnly)
      }
      .padding()
    }
    .onAppear {
      if scenePhase == .active { media.activate() }
      else { media.suspend() }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { media.activate() }
      else { media.suspend() }
    }
  }
}
