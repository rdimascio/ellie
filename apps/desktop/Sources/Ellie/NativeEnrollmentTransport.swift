import CryptoKit
import Foundation
import Security

final class NativeEnrollmentTransport: NSObject, NativeEnrollmentTransporting, @unchecked Sendable {
  private let timeout: TimeInterval
  private let now: @Sendable () -> Date
  init(timeout: TimeInterval = 10, now: @escaping @Sendable () -> Date = { Date() }) {
    self.timeout = timeout
    self.now = now
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
    pending: PendingNativeEnrollment, maximumBytes: Int = 4_096
  ) async throws -> (Data, HTTPURLResponse) {
    guard (1...8_192).contains(maximumBytes) else {
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
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
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
    let (data, response) = try await delegate.perform(request, in: session)
    guard let http = response as? HTTPURLResponse, http.url == url,
      http.mimeType == "application/json"
    else { throw NativeEnrollmentFailure.invalidResponse }
    return (data, http)
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
