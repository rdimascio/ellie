import Foundation

final class PhoneControlTransport: PhoneControlTransporting, @unchecked Sendable {
  private let inventoryTransport: NativeEnrollmentTransport
  private let commandTransport: NativeEnrollmentTransport

  init(
    inventoryTransport: NativeEnrollmentTransport = NativeEnrollmentTransport(),
    commandTransport: NativeEnrollmentTransport = NativeEnrollmentTransport(timeout: 45)
  ) {
    self.inventoryTransport = inventoryTransport
    self.commandTransport = commandTransport
  }

  func nodes(for credential: NativeEnrollmentCredential) async throws -> [PhoneControlNode] {
    let pending = pending(for: credential)
    let (data, response) = try await mappedRequest {
      try await inventoryTransport.requestEnvelope(
        path: "/native/v1/nodes", method: "GET", body: nil, bearer: credential.token,
        pending: pending, maximumBytes: 8_192)
    }
    try requireStatus(response.statusCode, data: data, success: 200)
    return try decodePhoneControlNodes(data, grants: credential.client.grants)
  }

  func open(
    _ app: PhoneControlApp, on nodeID: String, credential: NativeEnrollmentCredential
  ) async throws -> PhoneCommandOutcome {
    guard
      credential.client.grants.contains(where: {
        $0.target == nodeID && $0.capabilities == ["app.open"]
      })
    else { throw PhoneControlFailure.rejected }
    let body = try JSONSerialization.data(withJSONObject: [
      "nodeId": nodeID,
      "action": ["tool": "app.open", "app": app.rawValue],
    ])
    let data: Data
    let response: HTTPURLResponse
    do {
      (data, response) = try await mappedRequest {
        try await commandTransport.requestEnvelope(
          path: "/native/v1/commands", method: "POST", body: body,
          bearer: credential.token, pending: pending(for: credential))
      }
    } catch let failure as PhoneControlFailure where failure != .revoked && failure != .rejected {
      return .unknown
    }
    return try decodePhoneCommandResponse(status: response.statusCode, data: data)
  }

  private func pending(for credential: NativeEnrollmentCredential) -> PendingNativeEnrollment {
    PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
  }

  private func mappedRequest(
    _ operation: () async throws -> (Data, HTTPURLResponse)
  ) async throws -> (Data, HTTPURLResponse) {
    do { return try await operation() } catch is CancellationError {
      throw PhoneControlFailure.cancelled
    } catch let failure as NativeEnrollmentFailure where failure == .trustFailed {
      throw PhoneControlFailure.unavailable
    } catch let failure as NativeEnrollmentFailure where failure == .invalidResponse {
      throw PhoneControlFailure.invalidResponse
    } catch {
      if Task.isCancelled { throw PhoneControlFailure.cancelled }
      throw PhoneControlFailure.unavailable
    }
  }
}

private func requireStatus(_ status: Int, data: Data, success: Int) throws {
  if status == success { return }
  if status == 401 {
    try validatePhoneControlErrorEnvelope(data)
    throw PhoneControlFailure.revoked
  }
  if [400, 403, 404, 409].contains(status) {
    try validatePhoneControlErrorEnvelope(data)
    throw PhoneControlFailure.rejected
  }
  if status == 503 {
    try validatePhoneControlErrorEnvelope(data)
    throw PhoneControlFailure.unavailable
  }
  throw PhoneControlFailure.invalidResponse
}

func validatePhoneControlErrorEnvelope(_ data: Data) throws {
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["error"]), let error = object["error"] as? String,
    (1...256).contains(error.utf8.count)
  else { throw PhoneControlFailure.invalidResponse }
}

func decodePhoneControlNodes(_ data: Data, grants: [NativeGrant]) throws -> [PhoneControlNode] {
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["nodes"]), let rawNodes = object["nodes"] as? [[String: Any]],
    rawNodes.count <= 16
  else { throw PhoneControlFailure.invalidResponse }
  let allowed = Set(grants.filter { $0.capabilities == ["app.open"] }.map(\.target))
  var seen = Set<String>()
  return try rawNodes.map { raw in
    guard Set(raw.keys) == Set(["id", "label", "online", "capabilities"]),
      let id = raw["id"] as? String, validNativeIdentifier(id), allowed.contains(id),
      seen.insert(id).inserted,
      let label = raw["label"] as? String, validNativeLabel(label),
      let onlineValue = raw["online"] as? NSNumber,
      CFGetTypeID(onlineValue) == CFBooleanGetTypeID(),
      let capabilities = raw["capabilities"] as? [String],
      capabilities == [] || capabilities == ["app.open"]
    else { throw PhoneControlFailure.invalidResponse }
    return PhoneControlNode(
      id: id, label: label, online: onlineValue.boolValue, capabilities: capabilities)
  }
}

func decodePhoneCommandOutcome(_ data: Data, allowed: Set<String>) throws
  -> PhoneCommandOutcome
{
  guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    Set(object.keys) == Set(["outcome"]), let value = object["outcome"] as? String,
    allowed.contains(value)
  else { throw PhoneControlFailure.invalidResponse }
  switch value {
  case "completed": return .completed
  case "failed": return .failed
  case "unknown": return .unknown
  default: throw PhoneControlFailure.invalidResponse
  }
}

func decodePhoneCommandResponse(status: Int, data: Data) throws -> PhoneCommandOutcome {
  if status == 200 {
    return (try? decodePhoneCommandOutcome(data, allowed: ["completed", "failed"])) ?? .unknown
  }
  if status == 502 { return .unknown }
  let failure: PhoneControlFailure
  switch status {
  case 401: failure = .revoked
  case 400, 403, 404, 409: failure = .rejected
  case 503: failure = .unavailable
  default: return .unknown
  }
  guard (try? validatePhoneControlErrorEnvelope(data)) != nil else { return .unknown }
  throw failure
}
