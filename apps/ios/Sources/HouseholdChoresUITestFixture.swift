#if DEBUG
import Combine
import Foundation
import SwiftUI

@MainActor
struct HouseholdChoresUITestFixtureView: View {
  @StateObject private var sync: HouseholdChoresSyncStore
  @StateObject private var transport: HouseholdChoresUITestTransport

  init() {
    let transport = HouseholdChoresUITestTransport()
    _transport = StateObject(wrappedValue: transport)
    _sync = StateObject(wrappedValue: HouseholdChoresSyncStore(
      credential: Self.credential, transport: transport,
      persistence: HouseholdChoresUITestPending()))
  }

  var body: some View {
    NavigationStack {
      HouseholdChoresView(credential: Self.credential, sync: sync)
    }
    .overlay(alignment: .bottomTrailing) {
      VStack(alignment: .trailing, spacing: 2) {
        Text("Fixture chore PUTs: \(transport.saveCount)")
          .accessibilityIdentifier("household-chores-fixture-puts")
        Text("Fixture chore GETs: \(transport.readCount)")
          .accessibilityIdentifier("household-chores-fixture-reads")
        Text("Fixture chore revision: \(transport.committedRevision)")
          .accessibilityIdentifier("household-chores-fixture-revision")
        if transport.saveHeld {
          Button("Release synthetic save") { transport.releaseSave() }
            .accessibilityIdentifier("household-chores-fixture-release")
        }
      }
      .font(.caption2)
      .padding(4)
    }
  }

  private static let credential = NativeEnrollmentCredential(
    origin: URL(string: "https://127.0.0.1:8444")!,
    certificateSha256: String(repeating: "a", count: 64),
    client: NativeClient(
      id: "household-fixture-phone", role: "native_phone_controller", label: "Fixture phone",
      grants: [], createdAt: 1, expiresAt: 7_776_000_001),
    token: String(repeating: "b", count: 64))
}

private final class HouseholdChoresUITestPending: PendingChoresDraftPersisting, @unchecked Sendable {
  private var saved: PendingChoresDraft?
  func load() throws -> PendingChoresDraft? { saved }
  func save(_ draft: PendingChoresDraft) throws { saved = draft }
  func clear() throws { saved = nil }
}

@MainActor
private final class HouseholdChoresUITestTransport: ObservableObject, HouseholdChoresTransporting {
  @Published private(set) var saveCount = 0
  @Published private(set) var readCount = 0
  @Published private(set) var saveHeld = false
  @Published private(set) var committedRevision = 7
  private var release: CheckedContinuation<Void, Never>?
  private var document = HouseholdChoresDocument(
    revision: 7,
    value: ChoresState(householdTimeZone: "UTC", chores: [
      Chore(id: "11111111-1111-4111-8111-111111111111", title: "Household laundry",
        member: "Alex", dueDay: try! ChoreDay("2026-09-18")),
    ]))

  func authority(_ credential: NativeEnrollmentCredential) async throws -> [HouseholdDashboardGrant] {
    [HouseholdDashboardGrant(clientId: credential.client.id, profile: .shared,
      kind: "chores", access: .write)]
  }

  func read(_ credential: NativeEnrollmentCredential) async throws -> HouseholdChoresDocument {
    readCount += 1
    return document
  }

  func save(_ draft: PendingChoresDraft, credential: NativeEnrollmentCredential) async throws
    -> ChoresSyncSaveResult {
    saveCount += 1
    saveHeld = true
    await withCheckedContinuation { release = $0 }
    saveHeld = false
    document = HouseholdChoresDocument(revision: draft.baseRevision + 1, value: draft.value)
    committedRevision = Int(document.revision)
    return .saved(document)
  }

  func releaseSave() {
    release?.resume()
    release = nil
  }
}
#endif
