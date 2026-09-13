import SwiftUI

@MainActor
struct DevicesView: View {
    @ObservedObject var store: CoordinatorStore

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 16) {
                Picker("Identity on this Mac", selection: $store.role) {
                    ForEach(CoordinatorRole.allCases) { role in Text(role.title).tag(role) }
                }
                .frame(maxWidth: 350)
                Spacer()
                if store.isMonitoring {
                    if store.phase == .connecting || store.phase == .reconnecting {
                        ProgressView().controlSize(.small)
                    }
                    Button("Disconnect") { store.disconnect() }
                } else {
                    Button(store.phase == .disconnected ? "Connect" : "Reconnect") { store.connect() }
                        .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
            Divider()
            if let failure = store.failure {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: store.phase == .reconnecting ? "arrow.triangle.2.circlepath" : "exclamationmark.circle")
                    Text(failure.localizedDescription)
                    Spacer()
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(16)
                .background(.quaternary.opacity(0.35))
            }
            if store.nodes.isEmpty {
                ContentUnavailableView {
                    Label(emptyTitle, systemImage: "desktopcomputer")
                } description: {
                    Text(emptyDescription).frame(maxWidth: 430)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TimelineView(.periodic(from: .now, by: 5)) { context in
                    HSplitView {
                        List(selection: $store.selectedNodeID) {
                            ForEach(store.nodes) { node in
                                HStack(spacing: 12) {
                                    Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(.secondary)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text("Mac · \(node.id.prefix(8))").fontWeight(.medium)
                                        Text(status(node, at: context.date)).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.vertical, 8)
                                .tag(node.id)
                            }
                        }
                        .frame(minWidth: 220, idealWidth: 270)
                        if let node = store.selectedNode {
                            detail(node, at: context.date).frame(minWidth: 320)
                        } else {
                            ContentUnavailableView("Select a Mac", systemImage: "cursorarrow.click", description: Text("Inspect its availability and desktop capabilities."))
                                .frame(minWidth: 320, maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            }
            Divider()
            HStack {
                Image(systemName: store.phase == .connected ? "checkmark.shield" : "network")
                Text(connectionStatus)
                Spacer()
                if let updated = store.lastUpdated {
                    Text("Updated \(updated.formatted(date: .omitted, time: .shortened))")
                }
            }
            .font(.caption).foregroundStyle(.secondary).padding(16)
        }
        .frame(minWidth: 720, minHeight: 500)
        .toolbar {
            Button { store.refresh() } label: { Label("Refresh devices", systemImage: "arrow.clockwise") }
                .disabled(store.phase != .connected)
                .help("Refresh device status")
                .keyboardShortcut("r")
        }
        .onChange(of: store.role) { _, _ in store.disconnect() }
        .onDisappear { store.disconnect() }
    }

    private func detail(_ node: CoordinatorNode, at date: Date) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Label(status(node, at: date), systemImage: store.phase == .connected && node.isOnline(at: date) ? "checkmark.circle.fill" : "circle.dashed")
                    .font(.title2.weight(.medium))
                VStack(alignment: .leading, spacing: 8) {
                    Text("Node identity").font(.caption).foregroundStyle(.secondary)
                    Text(node.id).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("Desktop capabilities").font(.headline)
                    if node.capabilities.isEmpty {
                        Text("No desktop tools advertised.").foregroundStyle(.secondary)
                    } else {
                        ForEach(node.capabilities, id: \.self) { capability in
                            Label(capabilityTitle(capability), systemImage: "checkmark")
                        }
                    }
                }
                Text("Last registration: \(node.lastSeen.formatted(date: .abbreviated, time: .standard))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(30).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func status(_ node: CoordinatorNode, at date: Date) -> String {
        guard store.phase == .connected else { return "Status unavailable" }
        return node.isOnline(at: date) ? "Online" : "Offline"
    }

    private var connectionStatus: String {
        switch store.phase {
        case .disconnected: "Uses existing pairing on this Mac"
        case .connecting: "Connecting securely…"
        case .connected: store.role == .node ? "Connected · This node’s registration" : "Connected · Household nodes"
        case .reconnecting: "Connection interrupted · Retrying briefly…"
        case .unavailable: "Coordinator unavailable · Reconnect when ready"
        case .blocked: "Connection needs attention"
        }
    }

    private var emptyTitle: String {
        if store.phase == .connected { return "No nodes registered" }
        if store.phase == .connecting || store.phase == .reconnecting { return "Finding your Macs" }
        return "Your Macs, together"
    }

    private var emptyDescription: String {
        if store.phase == .connected {
            return "Start Ellie Node on a paired Mac. The coordinator appears here only if it also runs a paired node."
        }
        return "Choose this Mac’s existing coordinator or node identity, then connect. A node identity can see its own registration. A coordinator identity can see the household’s nodes."
    }

    private func capabilityTitle(_ capability: String) -> String {
        switch capability {
        case "app.open": "Open applications"
        case "url.open": "Open websites"
        case "window.place": "Place windows"
        case "window.adjacent": "Arrange adjacent windows"
        default: capability
        }
    }
}
