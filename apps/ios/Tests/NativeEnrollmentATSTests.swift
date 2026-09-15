import XCTest

@testable import Ellie

final class NativeEnrollmentATSTests: XCTestCase {
  func testRequestedAccessDescriptionsCoverBrowserOnlyMixedAndInvalidScopes() {
    XCTAssertEqual(
      nativeEnrollmentAccessDescription(
        NativeGrant(target: "mac", capabilities: ["browser.read", "browser.control"])),
      "Read the current browser page, Control the current browser page")
    XCTAssertEqual(
      nativeEnrollmentAccessDescription(
        NativeGrant(
          target: "mac", capabilities: ["browser.control", "app.open", "browser.read"])),
      "Control the current browser page, Open applications, Read the current browser page")
    XCTAssertNil(
      nativeEnrollmentAccessDescription(
        NativeGrant(target: "mac", capabilities: ["browser.read", "unknown"])))
    XCTAssertNil(
      nativeEnrollmentAccessDescription(
        NativeGrant(target: "mac", capabilities: ["browser.read", "browser.read"])))
    XCTAssertNil(
      nativeEnrollmentAccessDescription(NativeGrant(target: "mac", capabilities: [])))
  }

  func testProductionTransportConnectsToPinnedLocalHTTPSUnderATS() async throws {
    let diagnostics = NativeATSDiagnostics()
    let bundle = try XCTUnwrap(Bundle.allBundles.first { $0.bundleURL.pathExtension == "xctest" })
    let originText = try XCTUnwrap(
      bundle.object(forInfoDictionaryKey: "EllieATSTestOrigin") as? String)
    let pin = try XCTUnwrap(bundle.object(forInfoDictionaryKey: "EllieATSTestPin") as? String)
    guard !originText.isEmpty, !pin.isEmpty else {
      return XCTFail("ATS fixture settings are required")
    }
    let origin = try XCTUnwrap(URL(string: originText))
    let pending = PendingNativeEnrollment(
      origin: origin,
      certificateSha256: pin,
      label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64)
    )
    let enrollmentTransport = NativeEnrollmentTransport(
      diagnostic: {
        diagnostics.record($0)
      })
    let client = try await diagnosed("session recovery", diagnostics: diagnostics) {
      try await enrollmentTransport.recover(pending)
    }
    let activeClient = try XCTUnwrap(client)
    let credential = NativeEnrollmentCredential(
      origin: origin, certificateSha256: pin, client: activeClient, token: pending.candidateToken)
    let controls = PhoneControlTransport(
      inventoryTransport: NativeEnrollmentTransport(
        timeout: 10, diagnostic: { diagnostics.record($0) }),
      commandTransport: NativeEnrollmentTransport(
        timeout: 45, diagnostic: { diagnostics.record($0) }))
    let nodes = try await diagnosed("node inventory", diagnostics: diagnostics) {
      try await controls.nodes(for: credential)
    }
    XCTAssertEqual(
      nodes,
      [
        PhoneControlNode(
          id: "studio-mac", label: "Studio Mac", online: true, capabilities: ["app.open"])
      ])
    let outcome = try await controls.open(.safari, on: "studio-mac", credential: credential)
    XCTAssertEqual(outcome, .completed)
    do {
      _ = try await controls.open(.arc, on: "other-mac", credential: credential)
      XCTFail("Ungrant target accepted")
    } catch { XCTAssertEqual(error as? PhoneControlFailure, .rejected) }

    let wrongPin = PendingNativeEnrollment(
      origin: origin, certificateSha256: String(repeating: "0", count: 64), label: pending.label,
      grants: pending.grants, candidateToken: pending.candidateToken)
    _ = diagnostics.take()
    do {
      _ = try await enrollmentTransport.recover(wrongPin)
      XCTFail("Wrong pin accepted")
    } catch {
      XCTAssertEqual(error as? NativeEnrollmentFailure, .trustFailed)
      XCTAssertEqual(diagnostics.take(), .trustRejected)
    }

    let wrongHost = PendingNativeEnrollment(
      origin: URL(string: "https://localhost:\(origin.port!)")!, certificateSha256: pin,
      label: pending.label, grants: pending.grants, candidateToken: pending.candidateToken)
    do {
      _ = try await NativeEnrollmentTransport(timeout: 3).recover(wrongHost)
      XCTFail("Wrong hostname accepted")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .trustFailed) }

    try await diagnosed("logout", diagnostics: diagnostics) {
      try await NativeEnrollmentTransport(
        timeout: 3, diagnostic: { diagnostics.record($0) }
      ).logout(credential)
    }
    do {
      _ = try await controls.nodes(for: credential)
      XCTFail("Revoked credential accepted")
    } catch { XCTAssertEqual(error as? PhoneControlFailure, .revoked) }
  }
}

private final class NativeATSDiagnostics: @unchecked Sendable {
  private let lock = NSLock()
  private var category: NativeTransportFailureCategory?

  func record(_ category: NativeTransportFailureCategory) {
    lock.lock()
    self.category = category
    lock.unlock()
  }

  func take() -> NativeTransportFailureCategory? {
    lock.lock()
    defer { lock.unlock() }
    let result = category
    category = nil
    return result
  }
}

private func diagnosed<T>(
  _ stage: String, diagnostics: NativeATSDiagnostics,
  operation: () async throws -> T
) async throws -> T {
  _ = diagnostics.take()
  do {
    return try await operation()
  } catch {
    let category = diagnostics.take()?.rawValue ?? "non-network"
    XCTFail("Synthetic ATS \(stage) failed (\(category)).")
    throw error
  }
}
