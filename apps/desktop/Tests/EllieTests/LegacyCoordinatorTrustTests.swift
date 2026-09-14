import Darwin
import Foundation
import Security
import XCTest

@testable import Ellie

final class LegacyCoordinatorTrustTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "EllieLegacyTrust-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: false,
      attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    if let directory { try FileManager.default.removeItem(at: directory) }
    directory = nil
  }

  func testExactLegacyGeneratorProfileUsesPinnedBasicTrust() throws {
    let legacy = try certificate(name: "legacy")
    XCTAssertTrue(legacyCoordinatorCertificate(legacy))
    XCTAssertTrue(validate(legacy, pinned: legacy, at: Date()))

    var tamperedDER = SecCertificateCopyData(legacy) as Data
    tamperedDER[tamperedDER.index(before: tamperedDER.endIndex)] ^= 1
    let tampered = try XCTUnwrap(SecCertificateCreateWithData(nil, tamperedDER as CFData))
    XCTAssertFalse(legacyCoordinatorCertificate(tampered))
    XCTAssertFalse(validate(tampered, pinned: tampered, at: Date()))

    let other = try certificate(name: "other")
    XCTAssertFalse(validate(legacy, pinned: other, at: Date()))
    XCTAssertFalse(validate(legacy, pinned: legacy, at: Date().addingTimeInterval(-86_400)))
    XCTAssertFalse(validate(legacy, pinned: legacy, at: Date().addingTimeInterval(366 * 86_400)))
  }

  func testLegacyFallbackRejectsDifferentNameAlgorithmKeyAndExtendedProfiles() throws {
    let extraName = try certificate(name: "extra-name", subject: "/CN=ellie.local/OU=Other")
    let wrongName = try certificate(name: "wrong-name", subject: "/CN=other.local")
    let sha384 = try certificate(name: "sha384", digest: "-sha384")
    let weakKey = try certificate(name: "weak-key", bits: 1_024)
    let wrongSAN = try certificate(
      name: "wrong-san", extensions: "subjectAltName=DNS:other.local\nextendedKeyUsage=serverAuth")
    let wrongEKU = try certificate(
      name: "wrong-eku", extensions: "subjectAltName=DNS:ellie.local\nextendedKeyUsage=clientAuth")

    for rejected in [extraName, wrongName, sha384, weakKey, wrongSAN, wrongEKU] {
      XCTAssertFalse(legacyCoordinatorCertificate(rejected))
      XCTAssertFalse(validate(rejected, pinned: rejected, at: Date()))
    }
  }

  func testModernNamedServerCertificateKeepsStrictSSLPath() throws {
    let modern = try certificate(
      name: "modern", extensions: "subjectAltName=DNS:ellie.local\nextendedKeyUsage=serverAuth")
    XCTAssertFalse(legacyCoordinatorCertificate(modern))
    XCTAssertTrue(validate(modern, pinned: modern, at: Date()))
  }

  private func validate(
    _ peer: SecCertificate, pinned: SecCertificate, at date: Date
  ) -> Bool {
    var trust: SecTrust?
    XCTAssertEqual(
      SecTrustCreateWithCertificates(peer, SecPolicyCreateBasicX509(), &trust), errSecSuccess)
    guard let trust else { return false }
    return PinnedCoordinatorClient.validateServerTrust(
      trust, pinnedCertificate: pinned, at: date)
  }

  private func certificate(
    name: String, subject: String = "/CN=ellie.local", digest: String = "-sha256",
    bits: Int = 2_048, extensions: String? = nil
  ) throws -> SecCertificate {
    let key = directory.appendingPathComponent("\(name)-key.pem")
    let pem = directory.appendingPathComponent("\(name).pem")
    let der = directory.appendingPathComponent("\(name).der")
    var arguments = [
      "req", "-x509", "-newkey", "rsa:\(bits)", digest, "-nodes", "-days", "2",
      "-keyout", key.path, "-out", pem.path, "-subj", subject,
    ]
    if let extensions {
      let config = directory.appendingPathComponent("\(name).cnf")
      try
        "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\nCN=ellie.local\n[extensions]\n\(extensions)\n"
        .write(
          to: config, atomically: true, encoding: .utf8)
      arguments.append(contentsOf: ["-config", config.path, "-extensions", "extensions"])
    }
    try runOpenSSL(arguments)
    try runOpenSSL(["x509", "-in", pem.path, "-outform", "DER", "-out", der.path])
    return try XCTUnwrap(
      SecCertificateCreateWithData(nil, try Data(contentsOf: der) as CFData))
  }

  private func runOpenSSL(_ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/openssl")
    process.arguments = arguments
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    let deadline = Date().addingTimeInterval(10)
    while process.isRunning && Date() < deadline { usleep(10_000) }
    if process.isRunning {
      process.terminate()
      let terminateDeadline = Date().addingTimeInterval(1)
      while process.isRunning && Date() < terminateDeadline { usleep(10_000) }
    }
    if process.isRunning {
      Darwin.kill(process.processIdentifier, SIGKILL)
      let killDeadline = Date().addingTimeInterval(1)
      while process.isRunning && Date() < killDeadline { usleep(10_000) }
    }
    guard !process.isRunning, process.terminationStatus == 0 else {
      throw FixtureFailure.commandFailed
    }
  }

  private enum FixtureFailure: Error { case commandFailed }
}
