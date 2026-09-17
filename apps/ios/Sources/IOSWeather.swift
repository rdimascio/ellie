import SwiftUI

@MainActor
struct IOSWeatherWidget: View {
    @ObservedObject var store: WeatherStore
    let configure: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !store.state.enabled {
                Label("Weather is off", systemImage: "location.slash")
                    .font(.subheadline.weight(.semibold))
                Text(store.message ?? "Choose a place and enable Open-Meteo to see a forecast. Ellie never requests this iPhone’s location.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Set Up Weather", action: configure)
                    .accessibilityIdentifier("ios-weather-setup")
            } else if let place = store.state.place {
                Text(place.name).font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("ios-weather-place")
                if let snapshot = store.state.snapshot {
                    HStack(alignment: .center, spacing: 12) {
                        Image(systemName: snapshot.symbol).symbolRenderingMode(.multicolor).font(.largeTitle)
                        Text("\(Int(snapshot.temperature.rounded()))°F").font(.largeTitle.weight(.light))
                        Spacer(minLength: 0)
                    }
                    Text(snapshot.condition)
                    Text("Feels like \(Int(snapshot.apparentTemperature.rounded()))°F · Wind \(Int(snapshot.windSpeed.rounded())) mph")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Conditions as of \(snapshot.observedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        Text("\(store.needsRefresh || store.message != nil ? "Cached forecast" : "Current forecast") · \(store.freshness(at: context.date))")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("ios-weather-freshness")
                    }
                } else if store.isRefreshing {
                    ProgressView("Fetching first forecast")
                } else {
                    Text("No forecast yet").font(.caption).foregroundStyle(.secondary)
                }
                if let message = store.message {
                    Text(message).font(.caption).foregroundStyle(.orange)
                        .accessibilityIdentifier("ios-weather-error")
                }
                HStack {
                    Button("Refresh forecast") { store.refresh(force: true) }
                        .disabled(store.isRefreshing)
                        .accessibilityIdentifier("ios-weather-refresh")
                    Spacer(minLength: 0)
                    Button("Weather settings", action: configure)
                        .accessibilityIdentifier("ios-weather-settings")
                }
                Link("Weather data by Open-Meteo.com", destination: URL(string: "https://open-meteo.com/")!)
                    .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
        .task { store.refresh() }
    }
}
