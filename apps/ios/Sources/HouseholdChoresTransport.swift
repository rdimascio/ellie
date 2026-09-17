import Foundation

final class HouseholdChoresTransport: HouseholdChoresTransporting, @unchecked Sendable {
  private let reader: NativeEnrollmentTransport
  private let writer: NativeEnrollmentTransport
  private let authorityReader: HouseholdDashboardTransport

  init(
    reader: NativeEnrollmentTransport = NativeEnrollmentTransport(),
    writer: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 20),
    authorityReader: HouseholdDashboardTransport = HouseholdDashboardTransport()
  ) {
    self.reader = reader
    self.writer = writer
    self.authorityReader = authorityReader
  }

  func authority(_ credential: NativeEnrollmentCredential) async throws -> [HouseholdDashboardGrant] {
    do { return try await authorityReader.authority(credential) }
    catch let failure as DashboardSyncFailure { throw translate(failure) }
    catch { throw ChoresSyncFailure.unavailable }
  }

  func read(_ credential: NativeEnrollmentCredential) async throws -> HouseholdChoresDocument {
    let (data, response) = try await request(reader, method: "GET", body: nil,
      credential: credential, maximum: ChoresModel.maximumSerializedBytes + 2_048)
    if response.statusCode != 200 {
      try requireError(data)
      if response.statusCode == 401 { throw ChoresSyncFailure.revoked }
      if response.statusCode == 403 { throw ChoresSyncFailure.forbidden }
      if response.statusCode == 503 { throw ChoresSyncFailure.unavailable }
      throw ChoresSyncFailure.invalidResponse
    }
    return try decodeDocument(data, response: response)
  }

  func save(_ draft: PendingChoresDraft, credential: NativeEnrollmentCredential) async throws
    -> ChoresSyncSaveResult {
    let checked = try draft.validated()
    guard checked.origin == credential.origin,
      checked.certificateSha256 == credential.certificateSha256,
      checked.clientId == credential.client.id
    else { throw ChoresSyncFailure.invalidResponse }
    let value = try JSONSerialization.jsonObject(with: ChoresModel.encode(checked.value))
    let body = try JSONSerialization.data(withJSONObject: ["value": value], options: [.sortedKeys])
    let result: (Data, HTTPURLResponse)
    do {
      result = try await request(writer, method: "PUT", body: body,
        credential: credential, maximum: ChoresModel.maximumSerializedBytes + 2_048,
        headers: ["If-Match": "\"ellie-revision-\(checked.baseRevision)\""])
    } catch { throw ChoresSyncFailure.unknownOutcome }
    let (data, response) = result
    if response.statusCode == 401 { try requireError(data); throw ChoresSyncFailure.revoked }
    if response.statusCode == 403 { try requireError(data); throw ChoresSyncFailure.forbidden }
    if response.statusCode == 412 {
      return .conflict(try decodeConflict(data, baseRevision: checked.baseRevision))
    }
    guard response.statusCode == 200 else { throw ChoresSyncFailure.unknownOutcome }
    do {
      let document = try decodeDocument(data, response: response)
      guard document.revision == checked.baseRevision + 1,
        try ChoresModel.encode(document.value) == ChoresModel.encode(checked.value)
      else { throw ChoresSyncFailure.unknownOutcome }
      return .saved(document)
    } catch { throw ChoresSyncFailure.unknownOutcome }
  }

  private func request(
    _ transport: NativeEnrollmentTransport, method: String, body: Data?,
    credential: NativeEnrollmentCredential, maximum: Int,
    headers: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    do {
      return try await transport.requestEnvelope(
        path: "/native/v1/household/shared/chores", method: method, body: body,
        bearer: credential.token, pending: pending,
        maximumBytes: maximum, additionalHeaders: headers)
    } catch { throw ChoresSyncFailure.unavailable }
  }

  func decodeDocument(_ data: Data, response: HTTPURLResponse) throws
    -> HouseholdChoresDocument {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["profile", "kind", "revision", "value"],
      root["profile"] as? String == "shared", root["kind"] as? String == "chores",
      let revision = safeRevision(root["revision"]), let value = root["value"],
      JSONSerialization.isValidJSONObject(value),
      response.value(forHTTPHeaderField: "ETag") == "\"ellie-revision-\(revision)\""
    else { throw ChoresSyncFailure.invalidResponse }
    do {
      let encoded = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
      return HouseholdChoresDocument(revision: revision, value: try ChoresModel.decode(encoded))
    } catch { throw ChoresSyncFailure.invalidResponse }
  }

  func decodeConflict(_ data: Data, baseRevision: Int64) throws -> Int64 {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["profile", "kind", "revision"],
      root["profile"] as? String == "shared", root["kind"] as? String == "chores",
      let revision = safeRevision(root["revision"]), revision > baseRevision
    else { throw ChoresSyncFailure.unknownOutcome }
    return revision
  }

  private func requireError(_ data: Data) throws {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["error"], let message = root["error"] as? String,
      (1...256).contains(message.utf8.count)
    else { throw ChoresSyncFailure.invalidResponse }
  }

  private func safeRevision(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let decimal = number.doubleValue
    guard decimal.isFinite, decimal >= 0, decimal <= 9_007_199_254_740_991,
      decimal.rounded() == decimal
    else { return nil }
    return Int64(decimal)
  }

  private func translate(_ failure: DashboardSyncFailure) -> ChoresSyncFailure {
    switch failure {
    case .revoked: .revoked
    case .forbidden: .forbidden
    case .unavailable: .unavailable
    case .invalidResponse: .invalidResponse
    case .unknownOutcome: .unknownOutcome
    case .cacheUnavailable: .cacheUnavailable
    }
  }
}
