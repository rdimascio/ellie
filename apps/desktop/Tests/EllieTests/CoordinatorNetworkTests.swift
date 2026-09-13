import Darwin
import Foundation
import XCTest
@testable import Ellie

final class CoordinatorNetworkTests: XCTestCase {
    func testRealTLSRequestUsesExpectedPathHeadersAndBearer() async throws {
        let server = try await LoopbackCoordinator(mode: "success")
        defer { server.stop() }

        let nodes = try await PinnedCoordinatorClient().nodes(connection: server.connection)

        XCTAssertEqual(nodes.map(\.id), ["loopback-mac"])
        XCTAssertEqual(nodes.first?.capabilities, ["app.open", "window.place"])
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

private final class LoopbackCoordinator: @unchecked Sendable {
    private static let token = String(repeating: "a", count: 64)
    private let process: Process
    private let directory: URL
    let connection: CoordinatorConnection
    let sinkHitURL: URL

    convenience init(mode: String) async throws {
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
            try Self.opensslConfiguration.write(to: config, atomically: true, encoding: .utf8)
            try Self.serverScript.write(to: script, atomically: true, encoding: .utf8)
            try Self.runBounded("/usr/bin/openssl", arguments: [
                "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                "-keyout", key.path, "-out", certificate.path, "-config", config.path,
            ])
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
        if (req.url !== '/v1/nodes' || req.method !== 'GET' || req.headers['x-ellie-version'] !== '1' || req.headers.authorization !== `Bearer ${token}`) {
          res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{}');
        }
        if (mode === 'redirect') {
          res.writeHead(302, { location: `https://127.0.0.1:${sink.address().port}/target`, 'content-type': 'application/json' }); return res.end('{}');
        }
        if (mode === 'oversize') {
          res.writeHead(200, { 'content-type': 'application/json' }); return res.end(Buffer.alloc(128 * 1024 + 1, 32));
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
