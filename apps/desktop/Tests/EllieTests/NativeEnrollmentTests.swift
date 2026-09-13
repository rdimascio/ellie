import CryptoKit
import Security
import XCTest

@testable import Ellie

final class NativeEnrollmentTests: XCTestCase {
  private let referenceTime = Date(timeIntervalSince1970: 1_893_456_000)

  func testCanonicalPairingCodeParsesAndNoncanonicalFormsFail() throws {
    let qr = pairingQR(label: "Ryan’s \"iPhone\" 📱")
    let payload = try NativePairingPayload.parse(qr)
    XCTAssertEqual(payload.origin.absoluteString, "https://ellie.local:8444")
    XCTAssertEqual(payload.grants, [NativeGrant(target: "studio-mac", capabilities: ["app.open"])])
    XCTAssertThrowsError(try NativePairingPayload.parse(qr + "="))
    XCTAssertThrowsError(try NativePairingPayload.parse(String(repeating: "x", count: 2_301)))
    let reordered =
      #"{"origin":"https://ellie.local:8444","version":1,"certificateSha256":"\#(String(repeating: "a", count: 64))","invitation":"\#(String(repeating: "b", count: 64))","expiresAt":1893456600000,"label":"Phone","grants":[{"target":"studio-mac","capabilities":["app.open"]}]}"#
    XCTAssertThrowsError(try NativePairingPayload.parse(envelope(reordered)))
  }

  func testSharedCanonicalPairingFixtures() throws {
    struct Fixtures: Decodable {
      struct Valid: Decodable {
        let name: String
        let payload: NativePairingPayload
        let qr: String
      }
      struct Invalid: Decodable {
        let name: String
        let qr: String
      }
      let version: Int
      let valid: [Valid]
      let invalid: [Invalid]
    }
    let testFile = URL(fileURLWithPath: #filePath)
    let root = testFile.deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let fixtureURL = root.appendingPathComponent("contracts/native-pairing-fixtures.v1.json")
    let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: fixtureURL))
    XCTAssertEqual(fixtures.version, 1)
    for fixture in fixtures.valid {
      XCTAssertEqual(try NativePairingPayload.parse(fixture.qr), fixture.payload, fixture.name)
    }
    for fixture in fixtures.invalid {
      XCTAssertThrowsError(try NativePairingPayload.parse(fixture.qr), fixture.name)
    }
  }

  func testPinnedTrustRequiresExactPinHostnameAndValidity() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-native-trust-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let key = directory.appendingPathComponent("key.pem")
    let certURL = directory.appendingPathComponent("cert.pem")
    let derURL = directory.appendingPathComponent("cert.der")
    try runOpenSSL([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certURL.path,
      "-days", "2", "-subj", "/CN=ellie.local", "-addext", "subjectAltName=DNS:ellie.local",
      "-addext", "basicConstraints=critical,CA:FALSE", "-addext",
      "keyUsage=critical,digitalSignature,keyEncipherment", "-addext",
      "extendedKeyUsage=serverAuth",
    ])
    try runOpenSSL(["x509", "-in", certURL.path, "-outform", "DER", "-out", derURL.path])
    let data = try Data(contentsOf: derURL)
    let cert = SecCertificateCreateWithData(nil, data as CFData)!
    let pin = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    func trust() -> SecTrust {
      var value: SecTrust?
      XCTAssertEqual(
        SecTrustCreateWithCertificates(cert, SecPolicyCreateBasicX509(), &value), errSecSuccess)
      return value!
    }
    XCTAssertTrue(
      evaluateNativeServerTrust(trust(), host: "ellie.local", expectedPin: pin, at: Date()))
    XCTAssertFalse(
      evaluateNativeServerTrust(trust(), host: "other.local", expectedPin: pin, at: Date()))
    XCTAssertFalse(
      evaluateNativeServerTrust(
        trust(), host: "ellie.local", expectedPin: String(repeating: "0", count: 64), at: Date()))
    XCTAssertFalse(
      evaluateNativeServerTrust(
        trust(), host: "ellie.local", expectedPin: pin, at: Date(timeIntervalSince1970: 0)))
    XCTAssertFalse(
      evaluateNativeServerTrust(
        trust(), host: "ellie.local", expectedPin: pin,
        at: Date(timeIntervalSince1970: 4_102_444_800)))
  }

  func testEphemeralPinnedHTTPSRecoveryUsesNativeHeadersAndBoundedResponse() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-native-https-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let key = directory.appendingPathComponent("key.pem")
    let certURL = directory.appendingPathComponent("cert.pem")
    let derURL = directory.appendingPathComponent("cert.der")
    let requestURL = directory.appendingPathComponent("request.txt")
    let scriptURL = directory.appendingPathComponent("server.py")
    try runOpenSSL([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certURL.path,
      "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext",
      "basicConstraints=critical,CA:FALSE", "-addext",
      "keyUsage=critical,digitalSignature,keyEncipherment", "-addext",
      "extendedKeyUsage=serverAuth",
    ])
    try runOpenSSL(["x509", "-in", certURL.path, "-outform", "DER", "-out", derURL.path])
    let created = Int64(Date().timeIntervalSince1970 * 1_000)
    let response =
      #"{"client":{"id":"native-1","role":"native_phone_controller","label":"Phone","grants":[{"target":"studio-mac","capabilities":["app.open"]}],"createdAt":\#(created),"expiresAt":\#(created + 90 * 24 * 60 * 60 * 1_000)}}"#
    let script = """
      import socket, ssl, sys
      socket.setdefaulttimeout(5)
      s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(1); print(s.getsockname()[1],flush=True)
      c,_=s.accept(); ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[1],sys.argv[2]); c=ctx.wrap_socket(c,server_side=True)
      d=b''
      while b'\\r\\n\\r\\n' not in d: d += c.recv(1024)
      open(sys.argv[3],'wb').write(d)
      b=sys.argv[4].encode(); c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '+str(len(b)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+b); c.close(); s.close()
      """
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    func startServer() throws -> (Process, Int) {
      let process = Process()
      let output = Pipe()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
      process.arguments = [scriptURL.path, certURL.path, key.path, requestURL.path, response]
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      try process.run()
      let line = String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      guard let port = Int(line) else { throw NativeEnrollmentFailure.unavailable }
      return (process, port)
    }
    let (process, port) = try startServer()
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
    let certData = try Data(contentsOf: derURL)
    let pin = SHA256.hash(data: certData).map { String(format: "%02x", $0) }.joined()
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://127.0.0.1:\(port)")!, certificateSha256: pin, label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    let client = try await NativeEnrollmentTransport(timeout: 3).recover(pending)
    XCTAssertEqual(client?.id, "native-1")
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
    let request = try String(contentsOf: requestURL, encoding: .utf8)
    XCTAssertTrue(request.hasPrefix("GET /native/v1/session HTTP/1.1\r\n"))
    XCTAssertTrue(request.lowercased().contains("x-ellie-version: 1"))
    XCTAssertTrue(request.contains("Authorization: Bearer \(pending.candidateToken)"))
    XCTAssertFalse(request.lowercased().contains("cookie:"))
    for (name, host, testedPin, date) in [
      ("wrong pin", "127.0.0.1", String(repeating: "0", count: 64), Date()),
      ("wrong hostname", "localhost", pin, Date()),
      ("not yet valid", "127.0.0.1", pin, Date(timeIntervalSince1970: 0)),
      ("expired", "127.0.0.1", pin, Date(timeIntervalSince1970: 4_102_444_800)),
    ] {
      let (server, port) = try startServer()
      let rejected = PendingNativeEnrollment(
        origin: URL(string: "https://\(host):\(port)")!, certificateSha256: testedPin,
        label: pending.label, grants: pending.grants, candidateToken: pending.candidateToken)
      do {
        _ = try await NativeEnrollmentTransport(timeout: 2, now: { date }).recover(rejected)
        XCTFail(name)
      } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .trustFailed, name) }
      if server.isRunning { server.terminate() }
      server.waitUntilExit()
    }
  }

  func testEphemeralPinnedHTTPSSupportsCanonicalIPv6Origin() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-native-ipv6-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let key = directory.appendingPathComponent("key.pem")
    let certURL = directory.appendingPathComponent("cert.pem")
    let derURL = directory.appendingPathComponent("cert.der")
    let scriptURL = directory.appendingPathComponent("server.py")
    try runOpenSSL([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certURL.path,
      "-days", "2", "-subj", "/CN=::1", "-addext", "subjectAltName=IP:::1", "-addext",
      "basicConstraints=critical,CA:FALSE", "-addext",
      "keyUsage=critical,digitalSignature,keyEncipherment", "-addext",
      "extendedKeyUsage=serverAuth",
    ])
    try runOpenSSL(["x509", "-in", certURL.path, "-outform", "DER", "-out", derURL.path])
    let created = Int64(Date().timeIntervalSince1970 * 1_000)
    let response =
      #"{"client":{"id":"native-1","role":"native_phone_controller","label":"Phone","grants":[{"target":"studio-mac","capabilities":["app.open"]}],"createdAt":\#(created),"expiresAt":\#(created + 90 * 24 * 60 * 60 * 1_000)}}"#
    let script = """
      import socket, ssl, sys
      socket.setdefaulttimeout(5)
      s=socket.socket(socket.AF_INET6); s.bind(('::1',0)); s.listen(1); print(s.getsockname()[1],flush=True)
      c,_=s.accept(); ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[1],sys.argv[2]); c=ctx.wrap_socket(c,server_side=True)
      d=b''
      while b'\\r\\n\\r\\n' not in d: d += c.recv(1024)
      b=sys.argv[3].encode(); c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '+str(len(b)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+b); c.close(); s.close()
      """
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
    process.arguments = [scriptURL.path, certURL.path, key.path, response]
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    try process.run()
    let portText = String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard let port = Int(portText) else {
      if process.isRunning { process.terminate() }
      throw XCTSkip("IPv6 loopback is unavailable")
    }
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
    let data = try Data(contentsOf: derURL)
    let pin = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://[::1]:\(port)")!, certificateSha256: pin, label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    let client = try await NativeEnrollmentTransport(timeout: 3).recover(pending)
    XCTAssertEqual(client?.id, "native-1")
  }

  func testEphemeralHTTPSAbsoluteDeadlineAndCancellationStopSlowDrip() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-native-slow-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let key = directory.appendingPathComponent("key.pem")
    let certURL = directory.appendingPathComponent("cert.pem")
    let derURL = directory.appendingPathComponent("cert.der")
    let scriptURL = directory.appendingPathComponent("server.py")
    try runOpenSSL([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certURL.path,
      "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext",
      "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
    ])
    try runOpenSSL(["x509", "-in", certURL.path, "-outform", "DER", "-out", derURL.path])
    let script = """
      import socket, ssl, sys, time
      socket.setdefaulttimeout(5)
      s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(1); print(s.getsockname()[1],flush=True)
      c,_=s.accept(); ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[1],sys.argv[2]); c=ctx.wrap_socket(c,server_side=True)
      d=b''
      while b'\\r\\n\\r\\n' not in d: d += c.recv(1024)
      b=sys.argv[3].encode(); c.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: '+str(len(b)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n')
      for x in b: c.send(bytes([x])); time.sleep(float(sys.argv[4]))
      """
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    let created = Int64(Date().timeIntervalSince1970 * 1_000)
    let response =
      #"{"client":{"id":"native-1","role":"native_phone_controller","label":"Phone","grants":[{"target":"studio-mac","capabilities":["app.open"]}],"createdAt":\#(created),"expiresAt":\#(created + 90 * 24 * 60 * 60 * 1_000)}}"#
    let pin = SHA256.hash(data: try Data(contentsOf: derURL)).map { String(format: "%02x", $0) }
      .joined()
    func start() throws -> (Process, Int) {
      let process = Process()
      let output = Pipe()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
      process.arguments = [scriptURL.path, certURL.path, key.path, response, "0.05"]
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      try process.run()
      let text = String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return (process, Int(text)!)
    }
    func pending(_ port: Int) -> PendingNativeEnrollment {
      PendingNativeEnrollment(
        origin: URL(string: "https://127.0.0.1:\(port)")!, certificateSha256: pin, label: "Phone",
        grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
        candidateToken: String(repeating: "c", count: 64))
    }
    let (deadlineServer, deadlinePort) = try start()
    let deadlineStarted = Date()
    do {
      _ = try await NativeEnrollmentTransport(timeout: 0.2).recover(pending(deadlinePort))
      XCTFail("Slow drip exceeded deadline")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .unavailable) }
    XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(deadlineStarted), 0.15)
    XCTAssertLessThan(Date().timeIntervalSince(deadlineStarted), 2.0)
    if deadlineServer.isRunning { deadlineServer.terminate() }
    deadlineServer.waitUntilExit()
    let (cancelServer, cancelPort) = try start()
    let operation = Task {
      try await NativeEnrollmentTransport(timeout: 3).recover(pending(cancelPort))
    }
    try await Task.sleep(for: .milliseconds(100))
    operation.cancel()
    do {
      _ = try await operation.value
      XCTFail("Cancelled recovery completed")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .cancelled) }
    if cancelServer.isRunning { cancelServer.terminate() }
    cancelServer.waitUntilExit()
  }

  func testImmediateTransportCancellationCannotMissContinuationStart() async {
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://127.0.0.1:9")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    for _ in 0..<50 {
      let operation = Task { try await NativeEnrollmentTransport(timeout: 1).recover(pending) }
      operation.cancel()
      do {
        _ = try await operation.value
        XCTFail("Cancelled request completed")
      } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .cancelled) }
    }
  }

  func testEphemeralHTTPSRejectsOversizedBodiesAndRedirects() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-native-boundary-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let key = directory.appendingPathComponent("key.pem")
    let certURL = directory.appendingPathComponent("cert.pem")
    let derURL = directory.appendingPathComponent("cert.der")
    let scriptURL = directory.appendingPathComponent("server.py")
    try runOpenSSL([
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key.path, "-out", certURL.path,
      "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-addext",
      "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
    ])
    try runOpenSSL(["x509", "-in", certURL.path, "-outform", "DER", "-out", derURL.path])
    let script = """
      import socket, ssl, sys
      socket.setdefaulttimeout(5)
      s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(1); print(s.getsockname()[1],flush=True)
      c,_=s.accept(); ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(sys.argv[1],sys.argv[2]); c=ctx.wrap_socket(c,server_side=True)
      d=b''
      while b'\\r\\n\\r\\n' not in d: d += c.recv(1024)
      b=sys.argv[4].encode(); extra=('Location: '+sys.argv[5]+'\\r\\n').encode() if sys.argv[5] else b''
      c.sendall(('HTTP/1.1 '+sys.argv[3]+' X\\r\\nContent-Type: application/json\\r\\nContent-Length: '+str(len(b))+'\\r\\n').encode()+extra+b'Connection: close\\r\\n\\r\\n'+b)
      """
    try script.write(to: scriptURL, atomically: true, encoding: .utf8)
    let pin = SHA256.hash(data: try Data(contentsOf: derURL)).map { String(format: "%02x", $0) }
      .joined()
    func start(status: String, body: String, location: String = "") throws -> (
      Process, PendingNativeEnrollment
    ) {
      let process = Process()
      let output = Pipe()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
      process.arguments = [scriptURL.path, certURL.path, key.path, status, body, location]
      process.standardOutput = output
      process.standardError = FileHandle.nullDevice
      try process.run()
      let port = Int(
        String(decoding: output.fileHandleForReading.availableData, as: UTF8.self)
          .trimmingCharacters(in: .whitespacesAndNewlines))!
      return (
        process,
        PendingNativeEnrollment(
          origin: URL(string: "https://127.0.0.1:\(port)")!, certificateSha256: pin, label: "Phone",
          grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
          candidateToken: String(repeating: "c", count: 64))
      )
    }
    let (oversizeServer, oversizePending) = try start(
      status: "200", body: String(repeating: "x", count: 4_097))
    do {
      _ = try await NativeEnrollmentTransport(timeout: 2).recover(oversizePending)
      XCTFail("Oversized response accepted")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .invalidResponse) }
    if oversizeServer.isRunning { oversizeServer.terminate() }
    oversizeServer.waitUntilExit()
    let (redirectServer, redirectPending) = try start(
      status: "302", body: "{}", location: "/native/v1/session")
    do {
      _ = try await NativeEnrollmentTransport(timeout: 2).recover(redirectPending)
      XCTFail("Redirect followed")
    } catch { XCTAssertEqual(error as? NativeEnrollmentFailure, .unavailable) }
    if redirectServer.isRunning { redirectServer.terminate() }
    redirectServer.waitUntilExit()
  }

  @MainActor
  func testStoreDoesNothingUntilExplicitActionAndPendingNeverContainsInvitation() async throws {
    let vault = MemoryVault()
    let transport = FakeTransport()
    let store = NativeEnrollmentStore(vault: vault, transport: transport)
    let initialReads = await vault.reads
    XCTAssertEqual(initialReads, 0)
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    guard case .confirming = store.phase else { return XCTFail("Expected confirmation") }
    store.confirm()
    await eventually { if case .enrolled = store.phase { true } else { false } }
    let stored = await vault.value
    let encoded = try JSONEncoder().encode(stored)
    XCTAssertFalse(
      String(decoding: encoded, as: UTF8.self).contains(String(repeating: "b", count: 64)))
    let pairs = await transport.pairs
    XCTAssertEqual(pairs, 1)
  }

  @MainActor
  func testUncertainPairKeepsPendingAndRecoveryNeverReplaysPost() async {
    let vault = MemoryVault()
    let transport = FakeTransport(pairFailure: .uncertain)
    let store = NativeEnrollmentStore(vault: vault, transport: transport)
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    store.confirm()
    await eventually { if case .pairingUncertain = store.phase { true } else { false } }
    let pairCount = await transport.pairs
    XCTAssertEqual(pairCount, 1)
    await transport.allowRecovery()
    store.recover()
    await eventually { if case .enrolled = store.phase { true } else { false } }
    let finalPairCount = await transport.pairs
    let recoverCount = await transport.recovers
    XCTAssertEqual(finalPairCount, 1)
    XCTAssertEqual(recoverCount, 1)
  }

  @MainActor
  func testRejectedPairRemovesPendingWithoutRetry() async {
    let vault = MemoryVault()
    let transport = FakeTransport(pairFailure: .rejected)
    let store = NativeEnrollmentStore(vault: vault, transport: transport)
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    store.confirm()
    await eventually { if case .failed = store.phase { true } else { false } }
    let pending = await vault.pending
    let pairs = await transport.pairs
    XCTAssertNil(pending)
    XCTAssertEqual(pairs, 1)
  }

  @MainActor
  func testBackgroundCancellationCannotPublishLatePairSuccess() async {
    let vault = MemoryVault()
    let transport = FakeTransport(suspendPair: true)
    let store = NativeEnrollmentStore(vault: vault, transport: transport)
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    store.confirm()
    await eventually { await transport.pairs == 1 }
    store.cancelTransient()
    await transport.finishPair()
    await eventually { if case .pairingUncertain = store.phase { true } else { false } }
  }

  @MainActor
  func testScanChecksStoredEnvelopeBeforeOpeningCamera() async {
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://ellie.local:8444")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    let vault = MemoryVault(value: .pending(pending))
    let store = NativeEnrollmentStore(vault: vault, transport: FakeTransport())
    store.startScanning()
    await eventually { if case .pairingUncertain = store.phase { true } else { false } }
    if case .scanning = store.phase { XCTFail("Camera must stay closed") }
  }

  @MainActor
  func testCancelClearsConfirmedQRWithoutKeychainRead() async {
    let vault = MemoryVault()
    let store = NativeEnrollmentStore(vault: vault, transport: FakeTransport())
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    store.cancelTransient()
    XCTAssertEqual(store.phase, .idle)
    let reads = await vault.reads
    XCTAssertEqual(reads, 2)
  }

  @MainActor
  func testConfirmationRechecksInvitationExpiry() async {
    let store = NativeEnrollmentStore(
      vault: MemoryVault(), transport: FakeTransport(),
      now: { Date(timeIntervalSince1970: 1_893_456_601) })
    store.startScanning()
    await eventually { if case .scanning = store.phase { true } else { false } }
    store.scanned(pairingQR(), now: referenceTime)
    store.confirm()
    guard case .failed = store.phase else { return XCTFail("Expired confirmation was accepted") }
  }

  @MainActor
  func testStoredClientAllowsOnlyBoundedFutureClockSkew() async {
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://ellie.local:8444")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    func credential(offset: Int64) -> NativeEnrollmentCredential {
      let now = Int64(referenceTime.timeIntervalSince1970 * 1_000)
      let created = now + offset
      let client = NativeClient(
        id: "native-1", role: "native_phone_controller", label: pending.label,
        grants: pending.grants, createdAt: created, expiresAt: created + 90 * 24 * 60 * 60 * 1_000)
      return NativeEnrollmentCredential(
        origin: pending.origin, certificateSha256: pending.certificateSha256, client: client,
        token: pending.candidateToken)
    }
    let near = NativeEnrollmentStore(
      vault: MemoryVault(value: .active(credential(offset: 299_999))), transport: FakeTransport(),
      now: { self.referenceTime })
    near.startScanning()
    await eventually { if case .enrolled = near.phase { true } else { false } }
    let far = NativeEnrollmentStore(
      vault: MemoryVault(value: .active(credential(offset: 300_001))), transport: FakeTransport(),
      now: { self.referenceTime })
    far.startScanning()
    await eventually { if case .failed = far.phase { true } else { false } }
  }

  @MainActor
  func testExpiredSavedPairingCanBeRemovedWithoutReloadLoop() async {
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://ellie.local:8444")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    let expired = NativeEnrollmentCredential(
      origin: pending.origin, certificateSha256: pending.certificateSha256,
      client: NativeClient(
        id: "native-1", role: "native_phone_controller", label: pending.label,
        grants: pending.grants, createdAt: 1, expiresAt: 1 + 90 * 24 * 60 * 60 * 1_000),
      token: pending.candidateToken)
    let vault = MemoryVault(value: .active(expired))
    let store = NativeEnrollmentStore(vault: vault, transport: FakeTransport())
    store.startScanning()
    await eventually { if case .failed = store.phase { true } else { false } }
    store.removeLocalCredential()
    await eventually { store.phase == .idle }
    let value = await vault.value
    XCTAssertNil(value)
  }

  @MainActor
  func testMalformedRecoveryStaysRecoverableAndLogoutCancellationDoesNotStick() async {
    let pending = PendingNativeEnrollment(
      origin: URL(string: "https://ellie.local:8444")!,
      certificateSha256: String(repeating: "a", count: 64), label: "Phone",
      grants: [NativeGrant(target: "studio-mac", capabilities: ["app.open"])],
      candidateToken: String(repeating: "c", count: 64))
    let malformed = NativeClient(
      id: "other", role: "controller", label: "Wrong", grants: [], createdAt: 1, expiresAt: 2)
    let vault = MemoryVault(value: .pending(pending))
    let transport = FakeTransport(recoveryClient: malformed)
    let store = NativeEnrollmentStore(vault: vault, transport: transport)
    store.startScanning()
    await eventually { if case .pairingUncertain = store.phase { true } else { false } }
    store.recover()
    await eventually { if case .pairingUncertain = store.phase { true } else { false } }

    let created = Int64(Date().timeIntervalSince1970 * 1_000)
    let client = NativeClient(
      id: "native-1", role: "native_phone_controller", label: pending.label, grants: pending.grants,
      createdAt: created, expiresAt: created + 90 * 24 * 60 * 60 * 1_000)
    let active = NativeEnrollmentCredential(
      origin: pending.origin, certificateSha256: pending.certificateSha256, client: client,
      token: pending.candidateToken)
    await vault.set(.active(active))
    await transport.configureLogoutSuspension()
    let fresh = NativeEnrollmentStore(vault: vault, transport: transport)
    fresh.startScanning()
    await eventually { if case .enrolled = fresh.phase { true } else { false } }
    fresh.logout()
    await eventually { await transport.logouts == 1 }
    fresh.cancelTransient()
    await transport.finishLogout()
    await eventually { if case .logoutUncertain = fresh.phase { true } else { false } }
    let stillStored = await vault.value
    XCTAssertEqual(stillStored, .active(active))
  }

  private func pairingQR(label: String = "Phone") -> String {
    let json =
      #"{"version":1,"origin":"https://ellie.local:8444","certificateSha256":"\#(String(repeating: "a", count: 64))","invitation":"\#(String(repeating: "b", count: 64))","expiresAt":1893456600000,"label":\#(quoted(label)),"grants":[{"target":"studio-mac","capabilities":["app.open"]}]}"#
    return envelope(json)
  }
  private func envelope(_ json: String) -> String {
    "ellie-native:v1:"
      + Data(json.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  private func quoted(_ value: String) -> String {
    let data = try! JSONSerialization.data(
      withJSONObject: [value], options: .withoutEscapingSlashes)
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }
  private func runOpenSSL(_ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    XCTAssertEqual(process.terminationStatus, 0)
  }
  @MainActor private func eventually(_ condition: @escaping @MainActor () async -> Bool) async {
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while ContinuousClock.now < deadline {
      if await condition() { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
    XCTFail("Timed out")
  }
}

private actor MemoryVault: NativeCredentialVault {
  var value: StoredNativeEnrollment?
  var reads = 0
  init(value: StoredNativeEnrollment? = nil) { self.value = value }
  var pending: PendingNativeEnrollment? {
    if case .pending(let pending) = value { pending } else { nil }
  }
  func loadPending() -> PendingNativeEnrollment? {
    reads += 1
    return pending
  }
  func loadActive() -> NativeEnrollmentCredential? {
    reads += 1
    if case .active(let active) = value { return active }
    return nil
  }
  func savePending(_ pending: PendingNativeEnrollment) { value = .pending(pending) }
  func promote(_ active: NativeEnrollmentCredential) { value = .active(active) }
  func removePending() { if case .pending = value { value = nil } }
  func removeActive() { if case .active = value { value = nil } }
  func removeAll() { value = nil }
  func set(_ value: StoredNativeEnrollment?) { self.value = value }
}

private actor FakeTransport: NativeEnrollmentTransporting {
  var pairs = 0
  var recovers = 0
  private let pairFailure: NativeEnrollmentFailure?
  private let suspendPair: Bool
  private var pairContinuation: CheckedContinuation<Void, Never>?
  private var recoveryAllowed = false
  private var recoveryClient: NativeClient?
  private var suspendLogout = false
  private var logoutContinuation: CheckedContinuation<Void, Never>?
  var logouts = 0
  init(
    pairFailure: NativeEnrollmentFailure? = nil, suspendPair: Bool = false,
    recoveryClient: NativeClient? = nil
  ) {
    self.pairFailure = pairFailure
    self.suspendPair = suspendPair
    self.recoveryClient = recoveryClient
  }
  func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) async throws
    -> NativeClient
  {
    pairs += 1
    if suspendPair { await withCheckedContinuation { pairContinuation = $0 } }
    if let pairFailure { throw pairFailure }
    return client(pending)
  }
  func recover(_ pending: PendingNativeEnrollment) throws -> NativeClient? {
    recovers += 1
    return recoveryClient ?? (recoveryAllowed ? client(pending) : nil)
  }
  func logout(_ credential: NativeEnrollmentCredential) async throws {
    logouts += 1
    if suspendLogout { await withCheckedContinuation { logoutContinuation = $0 } }
  }
  func allowRecovery() { recoveryAllowed = true }
  func finishPair() {
    pairContinuation?.resume()
    pairContinuation = nil
  }
  func configureLogoutSuspension() { suspendLogout = true }
  func finishLogout() {
    logoutContinuation?.resume()
    logoutContinuation = nil
  }
  private func client(_ pending: PendingNativeEnrollment) -> NativeClient {
    let created = Int64(Date().timeIntervalSince1970 * 1_000)
    return NativeClient(
      id: "native-1", role: "native_phone_controller", label: pending.label, grants: pending.grants,
      createdAt: created, expiresAt: created + 90 * 24 * 60 * 60 * 1_000)
  }
}
