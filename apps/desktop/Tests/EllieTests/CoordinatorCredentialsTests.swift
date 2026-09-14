import Foundation
import Darwin
import XCTest
@testable import Ellie

final class CoordinatorCredentialsTests: XCTestCase {
    private var fixtureDirectories: [URL] = []

    override func tearDownWithError() throws {
        for directory in fixtureDirectories { try FileManager.default.removeItem(at: directory) }
        fixtureDirectories = []
    }

    private let certificate = """
    -----BEGIN CERTIFICATE-----
    MIICpDCCAYwCCQDNZsykCMgCzDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
    b2NhbGhvc3QwHhcNMjYwOTEzMDc0MjQyWhcNMjYwOTE0MDc0MjQyWjAUMRIwEAYD
    VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDS
    +dixu75u7xZDX8XHlFVThbuyZeTG6mR9DrEXeTsI4eczYsixKNyBATzsZwRi6Z4W
    kCjkheOhKSmxX1Wjs3ZY+WiBl+I9DGekeF+0EnyTZAHTmFBQBWB7q+Ij8/8VvBUZ
    x9IbdtkWJtbqOzJTiZolxvel1x+izzjq91Dk67YYtwdUH4qGobbUKRC7KDKefz7Q
    8WCkyXuywFIgL8QFJiuVqKiae2kg7pzNQ5Oh+Q8EGSZBgtcRk7pPAzKmrHEejZgn
    sPGbTDWgLFryO2yQY1gnaJ/inx1WoF32Wmp9e0l1XHBuP8jbj/rUj19sigr+5+gO
    SPDQRtYQBfd4XBHw9mPhAgMBAAEwDQYJKoZIhvcNAQELBQADggEBAD6rvsgdvC+w
    pbbebWomdFYZankZ3XdGlG8ICJY7RqHI0Wr92Y+hjhjZTnHNSurVW3LmekaeWq3B
    o0Vi2ky5dMTZLh/zFvRFLoecVEjBqbQ+7Sr0Dyk62/CuFetaj/dg2UYV7MEu9j9z
    5LiL84M+/Gzoqou825CZEKRR75XYk5LxMVnPdoAgy6glHNgQ/+QLvZhaXSiEhoLG
    CyFdyAFFcB62W0tzsFYK4aLBWraj/J0ijLOjJslDzOp6wLz4DirXf3WduJIo0G1C
    R6rYE7r6kQDUtp71updjXArY1My/wrl5omkMGdHZWOikL7JVPDrTGoCBHCVoWWhK
    Pgv2EmMm/pY=
    -----END CERTIFICATE-----
    """

    func testCoordinatorMapsLoopbackPortAndControllerAccount() async throws {
        let directory = try fixture(config: #"{"version":1,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem")
        let capture = AccountCapture()
        let loader = InstalledCoordinatorLoader(stateDirectory: directory) { account in
            await capture.set(account)
            return String(repeating: "a", count: 64)
        }
        let connection = try await loader.load(role: .coordinator)
        XCTAssertEqual(connection.origin.absoluteString, "https://127.0.0.1:7437")
        let account = await capture.value()
        XCTAssertEqual(account, "server.controller")
    }

    func testNodeMapsConfiguredOriginAndNodeAccount() async throws {
        let directory = try fixture(config: #"{"version":1,"id":"kitchen-mac","serverUrl":"https://ellie.local:7437"}"#, configName: "node.json", certificateName: "node-server-cert.pem")
        let capture = AccountCapture()
        let loader = InstalledCoordinatorLoader(stateDirectory: directory) { account in
            await capture.set(account)
            return String(repeating: "b", count: 64)
        }
        let connection = try await loader.load(role: .node)
        XCTAssertEqual(connection.origin.absoluteString, "https://ellie.local:7437")
        let account = await capture.value()
        XCTAssertEqual(account, "node.kitchen-mac")
    }

    func testMissingAndFutureConfigurationAreRejectedBeforeCredentialRead() async throws {
        let missing = try privateDirectory()
        try await assertFailure(.configurationMissing, loader: loaderThatMustNotRead(missing), role: .node)

        let future = try fixture(config: #"{"version":2,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem")
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(future), role: .coordinator)
    }

    func testUnsafeOriginAndOversizeConfigAreRejectedBeforeCredentialRead() async throws {
        let unsafe = try fixture(config: #"{"version":1,"id":"node","serverUrl":"https://user:secret@example.com/path"}"#, configName: "node.json", certificateName: "node-server-cert.pem")
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(unsafe), role: .node)

        let oversized = try privateDirectory()
        try write(Data(repeating: 0x20, count: 65_537), to: oversized.appendingPathComponent("server.json"))
        try write(Data(certificate.utf8), to: oversized.appendingPathComponent("server-cert.pem"))
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(oversized), role: .coordinator)
    }

    func testSymlinkAndPublicPermissionsAreRejectedWithoutReadingCredentials() async throws {
        let directory = try privateDirectory()
        let target = directory.appendingPathComponent("target.json")
        try write(Data(#"{"version":1,"port":7437}"#.utf8), to: target)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("server.json"), withDestinationURL: target)
        try write(Data(certificate.utf8), to: directory.appendingPathComponent("server-cert.pem"))
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(directory), role: .coordinator)

        let publicDirectory = try fixture(config: #"{"version":1,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: publicDirectory.appendingPathComponent("server.json").path)
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(publicDirectory), role: .coordinator)
    }

    func testFIFOConfigurationIsRejectedPromptly() async throws {
        let directory = try privateDirectory()
        let fifo = directory.appendingPathComponent("server.json")
        XCTAssertEqual(Darwin.mkfifo(fifo.path, 0o600), 0)
        try write(Data(certificate.utf8), to: directory.appendingPathComponent("server-cert.pem"))
        try await assertFailure(.configurationUnsafe, loader: loaderThatMustNotRead(directory), role: .coordinator)
    }

    func testInvalidAndMultipleCertificatesAreRejected() async throws {
        for contents in ["not a certificate", certificate + certificate] {
            let directory = try fixture(config: #"{"version":1,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem", certificate: contents)
            try await assertFailure(.invalidCertificate, loader: loaderThatMustNotRead(directory), role: .coordinator)
        }
    }

    func testCancellationDuringCredentialReadIsRedacted() async throws {
        let directory = try fixture(config: #"{"version":1,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem")
        let loader = InstalledCoordinatorLoader(stateDirectory: directory) { _ in
            try await Task.sleep(nanoseconds: 30_000_000_000)
            return "unreachable"
        }
        let task = Task { try await loader.load(role: .coordinator) }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, .cancelled)
        }
    }

    func testUnsafeCredentialIsRejected() async throws {
        let directory = try fixture(config: #"{"version":1,"port":7437}"#, configName: "server.json", certificateName: "server-cert.pem")
        let loader = InstalledCoordinatorLoader(stateDirectory: directory) { _ in "secret with spaces" }
        try await assertFailure(.credentialUnavailable, loader: loader, role: .coordinator)
    }

    func testNativeHelperCollectsFragmentedOutput() async throws {
        let directory = try helperFixture(script: """
        #!/bin/sh
        IFS= read -r ignored
        printf '{"val'
        sleep 0.05
        printf 'ue":"abc_123-XYZ"}'
        """)
        let value = try await NativeHelperCredentialReader(stateDirectory: directory, timeout: .seconds(1)).read(account: "server.controller")
        XCTAssertEqual(value, "abc_123-XYZ")
    }

    func testNativeHelperRejectsOversizeOutput() async throws {
        let directory = try helperFixture(script: """
        #!/bin/sh
        IFS= read -r ignored
        i=0
        while [ "$i" -lt 70000 ]; do
          printf x
          i=$((i + 1))
        done
        """)
        do {
            _ = try await NativeHelperCredentialReader(stateDirectory: directory, timeout: .seconds(2)).read(account: "server.controller")
            XCTFail("Expected bounded-output failure")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, .credentialUnavailable)
        }
    }

    func testNativeHelperTimesOutAndSupportsCancellation() async throws {
        let directory = try helperFixture(script: """
        #!/bin/sh
        IFS= read -r ignored
        exec sleep 30
        """)
        do {
            _ = try await NativeHelperCredentialReader(stateDirectory: directory, timeout: .milliseconds(100)).read(account: "server.controller")
            XCTFail("Expected timeout")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, .credentialUnavailable)
        }

        let task = Task {
            try await NativeHelperCredentialReader(stateDirectory: directory, timeout: .seconds(5)).read(account: "server.controller")
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, .cancelled)
        }
    }

    func testNativeHelperRejectsUnsafeBinDirectory() async throws {
        let directory = try helperFixture(script: "#!/bin/sh\nprintf '{\"value\":\"abc\"}'\n")
        let bin = directory.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o722], ofItemAtPath: bin.path)
        do {
            _ = try await NativeHelperCredentialReader(stateDirectory: directory).read(account: "server.controller")
            XCTFail("Expected unsafe helper-directory failure")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, .credentialUnavailable)
        }
    }

    private func loaderThatMustNotRead(_ directory: URL) -> InstalledCoordinatorLoader {
        InstalledCoordinatorLoader(stateDirectory: directory) { _ in
            XCTFail("Credential reader must not run for unsafe configuration")
            return "unreachable"
        }
    }

    private func assertFailure(_ expected: CoordinatorFailure, loader: InstalledCoordinatorLoader, role: CoordinatorRole) async throws {
        do {
            _ = try await loader.load(role: role)
            XCTFail("Expected \(expected)")
        } catch let failure as CoordinatorFailure {
            XCTAssertEqual(failure, expected)
        }
    }

    private func fixture(config: String, configName: String, certificateName: String, certificate: String? = nil) throws -> URL {
        let directory = try privateDirectory()
        try write(Data(config.utf8), to: directory.appendingPathComponent(configName))
        try write(Data((certificate ?? self.certificate).utf8), to: directory.appendingPathComponent(certificateName))
        return directory
    }

    private func privateDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("EllieCredentials-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        fixtureDirectories.append(url)
        return url
    }

    private func helperFixture(script: String) throws -> URL {
        let directory = try privateDirectory()
        let bin = directory.appendingPathComponent("bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bin.path)
        let helper = bin.appendingPathComponent("ellie-macos")
        try Data(script.utf8).write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        return directory
    }

    private func write(_ data: Data, to url: URL) throws {
        try data.write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

private actor AccountCapture {
    private var account: String?
    func set(_ account: String) { self.account = account }
    func value() -> String? { account }
}
