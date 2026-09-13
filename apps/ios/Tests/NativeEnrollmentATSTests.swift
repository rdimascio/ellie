import XCTest

@testable import Ellie

final class NativeEnrollmentATSTests: XCTestCase {
  func testProductionTransportConnectsToPinnedLocalHTTPSUnderATS() async throws {
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
    let client = try await NativeEnrollmentTransport(timeout: 3).recover(pending)
    let activeClient = try XCTUnwrap(client)
    let credential = NativeEnrollmentCredential(
      origin: origin, certificateSha256: pin, client: activeClient, token: pending.candidateToken)
    let controls = PhoneControlTransport()
    let nodes = try await controls.nodes(for: credential)
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
    do {
      _ = try await NativeEnrollmentTransport(timeout: 3).recover(wrongPin)
      XCTFail("Wrong pin accepted")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .trustFailed) }

    let wrongHost = PendingNativeEnrollment(
      origin: URL(string: "https://localhost:\(origin.port!)")!, certificateSha256: pin,
      label: pending.label, grants: pending.grants, candidateToken: pending.candidateToken)
    do {
      _ = try await NativeEnrollmentTransport(timeout: 3).recover(wrongHost)
      XCTFail("Wrong hostname accepted")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .trustFailed) }

    try await NativeEnrollmentTransport(timeout: 3).logout(credential)
    do {
      _ = try await controls.nodes(for: credential)
      XCTFail("Revoked credential accepted")
    } catch { XCTAssertEqual(error as? PhoneControlFailure, .revoked) }
  }
}
