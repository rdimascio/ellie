import Foundation

final class HouseholdDashboardTransport: HouseholdDashboardTransporting, @unchecked Sendable {
  private let reader: NativeEnrollmentTransport
  private let writer: NativeEnrollmentTransport

  init(
    reader: NativeEnrollmentTransport = NativeEnrollmentTransport(),
    writer: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 20)
  ) {
    self.reader = reader
    self.writer = writer
  }

  func authority(_ credential: NativeEnrollmentCredential) async throws
    -> [HouseholdDashboardGrant]
  {
    let (data, response) = try await request(
      reader, path: "/native/v1/household/authority", method: "GET", body: nil,
      credential: credential, maximum: 32_768)
    try requireReadStatus(response.statusCode, data)
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(root.keys) == ["grants"], let rows = root["grants"] as? [[String: Any]], rows.count <= 128
    else { throw DashboardSyncFailure.invalidResponse }
    var seen = Set<String>()
    return try rows.map { row in
      guard Set(row.keys) == ["clientId", "profile", "kind", "access"],
        let clientID = row["clientId"] as? String, validNativeIdentifier(clientID),
        let profileText = row["profile"] as? String, let profile = HouseholdProfile(rawValue: profileText),
        let kind = row["kind"] as? String, kind == "dashboards" || kind == "chores",
        clientID == credential.client.id,
        let accessText = row["access"] as? String, let access = HouseholdAccess(rawValue: accessText),
        seen.insert("\(profile.rawValue)\u{0}\(kind)").inserted
      else { throw DashboardSyncFailure.invalidResponse }
      return HouseholdDashboardGrant(clientId: clientID, profile: profile, kind: kind, access: access)
    }
  }

  func read(_ profile: HouseholdProfile, credential: NativeEnrollmentCredential) async throws
    -> HouseholdDashboardDocument
  {
    let (data, response) = try await request(
      reader, path: path(profile), method: "GET", body: nil, credential: credential,
      maximum: DashboardModel.maximumSerializedBytes + 2_048)
    try requireReadStatus(response.statusCode, data)
    return try decodeDocument(data, response: response, expectedProfile: profile)
  }

  func save(_ draft: PendingDashboardDraft, credential: NativeEnrollmentCredential) async throws
    -> DashboardSyncSaveResult
  {
    let checked = try draft.validated()
    let value = try JSONSerialization.jsonObject(with: DashboardModel.encode(checked.value))
    let body = try JSONSerialization.data(withJSONObject: ["value": value], options: [.sortedKeys])
    let result: (Data, HTTPURLResponse)
    do {
      result = try await request(
        writer, path: path(checked.profile), method: "PUT", body: body,
        credential: credential, maximum: DashboardModel.maximumSerializedBytes + 2_048,
        headers: ["If-Match": "\"ellie-revision-\(checked.baseRevision)\""])
    } catch let failure as DashboardSyncFailure where failure == .revoked || failure == .forbidden {
      throw failure
    } catch { throw DashboardSyncFailure.unknownOutcome }
    let (data, response) = result
    if response.statusCode == 401 { try requireError(data); throw DashboardSyncFailure.revoked }
    if response.statusCode == 403 { try requireError(data); throw DashboardSyncFailure.forbidden }
    if response.statusCode == 412 {
      guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        Set(root.keys) == ["profile", "kind", "revision"],
        root["profile"] as? String == checked.profile.rawValue,
        root["kind"] as? String == "dashboards", let revision = safeRevision(root["revision"])
      else { throw DashboardSyncFailure.unknownOutcome }
      guard revision != checked.baseRevision else { throw DashboardSyncFailure.unknownOutcome }
      return .conflict(revision)
    }
    if response.statusCode == 400 || response.statusCode == 409 || response.statusCode == 428 {
      try requireError(data)
      throw DashboardSyncFailure.invalidResponse
    }
    guard response.statusCode == 200 else { throw DashboardSyncFailure.unknownOutcome }
    do {
      let document = try decodeDocument(data, response: response, expectedProfile: checked.profile)
      guard document.revision == checked.baseRevision + 1,
        try DashboardModel.encode(document.value) == DashboardModel.encode(checked.value)
      else { throw DashboardSyncFailure.unknownOutcome }
      return .saved(document)
    } catch { throw DashboardSyncFailure.unknownOutcome }
  }

  private func request(
    _ transport: NativeEnrollmentTransport, path: String, method: String, body: Data?,
    credential: NativeEnrollmentCredential, maximum: Int, headers: [String: String] = [:]
  ) async throws -> (Data, HTTPURLResponse) {
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    guard Set(headers.keys).isSubset(of: ["If-Match"]),
      headers.allSatisfy({ !$0.value.contains("\r") && !$0.value.contains("\n") })
    else { throw DashboardSyncFailure.invalidResponse }
    do {
      return try await transport.requestEnvelope(
        path: path, method: method, body: body, bearer: credential.token, pending: pending,
        maximumBytes: maximum, additionalHeaders: headers)
    } catch is CancellationError { throw DashboardSyncFailure.unavailable }
    catch { throw DashboardSyncFailure.unavailable }
  }

  private func path(_ profile: HouseholdProfile) -> String {
    "/native/v1/household/\(profile.rawValue)/dashboards"
  }
}

private func requireReadStatus(_ status: Int, _ data: Data) throws {
  if status == 200 { return }
  try requireError(data)
  if status == 401 { throw DashboardSyncFailure.revoked }
  if status == 403 { throw DashboardSyncFailure.forbidden }
  if status == 503 { throw DashboardSyncFailure.unavailable }
  throw DashboardSyncFailure.invalidResponse
}

private func requireError(_ data: Data) throws {
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(root.keys) == ["error"], let message = root["error"] as? String,
    (1...256).contains(message.utf8.count)
  else { throw DashboardSyncFailure.invalidResponse }
}

private func safeRevision(_ value: Any?) -> Int64? {
  guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
  let decimal = number.doubleValue
  guard decimal.isFinite, decimal >= 0, decimal <= 9_007_199_254_740_991,
    decimal.rounded() == decimal
  else { return nil }
  return Int64(decimal)
}

private func decodeDocument(
  _ data: Data, response: HTTPURLResponse, expectedProfile: HouseholdProfile
) throws -> HouseholdDashboardDocument {
  guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(root.keys) == ["profile", "kind", "revision", "value"],
    root["profile"] as? String == expectedProfile.rawValue,
    root["kind"] as? String == "dashboards", let revision = safeRevision(root["revision"]),
    let value = root["value"], JSONSerialization.isValidJSONObject(value),
    let etag = response.value(forHTTPHeaderField: "ETag"), etag == "\"ellie-revision-\(revision)\""
  else { throw DashboardSyncFailure.invalidResponse }
  let encoded = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  let state = try DashboardModel.decode(encoded)
  return HouseholdDashboardDocument(profile: expectedProfile, revision: revision, value: state)
}
