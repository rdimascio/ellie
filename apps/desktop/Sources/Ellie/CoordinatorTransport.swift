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

enum NativeApp: String, CaseIterable, Identifiable, Sendable {
    case arc, safari, messages

    var id: String { rawValue }
    var title: String {
        switch self {
        case .arc: "Arc"
        case .safari: "Safari"
        case .messages: "Messages"
        }
    }
    var command: String { "open app \(title)" }
}

enum NativeCommandRejection: Equatable, Sendable {
    case invalidRequest, unauthorized, forbidden, nodeNotFound, nodeUnavailable, staleNode, capabilityMissing
}

enum NativeCommandOutcome: Equatable, Sendable {
    case completed
}

enum NativeCommandFailure: Error, Equatable, LocalizedError {
    case rejected(NativeCommandRejection)
    case outcomeUnknown
    case cancelled

    var errorDescription: String? {
        switch self {
        case .rejected(.invalidRequest): "The coordinator rejected this app request. Refresh the node list and try again."
        case .rejected(.unauthorized): "The coordinator rejected this identity. Its pairing may have been revoked."
        case .rejected(.forbidden): "This identity is not allowed to control that node."
        case .rejected(.nodeNotFound): "That node is no longer registered. Refresh the node list."
        case .rejected(.nodeUnavailable): "That node is offline or busy. Wait for it to become available, then try again."
        case .rejected(.staleNode): "That node is not currently online. Refresh its status before opening an app."
        case .rejected(.capabilityMissing): "That node does not currently allow app opening. Check its Ellie service and permissions."
        case .outcomeUnknown: "Ellie stopped waiting before it could confirm the result. The app may have opened. Check the target Mac before trying again."
        case .cancelled: "Ellie stopped waiting for the result. The app may have opened. Check the target Mac before trying again."
        }
    }
}

protocol CoordinatorActing: Sendable {
    func openApp(connection: CoordinatorConnection, nodeID: String, app: NativeApp) async throws -> NativeCommandOutcome
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

struct PinnedCoordinatorClient: CoordinatorReading, CoordinatorActing {
    static let maximumResponseBytes = 128 * 1_024
    static let maximumNodes = 128
    static let deadline: TimeInterval = 5
    static let commandDeadline: TimeInterval = 35

    typealias Loader = @Sendable (URLRequest, Data) async throws -> (Data, Int)
    private let loader: Loader
    private let now: @Sendable () -> Date

    init() {
        loader = { request, certificate in
            try await Self.load(request: request, certificateDER: certificate, deadline: request.timeoutInterval)
        }
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

    func openApp(connection: CoordinatorConnection, nodeID: String, app: NativeApp) async throws -> NativeCommandOutcome {
        let request = try Self.makeCommandRequest(connection: connection, nodeID: nodeID, app: app)
        let result: (Data, Int)
        do {
            result = try await loader(request, connection.certificateDER)
        } catch is CancellationError {
            throw NativeCommandFailure.cancelled
        } catch let failure as CoordinatorFailure where failure == .cancelled {
            throw NativeCommandFailure.cancelled
        } catch {
            throw NativeCommandFailure.outcomeUnknown
        }

        switch result.1 {
        case 200:
            guard result.0.count <= Self.maximumResponseBytes,
                  let object = try? JSONSerialization.jsonObject(with: result.0) as? [String: Any],
                  Set(object.keys) == ["ok", "message"],
                  let okValue = object["ok"] as? NSNumber,
                  CFGetTypeID(okValue) == CFBooleanGetTypeID(),
                  let ok = object["ok"] as? Bool,
                  let message = object["message"] as? String,
                  !message.isEmpty, message.utf8.count <= 500 else {
                throw NativeCommandFailure.outcomeUnknown
            }
            guard ok else { throw NativeCommandFailure.outcomeUnknown }
            return .completed
        case 400: throw NativeCommandFailure.rejected(.invalidRequest)
        case 401: throw NativeCommandFailure.rejected(.unauthorized)
        case 403: throw NativeCommandFailure.rejected(.forbidden)
        case 404: throw NativeCommandFailure.rejected(.nodeNotFound)
        case 409: throw NativeCommandFailure.rejected(.nodeUnavailable)
        default: throw NativeCommandFailure.outcomeUnknown
        }
    }

  func createNativeInvitation(
    connection: CoordinatorConnection, label: String, grants: [ManagedNativeGrant]
  ) async throws -> NativeInvitation {
    guard (1...16).contains(grants.count), Set(grants.map(\.target)).count == grants.count,
      grants.allSatisfy({
        validManagedNativeIdentifier($0.target) && managedNativeCapabilities($0.capabilities) != nil
      })
    else { throw PairingManagementFailure.invalid }
    let canonicalGrants = grants.map { grant in
      ManagedNativeGrant(
        target: grant.target,
        capabilities: managedNativeCapabilityOrder.filter(grant.capabilities.contains))
    }
    let data = try JSONEncoder().encode(
      NativeInvitationRequest(label: label, grants: canonicalGrants))
    let (body, status) = try await management(
      connection, path: "/v1/native/invitations", method: "POST", body: data)
    switch status {
    case 200: break
    case 400, 415: throw PairingManagementFailure.invalid
    case 401, 403: throw PairingManagementFailure.unauthorized
    default: throw PairingManagementFailure.unknownOutcome
    }
    guard
      let value = try? Self.decodeInvitationPayload(
        body, connection: connection, label: label, grants: canonicalGrants, now: now())
    else { throw PairingManagementFailure.unknownOutcome }
    let encoded = body.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    let qr = "ellie-native:v1:" + encoded
    guard qr.utf8.count <= 2300 else { throw PairingManagementFailure.unknownOutcome }
    return NativeInvitation(
      label: value.label, grants: value.grants,
      expiresAt: Date(timeIntervalSince1970: Double(value.expiresAt) / 1_000), qr: qr)
  }
  func nativeClients(connection: CoordinatorConnection) async throws -> [ManagedNativeClient] {
    let (body, status) = try await management(
      connection, path: "/v1/native/clients", method: "GET", body: nil)
    if status == 401 || status == 403 { throw PairingManagementFailure.unauthorized }
    guard status == 200, let values = try? Self.decodeManagedClients(body, now: now())
    else { throw PairingManagementFailure.unavailable }
    return values
  }
  func revokeNativeClient(connection: CoordinatorConnection, id: String) async throws -> Bool {
    guard validManagedNativeIdentifier(id) else { throw PairingManagementFailure.invalid }
    let data = try JSONSerialization.data(withJSONObject: ["id": id])
    let (body, status) = try await management(
      connection, path: "/v1/native/revoke", method: "POST", body: data)
    switch status {
    case 200: break
    case 400, 415: throw PairingManagementFailure.invalid
    case 401, 403: throw PairingManagementFailure.unauthorized
    default: throw PairingManagementFailure.unknownOutcome
    }
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      Set(object.keys) == ["ok", "revoked"],
      let okNumber = object["ok"] as? NSNumber, CFGetTypeID(okNumber) == CFBooleanGetTypeID(),
      let revokedNumber = object["revoked"] as? NSNumber,
      CFGetTypeID(revokedNumber) == CFBooleanGetTypeID(),
      let ok = object["ok"] as? Bool, ok, let revoked = object["revoked"] as? Bool
    else { throw PairingManagementFailure.unknownOutcome }
    return revoked
  }

  static func decodeInvitationPayload(
    _ body: Data, connection: CoordinatorConnection, label: String, grants: [ManagedNativeGrant],
    now: Date
  ) throws -> NativeInvitationPayload {
    guard body.count <= 4_096,
      let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
      Set(object.keys)
        == [
          "version", "origin", "certificateSha256", "invitation", "expiresAt", "label", "grants",
        ],
      let version = object["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
      version.doubleValue == 1,
      let originText = object["origin"] as? String,
      canonicalManagedNativeOrigin(originText) != nil,
      let pin = object["certificateSha256"] as? String, Self.validHexToken(pin),
      let invitation = object["invitation"] as? String, Self.validHexToken(invitation),
      let expires = object["expiresAt"] as? NSNumber,
      CFGetTypeID(expires) != CFBooleanGetTypeID(),
      expires.doubleValue.rounded() == expires.doubleValue,
      expires.doubleValue >= 0, expires.doubleValue <= 9_007_199_254_740_991,
      let responseLabel = object["label"] as? String, responseLabel == label,
      validManagedNativeLabel(responseLabel),
      let rawGrants = object["grants"] as? [[String: Any]], rawGrants.count == grants.count
    else { throw PairingManagementFailure.unknownOutcome }
    let checkedGrants = try rawGrants.map { raw -> ManagedNativeGrant in
      guard Set(raw.keys) == ["target", "capabilities"],
        let target = raw["target"] as? String,
        let capabilities = raw["capabilities"] as? [String],
        validManagedNativeIdentifier(target), managedNativeCapabilities(capabilities) != nil
      else { throw PairingManagementFailure.unknownOutcome }
      return ManagedNativeGrant(target: target, capabilities: capabilities)
    }
    guard checkedGrants == grants, Set(checkedGrants.map(\.target)).count == checkedGrants.count
    else {
      throw PairingManagementFailure.unknownOutcome
    }
    let expiresAt = expires.int64Value
    let currentMilliseconds = Int64(now.timeIntervalSince1970 * 1_000)
    guard expiresAt > currentMilliseconds, expiresAt <= currentMilliseconds + 600_000 else {
      throw PairingManagementFailure.unknownOutcome
    }
    let payload = NativeInvitationPayload(
      version: 1, origin: originText, certificateSha256: pin, invitation: invitation,
      expiresAt: expiresAt, label: responseLabel, grants: checkedGrants)
    guard Self.canonicalInvitationJSON(payload) == body else {
      throw PairingManagementFailure.unknownOutcome
    }
    return payload
  }

  static func decodeManagedClients(_ body: Data, now: Date) throws -> [ManagedNativeClient] {
    guard body.count <= maximumResponseBytes,
      let values = try? JSONSerialization.jsonObject(with: body) as? [[String: Any]],
      values.count <= 128
    else { throw PairingManagementFailure.unavailable }
    var identifiers = Set<String>()
    return try values.map { value in
      guard Set(value.keys) == ["id", "role", "label", "grants", "createdAt", "expiresAt"],
        let id = value["id"] as? String, validManagedNativeIdentifier(id),
        identifiers.insert(id).inserted,
        value["role"] as? String == "native_phone_controller",
        let label = value["label"] as? String, validManagedNativeLabel(label),
        let rawGrants = value["grants"] as? [[String: Any]], (1...16).contains(rawGrants.count),
        let created = exactSafeInteger(value["createdAt"]),
        let expires = exactSafeInteger(value["expiresAt"]), expires > created,
        expires - created == 90 * 24 * 60 * 60 * 1_000,
        created <= Int64(now.timeIntervalSince1970 * 1_000) + 300_000,
        expires > Int64(now.timeIntervalSince1970 * 1_000)
      else { throw PairingManagementFailure.unavailable }
      let grants = try rawGrants.map { raw -> ManagedNativeGrant in
        guard Set(raw.keys) == ["target", "capabilities"],
          let target = raw["target"] as? String, validManagedNativeIdentifier(target),
          let capabilities = raw["capabilities"] as? [String],
          managedNativeCapabilities(capabilities) != nil
        else { throw PairingManagementFailure.unavailable }
        return ManagedNativeGrant(target: target, capabilities: capabilities)
      }
      guard Set(grants.map(\.target)).count == grants.count else {
        throw PairingManagementFailure.unavailable
      }
      return ManagedNativeClient(
        id: id, role: "native_phone_controller", label: label, grants: grants,
        createdAt: created, expiresAt: expires)
    }
  }

  private static func validHexToken(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }

  private static func exactSafeInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.rounded() == number.doubleValue, number.doubleValue >= 0,
      number.doubleValue <= 9_007_199_254_740_991
    else { return nil }
    return number.int64Value
  }

  private static func canonicalInvitationJSON(_ payload: NativeInvitationPayload) -> Data? {
    func quote(_ value: String) -> String? {
      guard
        let data = try? JSONSerialization.data(
          withJSONObject: [value], options: [.withoutEscapingSlashes]),
        let text = String(data: data, encoding: .utf8)
      else { return nil }
      return String(text.dropFirst().dropLast())
    }
    guard let origin = quote(payload.origin), let pin = quote(payload.certificateSha256),
      let invitation = quote(payload.invitation), let label = quote(payload.label)
    else { return nil }
    var encodedGrants: [String] = []
    for grant in payload.grants {
      guard let target = quote(grant.target) else { return nil }
      let capabilities = grant.capabilities.compactMap(quote)
      guard capabilities.count == grant.capabilities.count else { return nil }
      encodedGrants.append(
        #"{"target":\#(target),"capabilities":[\#(capabilities.joined(separator: ","))]}"#)
    }
    return
      #"{"version":1,"origin":\#(origin),"certificateSha256":\#(pin),"invitation":\#(invitation),"expiresAt":\#(payload.expiresAt),"label":\#(label),"grants":[\#(encodedGrants.joined(separator: ","))]}"#
      .data(using: .utf8)
  }
  private func management(
    _ connection: CoordinatorConnection, path: String, method: String, body: Data?
  ) async throws -> (Data, Int) {
    var request = try Self.makeRequest(connection: connection)
    var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
    parts.path = path
    request.url = parts.url!
    request.httpMethod = method
    request.httpBody = body
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    return try await loader(request, connection.certificateDER)
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
      components.path.isEmpty || components.path == "/",
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

    static func makeCommandRequest(connection: CoordinatorConnection, nodeID: String, app: NativeApp) throws -> URLRequest {
        guard validIdentifier(nodeID) else { throw CoordinatorFailure.configurationUnsafe }
        var request = try makeRequest(connection: connection)
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.path = "/v1/commands"
        request.url = components.url!
        request.httpMethod = "POST"
        request.timeoutInterval = commandDeadline
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["nodeId": nodeID, "text": app.command], options: [.sortedKeys])
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
        "app.open", "browser.read", "browser.control", "url.open", "window.place", "window.adjacent",
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
        if SecTrustEvaluateWithError(trust, nil) { return true }
        guard legacyCoordinatorCertificate(pinnedCertificate) else { return false }
        guard SecTrustSetPolicies(trust, SecPolicyCreateBasicX509()) == errSecSuccess,
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

    private static func load(request: URLRequest, certificateDER: Data, deadline: TimeInterval) async throws -> (Data, Int) {
        let operation = CoordinatorRequest(request: request, certificateDER: certificateDER, deadline: deadline)
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
    private let requestDeadline: TimeInterval
    private var continuation: CheckedContinuation<(Data, Int), Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var responseStatus: Int?
    private var body = Data()
    private var finished = false
    private var trustRejected = false
    private var deadline: DispatchSourceTimer?

    init(request: URLRequest, certificateDER: Data, deadline: TimeInterval = PinnedCoordinatorClient.deadline) {
        self.request = request
        self.pinnedCertificate = SecCertificateCreateWithData(nil, certificateDER as CFData)!
        self.requestDeadline = deadline
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
            configuration.timeoutIntervalForRequest = requestDeadline
            configuration.timeoutIntervalForResource = requestDeadline
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
            timer.schedule(deadline: .now() + requestDeadline)
            timer.setEventHandler { [weak self] in self?.finish(.failure(CoordinatorFailure.unavailable)) }
            self.deadline = timer
            timer.resume()
            task.resume()
      lock.unlock()
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

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let response = response as? HTTPURLResponse,
      response.mimeType?.lowercased() == "application/json",
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
      continuation = nil
      task = nil
      session = nil
      deadline = nil
            return resources
        }
        guard let continuation = resources.0 else { return }
        resources.3?.cancel()
        resources.1?.cancel()
        resources.2?.invalidateAndCancel()
        continuation.resume(with: result)
    }
}

extension NSLock {
  fileprivate func withLock<T>(_ work: () -> T) -> T {
    lock()
    defer { unlock() }
        return work()
    }
}
