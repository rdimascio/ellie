import CryptoKit
import Foundation
import Security

final class NativeEnrollmentTransport: NSObject, NativeEnrollmentTransporting, @unchecked Sendable {
  private let timeout: TimeInterval
  private let now: @Sendable () -> Date
  private let diagnostic: @Sendable (NativeTransportFailureCategory) -> Void
  init(
    timeout: TimeInterval = 10, now: @escaping @Sendable () -> Date = { Date() },
    diagnostic: @escaping @Sendable (NativeTransportFailureCategory) -> Void = { _ in }
  ) {
    self.timeout = timeout
    self.now = now
    self.diagnostic = diagnostic
  }

  func logout(_ credential: NativeEnrollmentCredential) async throws {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    do {
      let _: LogoutResponse = try await request(
        path: "/native/v1/logout", method: "POST", body: Data("{}".utf8), bearer: credential.token,
        pending: pending)
    } catch let failure as NativeEnrollmentFailure
      where failure == .rejected || failure == .trustFailed || failure == .invalidResponse
    { throw failure } catch { throw NativeEnrollmentFailure.uncertain }
  }

  private func request<T: Decodable>(
    path: String, method: String, body: Data?, bearer: String?, pending: PendingNativeEnrollment
  ) async throws -> T {
    let (data, http) = try await requestEnvelope(
      path: path, method: method, body: body, bearer: bearer, pending: pending)
    if http.statusCode == 400 { throw NativeEnrollmentFailure.rejected }
    guard http.statusCode == 200 else { throw HTTPFailure(status: http.statusCode) }
    do {
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NativeEnrollmentFailure.invalidResponse
      }
      let expected = T.self == ClientResponse.self ? Set(["client"]) : Set(["ok"])
      guard Set(object.keys) == expected else { throw NativeEnrollmentFailure.invalidResponse }
      if T.self == ClientResponse.self {
        guard let client = object["client"] as? [String: Any],
          Set(client.keys) == Set(["id", "role", "label", "grants", "createdAt", "expiresAt"])
        else { throw NativeEnrollmentFailure.invalidResponse }
      }
      return try JSONDecoder().decode(T.self, from: data)
    } catch { throw NativeEnrollmentFailure.invalidResponse }
  }

  func requestEnvelope(
    path: String, method: String, body: Data?, bearer: String?,
    pending: PendingNativeEnrollment, maximumBytes: Int = 4_096,
    contentType: String? = nil, additionalHeaders: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    guard (1...270_000).contains(maximumBytes), additionalHeaders.count <= 2,
      Set(additionalHeaders.keys).isSubset(of: ["If-Match", "X-Ellie-Turn-ID"]),
      additionalHeaders.allSatisfy({
        $0.value.utf8.count <= 128 && !$0.value.contains("\r") && !$0.value.contains("\n")
      })
    else {
      throw NativeEnrollmentFailure.invalidResponse
    }
    guard let url = URL(string: path, relativeTo: pending.origin)?.absoluteURL,
      url.scheme == "https", nativeTLSHost(url.host) == nativeTLSHost(pending.origin.host)
    else { throw NativeEnrollmentFailure.invalidCode }
    var request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
    request.httpMethod = method
    request.httpBody = body
    request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
    if let body {
      request.setValue(contentType ?? "application/json", forHTTPHeaderField: "Content-Type")
      request.setValue(String(body.count), forHTTPHeaderField: "Content-Length")
    }
    for (name, value) in additionalHeaders { request.setValue(value, forHTTPHeaderField: name) }
    if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
    guard let host = nativeTLSHost(pending.origin.host) else {
      throw NativeEnrollmentFailure.invalidCode
    }
    let delegate = PinnedSessionDelegate(
      host: host, pin: pending.certificateSha256, maximumBytes: maximumBytes, timeout: timeout,
      verificationDate: now())
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await delegate.perform(request, in: session)
    } catch {
      diagnostic(nativeTransportFailureCategory(error))
      throw error
    }
    guard let http = response as? HTTPURLResponse, http.url == url,
      http.mimeType == "application/json"
    else { throw NativeEnrollmentFailure.invalidResponse }
    return (data, http)
  }

  /// Only the two read-only Life account paths used by the native calendar widget.
  /// The memory-only Life session is never put in a shared cookie jar or a URL.
  func lifeCalendarGET(path: String, credential: LifeWebCredential, sessionToken: String)
    async throws -> (Data, HTTPURLResponse)
  {
    guard let components = URLComponents(string: path),
      components.scheme == nil, components.host == nil,
      components.fragment == nil,
      (path == "/api/connections" ||
        (components.path.range(of: "^/api/connections/[A-Za-z0-9_-]{1,128}/agenda$", options: .regularExpression) != nil &&
          components.queryItems?.count == 1 &&
          components.queryItems?.first?.name == "timeZone" &&
          components.queryItems?.first?.value?.range(of: "^[A-Za-z0-9_+./-]{1,80}$", options: .regularExpression) != nil)),
      sessionToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      credential.origin.scheme == "https",
      let host = nativeTLSHost(credential.origin.host),
      let url = URL(string: path, relativeTo: credential.origin)?.absoluteURL,
      url.scheme == "https", url.host == credential.origin.host,
      url.port == credential.origin.port, url.user == nil, url.password == nil,
      url.fragment == nil
    else { throw NativeEnrollmentFailure.invalidCode }
    return try await pinnedLifeGET(url: url, host: host, credential: credential,
      sessionToken: sessionToken, maximumBytes: 48_000)
  }

  /// Exact read-only Gmail routes. No generic Life URL or provider action is admitted.
  func lifeGmailGET(path: String, credential: LifeWebCredential, sessionToken: String)
    async throws -> (Data, HTTPURLResponse)
  {
    guard let maximumBytes = Self.lifeGmailMaximumBytes(path: path),
      sessionToken.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      credential.origin.scheme == "https",
      let host = nativeTLSHost(credential.origin.host),
      let url = URL(string: path, relativeTo: credential.origin)?.absoluteURL,
      url.scheme == "https", url.host == credential.origin.host,
      url.port == credential.origin.port, url.user == nil, url.password == nil,
      url.fragment == nil
    else { throw NativeEnrollmentFailure.invalidCode }
    return try await pinnedLifeGET(url: url, host: host, credential: credential,
      sessionToken: sessionToken, maximumBytes: maximumBytes)
  }

  static func lifeGmailMaximumBytes(path: String) -> Int? {
    guard let components = URLComponents(string: path),
      components.scheme == nil, components.host == nil,
      components.query == nil, components.fragment == nil,
      components.percentEncodedPath == path,
      (path == "/api/connections" ||
        path.range(of: "^/api/connections/[A-Za-z0-9_-]{1,128}/preview$",
          options: .regularExpression) != nil ||
        path.range(of: "^/api/connections/[A-Za-z0-9_-]{1,128}/messages/[A-Za-z0-9_-]{1,1024}$",
          options: .regularExpression) != nil)
    else { return nil }
    return path.contains("/messages/") ? 240 * 1_024 : 48_000
  }

  private func pinnedLifeGET(url: URL, host: String, credential: LifeWebCredential,
    sessionToken: String, maximumBytes: Int) async throws -> (Data, HTTPURLResponse)
  {
    var request = URLRequest(
      url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
    request.httpMethod = "GET"
    request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
    request.setValue("__Host-ellie_life=\(sessionToken)", forHTTPHeaderField: "Cookie")
    let delegate = PinnedSessionDelegate(
      host: host, pin: credential.certificateSha256, maximumBytes: maximumBytes,
      timeout: timeout, verificationDate: now())
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.urlCredentialStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    configuration.timeoutIntervalForRequest = timeout
    configuration.timeoutIntervalForResource = timeout
    let connection = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { connection.finishTasksAndInvalidate() }
    let (data, response) = try await delegate.perform(request, in: connection)
    guard let http = response as? HTTPURLResponse, http.url == url,
      http.mimeType == "application/json" else { throw NativeEnrollmentFailure.invalidResponse }
    return (data, http)
  }
}

enum NativeTransportFailureCategory: String, Sendable {
  case cancelled
  case connectionLost
  case connectionFailed
  case timedOut
  case trustRejected
  case unavailable
}

private func nativeTransportFailureCategory(_ error: Error) -> NativeTransportFailureCategory {
  if error is CancellationError { return .cancelled }
  if let failure = error as? NativeEnrollmentFailure, failure == .trustFailed {
    return .trustRejected
  }
  let code = (error as? URLError)?.code
  switch code {
  case .cancelled: return .cancelled
  case .networkConnectionLost: return .connectionLost
  case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return .connectionFailed
  case .timedOut: return .timedOut
  case .secureConnectionFailed, .serverCertificateHasBadDate, .serverCertificateUntrusted,
    .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid, .clientCertificateRejected,
    .clientCertificateRequired:
    return .trustRejected
  default: return .unavailable
  }
}

private func nativeTLSHost(_ host: String?) -> String? {
  guard let host, !host.isEmpty else { return nil }
  if host.first == "[", host.last == "]" { return String(host.dropFirst().dropLast()) }
  return host
}

private struct ClientResponse: Decodable {
  let client: NativeClient
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard container.allKeys.count == 1 else { throw NativeEnrollmentFailure.invalidResponse }
    client = try container.decode(NativeClient.self, forKey: .client)
  }
  enum CodingKeys: String, CodingKey { case client }
}
private struct LogoutResponse: Decodable {
  let ok: Bool
  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    guard container.allKeys.count == 1, try container.decode(Bool.self, forKey: .ok) else {
      throw NativeEnrollmentFailure.invalidResponse
    }
    ok = true
  }
  enum CodingKeys: String, CodingKey { case ok }
}
private struct HTTPFailure: Error { let status: Int }

private final class PinnedSessionDelegate: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate,
  @unchecked Sendable
{
  private let host: String
  private let pin: String
  private let maximumBytes: Int
  private let timeout: TimeInterval
  private let verificationDate: Date
  private var data = Data()
  private var response: URLResponse?
  private var continuation: CheckedContinuation<(Data, URLResponse), Error>?
  private var trustRejected = false
  private var timer: DispatchSourceTimer?
  private let completionLock = NSLock()
  private var cancelled = false
  private var dataTask: URLSessionDataTask?
  init(host: String, pin: String, maximumBytes: Int, timeout: TimeInterval, verificationDate: Date)
  {
    self.host = host
    self.pin = pin
    self.maximumBytes = maximumBytes
    self.timeout = timeout
    self.verificationDate = verificationDate
  }
  func perform(_ request: URLRequest, in session: URLSession) async throws -> (Data, URLResponse) {
    try Task.checkCancellation()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let timer = DispatchSource.makeTimerSource()
        timer.schedule(deadline: .now() + timeout)
        timer.setEventHandler {
          session.invalidateAndCancel()
          self.finish(.failure(URLError(.timedOut)))
        }
        completionLock.lock()
        if cancelled {
          completionLock.unlock()
          timer.cancel()
          timer.resume()
          continuation.resume(throwing: CancellationError())
          return
        }
        let task = session.dataTask(with: request)
        self.continuation = continuation
        self.timer = timer
        self.dataTask = task
        timer.resume()
        task.resume()
        completionLock.unlock()
      }
    } onCancel: {
      self.cancel()
    }
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
  func urlSession(
    _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      challenge.protectionSpace.host == host, let trust = challenge.protectionSpace.serverTrust
    else {
      trustRejected = true
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    guard evaluateNativeServerTrust(trust, host: host, expectedPin: pin, at: verificationDate)
    else {
      trustRejected = true
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    self.response = response
    completionHandler(.allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    guard data.count + chunk.count <= maximumBytes else {
      dataTask.cancel()
      finish(.failure(NativeEnrollmentFailure.invalidResponse))
      return
    }
    data.append(chunk)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if trustRejected {
      finish(.failure(NativeEnrollmentFailure.trustFailed))
    } else if let error {
      finish(.failure(error))
    } else if let response {
      finish(.success((data, response)))
    } else {
      finish(.failure(NativeEnrollmentFailure.invalidResponse))
    }
  }
  private func finish(_ result: Result<(Data, URLResponse), Error>) {
    completionLock.lock()
    guard let continuation else {
      completionLock.unlock()
      return
    }
    self.continuation = nil
    let timer = self.timer
    self.timer = nil
    self.dataTask = nil
    completionLock.unlock()
    timer?.cancel()
    continuation.resume(with: result)
  }
  private func cancel() {
    completionLock.lock()
    cancelled = true
    let task = dataTask
    completionLock.unlock()
    task?.cancel()
    finish(.failure(CancellationError()))
  }
}

func evaluateNativeServerTrust(_ trust: SecTrust, host: String, expectedPin: String, at date: Date)
  -> Bool
{
  guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first
  else { return false }
  let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map {
    String(format: "%02x", $0)
  }.joined()
  guard digest == expectedPin else { return false }
  SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
  SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
  SecTrustSetAnchorCertificatesOnly(trust, true)
  SecTrustSetVerifyDate(trust, date as CFDate)
  var error: CFError?
  return SecTrustEvaluateWithError(trust, &error)
}

extension NativeEnrollmentTransport {
  func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) async throws
    -> NativeClient
  {
    guard payload.origin == pending.origin, payload.certificateSha256 == pending.certificateSha256,
      payload.label == pending.label, payload.grants == pending.grants
    else { throw NativeEnrollmentFailure.invalidCode }
    do {
      let body = try JSONSerialization.data(withJSONObject: [
        "invitation": payload.invitation, "token": pending.candidateToken,
      ])
      let response: ClientResponse = try await request(
        path: "/native/v1/pair", method: "POST", body: body, bearer: nil, pending: pending)
      return response.client
    } catch is CancellationError { throw NativeEnrollmentFailure.uncertain } catch let failure
      as NativeEnrollmentFailure
      where failure == .rejected || failure == .trustFailed || failure == .invalidResponse
    { throw failure } catch { throw NativeEnrollmentFailure.uncertain }
  }
  func recover(_ pending: PendingNativeEnrollment) async throws -> NativeClient? {
    do {
      let response: ClientResponse = try await request(
        path: "/native/v1/session", method: "GET", body: nil, bearer: pending.candidateToken,
        pending: pending)
      return response.client
    } catch let error as HTTPFailure where error.status == 401 {
      return nil
    } catch is CancellationError { throw NativeEnrollmentFailure.cancelled } catch let failure
      as NativeEnrollmentFailure
    { throw failure } catch {
      if Task.isCancelled { throw NativeEnrollmentFailure.cancelled }
      throw NativeEnrollmentFailure.unavailable
    }
  }
}
