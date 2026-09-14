import Darwin
import Foundation
import Security

enum CoordinatorRole: String, CaseIterable, Identifiable {
    case coordinator
    case node

    var id: String { rawValue }
    var title: String {
        switch self {
        case .coordinator: "Coordinator"
        case .node: "Node"
        }
    }
}

struct InstalledCoordinatorLoader: Sendable {
    typealias CredentialReader = @Sendable (_ account: String) async throws -> String

    private static let maximumConfigBytes = 64 * 1024
    private static let maximumCertificateBytes = 256 * 1024

    let stateDirectory: URL
    private let credentialReader: CredentialReader?

    init(stateDirectory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ellie", isDirectory: true)) {
        self.stateDirectory = stateDirectory
        self.credentialReader = nil
    }

    init(stateDirectory: URL, credentialReader: @escaping CredentialReader) {
        self.stateDirectory = stateDirectory
        self.credentialReader = credentialReader
    }

    func load(role: CoordinatorRole) async throws -> CoordinatorConnection {
        guard !Task.isCancelled else { throw CoordinatorFailure.cancelled }
        let directory = try PrivateDirectory(url: stateDirectory)
        defer { directory.close() }

        let configName: String
        let certificateName: String
        switch role {
        case .coordinator:
            configName = "server.json"
            certificateName = "server-cert.pem"
        case .node:
            configName = "node.json"
            certificateName = "node-server-cert.pem"
        }

        let config = try directory.read(name: configName, maximumBytes: Self.maximumConfigBytes)
        let certificatePEM = try directory.read(name: certificateName, maximumBytes: Self.maximumCertificateBytes)
        let parsed = try Self.parseConfiguration(config, role: role)
        let certificateDER = try Self.decodeCertificate(certificatePEM)
        guard !Task.isCancelled else { throw CoordinatorFailure.cancelled }

        let token: String
        do {
            if let credentialReader {
                token = try await credentialReader(parsed.account)
            } else {
                token = try await NativeHelperCredentialReader(stateDirectory: stateDirectory).read(account: parsed.account)
            }
        } catch is CancellationError {
            throw CoordinatorFailure.cancelled
        } catch let failure as CoordinatorFailure {
            if Task.isCancelled { throw CoordinatorFailure.cancelled }
            throw failure
        } catch {
            if Task.isCancelled { throw CoordinatorFailure.cancelled }
            throw CoordinatorFailure.credentialUnavailable
        }
        guard !Task.isCancelled else { throw CoordinatorFailure.cancelled }
        guard Self.isBearerSafe(token) else { throw CoordinatorFailure.credentialUnavailable }
        return CoordinatorConnection(origin: parsed.origin, certificateDER: certificateDER, token: token)
    }

    private static func parseConfiguration(_ data: Data, role: CoordinatorRole) throws -> (origin: URL, account: String) {
        let object: [String: Any]
        do {
            guard let dictionary = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw CoordinatorFailure.configurationUnsafe
            }
            object = dictionary
        } catch {
            throw CoordinatorFailure.configurationUnsafe
        }
        guard let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(),
              version.intValue == 1, version.doubleValue == 1 else {
            throw CoordinatorFailure.configurationUnsafe
        }

        switch role {
        case .coordinator:
            guard let portNumber = object["port"] as? NSNumber,
                  CFGetTypeID(portNumber) != CFBooleanGetTypeID(),
                  portNumber.doubleValue.rounded() == portNumber.doubleValue,
                  (1...65_535).contains(portNumber.intValue),
                  let origin = URL(string: "https://127.0.0.1:\(portNumber.intValue)") else {
                throw CoordinatorFailure.configurationUnsafe
            }
            return (origin, "server.controller")
        case .node:
            guard let id = object["id"] as? String, isIdentifier(id),
                  let value = object["serverUrl"] as? String,
                  let origin = safeHTTPSOrigin(value) else {
                throw CoordinatorFailure.configurationUnsafe
            }
            return (origin, "node.\(id)")
        }
    }

    private static func safeHTTPSOrigin(_ value: String) -> URL? {
        guard value.utf8.count <= 2_048, let components = URLComponents(string: value),
              components.scheme == "https", let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              (components.path.isEmpty || components.path == "/"),
              components.query == nil, components.fragment == nil,
              components.port.map({ (1...65_535).contains($0) }) ?? true,
              let url = components.url, url.absoluteString == value || url.absoluteString == value + "/" else { return nil }
        return URL(string: components.string!)
    }

    private static func isIdentifier(_ value: String) -> Bool {
        guard let first = value.unicodeScalars.first,
              CharacterSet.alphanumerics.contains(first),
              value.utf8.count <= 100 else { return false }
        return value.unicodeScalars.allSatisfy {
            CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0)
        }
    }

    private static func isBearerSafe(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 512 && value.unicodeScalars.allSatisfy {
            CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-").contains($0)
        }
    }

    private static func decodeCertificate(_ pem: Data) throws -> Data {
        guard let text = String(data: pem, encoding: .utf8) else { throw CoordinatorFailure.invalidCertificate }
        let begin = "-----BEGIN CERTIFICATE-----"
        let end = "-----END CERTIFICATE-----"
        let pieces = text.components(separatedBy: begin)
        guard pieces.count == 2, pieces[0].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CoordinatorFailure.invalidCertificate
        }
        let endings = pieces[1].components(separatedBy: end)
        guard endings.count == 2, endings[1].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw CoordinatorFailure.invalidCertificate
        }
        let base64 = endings[0].components(separatedBy: .whitespacesAndNewlines).joined()
        guard let der = Data(base64Encoded: base64), !der.isEmpty,
              SecCertificateCreateWithData(nil, der as CFData) != nil else {
            throw CoordinatorFailure.invalidCertificate
        }
        return der
    }
}

private final class PrivateDirectory {
    private var descriptor: Int32

    init(url: URL) throws {
        descriptor = Darwin.open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else {
            if errno == ENOENT { throw CoordinatorFailure.configurationMissing }
            throw CoordinatorFailure.configurationUnsafe
        }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFDIR,
              status.st_uid == getuid(),
              (status.st_mode & 0o077) == 0 else {
            close()
            throw CoordinatorFailure.configurationUnsafe
        }
    }

    func close() {
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 }
    }

    func read(name: String, maximumBytes: Int) throws -> Data {
        let fd = openat(descriptor, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { throw CoordinatorFailure.configurationMissing }
            throw CoordinatorFailure.configurationUnsafe
        }
        defer { Darwin.close(fd) }
        var status = stat()
        guard fstat(fd, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_uid == getuid(),
              (status.st_mode & 0o077) == 0,
              status.st_size >= 0,
              status.st_size <= maximumBytes else {
            throw CoordinatorFailure.configurationUnsafe
        }
        var data = Data()
        data.reserveCapacity(Int(status.st_size))
        var buffer = [UInt8](repeating: 0, count: 8_192)
        while true {
            let count = Darwin.read(fd, &buffer, min(buffer.count, maximumBytes + 1 - data.count))
            if count == 0 { break }
            guard count > 0 else {
                if errno == EINTR { continue }
                throw CoordinatorFailure.configurationUnsafe
            }
            data.append(buffer, count: count)
            guard data.count <= maximumBytes else { throw CoordinatorFailure.configurationUnsafe }
        }
        return data
    }
}

struct NativeHelperCredentialReader: Sendable {
    let stateDirectory: URL
    let timeout: DispatchTimeInterval

    init(stateDirectory: URL, timeout: DispatchTimeInterval = .seconds(5)) {
        self.stateDirectory = stateDirectory
        self.timeout = timeout
    }

    func read(account: String) async throws -> String {
        let helper = stateDirectory.appendingPathComponent("bin/ellie-macos")
        try validateHelper(helper)
        let request = try JSONSerialization.data(withJSONObject: ["command": "keychain.get", "account": account])
        let operation = HelperOperation(executable: helper, request: request, timeout: timeout)
        return try await withTaskCancellationHandler(operation: {
            try await operation.run()
        }, onCancel: {
            operation.cancel()
        })
    }

    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(200)) {
            if process.isRunning { Darwin.kill(pid, SIGKILL) }
        }
    }

    private func validateHelper(_ url: URL) throws {
        var directoryStatus = stat()
        let directory = url.deletingLastPathComponent()
        guard lstat(directory.path, &directoryStatus) == 0,
              (directoryStatus.st_mode & S_IFMT) == S_IFDIR,
              directoryStatus.st_uid == getuid(),
              (directoryStatus.st_mode & 0o022) == 0 else {
            throw CoordinatorFailure.credentialUnavailable
        }
        var status = stat()
        guard lstat(url.path, &status) == 0,
              (status.st_mode & S_IFMT) == S_IFREG,
              status.st_uid == getuid(),
              (status.st_mode & 0o022) == 0,
              (status.st_mode & 0o100) != 0 else {
            throw CoordinatorFailure.credentialUnavailable
        }
    }
}

private final class HelperOperation: @unchecked Sendable {
    private let executable: URL
    private let request: Data
    private let timeout: DispatchTimeInterval
    private let lock = NSLock()
    private let process = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var timer: DispatchSourceTimer?
    private var continuation: CheckedContinuation<String, Error>?
    private var outputData = Data()
    private var exitStatus: Int32?
    private var sawEOF = false
    private var completed = false

    init(executable: URL, request: Data, timeout: DispatchTimeInterval) {
        self.executable = executable
        self.request = request
        self.timeout = timeout
    }

    func run() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            guard !completed else {
                lock.unlock()
                continuation.resume(throwing: CoordinatorFailure.cancelled)
                return
            }
            self.continuation = continuation
            lock.unlock()
            start()
        }
    }

    func cancel() {
        finish(.failure(CoordinatorFailure.cancelled), stoppingProcess: true)
    }

    private func start() {
        process.executableURL = executable
        process.arguments = []
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            self.received(data)
        }
        process.terminationHandler = { [weak self] process in
            self?.exited(status: process.terminationStatus)
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
        timer.setEventHandler { [weak self] in
            self?.finish(.failure(CoordinatorFailure.credentialUnavailable), stoppingProcess: true)
        }
        timer.schedule(deadline: .now() + timeout)
        timer.resume()
        lock.lock()
        if completed {
            lock.unlock()
            timer.cancel()
            return
        }
        self.timer = timer
        lock.unlock()
        do {
            try process.run()
            lock.lock()
            let wasCancelled = completed
            lock.unlock()
            if wasCancelled {
                Self.stop(process)
                return
            }
            input.fileHandleForWriting.write(request)
            try? input.fileHandleForWriting.close()
        } catch {
            finish(.failure(CoordinatorFailure.credentialUnavailable), stoppingProcess: true)
        }
    }

    private func received(_ data: Data) {
        var result: Result<String, Error>?
        lock.lock()
        if !completed {
            if data.isEmpty {
                sawEOF = true
            } else if outputData.count + data.count > 65_536 {
                result = .failure(CoordinatorFailure.credentialUnavailable)
            } else {
                outputData.append(data)
            }
            if result == nil { result = completedResultLocked() }
        }
        lock.unlock()
        if let result { finish(result, stoppingProcess: result.isFailure) }
    }

    private func exited(status: Int32) {
        lock.lock()
        if !completed { exitStatus = status }
        let result = completed ? nil : completedResultLocked()
        lock.unlock()
        if let result { finish(result, stoppingProcess: false) }
    }

    private func completedResultLocked() -> Result<String, Error>? {
        guard sawEOF, let exitStatus else { return nil }
        guard exitStatus == 0,
              let object = try? JSONSerialization.jsonObject(with: outputData) as? [String: Any],
              let value = object["value"] as? String else {
            return .failure(CoordinatorFailure.credentialUnavailable)
        }
        return .success(value)
    }

    private func finish(_ result: Result<String, Error>, stoppingProcess: Bool) {
        let saved: CheckedContinuation<String, Error>?
        let savedTimer: DispatchSourceTimer?
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        saved = continuation
        continuation = nil
        savedTimer = timer
        timer = nil
        lock.unlock()

        output.fileHandleForReading.readabilityHandler = nil
        savedTimer?.cancel()
        if stoppingProcess { Self.stop(process) }
        saved?.resume(with: result)
    }

    private static func stop(_ process: Process) {
        guard process.isRunning else { return }
        process.terminate()
        let pid = process.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(200)) {
            if process.isRunning { Darwin.kill(pid, SIGKILL) }
        }
    }
}

private extension Result {
    var isFailure: Bool {
        if case .failure = self { return true }
        return false
    }
}
