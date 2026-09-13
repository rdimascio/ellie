import SwiftUI

struct NativeWidgetCard: View {
    @Environment(\.colorScheme) private var colorScheme
    let widget: DashboardWidget
    let editing: Bool
    @ObservedObject var weatherStore: WeatherStore
    let configure: () -> Void
    let earlier: () -> Void
    let later: () -> Void
    let remove: () -> Void
    let isFirst: Bool
    let isLast: Bool

    private var isClock: Bool { widget.type == .clock }
    private var isNote: Bool { widget.type == .note }
    private var foreground: Color { isClock ? .white : .primary }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(spacing: 8) {
                Image(systemName: widget.type.symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isClock ? Color.white.opacity(0.6) : Color.secondary)
                Text(widget.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                Spacer(minLength: 4)
                if editing {
                    HStack(spacing: 8) {
                        Button(action: earlier) { Image(systemName: "arrow.left") }.disabled(isFirst).help("Move earlier").accessibilityLabel("Move \(widget.title) earlier")
                        Button(action: later) { Image(systemName: "arrow.right") }.disabled(isLast).help("Move later").accessibilityLabel("Move \(widget.title) later")
                        Button(action: configure) { Image(systemName: "slider.horizontal.3") }.help("Edit \(widget.title)").accessibilityLabel("Edit \(widget.title)")
                        Button(role: .destructive, action: remove) { Image(systemName: "minus.circle") }.help("Remove \(widget.title)").accessibilityLabel("Remove \(widget.title)")
                    }
                    .font(.system(size: 13))
                    .buttonStyle(.borderless)
                }
            }
            .foregroundStyle(foreground)
            Group {
                if isClock { NativeClock(timeZone: widget.config["timeZone"], wide: widget.size == .wide) }
                else if isNote {
                    VStack(alignment: .leading, spacing: 16) {
                        let text = widget.config["text"] ?? ""
                        if text.isEmpty {
                            Button(action: configure) {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("A little room\nfor a thought.")
                                        .font(.system(size: 25, weight: .medium)).tracking(-0.5)
                                    Text("Add a note").font(.system(size: 12)).foregroundStyle(.secondary)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Text(text).font(.system(size: 20, weight: .regular)).lineSpacing(5)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 155, alignment: .topLeading)
                } else if widget.type == .weather {
                    NativeWeather(store: weatherStore, configure: configure)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        Image(systemName: widget.type.symbol)
                            .font(.system(size: 38, weight: .ultraLight))
                            .foregroundStyle(.secondary)
                            .padding(.top, 6)
                        Spacer(minLength: 0)
                        Text("Not connected").font(.system(size: 18, weight: .medium))
                        Text(widget.type.summary)
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 155, alignment: .leading)
                }
            }
        }
        .padding(24)
        .foregroundStyle(foreground)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.primary.opacity(isClock ? 0 : 0.04), lineWidth: 1))
        .contextMenu {
            Button("Edit Widget…", action: configure)
            Button("Move Earlier", action: earlier).disabled(isFirst)
            Button("Move Later", action: later).disabled(isLast)
            Divider()
            Button("Remove Widget", role: .destructive, action: remove)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(widget.title)
    }

    private var background: Color {
        if isClock { return Color(red: 0.105, green: 0.12, blue: 0.15) }
        if isNote { return colorScheme == .dark ? Color(red: 0.22, green: 0.19, blue: 0.13) : Color(red: 1, green: 0.96, blue: 0.82) }
        return Color(nsColor: .controlBackgroundColor)
    }
}

struct NativeClock: View {
    let timeZone: String?
    let wide: Bool

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let zone = timeZone.flatMap(TimeZone.init(identifier:)) ?? .current
            HStack(alignment: .center, spacing: 24) {
                VStack(alignment: .leading, spacing: 16) {
                    let parts = clockParts(context.date, zone: zone)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(parts.time)
                            .font(.system(size: wide ? 84 : 58, weight: .ultraLight))
                            .tracking(-3).lineLimit(1).minimumScaleFactor(0.5)
                        if !parts.period.isEmpty {
                            Text(parts.period).font(.system(size: 16, weight: .light))
                                .foregroundStyle(.white.opacity(0.65))
                        }
                    }
                    Text(zone.identifier == TimeZone.current.identifier ? "Local time" : zone.identifier.replacingOccurrences(of: "_", with: " "))
                        .font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if wide { ClockDial(date: context.date, timeZone: zone).frame(width: 138, height: 138).accessibilityHidden(true) }
            }
            .foregroundStyle(.white)
            .frame(minHeight: 155)
        }
    }
    private func clockParts(_ date: Date, zone: TimeZone) -> (time: String, period: String) {
        let formatter = DateFormatter()
        formatter.locale = .current
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate("jm")
        let text = formatter.string(from: date)
        for period in [formatter.amSymbol, formatter.pmSymbol].compactMap({ $0 }) where !period.isEmpty {
            if text.hasSuffix(period) {
                return (String(text.dropLast(period.count)).trimmingCharacters(in: .whitespaces), period)
            }
        }
        return (text, "")
    }

}

private struct ClockDial: View {
    let date: Date
    let timeZone: TimeZone
    private var components: DateComponents {
        var calendar = Calendar.current
        calendar.timeZone = timeZone
        return calendar.dateComponents([.hour, .minute, .second], from: date)
    }
    var body: some View {
        let hour = Double(components.hour ?? 0)
        let minute = Double(components.minute ?? 0)
        let second = Double(components.second ?? 0)
        ZStack {
            Circle().strokeBorder(.white.opacity(0.09), lineWidth: 1)
            ForEach(0..<60) { index in
                Capsule().fill(.white.opacity(index % 5 == 0 ? 0.6 : 0.18))
                    .frame(width: index % 5 == 0 ? 2 : 1, height: index % 5 == 0 ? 8 : 3)
                    .offset(y: -60).rotationEffect(.degrees(Double(index) * 6))
            }
            Capsule().fill(.white).frame(width: 3, height: 34).offset(y: -14).rotationEffect(.degrees(hour * 30 + minute / 2))
            Capsule().fill(.white).frame(width: 2, height: 48).offset(y: -22).rotationEffect(.degrees(minute * 6))
            Capsule().fill(Color.orange).frame(width: 1, height: 57).offset(y: -22).rotationEffect(.degrees(second * 6))
            Circle().fill(.orange).frame(width: 5, height: 5)
        }
    }
}

struct WidgetGallery: View {
    @Environment(\.dismiss) private var dismiss
    let add: (WidgetKind) -> Void
    private let kinds: [WidgetKind] = [.clock, .note, .weather, .calendar, .chores, .playlist]

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Add a widget").font(.system(size: 24, weight: .bold)).tracking(-0.5)
                    Text("Make a place for what matters.").font(.system(size: 13)).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                ForEach(kinds, id: \.self) { kind in
                    Button { add(kind) } label: {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Image(systemName: kind.symbol).font(.system(size: 26, weight: .light))
                                Spacer()
                                Image(systemName: "plus.circle.fill").font(.system(size: 18)).foregroundStyle(.tertiary)
                            }
                            Text(kind.displayName).font(.system(size: 14, weight: .semibold))
                            Text(kind.summary).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
                        }
                        .padding(18).frame(maxWidth: .infinity, minHeight: 133, alignment: .leading)
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Add \(kind.displayName)")
                }
            }
            Text("Clock and notes work on this Mac. Other widgets are ready for future connections.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .padding(28).frame(width: 570)
    }
}

struct WidgetInspector: View {
    @Environment(\.dismiss) private var dismiss
    let widget: DashboardWidget
    @ObservedObject var weatherStore: WeatherStore
    let save: (String, WidgetSize, [String: String]) -> Void
    @State private var title: String
    @State private var size: WidgetSize
    @State private var note: String
    @State private var zone: String
    @State private var weatherEnabled: Bool
    @State private var placeName: String
    @State private var latitude: String
    @State private var longitude: String

    init(widget: DashboardWidget, weatherStore: WeatherStore, save: @escaping (String, WidgetSize, [String: String]) -> Void) {
        self.widget = widget
        self.weatherStore = weatherStore
        self.save = save
        _title = State(initialValue: widget.title)
        _size = State(initialValue: widget.size)
        _note = State(initialValue: widget.config["text"] ?? "")
        _zone = State(initialValue: widget.config["timeZone"] ?? "")
        _weatherEnabled = State(initialValue: weatherStore.state.enabled)
        _placeName = State(initialValue: weatherStore.state.place?.name ?? "")
        _latitude = State(initialValue: weatherStore.state.place.map { String($0.latitude) } ?? "")
        _longitude = State(initialValue: weatherStore.state.place.map { String($0.longitude) } ?? "")
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label("Edit \(widget.type.displayName)", systemImage: widget.type.symbol).font(.headline)
                Spacer()
            }.padding(24)
            Form {
                TextField("Title", text: $title)
                Picker("Size", selection: $size) {
                    Text("Small").tag(WidgetSize.small)
                    Text("Wide").tag(WidgetSize.wide)
                }
                .pickerStyle(.segmented)
                if widget.type == .note {
                    Section("Note") {
                        TextEditor(text: $note).font(.body).frame(height: 145)
                            .accessibilityLabel("Note text")
                        Text("\(note.count) of 2,000 characters").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if widget.type == .clock {
                    TextField("Time zone", text: $zone, prompt: Text("This Mac’s time zone"))
                    Text("Leave blank for local time, or enter a name such as Europe/London.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if widget.type == .weather {
                    Section("Forecast") {
                        Toggle("Use Open-Meteo forecasts", isOn: $weatherEnabled)
                        if weatherEnabled {
                            TextField("Place name", text: $placeName, prompt: Text("Home, London, …"))
                            TextField("Latitude", text: $latitude, prompt: Text("37.7749"))
                            TextField("Longitude", text: $longitude, prompt: Text("−122.4194"))
                            Text("Ellie sends these coordinates to Open-Meteo only when enabled. It never requests your Mac’s location.")
                                .font(.caption).foregroundStyle(.secondary)
                            Text("These settings apply to every weather widget.")
                                .font(.caption).foregroundStyle(.secondary)
                            Link("Weather data by Open-Meteo.com", destination: URL(string: "https://open-meteo.com/")!)
                                .font(.caption)
                        } else {
                            Text("Weather stays entirely offline. Turning this off deletes the saved place and forecast.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if let message = weatherStore.message {
                            Text(message).font(.caption).foregroundStyle(.red)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Save") {
                    var config = widget.config
                    if widget.type == .note { config = ["text": note] }
                    if widget.type == .clock { config = zone.isEmpty ? [:] : ["timeZone": zone] }
                    if widget.type == .weather {
                        if weatherEnabled {
                            guard weatherStore.configure(name: placeName, latitudeText: latitude, longitudeText: longitude) else { return }
                        } else if !weatherStore.disable() { return }
                    }
                    save(title, size, config)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || title.count > 80 || note.count > 2000 ||
                    (widget.type == .weather && weatherEnabled && !validWeatherPlace))
            }
            .padding(20)
        }
        .frame(width: 460)
    }

    private var validWeatherPlace: Bool {
        let name = placeName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf16.count <= 80,
              let latitude = Double(latitude), let longitude = Double(longitude) else { return false }
        return latitude.isFinite && longitude.isFinite && (-90...90).contains(latitude) && (-180...180).contains(longitude)
    }
}

struct NativeWeather: View {
    @ObservedObject var store: WeatherStore
    let configure: () -> Void

    var body: some View {
        Group {
            if !store.state.enabled {
                VStack(alignment: .leading, spacing: 13) {
                    Image(systemName: "location.slash").font(.system(size: 32, weight: .light)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Text("Choose a place").font(.system(size: 19, weight: .semibold))
                    Text("Weather is off until you add coordinates and enable Open-Meteo.").font(.system(size: 12)).foregroundStyle(.secondary)
                    Button("Set Up Weather…", action: configure).buttonStyle(.bordered)
                }
            } else if let place = store.state.place, let snapshot = store.state.snapshot {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(place.name).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
                            Text("\(Int(snapshot.temperature.rounded()))°").font(.system(size: 54, weight: .thin)).tracking(-2)
                        }
                        Spacer()
                        Image(systemName: snapshot.symbol).symbolRenderingMode(.multicolor).font(.system(size: 42))
                    }
                    Text(snapshot.condition).font(.system(size: 18, weight: .medium))
                    Text("Conditions as of \(snapshot.observedAt.formatted(date: .omitted, time: .shortened))")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Feels like \(Int(snapshot.apparentTemperature.rounded()))°  ·  Wind \(Int(snapshot.windSpeed.rounded())) mph")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        HStack(spacing: 6) {
                            Text(store.message ?? store.freshness(at: context.date))
                            Spacer()
                            Button { store.refresh(force: true) } label: {
                                Image(systemName: "arrow.clockwise")
                            }.buttonStyle(.borderless).disabled(store.isRefreshing).help("Refresh forecast")
                        }.font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Link("Weather data by Open-Meteo.com", destination: URL(string: "https://open-meteo.com/")!)
                        .font(.system(size: 10))
                }
            } else {
                VStack(alignment: .leading, spacing: 13) {
                    if store.isRefreshing { ProgressView().controlSize(.small) }
                    else { Image(systemName: "exclamationmark.triangle").foregroundStyle(.secondary) }
                    Spacer(minLength: 0)
                    Text(store.state.place?.name ?? "Weather").font(.system(size: 19, weight: .semibold))
                    Text(store.message ?? "Fetching the first forecast…").font(.system(size: 12)).foregroundStyle(.secondary)
                    Button("Try Again") { store.refresh(force: true) }.disabled(store.isRefreshing)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 155, alignment: .leading)
        .task { store.refresh() }
    }
}
