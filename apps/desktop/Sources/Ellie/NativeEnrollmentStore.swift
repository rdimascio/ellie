import Combine
import Foundation
import Security

@MainActor
final class NativeEnrollmentStore: ObservableObject {
  enum Phase: Equatable {
    case idle, checking, scanning
    case confirming(NativePairingPayload)
    case working
    case enrolled(NativeEnrollmentCredential)
    case pairingUncertain(PendingNativeEnrollment)
    case logoutUncertain(NativeEnrollmentCredential)
    case failed(String)
  }
  @Published private(set) var phase: Phase = .idle
  private let vault: NativeCredentialVault
  private let transport: NativeEnrollmentTransporting
  private let now: @Sendable () -> Date
  private var task: Task<Void, Never>?
  private var pendingDuringMutation: PendingNativeEnrollment?
  private var cancellationFallback: Phase?
  private var generation = 0

  init(
    vault: NativeCredentialVault = KeychainNativeCredentialVault(),
    transport: NativeEnrollmentTransporting = NativeEnrollmentTransport(),
    now: @escaping @Sendable () -> Date = { Date() }
  ) {
    self.vault = vault
    self.transport = transport
    self.now = now
  }

  func startScanning() {
    guard task == nil else { return }
    phase = .checking
    launch(cancellationFallback: .idle) {
      if let active = try await self.vault.loadActive() {
        try validateStored(active, now: self.now())
        return .enrolled(active)
      }
      if let pending = try await self.vault.loadPending() {
        try validateStored(pending)
        return .pairingUncertain(pending)
      }
      return .scanning
    }
  }
  func scanned(_ value: String, now: Date = Date()) {
    guard case .scanning = phase else { return }
    do {
      let payload = try NativePairingPayload.parse(value)
      guard payload.expiresAt > milliseconds(now) else { throw NativeEnrollmentFailure.expiredCode }
      phase = .confirming(payload)
    } catch { phase = .failed(publicMessage(error)) }
  }
  func scannerFailed() {
    if case .scanning = phase {
      phase = .failed(
        "The camera could not scan an enrollment code. Check Camera access and try again.")
    }
  }
  func confirm() {
    guard task == nil, case .confirming(let payload) = phase else { return }
    do {
      guard payload.expiresAt > milliseconds(now()) else {
        throw NativeEnrollmentFailure.expiredCode
      }
      let pending = PendingNativeEnrollment(
        origin: payload.origin, certificateSha256: payload.certificateSha256, label: payload.label,
        grants: payload.grants, candidateToken: try Self.token())
      pendingDuringMutation = pending
      phase = .working
      launch(cancellationFallback: .pairingUncertain(pending)) {
        try Task.checkCancellation()
        try await self.vault.savePending(pending)
        try Task.checkCancellation()
        do {
          let client = try await self.transport.pair(payload: payload, pending: pending)
          try Task.checkCancellation()
          try validateClient(client, pending: pending, now: self.now())
          let credential = NativeEnrollmentCredential(
            origin: pending.origin, certificateSha256: pending.certificateSha256, client: client,
            token: pending.candidateToken)
          do { try await self.vault.promote(credential) } catch {
            throw NativeEnrollmentFailure.uncertain
          }
          return .enrolled(credential)
        } catch let failure as NativeEnrollmentFailure where failure == .rejected {
          try await self.vault.removePending()
          throw failure
        } catch { throw NativeEnrollmentFailure.uncertain }
      }
    } catch { phase = .failed(publicMessage(error)) }
  }
  func recover() {
    guard task == nil, case .pairingUncertain(let pending) = phase else { return }
    pendingDuringMutation = pending
    phase = .working
    launch(cancellationFallback: .pairingUncertain(pending)) {
      let client: NativeClient
      do {
        guard let recovered = try await self.transport.recover(pending) else {
          return .pairingUncertain(pending)
        }
        client = recovered
      } catch { return .pairingUncertain(pending) }
      do {
        try Task.checkCancellation()
        try validateClient(client, pending: pending, now: self.now())
      } catch { return .pairingUncertain(pending) }
      let credential = NativeEnrollmentCredential(
        origin: pending.origin, certificateSha256: pending.certificateSha256, client: client,
        token: pending.candidateToken)
      do { try await self.vault.promote(credential) } catch {
        throw NativeEnrollmentFailure.uncertain
      }
      return .enrolled(credential)
    }
  }
  func logout() {
    guard task == nil, case .enrolled(let credential) = phase else { return }
    phase = .working
    launch(cancellationFallback: .logoutUncertain(credential)) {
      do { try await self.transport.logout(credential) } catch {
        return .logoutUncertain(credential)
      }
      try Task.checkCancellation()
      do { try await self.vault.removeActive() } catch { return .logoutUncertain(credential) }
      return .idle
    }
  }
  func checkLogout() {
    guard task == nil, case .logoutUncertain(let credential) = phase else { return }
    let pending = PendingNativeEnrollment(
      origin: credential.origin, certificateSha256: credential.certificateSha256,
      label: credential.client.label, grants: credential.client.grants,
      candidateToken: credential.token)
    phase = .working
    launch(cancellationFallback: .logoutUncertain(credential)) {
      let recovered: NativeClient?
      do { recovered = try await self.transport.recover(pending) } catch {
        return .logoutUncertain(credential)
      }
      if let client = recovered {
        do {
          try Task.checkCancellation()
          try validateClient(client, pending: pending, now: self.now())
        } catch { return .logoutUncertain(credential) }
        guard client.id == credential.client.id, client.createdAt == credential.client.createdAt,
          client.expiresAt == credential.client.expiresAt
        else { return .logoutUncertain(credential) }
        return .enrolled(credential)
      }
      try Task.checkCancellation()
      try await self.vault.removeActive()
      return .idle
    }
  }
  func removeLocalCredential() {
    guard task == nil else { return }
    phase = .working
    launch(cancellationFallback: .idle) {
      try await self.vault.removeAll()
      return .idle
    }
  }
  func cancelTransient() {
    switch phase {
    case .scanning, .confirming: phase = .idle
    case .checking:
      generation += 1
      task?.cancel()
      phase = .idle
    case .working:
      generation += 1
      task?.cancel()
      phase = cancellationFallback ?? .idle
    default: break
    }
  }

  private func launch(
    cancellationFallback: Phase, _ operation: @escaping @MainActor () async throws -> Phase
  ) {
    guard task == nil else { return }
    self.cancellationFallback = cancellationFallback
    generation += 1
    let expected = generation
    task = Task {
      defer {
        task = nil
        pendingDuringMutation = nil
        self.cancellationFallback = nil
      }
      do {
        let result = try await operation()
        if expected == generation { phase = result }
      } catch is CancellationError {
        if expected == generation {
          if let pendingDuringMutation {
            phase = .pairingUncertain(pendingDuringMutation)
          } else if case .working = phase {
            phase = .idle
          }
        }
      } catch let failure as NativeEnrollmentFailure where failure == .uncertain {
        if expected == generation {
          if let pendingDuringMutation {
            phase = .pairingUncertain(pendingDuringMutation)
          } else {
            phase = .failed(failure.localizedDescription)
          }
        }
      } catch { if expected == generation { phase = .failed(publicMessage(error)) } }
    }
  }
  private static func token() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
      throw NativeEnrollmentFailure.unavailable
    }
    return bytes.map { String(format: "%02x", $0) }.joined()
  }
}

private let nativeSessionLifetime: Int64 = 90 * 24 * 60 * 60 * 1_000
private let nativeClockSkewTolerance: Int64 = 5 * 60 * 1_000
private func milliseconds(_ date: Date) -> Int64 { Int64(date.timeIntervalSince1970 * 1_000) }
private func validateClient(_ client: NativeClient, pending: PendingNativeEnrollment, now: Date)
  throws
{
  let nowValue = milliseconds(now)
  let maximum = Int64(9_007_199_254_740_991)
  guard client.role == "native_phone_controller", client.label == pending.label,
    client.grants == pending.grants,
    validNativeIdentifier(client.id), client.createdAt >= 0, client.createdAt <= maximum,
    client.createdAt <= nowValue + nativeClockSkewTolerance,
    client.expiresAt >= client.createdAt, client.expiresAt <= maximum,
    client.expiresAt - client.createdAt == nativeSessionLifetime,
    client.expiresAt > nowValue
  else { throw NativeEnrollmentFailure.invalidResponse }
}
private func validateStored(_ pending: PendingNativeEnrollment) throws {
  guard canonicalNativeOrigin(pending.origin.absoluteString) != nil,
    isNativeHexToken(pending.certificateSha256), isNativeHexToken(pending.candidateToken),
    validNativeLabel(pending.label), (try? validateNativeGrants(pending.grants)) != nil
  else { throw NativeEnrollmentFailure.credentialInvalid }
}
private func validateStored(_ credential: NativeEnrollmentCredential, now: Date) throws {
  let pending = PendingNativeEnrollment(
    origin: credential.origin, certificateSha256: credential.certificateSha256,
    label: credential.client.label, grants: credential.client.grants,
    candidateToken: credential.token)
  try validateStored(pending)
  guard credential.client.expiresAt > milliseconds(now) else {
    throw NativeEnrollmentFailure.credentialExpired
  }
  try validateClient(credential.client, pending: pending, now: now)
}
private func publicMessage(_ error: Error) -> String {
  (error as? NativeEnrollmentFailure)?.localizedDescription
    ?? NativeEnrollmentFailure.unavailable.localizedDescription
}
