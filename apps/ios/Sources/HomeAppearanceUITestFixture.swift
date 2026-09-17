#if DEBUG
import Combine
import Foundation
import SwiftUI

@MainActor
struct HomeAppearanceUITestFixtureView: View {
    let accessibilityLayout: Bool
    let narrowLayout: Bool
    @StateObject private var dashboards: DashboardStore
    @StateObject private var enrollment: NativeEnrollmentStore
    @StateObject private var probe: HomeAppearanceProbe

    init(accessibilityLayout: Bool, narrowLayout: Bool) {
        self.accessibilityLayout = accessibilityLayout
        self.narrowLayout = narrowLayout
        let probe = HomeAppearanceProbe()
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("ellie-home-appearance-\(UUID().uuidString).json")
        precondition(!FileManager.default.fileExists(atPath: file.path))
        _dashboards = StateObject(wrappedValue: DashboardStore(fileURL: file))
        _probe = StateObject(wrappedValue: probe)
        _enrollment = StateObject(wrappedValue: NativeEnrollmentStore(
            vault: HomeAppearanceVault(probe: probe),
            transport: HomeAppearanceRejectTransport(probe: probe),
            now: { Date(timeIntervalSince1970: 1_800_000_000) }))
    }

    var body: some View {
        IOSDashboardList(store: dashboards, enrollment: enrollment, uiTestLifeDestination: { credential in
            AnyView(Text("Synthetic Life destination: \(credential.client.id)")
                .accessibilityIdentifier("home-fixture-life-destination")
                .navigationTitle("Fixture Life")
                .onAppear { probe.lifeOpens += 1 })
        })
        .dynamicTypeSize(accessibilityLayout ? .accessibility5 : .large)
        .frame(width: narrowLayout || accessibilityLayout ? 320 : nil)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 4) {
                HStack {
                    Button("Load fixture pairing") { enrollment.startScanning() }
                        .accessibilityIdentifier("home-fixture-load-pairing")
                    Button("Remove fixture pairing") { enrollment.removeLocalCredential() }
                        .accessibilityIdentifier("home-fixture-remove-pairing")
                }
                Text("Fixture vault reads: \(probe.vaultReads)")
                    .accessibilityIdentifier("home-fixture-vault-reads")
                Text("Fixture transport calls: \(probe.transportCalls)")
                    .accessibilityIdentifier("home-fixture-transport-calls")
                Text("Fixture Life opens: \(probe.lifeOpens)")
                    .accessibilityIdentifier("home-fixture-life-opens")
            }
            .font(.caption)
            .padding(8)
            .background(Color(uiColor: .systemBackground))
        }
    }
}

@MainActor
private final class HomeAppearanceProbe: ObservableObject {
    @Published var vaultReads = 0
    @Published var transportCalls = 0
    @Published var lifeOpens = 0
    func readVault() { vaultReads += 1 }
    func calledTransport() { transportCalls += 1 }
}

private actor HomeAppearanceVault: NativeCredentialVault {
    let probe: HomeAppearanceProbe
    private var active: NativeEnrollmentCredential? = NativeEnrollmentCredential(
        origin: URL(string: "https://127.0.0.1:8444")!,
        certificateSha256: String(repeating: "b", count: 64),
        client: NativeClient(
            id: "home-fixture-phone", role: "native_phone_controller", label: "Home fixture phone",
            grants: [NativeGrant(target: "fixture-mac", capabilities: ["app.open"])],
            createdAt: 1_800_000_000_000, expiresAt: 1_807_776_000_000),
        token: String(repeating: "c", count: 64))

    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func loadActive() async -> NativeEnrollmentCredential? {
        await probe.readVault()
        return active
    }
    func loadPending() async -> PendingNativeEnrollment? {
        await probe.readVault()
        return nil
    }
    func savePending(_ value: PendingNativeEnrollment) throws { throw NativeEnrollmentFailure.unavailable }
    func promote(_ value: NativeEnrollmentCredential) throws { throw NativeEnrollmentFailure.unavailable }
    func removePending() {}
    func removeActive() { active = nil }
    func removeAll() { active = nil }
}

private actor HomeAppearanceRejectTransport: NativeEnrollmentTransporting {
    let probe: HomeAppearanceProbe
    init(probe: HomeAppearanceProbe) { self.probe = probe }
    func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) async throws -> NativeClient {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
    func recover(_ pending: PendingNativeEnrollment) async throws -> NativeClient? {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
    func logout(_ credential: NativeEnrollmentCredential) async throws {
        await probe.calledTransport()
        throw NativeEnrollmentFailure.unavailable
    }
}
#endif
