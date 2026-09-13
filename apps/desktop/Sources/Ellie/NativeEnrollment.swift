import Darwin
import Foundation
import Security

struct NativeGrant: Codable, Equatable, Sendable {
  let target: String
  let capabilities: [String]
}

struct NativePairingPayload: Codable, Equatable, Sendable {
  static let prefix = "ellie-native:v1:"
  static let maximumEnvelopeBytes = 2_300
  static let maximumJSONBytes = 4_096
  let version: Int
  let origin: URL
  let certificateSha256: String
  let invitation: String
  let expiresAt: Int64
  let label: String
  let grants: [NativeGrant]

  static func parse(_ envelope: String) throws -> Self {
    guard envelope.utf8.count <= maximumEnvelopeBytes, envelope.hasPrefix(prefix) else {
      throw NativeEnrollmentFailure.invalidCode
    }
    let encoded = String(envelope.dropFirst(prefix.count))
    guard !encoded.isEmpty,
      encoded.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil
    else { throw NativeEnrollmentFailure.invalidCode }
    var base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    guard let data = Data(base64Encoded: base64), data.count <= maximumJSONBytes,
      data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
        of: "/", with: "_"
      ).replacingOccurrences(of: "=", with: "") == encoded,
      String(data: data, encoding: .utf8) != nil,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys)
        == Set([
          "version", "origin", "certificateSha256", "invitation", "expiresAt", "label", "grants",
        ]),
      let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
      version.intValue == 1,
      let originText = object["origin"] as? String, let origin = canonicalNativeOrigin(originText),
      let pin = object["certificateSha256"] as? String, isNativeHexToken(pin),
      let invitation = object["invitation"] as? String, isNativeHexToken(invitation),
      let expires = object["expiresAt"] as? NSNumber, CFGetTypeID(expires) != CFBooleanGetTypeID(),
      expires.doubleValue.rounded() == expires.doubleValue, expires.doubleValue >= 0,
      expires.doubleValue <= 9_007_199_254_740_991,
      let label = object["label"] as? String, validNativeLabel(label),
      let rawGrants = object["grants"] as? [[String: Any]], (1...16).contains(rawGrants.count)
    else { throw NativeEnrollmentFailure.invalidCode }
    let grants = try validateNativeGrants(
      rawGrants.map { raw in
        guard Set(raw.keys) == Set(["target", "capabilities"]),
          let target = raw["target"] as? String,
          let capabilities = raw["capabilities"] as? [String]
        else { throw NativeEnrollmentFailure.invalidCode }
        return NativeGrant(target: target, capabilities: capabilities)
      })
    let result = Self(
      version: 1, origin: origin, certificateSha256: pin, invitation: invitation,
      expiresAt: expires.int64Value, label: label, grants: grants)
    guard canonicalJSON(result) == data else { throw NativeEnrollmentFailure.invalidCode }
    return result
  }
}

struct NativeClient: Codable, Equatable, Sendable {
  let id: String
  let role: String
  let label: String
  let grants: [NativeGrant]
  let createdAt: Int64
  let expiresAt: Int64
}

struct PendingNativeEnrollment: Codable, Equatable, Sendable {
  let origin: URL
  let certificateSha256: String
  let label: String
  let grants: [NativeGrant]
  let candidateToken: String
}
struct NativeEnrollmentCredential: Codable, Equatable, Sendable {
  let origin: URL
  let certificateSha256: String
  let client: NativeClient
  let token: String
}

enum StoredNativeEnrollment: Codable, Equatable, Sendable {
  case pending(PendingNativeEnrollment)
  case active(NativeEnrollmentCredential)
  enum CodingKeys: String, CodingKey { case version, state, value }
  func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(1, forKey: .version)
    switch self {
    case .pending(let value):
      try container.encode("pending", forKey: .state)
      try container.encode(value, forKey: .value)
    case .active(let value):
      try container.encode("active", forKey: .state)
      try container.encode(value, forKey: .value)
    }
  }
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard try container.decode(Int.self, forKey: .version) == 1 else {
      throw NativeEnrollmentFailure.unavailable
    }
    switch try container.decode(String.self, forKey: .state) {
    case "pending":
      self = .pending(try container.decode(PendingNativeEnrollment.self, forKey: .value))
    case "active":
      self = .active(try container.decode(NativeEnrollmentCredential.self, forKey: .value))
    default: throw NativeEnrollmentFailure.unavailable
    }
  }
}

enum NativeEnrollmentFailure: Error, Equatable, LocalizedError {
  case invalidCode, expiredCode, rejected, unavailable, credentialUnavailable, credentialInvalid,
    credentialExpired, invalidResponse, trustFailed, uncertain, cancelled
  var errorDescription: String? {
    switch self {
    case .invalidCode: "This is not a valid Ellie enrollment code."
    case .expiredCode: "This enrollment invitation has expired. Ask a controller for a new one."
    case .rejected: "The coordinator rejected enrollment. Ask a controller for a new invitation."
    case .unavailable: "The coordinator could not be reached."
    case .credentialUnavailable:
      "The saved pairing is unavailable. Unlock this iPhone and try again."
    case .credentialInvalid: "The saved pairing is damaged and cannot be used."
    case .credentialExpired: "The saved pairing has expired. Remove it before pairing again."
    case .invalidResponse: "The coordinator returned an invalid enrollment response."
    case .trustFailed: "The coordinator identity did not match the enrollment code."
    case .uncertain:
      "Pairing may have completed. Use Recover; do not scan or submit the invitation again."
    case .cancelled: "Enrollment stopped."
    }
  }
}

protocol NativeCredentialVault: Sendable {
  func loadPending() async throws -> PendingNativeEnrollment?
  func loadActive() async throws -> NativeEnrollmentCredential?
  func savePending(_ value: PendingNativeEnrollment) async throws
  func promote(_ value: NativeEnrollmentCredential) async throws
  func removePending() async throws
  func removeActive() async throws
  func removeAll() async throws
}

actor KeychainNativeCredentialVault: NativeCredentialVault {
  private let service: String
  private let account: String
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  init(
    service: String = "org.ellie.dashboard.ios.native-enrollment.v1",
    account: String = "enrollment.v1"
  ) {
    self.service = service
    self.account = account
  }
  func loadPending() throws -> PendingNativeEnrollment? {
    if case .pending(let value) = try read() { value } else { nil }
  }
  func loadActive() throws -> NativeEnrollmentCredential? {
    if case .active(let value) = try read() { value } else { nil }
  }
  func savePending(_ value: PendingNativeEnrollment) throws {
    try write(encoder.encode(StoredNativeEnrollment.pending(value)))
  }
  func promote(_ value: NativeEnrollmentCredential) throws {
    try write(encoder.encode(StoredNativeEnrollment.active(value)))
  }
  func removePending() throws { if case .pending = try read() { try remove() } }
  func removeActive() throws { if case .active = try read() { try remove() } }
  func removeAll() throws { try remove() }
  private func query(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
  private func read() throws -> StoredNativeEnrollment? {
    var q = query(account)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw NativeEnrollmentFailure.credentialUnavailable
    }
    guard data.count <= 8_192, storedEnvelopeHasExactShape(data) else {
      throw NativeEnrollmentFailure.credentialInvalid
    }
    do { return try decoder.decode(StoredNativeEnrollment.self, from: data) } catch {
      throw NativeEnrollmentFailure.credentialInvalid
    }
  }
  private func write(_ data: Data) throws {
    var add = query(account)
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard
        SecItemUpdate(
          query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
          == errSecSuccess
      else { throw NativeEnrollmentFailure.credentialUnavailable }
    } else if status != errSecSuccess {
      throw NativeEnrollmentFailure.credentialUnavailable
    }
  }
  private func remove() throws {
    let status = SecItemDelete(query(account) as CFDictionary)
    if status != errSecSuccess && status != errSecItemNotFound {
      throw NativeEnrollmentFailure.credentialUnavailable
    }
  }
}

private func storedEnvelopeHasExactShape(_ data: Data) -> Bool {
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["version", "state", "value"]),
    let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
    version.intValue == 1,
    let state = object["state"] as? String, let value = object["value"] as? [String: Any]
  else { return false }
  func grants(_ raw: Any?) -> Bool {
    guard let values = raw as? [[String: Any]] else { return false }
    return values.allSatisfy { Set($0.keys) == Set(["target", "capabilities"]) }
  }
  if state == "pending" {
    return Set(value.keys)
      == Set(["origin", "certificateSha256", "label", "grants", "candidateToken"])
      && grants(value["grants"])
  }
  guard state == "active",
    Set(value.keys) == Set(["origin", "certificateSha256", "client", "token"]),
    let client = value["client"] as? [String: Any],
    Set(client.keys) == Set(["id", "role", "label", "grants", "createdAt", "expiresAt"])
  else { return false }
  return grants(client["grants"])
}

private func canonicalJSON(_ payload: NativePairingPayload) -> Data? {
  func quote(_ value: String) -> String? {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: [value], options: [.withoutEscapingSlashes]),
      let text = String(data: data, encoding: .utf8)
    else { return nil }
    return String(text.dropFirst().dropLast())
  }
  guard let origin = quote(payload.origin.absoluteString),
    let pin = quote(payload.certificateSha256),
    let invitation = quote(payload.invitation), let label = quote(payload.label)
  else { return nil }
  var encodedGrants: [String] = []
  for grant in payload.grants {
    guard let target = quote(grant.target) else { return nil }
    encodedGrants.append(#"{"target":\#(target),"capabilities":["app.open"]}"#)
  }
  return
    #"{"version":1,"origin":\#(origin),"certificateSha256":\#(pin),"invitation":\#(invitation),"expiresAt":\#(payload.expiresAt),"label":\#(label),"grants":[\#(encodedGrants.joined(separator: ","))]}"#
    .data(using: .utf8)
}

protocol NativeEnrollmentTransporting: Sendable {
  func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) async throws
    -> NativeClient
  func recover(_ pending: PendingNativeEnrollment) async throws -> NativeClient?
  func logout(_ credential: NativeEnrollmentCredential) async throws
}

func isNativeHexToken(_ value: String) -> Bool {
  let bytes = value.utf8
  return bytes.count == 64 && bytes.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
func validNativeIdentifier(_ value: String) -> Bool {
  let bytes = value.utf8
  guard (1...100).contains(bytes.count), let first = bytes.first,
    (48...57).contains(first) || (65...90).contains(first) || (97...122).contains(first)
  else { return false }
  return bytes.dropFirst().allSatisfy {
    (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 46
      || $0 == 95 || $0 == 45
  }
}
func validNativeLabel(_ value: String) -> Bool {
  value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    && (1...64).contains(value.unicodeScalars.count)
    && value.unicodeScalars.allSatisfy {
      switch $0.properties.generalCategory {
      case .control, .format, .surrogate, .privateUse, .unassigned: false
      default: true
      }
    }
}
func validateNativeGrants(_ grants: [NativeGrant]) throws -> [NativeGrant] {
  guard (1...16).contains(grants.count),
    grants.allSatisfy({ validNativeIdentifier($0.target) && $0.capabilities == ["app.open"] }),
    Set(grants.map(\.target)).count == grants.count
  else { throw NativeEnrollmentFailure.invalidCode }
  return grants
}
func canonicalNativeOrigin(_ value: String) -> URL? {
  guard value.utf8.count <= 2_048, value.hasPrefix("https://"), let url = URL(string: value),
    url.scheme == "https", !value.dropFirst(8).isEmpty,
    url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil
  else { return nil }
  let authority = value.dropFirst(8)
  let bareHost: String
  if authority.first == "[" {
    guard let close = authority.firstIndex(of: "]") else { return nil }
    bareHost = String(authority[authority.index(after: authority.startIndex)..<close])
    let suffix = authority[authority.index(after: close)...]
    guard suffix.isEmpty || (suffix.first == ":" && suffix.dropFirst().allSatisfy(\.isNumber))
    else { return nil }
  } else {
    let pieces = authority.split(separator: ":", omittingEmptySubsequences: false)
    guard pieces.count <= 2 else { return nil }
    bareHost = String(pieces[0])
    if pieces.count == 2 {
      guard !pieces[1].isEmpty, pieces[1].allSatisfy(\.isNumber) else { return nil }
    }
  }
  guard !bareHost.isEmpty else { return nil }
  var address4 = in_addr()
  var address6 = in6_addr()
  var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
  let normalizedHost: String
  if inet_pton(AF_INET, bareHost, &address4) == 1 {
    guard inet_ntop(AF_INET, &address4, &buffer, socklen_t(buffer.count)) != nil else { return nil }
    normalizedHost = String(cString: buffer)
  } else if inet_pton(AF_INET6, bareHost, &address6) == 1 {
    guard inet_ntop(AF_INET6, &address6, &buffer, socklen_t(buffer.count)) != nil else {
      return nil
    }
    normalizedHost = "[\(String(cString: buffer))]"
  } else {
    // Foundation accepts legacy numeric IPv4 spellings which browsers normalize
    // to a different host. Native pairing requires the literal canonical host.
    let finalLabel =
      bareHost.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? ""
    let decimal =
      !finalLabel.isEmpty
      && finalLabel.unicodeScalars.allSatisfy(CharacterSet.decimalDigits.contains)
    let hexadecimal =
      finalLabel.lowercased().hasPrefix("0x") && finalLabel.count > 2
      && finalLabel.dropFirst(2).unicodeScalars.allSatisfy(
        CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains)
    if decimal || hexadecimal { return nil }
    guard url.host == bareHost else { return nil }
    normalizedHost = bareHost.lowercased()
  }
  let port = url.port
  guard port == nil || (1...65_535).contains(port!), port != 443 else { return nil }
  let canonical = "https://\(normalizedHost)" + (port.map { ":\($0)" } ?? "")
  return canonical == value ? url : nil
}
