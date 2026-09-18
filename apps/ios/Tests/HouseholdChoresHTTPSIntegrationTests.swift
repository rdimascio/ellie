import Foundation
import XCTest
@testable import Ellie

@MainActor
final class HouseholdChoresHTTPSIntegrationTests: XCTestCase {
  private func credential(_ role: String) throws -> NativeEnrollmentCredential {
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    let origin = try XCTUnwrap(URL(string: try XCTUnwrap(
      bundle.object(forInfoDictionaryKey: "EllieATSTestOrigin") as? String)))
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "EllieATSTestPin") as? String)
    let token = role == "a" ? String(repeating: "ab", count: 32) : String(repeating: "bc", count: 32)
    return NativeEnrollmentCredential(origin: origin, certificateSha256: pin,
      client: NativeClient(id: "chores-client-\(role)", role: "native_phone_controller",
        label: "Synthetic chores \(role)",
        grants: [NativeGrant(target: "chores-fixture-no-node", capabilities: ["app.open"])], createdAt: 1,
        expiresAt: 9_007_199_254_740_000), token: token)
  }

  private func control(_ command: String, _ credential: NativeEnrollmentCredential) async throws {
    let pending = PendingNativeEnrollment(origin: credential.origin,
      certificateSha256: credential.certificateSha256, label: credential.client.label,
      grants: credential.client.grants, candidateToken: credential.token)
    let (_, response) = try await NativeEnrollmentTransport(timeout: 5).requestEnvelope(
      path: "/__ellie-test/chores/\(command)", method: "GET", body: nil,
      bearer: credential.token, pending: pending)
    XCTAssertEqual(response.statusCode, 200, "Synthetic chore control \(command) failed")
  }

  private func waitFor(_ description: String, _ condition: () -> Bool) async throws {
    for _ in 0..<500 {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out waiting for \(description)")
  }

  func testTwoEnrolledClientsUsePinnedProductionChoresWithNoWriteReplay() async throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EllieChoresHTTPS-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    func pending(_ name: String) -> PrivatePendingChoresDraftStore {
      PrivatePendingChoresDraftStore(fileURL: directory.appendingPathComponent("\(name).json"))
    }
    let a = try credential("a"), b = try credential("b")
    let first = HouseholdChoresSyncStore(credential: a, persistence: pending("first"))
    let stale = HouseholdChoresSyncStore(credential: b, persistence: pending("stale"))
    first.checkAccess(); stale.checkAccess()
    try await waitFor("both grants") { first.canWrite && stale.canWrite }
    first.readServerCopy(); stale.readServerCopy()
    try await waitFor("initial revisions") {
      first.remote?.revision == 0 && stale.remote?.revision == 0
    }
    let due = try ChoreDay("2026-09-18")
    stale.prepareAdd(title: "Stale", member: "B", body: "", dueDay: due)
    first.prepareAdd(title: "Bins", member: "A", body: "", dueDay: due)
    first.savePrepared()
    try await waitFor("first conditional write") { first.remote?.revision == 1 && !first.isBusy }
    let fresh = HouseholdChoresSyncStore(credential: b, persistence: pending("fresh"))
    fresh.checkAccess()
    try await waitFor("second client grant") { fresh.canRead }
    fresh.readServerCopy()
    try await waitFor("second client fresh read") { fresh.remote?.revision == 1 }
    XCTAssertEqual(fresh.remote?.value.chores.map(\.title), ["Bins"])
    stale.savePrepared()
    try await waitFor("stale conflict") { stale.phase == .conflict(1) }
    XCTAssertNotNil(stale.draft, "A conflict must retain the reviewed draft")

    first.prepareAdd(title: "Laundry", member: "A", body: "", dueDay: due)
    try await control("arm-drop", a)
    first.savePrepared()
    try await waitFor("dropped response") { first.phase == .unknown }
    // Reconstruct the store from the same private marker; no app-process restart is simulated.
    let restored = HouseholdChoresSyncStore(credential: a, persistence: pending("first"))
    XCTAssertEqual(restored.phase, .unknown)
    restored.savePrepared() // Recovery cannot replay a possibly committed PUT.
    restored.checkAccess()
    try await waitFor("restored grant") { restored.canWrite && !restored.isBusy }
    restored.checkResult()
    try await waitFor("read-only recovery") { restored.phase == .matchedCurrentCopy(2) }
    XCTAssertEqual(restored.remote?.value.chores.map(\.title), ["Bins", "Laundry"])
    restored.savePrepared()

    // A withheld production 200 must not republish private data after explicit cancellation
    // and a real grant revocation. Release may only attempt delivery because cancellation can
    // already have closed the URLSession request.
    try await control("arm-hold", a)
    fresh.readServerCopy()
    try await control("held", a)
    let cancelled = fresh.cancelCurrentRequest()
    try await control("revoke-b", b)
    try await control("release", a)
    await cancelled?.value
    XCTAssertNil(fresh.remote)
    fresh.checkAccess()
    try await waitFor("revoked second client") { fresh.phase == .revoked }
    XCTAssertFalse(fresh.canRead)
  }
}
