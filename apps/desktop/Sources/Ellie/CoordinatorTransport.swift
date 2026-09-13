import Foundation
import Security

struct CoordinatorConnection: Sendable {
    let origin: URL
    let certificateDER: Data
    let token: String
}

struct CoordinatorNode: Identifiable, Equatable, Sendable {
    let id: String
    let capabilities: [String]
    let lastSeen: Date

    func isOnline(at date: Date) -> Bool {
        let age = date.timeIntervalSince(lastSeen)
        return age >= -5 && age <= 60
    }
}

protocol CoordinatorReading: Sendable {
    func nodes(connection: CoordinatorConnection) async throws -> [CoordinatorNode]
}

enum CoordinatorFailure: Error, Equatable, LocalizedError {
    case configurationMissing
    case configurationUnsafe
    case credentialUnavailable
    case invalidCertificate
    case trustFailed
    case unauthorized
    case unavailable
    case invalidResponse
    case cancelled

    var errorDescription: String? {
        switch self {
        case .configurationMissing: "This Mac has no saved identity for that role. Choose its installed role or finish Ellie setup first."
        case .configurationUnsafe: "The saved connection has invalid settings or unsafe file permissions. Run Ellie doctor to inspect it."
        case .credentialUnavailable: "The saved credential is unavailable. Unlock the login Keychain and check the installed Ellie helper."
        case .invalidCertificate: "The coordinator certificate is invalid."
        case .trustFailed: "The coordinator identity could not be verified."
        case .unauthorized: "The coordinator rejected this identity. Its pairing may have been revoked."
        case .unavailable: "Cannot reach the coordinator. Check its service and this Mac’s network. For LAN access, allow Ellie in System Settings → Privacy & Security → Local Network."
        case .invalidResponse: "The coordinator returned an invalid response."
        case .cancelled: "The coordinator request was cancelled."
        }
    }
}

struct PinnedCoordinatorClient: CoordinatorReading {
    static let maximumResponseBytes = 128 * 1_024
    static let maximumNodes = 128
    static let deadline: TimeInterval = 5

    typealias Loader = @Sendable (URLRequest, Data) async throws -> (Data, Int)
    private let loader: Loader
    private let now: @Sendable () -> Date

    init() {
        loader = { request, certificate in try await Self.load(request: request, certificateDER: certificate) }
        now = { Date() }
    }

    init(loader: @escaping Loader, now: @escaping @Sendable () -> Date = { Date() }) {
        self.loader = loader
        self.now = now
    }

    func nodes(connection: CoordinatorConnection) async throws -> [CoordinatorNode] {
        let request = try Self.makeRequest(connection: connection)
        let result: (Data, Int)
        do {
            result = try await loader(request, connection.certificateDER)
        } catch let failure as CoordinatorFailure {
            throw failure
        } catch is CancellationError {
            throw CoordinatorFailure.cancelled
        } catch {
            throw CoordinatorFailure.unavailable
        }

        switch result.1 {
        case 200: break
        case 401, 403: throw CoordinatorFailure.unauthorized
        case 300..<500: throw CoordinatorFailure.invalidResponse
        default: throw CoordinatorFailure.unavailable
        }
        return try Self.decodeNodes(result.0, now: now())
    }

    static func makeRequest(connection: CoordinatorConnection) throws -> URLRequest {
        guard connection.token.utf8.count == 64,
              connection.token.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw CoordinatorFailure.credentialUnavailable }
        guard SecCertificateCreateWithData(nil, connection.certificateDER as CFData) != nil else {
            throw CoordinatorFailure.invalidCertificate
        }
        guard var components = URLComponents(url: connection.origin, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil, components.password == nil,
              (components.path.isEmpty || components.path == "/"),
              components.query == nil, components.fragment == nil
        else { throw CoordinatorFailure.configurationUnsafe }
        components.path = "/v1/nodes"
        guard let url = components.url else { throw CoordinatorFailure.configurationUnsafe }

        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: deadline)
        request.httpMethod = "GET"
        request.setValue("1", forHTTPHeaderField: "X-Ellie-Version")
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        return request
    }

    static func decodeNodes(_ data: Data, now: Date) throws -> [CoordinatorNode] {
        guard data.count <= maximumResponseBytes,
              let values = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
              values.count <= maximumNodes
        else { throw CoordinatorFailure.invalidResponse }

        var identifiers = Set<String>()
        return try values.map { value in
            guard let id = value["id"] as? String, validIdentifier(id), identifiers.insert(id).inserted,
                  let milliseconds = value["lastSeen"] as? NSNumber,
                  CFGetTypeID(milliseconds) != CFBooleanGetTypeID()
            else { throw CoordinatorFailure.invalidResponse }
            let timestamp = milliseconds.doubleValue
            guard timestamp.isFinite, timestamp >= 0 else { throw CoordinatorFailure.invalidResponse }
            let lastSeen = Date(timeIntervalSince1970: timestamp / 1_000)
            guard lastSeen.timeIntervalSince(now) <= 5 else { throw CoordinatorFailure.invalidResponse }

            let rawCapabilities = value["executionCapabilities"] ?? value["capabilities"]
            guard let capabilities = rawCapabilities as? [String], capabilities.count <= allowedCapabilities.count,
                  capabilities.allSatisfy(allowedCapabilities.contains)
            else { throw CoordinatorFailure.invalidResponse }
            var seen = Set<String>()
            let unique = capabilities.filter { seen.insert($0).inserted }
            return CoordinatorNode(id: id, capabilities: unique, lastSeen: lastSeen)
        }
    }

    private static let allowedCapabilities: Set<String> = [
        "app.open", "url.open", "window.place", "window.adjacent",
    ]

    private static func validIdentifier(_ value: String) -> Bool {
        guard !value.isEmpty, value.utf8.count <= 100,
              let first = value.utf8.first, asciiAlphaNumeric(first)
        else { return false }
        return value.utf8.allSatisfy {
            asciiAlphaNumeric($0) || $0 == 46 || $0 == 95 || $0 == 45
        }
    }

    private static func asciiAlphaNumeric(_ byte: UInt8) -> Bool {
        (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte)
    }

    static func validateServerTrust(_ trust: SecTrust, pinnedCertificate: SecCertificate, at date: Date) -> Bool {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = chain.first,
              SecCertificateCopyData(leaf) as Data == SecCertificateCopyData(pinnedCertificate) as Data,
              certificateIsValid(pinnedCertificate, at: date)
        else { return false }
        let policy = SecPolicyCreateSSL(true, "ellie.local" as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, [pinnedCertificate] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustSetVerifyDate(trust, date as CFDate) == errSecSuccess
        else { return false }
        return SecTrustEvaluateWithError(trust, nil)
    }

    private static func certificateIsValid(_ certificate: SecCertificate, at date: Date) -> Bool {
        let keys = [kSecOIDX509V1ValidityNotBefore, kSecOIDX509V1ValidityNotAfter] as CFArray
        guard let values = SecCertificateCopyValues(certificate, keys, nil) as? [CFString: Any],
              let notBefore = propertyDate(values[kSecOIDX509V1ValidityNotBefore]),
              let notAfter = propertyDate(values[kSecOIDX509V1ValidityNotAfter])
        else { return false }
        return date >= notBefore && date <= notAfter
    }

    private static func propertyDate(_ property: Any?) -> Date? {
        guard let dictionary = property as? [CFString: Any] else { return nil }
        if let date = dictionary[kSecPropertyKeyValue] as? Date { return date }
        if let value = dictionary[kSecPropertyKeyValue] as? NSNumber {
            return Date(timeIntervalSinceReferenceDate: value.doubleValue)
        }
        return nil
    }

    private static func load(request: URLRequest, certificateDER: Data) async throws -> (Data, Int) {
        let operation = CoordinatorRequest(request: request, certificateDER: certificateDER)
        return try await withTaskCancellationHandler {
            try await operation.start()
        } onCancel: {
            operation.cancel()
        }
    }
}

final class CoordinatorRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let request: URLRequest
    private let pinnedCertificate: SecCertificate
    private var continuation: CheckedContinuation<(Data, Int), Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var responseStatus: Int?
    private var body = Data()
    private var finished = false
    private var trustRejected = false
    private var deadline: DispatchSourceTimer?

    init(request: URLRequest, certificateDER: Data) {
        self.request = request
        self.pinnedCertificate = SecCertificateCreateWithData(nil, certificateDER as CFData)!
    }

    func start() async throws -> (Data, Int) {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard !finished else {
                lock.unlock()
                continuation.resume(throwing: CoordinatorFailure.cancelled)
                return
            }
            self.continuation = continuation
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = PinnedCoordinatorClient.deadline
            configuration.timeoutIntervalForResource = PinnedCoordinatorClient.deadline
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            configuration.urlCache = nil
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCredentialStorage = nil
            configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            self.session = session
            let task = session.dataTask(with: request)
            self.task = task
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
            timer.schedule(deadline: .now() + PinnedCoordinatorClient.deadline)
            timer.setEventHandler { [weak self] in self?.finish(.failure(CoordinatorFailure.unavailable)) }
            self.deadline = timer
            lock.unlock()
            timer.resume()
            task.resume()
        }
    }

    func cancel() {
        finish(.failure(CoordinatorFailure.cancelled))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              PinnedCoordinatorClient.validateServerTrust(trust, pinnedCertificate: pinnedCertificate, at: Date())
        else {
            lock.withLock { trustRejected = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse,
              response.expectedContentLength <= Int64(PinnedCoordinatorClient.maximumResponseBytes)
        else {
            completionHandler(.cancel)
            finish(.failure(CoordinatorFailure.invalidResponse))
            return
        }
        lock.withLock { responseStatus = response.statusCode }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let exceeded = lock.withLock { () -> Bool in
            guard !finished else { return false }
            guard data.count <= PinnedCoordinatorClient.maximumResponseBytes,
                  body.count <= PinnedCoordinatorClient.maximumResponseBytes - data.count
            else { return true }
            body.append(data)
            return false
        }
        if exceeded { finish(.failure(CoordinatorFailure.invalidResponse)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil {
            let failure: CoordinatorFailure = lock.withLock { trustRejected ? .trustFailed : .unavailable }
            finish(.failure(failure))
            return
        }
        let result = lock.withLock { responseStatus.map { (body, $0) } }
        if let result { finish(.success(result)) }
        else { finish(.failure(CoordinatorFailure.invalidResponse)) }
    }

    private func finish(_ result: Result<(Data, Int), Error>) {
        let resources = lock.withLock { () -> (CheckedContinuation<(Data, Int), Error>?, URLSessionDataTask?, URLSession?, DispatchSourceTimer?) in
            guard !finished else { return (nil, nil, nil, nil) }
            finished = true
            let resources = (continuation, task, session, deadline)
            continuation = nil; task = nil; session = nil; deadline = nil
            return resources
        }
        guard let continuation = resources.0 else { return }
        resources.3?.cancel()
        resources.1?.cancel()
        resources.2?.invalidateAndCancel()
        continuation.resume(with: result)
    }
}

private extension NSLock {
    func withLock<T>(_ work: () -> T) -> T {
        lock(); defer { unlock() }
        return work()
    }
}
