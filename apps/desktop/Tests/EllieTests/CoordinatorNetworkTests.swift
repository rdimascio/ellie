import Darwin
import Foundation
import XCTest
@testable import Ellie

final class CoordinatorNetworkTests: XCTestCase {
    func testRealTLSAcceptsTheExistingCoordinatorGeneratorIdentity() async throws {
        let server = try await LoopbackCoordinator(mode: "success", certificateProfile: .legacy)
        defer { server.stop() }
        let nodes = try await PinnedCoordinatorClient().nodes(connection: server.connection)
        XCTAssertEqual(nodes.map(\.id), ["loopback-mac"])
    }

    func testRealTLSLegacyCertificateMismatchSendsNoRequest() async throws {
        let server = try await LoopbackCoordinator(mode: "success", certificateProfile: .legacy)
        defer { server.stop() }
        let other = try await LoopbackCoordinator(mode: "success", certificateProfile: .legacy)
        defer { other.stop() }
        let mismatched = CoordinatorConnection(origin: server.connection.origin,
            certificateDER: other.connection.certificateDER, token: server.connection.token)
        do {
            _ = try await PinnedCoordinatorClient().nodes(connection: mismatched)
            XCTFail("A different legacy identity was accepted")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .trustFailed)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.requestHitURL.path))
    }

    func testRealTLSModernNameAndPurposeFailuresSendNoRequest() async throws {
        for profile in [CoordinatorCertificateProfile.wrongDNS, .clientOnly] {
            let server = try await LoopbackCoordinator(mode: "success", certificateProfile: profile)
            defer { server.stop() }
            do {
                _ = try await PinnedCoordinatorClient().nodes(connection: server.connection)
                XCTFail("A modern certificate with the wrong name or purpose was accepted")
            } catch {
                XCTAssertEqual(error as? CoordinatorFailure, .trustFailed)
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: server.requestHitURL.path))
        }
    }

    func testRealTLSRequestUsesExpectedPathHeadersAndBearer() async throws {
        let server = try await LoopbackCoordinator(mode: "success")
        defer { server.stop() }

        let nodes = try await PinnedCoordinatorClient().nodes(connection: server.connection)

        XCTAssertEqual(nodes.map(\.id), ["loopback-mac"])
        XCTAssertEqual(nodes.first?.capabilities, ["app.open", "window.place"])
    }

    func testRealTLSCommandPostsFiniteAppRequest() async throws {
        let server = try await LoopbackCoordinator(mode: "action")
        defer { server.stop() }

        let outcome = try await PinnedCoordinatorClient().openApp(
            connection: server.connection, nodeID: "loopback-mac", app: .safari
        )
        XCTAssertEqual(outcome, .completed)
    }

    func testRealTLSRedirectIsRefusedWithoutForwardingCredential() async throws {
        let server = try await LoopbackCoordinator(mode: "redirect")
        defer { server.stop() }

        do {
            _ = try await PinnedCoordinatorClient().nodes(connection: server.connection)
            XCTFail("expected redirect rejection")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .invalidResponse)
        }
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertFalse(FileManager.default.fileExists(atPath: server.sinkHitURL.path))
    }

    func testRealTLSStreamingBodyLimitCancelsOversizedResponse() async throws {
        let server = try await LoopbackCoordinator(mode: "oversize")
        defer { server.stop() }

        do {
            _ = try await PinnedCoordinatorClient().nodes(connection: server.connection)
            XCTFail("expected bounded response rejection")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .invalidResponse)
        }
    }

    func testRealTLSRejectsNonJSONResponseMetadata() async throws {
        let server = try await LoopbackCoordinator(mode: "wrong-mime")
        defer { server.stop() }

        do {
            _ = try await PinnedCoordinatorClient().nodes(connection: server.connection)
            XCTFail("expected content type rejection")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .invalidResponse)
        }
    }

    func testRealTLSAbsoluteDeadlineStopsSlowDrip() async throws {
        let server = try await LoopbackCoordinator(mode: "drip")
        defer { server.stop() }
        let clock = ContinuousClock()
        let start = clock.now

        do {
            _ = try await PinnedCoordinatorClient().nodes(connection: server.connection)
            XCTFail("expected deadline")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .unavailable)
        }
        let elapsed = start.duration(to: clock.now)
        XCTAssertGreaterThanOrEqual(elapsed, .seconds(4.5))
        XCTAssertLessThan(elapsed, .seconds(6.5))
    }

    func testRealTLSCancellationPromptlyCancelsURLSessionTask() async throws {
        let server = try await LoopbackCoordinator(mode: "drip")
        defer { server.stop() }
        let client = PinnedCoordinatorClient()
        let task = Task { try await client.nodes(connection: server.connection) }
        try await Task.sleep(for: .milliseconds(150))
        let clock = ContinuousClock()
        let start = clock.now

        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected cancellation")
        } catch {
            XCTAssertEqual(error as? CoordinatorFailure, .cancelled)
        }
        XCTAssertLessThan(start.duration(to: clock.now), .seconds(1))
    }
}

private enum CoordinatorCertificateProfile { case modern, legacy, wrongDNS, clientOnly }

private final class LoopbackCoordinator: @unchecked Sendable {
    private static let token = String(repeating: "a", count: 64)
    private let process: Process
    private let directory: URL
    let connection: CoordinatorConnection
    let sinkHitURL: URL
    var requestHitURL: URL { directory.appendingPathComponent("request-hit") }

    convenience init(mode: String, certificateProfile: CoordinatorCertificateProfile = .modern) async throws {
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("EllieCoordinatorNetwork-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let config = directory.appendingPathComponent("openssl.cnf")
        let key = directory.appendingPathComponent("key.pem")
        let certificate = directory.appendingPathComponent("certificate.pem")
        let certificateDER = directory.appendingPathComponent("certificate.der")
        let script = directory.appendingPathComponent("server.js")
        let ready = directory.appendingPathComponent("ready.json")
        let sinkHit = directory.appendingPathComponent("sink-hit")
        do {
            var certificateConfiguration = Self.opensslConfiguration
            if certificateProfile == .wrongDNS {
                certificateConfiguration = certificateConfiguration.replacingOccurrences(
                    of: "subjectAltName=DNS:ellie.local", with: "subjectAltName=DNS:other.invalid")
            } else if certificateProfile == .clientOnly {
                certificateConfiguration = certificateConfiguration.replacingOccurrences(
                    of: "extendedKeyUsage=serverAuth", with: "extendedKeyUsage=clientAuth")
            }
            try certificateConfiguration.write(to: config, atomically: true, encoding: .utf8)
            try Self.serverScript.write(to: script, atomically: true, encoding: .utf8)
            if certificateProfile == .legacy {
                let repository = URL(fileURLWithPath: #filePath)
                    .deletingLastPathComponent().deletingLastPathComponent()
                    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                let generator = repository.appendingPathComponent("apps/cli/src/certificate.ts")
                try Self.runBounded("/usr/bin/env", arguments: [
                    "node", "--input-type=module", "-e",
                    "const {generateCertificate}=await import(process.argv[1]); const {writeFile}=await import('node:fs/promises'); const identity=await generateCertificate({openssl:'/usr/bin/openssl'}); await writeFile(process.argv[2],identity.key,{mode:0o600}); await writeFile(process.argv[3],identity.cert,{mode:0o600});",
                    generator.absoluteString, key.path, certificate.path,
                ])
            } else {
                try Self.runBounded("/usr/bin/openssl", arguments: [
                    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                    "-keyout", key.path, "-out", certificate.path, "-config", config.path,
                ])
            }
            try Self.runBounded("/usr/bin/openssl", arguments: [
                "x509", "-in", certificate.path, "-outform", "DER", "-out", certificateDER.path,
            ])
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node", script.path, mode, certificate.path, key.path, ready.path, sinkHit.path, Self.token]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            let port: Int
            do {
                port = try await Self.waitForPort(ready, process: process)
            } catch {
                Self.stop(process)
                throw error
            }
            self.init(
                process: process,
                directory: directory,
                connection: CoordinatorConnection(
                    origin: URL(string: "https://127.0.0.1:\(port)")!,
                    certificateDER: try Data(contentsOf: certificateDER),
                    token: Self.token
                ),
                sinkHitURL: sinkHit
            )
        } catch {
            try? manager.removeItem(at: directory)
            throw error
        }
    }

    private init(process: Process, directory: URL, connection: CoordinatorConnection, sinkHitURL: URL) {
        self.process = process
        self.directory = directory
        self.connection = connection
        self.sinkHitURL = sinkHitURL
    }

    func stop() {
        Self.stop(process)
        try? FileManager.default.removeItem(at: directory)
    }

    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let deadline = Date().addingTimeInterval(1)
        while process.isRunning && Date() < deadline { usleep(10_000) }
        if process.isRunning {
            Darwin.kill(process.processIdentifier, SIGKILL)
            let killDeadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < killDeadline { usleep(10_000) }
        }
    }

    private static func waitForPort(_ ready: URL, process: Process) async throws -> Int {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(4))
        while clock.now < deadline {
            guard process.isRunning else { throw HarnessFailure.serverExited }
            if let data = try? Data(contentsOf: ready),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let port = object["port"] as? Int, port > 0
            { return port }
            try await Task.sleep(for: .milliseconds(20))
        }
        throw HarnessFailure.startTimedOut
    }

    private static func runBounded(_ executable: String, arguments: [String]) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(8)
        while process.isRunning && Date() < deadline { usleep(10_000) }
        if process.isRunning {
            process.terminate()
            let terminateDeadline = Date().addingTimeInterval(1)
            while process.isRunning && Date() < terminateDeadline { usleep(10_000) }
        }
        if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        guard !process.isRunning, process.terminationStatus == 0 else { throw HarnessFailure.commandFailed }
    }

    private enum HarnessFailure: Error { case commandFailed, serverExited, startTimedOut }

    private static let opensslConfiguration = """
    [req]
    distinguished_name=dn
    x509_extensions=extensions
    prompt=no
    [dn]
    CN=ellie.local
    [extensions]
    subjectAltName=DNS:ellie.local
    basicConstraints=critical,CA:TRUE
    keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign
    extendedKeyUsage=serverAuth
    """

    private static let serverScript = #"""
    const https = require('node:https');
    const fs = require('node:fs');
    const [mode, certPath, keyPath, readyPath, sinkHitPath, token] = process.argv.slice(2);
    const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath), minVersion: 'TLSv1.2' };
    const sink = https.createServer(options, (req, res) => {
      fs.writeFileSync(sinkHitPath, JSON.stringify({ authorization: req.headers.authorization || null }));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]');
    });
    let main;
    sink.listen(0, '127.0.0.1', () => {
      main = https.createServer(options, (req, res) => {
        fs.writeFileSync(require('node:path').join(require('node:path').dirname(readyPath), 'request-hit'), 'received', { mode: 0o600 });
        if (mode === 'action') {
          if (req.url !== '/v1/commands' || req.method !== 'POST' || req.headers['x-ellie-version'] !== '1' ||
              req.headers.authorization !== `Bearer ${token}` || req.headers['content-type'] !== 'application/json') {
            res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{}');
          }
          const chunks = [];
          req.on('data', chunk => chunks.push(chunk));
          req.on('end', () => {
            let body;
            try { body = JSON.parse(Buffer.concat(chunks)); } catch { body = null; }
            if (!body || body.nodeId !== 'loopback-mac' || body.text !== 'open app Safari') {
              res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{}');
            }
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, message: 'opened' }));
          });
          return;
        }
        if (req.url !== '/v1/nodes' || req.method !== 'GET' || req.headers['x-ellie-version'] !== '1' || req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{}');
        }
        if (mode === 'redirect') {
          res.writeHead(302, { location: `https://127.0.0.1:${sink.address().port}/target`, 'content-type': 'application/json' }); return res.end('{}');
        }
        if (mode === 'oversize') {
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end(Buffer.alloc(128 * 1024 + 1, 32));
        }
        if (mode === 'wrong-mime') {
          res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('[]');
        }
        if (mode === 'drip') {
          res.writeHead(200, { 'content-type': 'application/json' }); res.write('[');
          const timer = setInterval(() => { if (res.destroyed) clearInterval(timer); else res.write(' '); }, 50);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify([{ id: 'loopback-mac', capabilities: ['url.open'], executionCapabilities: ['app.open', 'window.place'], lastSeen: Date.now() }]));
      });
      main.listen(0, '127.0.0.1', () => fs.writeFileSync(readyPath, JSON.stringify({ port: main.address().port }), { mode: 0o600 }));
    });
    const close = () => { if (main) main.closeAllConnections(); sink.closeAllConnections(); process.exit(0); };
    process.on('SIGTERM', close); process.on('SIGINT', close);
    setTimeout(() => process.exit(2), 20000).unref();
    """#
}
