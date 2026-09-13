import Security
import XCTest

@testable import Ellie

final class NativeCredentialVaultIOSTests: XCTestCase {
  func testPendingPersistsAcrossVaultReopen() async throws {
    let namespace = KeychainTestNamespace()
    defer { namespace.cleanUp() }
    let pending = makePending()

    try await KeychainNativeCredentialVault(service: namespace.service, account: namespace.account)
      .savePending(pending)

    let reopened = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)
    let reopenedPending = try await reopened.loadPending()
    let reopenedActive = try await reopened.loadActive()
    XCTAssertEqual(reopenedPending, pending)
    XCTAssertNil(reopenedActive)
  }

  func testPromotionReplacesPendingWithDeviceOnlyActiveCredential() async throws {
    let namespace = KeychainTestNamespace()
    defer { namespace.cleanUp() }
    let pending = makePending()
    let active = makeActive(from: pending)
    let vault = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)

    try await vault.savePending(pending)
    try await vault.promote(active)

    let reopened = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)
    let reopenedPending = try await reopened.loadPending()
    let reopenedActive = try await reopened.loadActive()
    XCTAssertNil(reopenedPending)
    XCTAssertEqual(reopenedActive, active)
    XCTAssertEqual(
      try namespace.accessibility(), kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
  }

  func testExplicitRemovalPreservesSecondOwnedIdentity() async throws {
    let namespace = KeychainTestNamespace()
    defer { namespace.cleanUp() }
    try namespace.addSentinel()
    let pending = makePending()
    let vault = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)

    try await vault.savePending(pending)
    try await vault.removePending()
    let removedPending = try await vault.loadPending()
    XCTAssertNil(removedPending)
    XCTAssertEqual(try namespace.sentinel(), namespace.sentinelData)

    try await vault.savePending(pending)
    try await vault.promote(makeActive(from: pending))
    try await vault.removeActive()
    let removedActive = try await vault.loadActive()
    XCTAssertNil(removedActive)
    XCTAssertEqual(try namespace.sentinel(), namespace.sentinelData)
  }

  func testMalformedOwnedEnvelopeCanBeRemovedAndRecreatedWithoutTouchingSentinel() async throws {
    let namespace = KeychainTestNamespace()
    defer { namespace.cleanUp() }
    try namespace.addSentinel()
    try namespace.addPrimary(Data(#"{"version":1,"state":"pending","value":{}}"#.utf8))
    let vault = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)

    do {
      _ = try await vault.loadPending()
      XCTFail("Malformed owned credential was accepted")
    } catch {
      XCTAssertEqual(error as? NativeEnrollmentFailure, .credentialInvalid)
    }

    try await vault.removeAll()
    let removedPending = try await vault.loadPending()
    XCTAssertNil(removedPending)
    XCTAssertEqual(try namespace.sentinel(), namespace.sentinelData)

    let pending = makePending()
    try await vault.savePending(pending)
    let reopened = KeychainNativeCredentialVault(
      service: namespace.service, account: namespace.account)
    let reopenedPending = try await reopened.loadPending()
    XCTAssertEqual(reopenedPending, pending)
    XCTAssertEqual(try namespace.sentinel(), namespace.sentinelData)
  }

  private func makePending() -> PendingNativeEnrollment {
    PendingNativeEnrollment(
      origin: URL(string: "https://127.0.0.1:8444")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Synthetic iPhone",
      grants: [NativeGrant(target: "synthetic-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
  }

  private func makeActive(from pending: PendingNativeEnrollment) -> NativeEnrollmentCredential {
    NativeEnrollmentCredential(
      origin: pending.origin, certificateSha256: pending.certificateSha256,
      client: NativeClient(
        id: "synthetic-client", role: "native_phone_controller", label: pending.label,
        grants: pending.grants, createdAt: 1_893_456_000_000,
        expiresAt: 1_901_232_000_000),
      token: pending.candidateToken)
  }
}

private struct KeychainTestNamespace {
  let service = "org.ellie.tests.native-enrollment.\(UUID().uuidString)"
  let account = "enrollment"
  let sentinelAccount = "sentinel"
  let sentinelData = Data("owned-sentinel".utf8)

  func addPrimary(_ data: Data) throws { try add(data, account: account) }
  func addSentinel() throws { try add(sentinelData, account: sentinelAccount) }

  func sentinel() throws -> Data? {
    var query = baseQuery(account: sentinelAccount)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw KeychainTestError(status)
    }
    return data
  }

  func accessibility() throws -> String {
    var query = baseQuery(account: account)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let attributes = result as? [String: Any],
      let accessibility = attributes[kSecAttrAccessible as String] as? String
    else { throw KeychainTestError(status) }
    return accessibility
  }

  func cleanUp() {
    SecItemDelete(baseQuery(account: account) as CFDictionary)
    SecItemDelete(baseQuery(account: sentinelAccount) as CFDictionary)
  }

  private func add(_ data: Data, account: String) throws {
    var query = baseQuery(account: account)
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainTestError(status) }
  }

  private func baseQuery(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}

private struct KeychainTestError: Error {
  let status: OSStatus
  init(_ status: OSStatus) { self.status = status }
}
