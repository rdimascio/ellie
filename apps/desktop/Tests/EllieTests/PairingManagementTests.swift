import XCTest
import Vision

@testable import Ellie

private actor PairingFixture: CoordinatorManaging {
  var calls: [String] = []
  func recordedCalls() -> [String] { calls }
  func createNativeInvitation(connection: CoordinatorConnection, label: String, nodeIDs: [String])
    async throws -> NativeInvitation
  {
    calls.append("invite:\(label):\(nodeIDs.joined(separator: ","))")
    return NativeInvitation(
      label: label,
      grants: nodeIDs.map { ManagedNativeGrant(target: $0, capabilities: ["app.open"]) },
      expiresAt: Date(timeIntervalSince1970: 600), qr: "ellie-native:v1:test")
  }
  func nativeClients(connection: CoordinatorConnection) async throws -> [ManagedNativeClient] {
    calls.append("clients")
    return [
      ManagedNativeClient(
        id: "phone-1", role: "native_phone_controller", label: "Kitchen phone",
        grants: [ManagedNativeGrant(target: "mac-1", capabilities: ["app.open"])], createdAt: 0,
        expiresAt: 1000)
    ]
  }
  func revokeNativeClient(connection: CoordinatorConnection, id: String) async throws -> Bool {
    calls.append("revoke:\(id)")
    return true
  }
}
private actor SlowRevokeFixture: CoordinatorManaging {
  func createNativeInvitation(connection: CoordinatorConnection, label: String, nodeIDs: [String])
    async throws -> NativeInvitation
  {
    NativeInvitation(
      label: label,
      grants: nodeIDs.map { ManagedNativeGrant(target: $0, capabilities: ["app.open"]) },
      expiresAt: Date().addingTimeInterval(600), qr: "ellie-native:v1:test")
  }
  func nativeClients(connection: CoordinatorConnection) async throws -> [ManagedNativeClient] { [] }
  func revokeNativeClient(connection: CoordinatorConnection, id: String) async throws -> Bool {
    try await Task.sleep(for: .seconds(30))
    return true
  }
}
final class PairingManagementTests: XCTestCase {
  func testMaximumEnvelopeQRCodeHasQuietZoneAndDecodesWithVision() throws {
    let envelope = "ellie-native:v1:" + String(repeating: "A", count: 2_284)
    let image = try XCTUnwrap(ManagedPairingQRCode.image(envelope))
    XCTAssertLessThanOrEqual(image.size.width, 370)
    XCTAssertEqual(image.size.width.rounded(), image.size.width)
    var proposed = NSRect(origin: .zero, size: image.size)
    let cgImage = try XCTUnwrap(image.cgImage(forProposedRect: &proposed, context: nil, hints: nil))
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    try VNImageRequestHandler(cgImage: cgImage).perform([request])
    let decoded = try XCTUnwrap((request.results?.first as? VNBarcodeObservation)?.payloadStringValue)
    XCTAssertEqual(decoded, envelope)
  }

  func testInvitationPayloadRequiresCanonicalDelegatedAuthorityAndExactGrantBinding() throws {
    let certificate = Data("synthetic certificate".utf8)
    let pin = String(repeating: "d", count: 64)
    let now = Date(timeIntervalSince1970: 2_000_000)
    let expires = Int64(now.timeIntervalSince1970 * 1_000) + 600_000
    let connection = CoordinatorConnection(
      origin: URL(string: "https://controller.example:8443")!, certificateDER: certificate,
      token: String(repeating: "a", count: 64))
    let grants = [ManagedNativeGrant(target: "mac-1", capabilities: ["app.open"])]
    let canonical = Data(
      #"{"version":1,"origin":"https://listener.example:9443","certificateSha256":"\#(pin)","invitation":"\#(String(repeating: "b", count: 64))","expiresAt":\#(expires),"label":"My phone","grants":[{"target":"mac-1","capabilities":["app.open"]}]}"#
        .utf8)
    let value = try PinnedCoordinatorClient.decodeInvitationPayload(
      canonical, connection: connection, label: "My phone", grants: grants, now: now)
    XCTAssertEqual(value.origin, "https://listener.example:9443")

    for invalid in [
      String(decoding: canonical, as: UTF8.self).replacingOccurrences(
        of: pin, with: String(repeating: "D", count: 64)),
      String(decoding: canonical, as: UTF8.self).replacingOccurrences(of: "mac-1", with: "mac-2"),
      String(decoding: canonical, as: UTF8.self).replacingOccurrences(of: pin, with: pin + #"\n"#),
      String(decoding: canonical, as: UTF8.self).replacingOccurrences(
        of: "https://listener.example:9443", with: "https://LISTENER.example:9443"),
      String(decoding: canonical, as: UTF8.self).dropLast() + #",\"extra\":true}"#,
    ] {
      XCTAssertThrowsError(
        try PinnedCoordinatorClient.decodeInvitationPayload(
          Data(invalid.utf8), connection: connection, label: "My phone", grants: grants, now: now))
    }
  }

  func testManagedIdentifiersRejectTerminalNewlines() {
    XCTAssertTrue(validManagedNativeIdentifier("mac-1"))
    for suffix in ["\n", "\r", "\r\n", " extra"] {
      XCTAssertFalse(validManagedNativeIdentifier("mac-1" + suffix))
    }
  }

  func testClientListRejectsWrongRoleGrantShapeAndLifetime() throws {
    let now = Date(timeIntervalSince1970: 2_000_000)
    let created = Int64(now.timeIntervalSince1970 * 1_000)
    let expires = created + 90 * 24 * 60 * 60 * 1_000
    let valid =
      #"[{"id":"phone-1","role":"native_phone_controller","label":"My phone","grants":[{"target":"mac-1","capabilities":["app.open"]}],"createdAt":\#(created),"expiresAt":\#(expires)}]"#
    XCTAssertEqual(
      try PinnedCoordinatorClient.decodeManagedClients(Data(valid.utf8), now: now).count, 1)
    for invalid in [
      valid.replacingOccurrences(of: "native_phone_controller", with: "controller"),
      valid.replacingOccurrences(of: "app.open", with: "url.open"),
      valid.replacingOccurrences(of: String(expires), with: String(expires + 1)),
      valid.dropLast() + #",{"id":"phone-1"}]"#,
    ] {
      XCTAssertThrowsError(
        try PinnedCoordinatorClient.decodeManagedClients(Data(invalid.utf8), now: now))
    }
  }

  @MainActor func testCancellingRevokeShowsUncertaintyEvenWithVisibleInvitation() async {
    let store = PairingManagementStore(client: SlowRevokeFixture())
    let connection = CoordinatorConnection(
      origin: URL(string: "https://example.test")!, certificateDER: Data(), token: "synthetic")
    store.label = "My phone"
    store.selected = ["mac-1"]
    store.invite(connection)
    await wait { store.invitation != nil }
    store.revoke("phone-1", connection: connection)
    store.cancel()
    XCTAssertEqual(
      store.message,
      "Stopped waiting. Revocation may have completed; refresh clients before trying again.")
    XCTAssertFalse(store.working)
  }

  @MainActor func testExplicitInviteHideListAndRevoke() async {
    let fixture = PairingFixture()
    let store = PairingManagementStore(client: fixture)
    let connection = CoordinatorConnection(
      origin: URL(string: "https://example.test")!, certificateDER: Data(), token: "synthetic")
    store.load(connection)
    await wait { store.clients.count == 1 }
    store.label = "My phone"
    store.selected = ["mac-1"]
    store.invite(connection)
    await wait { store.invitation != nil }
    XCTAssertEqual(
      store.invitation?.grants, [ManagedNativeGrant(target: "mac-1", capabilities: ["app.open"])])
    store.hideInvitation()
    XCTAssertNil(store.invitation)
    XCTAssertTrue(store.message?.contains("remains valid") == true)
    store.revoke("phone-1", connection: connection)
    await wait { store.clients.isEmpty }
    let calls = await fixture.recordedCalls()
    XCTAssertEqual(calls, ["clients", "invite:My phone:mac-1", "revoke:phone-1"])
  }
  @MainActor private func wait(_ condition: @escaping () -> Bool) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
  }
}
