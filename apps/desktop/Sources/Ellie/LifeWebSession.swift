import Foundation
import Security

struct LifeWebCredential: Equatable, Sendable {
  let origin: URL
  let certificateSha256: String
  let bearer: String
  let credentialExpiresAt: Int64?

  init(enrollment: NativeEnrollmentCredential) {
    origin = enrollment.origin
    certificateSha256 = enrollment.certificateSha256
    bearer = enrollment.token
    credentialExpiresAt = enrollment.client.expiresAt
  }

}

struct LifeWebSession: Equatable, Sendable {
  let token: String
  let expiresAt: Int64
  let entryURL: URL

  static func decode(
    _ data: Data, credential: LifeWebCredential, now: Date = Date()
  ) throws -> LifeWebSession {
    guard data.count <= 4_096,
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == Set(["sessionToken", "expiresAt", "entryPath"]),
      let token = value["sessionToken"] as? String,
      token.utf8.count == 64,
      token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      let expires = value["expiresAt"] as? NSNumber,
      CFGetTypeID(expires) != CFBooleanGetTypeID(),
      let entryPath = value["entryPath"] as? String, entryPath == "/life/",
      let entryURL = URL(string: entryPath, relativeTo: credential.origin)?.absoluteURL,
      entryURL.scheme == "https", entryURL.host == credential.origin.host,
      entryURL.port == credential.origin.port
    else { throw LifeWebSessionFailure.invalidResponse }
    let milliseconds = expires.int64Value
    guard Double(milliseconds) == expires.doubleValue else {
      throw LifeWebSessionFailure.invalidResponse
    }
    let current = Int64(now.timeIntervalSince1970 * 1_000)
    let maximum = min(current + 30 * 60 * 1_000, credential.credentialExpiresAt ?? .max)
    guard milliseconds > current, milliseconds <= maximum else {
      throw LifeWebSessionFailure.invalidResponse
    }
    return LifeWebSession(token: token, expiresAt: milliseconds, entryURL: entryURL)
  }

  static func decodeHTTP(
    status: Int, data: Data, credential: LifeWebCredential, now: Date = Date()
  ) throws -> LifeWebSession {
    switch status {
    case 200: return try decode(data, credential: credential, now: now)
    case 401: throw LifeWebSessionFailure.revoked
    case 403: throw LifeWebSessionFailure.grantRequired
    default: throw LifeWebSessionFailure.unavailable
    }
  }

  static func checkHTTP(status: Int, data: Data) throws {
    if status == 401 { throw LifeWebSessionFailure.revoked }
    if status == 403 { throw LifeWebSessionFailure.grantRequired }
    guard status == 200, data.count <= 128,
      let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == ["allowed"],
      let allowed = value["allowed"] as? NSNumber,
      CFGetTypeID(allowed) == CFBooleanGetTypeID(), allowed.boolValue
    else { throw LifeWebSessionFailure.unavailable }
  }

  func cookie(for origin: URL) throws -> HTTPCookie {
    guard origin.scheme == "https",
      let cookie = HTTPCookie(properties: [
        .originURL: origin, .path: "/", .name: "__Host-ellie_life", .value: token,
        .secure: "TRUE", .expires: Date(timeIntervalSince1970: Double(expiresAt) / 1_000),
        HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        HTTPCookiePropertyKey("SameSite"): "Strict",
      ])
    else { throw LifeWebSessionFailure.invalidResponse }
    return cookie
  }

  func renewalDate(now: Date) -> (date: Date, renew: Bool) {
    let expiry = Date(timeIntervalSince1970: Double(expiresAt) / 1_000)
    return expiry.timeIntervalSince(now) > 120
      ? (expiry.addingTimeInterval(-60), true) : (expiry, false)
  }
}

enum LifeWebSessionFailure: Error, Equatable {
  case grantRequired
  case revoked
  case invalidResponse
  case unavailable
}

protocol LifeWebSessionAuthorizing: Sendable {
  func authorize(_ credential: LifeWebCredential) async throws -> LifeWebSession
  func check(_ credential: LifeWebCredential) async throws
}

struct NativeLifeWebSessionAuthorizer: LifeWebSessionAuthorizing {
  let transport: NativeEnrollmentTransport
  let now: @Sendable () -> Date

  init(
    transport: NativeEnrollmentTransport = NativeEnrollmentTransport(),
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.transport = transport
    self.now = now
  }

  func authorize(_ credential: LifeWebCredential) async throws -> LifeWebSession {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: "Ellie Life", grants: [], candidateToken: credential.bearer)
    do {
      let (data, response) = try await transport.requestEnvelope(
        path: "/native/v1/life/session", method: "POST", body: Data("{}".utf8),
        bearer: credential.bearer, pending: pending, maximumBytes: 4_096)
      return try LifeWebSession.decodeHTTP(
        status: response.statusCode, data: data, credential: credential, now: now())
    } catch let failure as LifeWebSessionFailure { throw failure }
    catch let failure as NativeEnrollmentFailure where failure == .trustFailed {
      throw LifeWebSessionFailure.unavailable
    } catch { throw LifeWebSessionFailure.unavailable }
  }

  func check(_ credential: LifeWebCredential) async throws {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: "Ellie Life", grants: [], candidateToken: credential.bearer)
    do {
      let (data, response) = try await transport.requestEnvelope(
        path: "/native/v1/life/session", method: "GET", body: nil,
        bearer: credential.bearer, pending: pending, maximumBytes: 128)
      try LifeWebSession.checkHTTP(status: response.statusCode, data: data)
    } catch let failure as LifeWebSessionFailure { throw failure }
    catch { throw LifeWebSessionFailure.unavailable }
  }
}

enum LifeWebNavigationPolicy {
  static func allows(_ url: URL, mainFrame: Bool, origin: URL) -> Bool {
    if !mainFrame && url.absoluteString == "about:srcdoc" { return true }
    guard url.scheme == "https", url.host == origin.host, url.port == origin.port,
      url.user == nil, url.password == nil
    else { return false }
    if mainFrame { return url.path == "/life" || url.path.hasPrefix("/life/") }
    let components = url.path.split(separator: "/")
    return components.count == 5 && components[0] == "api" && components[1] == "life"
      && components[2] == "plugins" && components[4] == "view"
  }
}
