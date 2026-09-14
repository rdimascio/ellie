import Darwin
import Foundation

private enum FixtureError: Error { case invalid }

private func required(_ name: String) throws -> String {
    guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else {
        throw FixtureError.invalid
    }
    return value
}

private func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value)
    FileHandle.standardOutput.write(data)
}

private func appendEffect(_ app: String) throws -> Bool {
    let path = try required("ELLIE_PACKAGED_RUNTIME_EFFECTS")
    let descriptor = open(path, O_WRONLY | O_APPEND | O_NOFOLLOW)
    guard descriptor >= 0 else { throw FixtureError.invalid }
    defer { close(descriptor) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_nlink == 1,
          information.st_uid == getuid(),
          information.st_size >= 0,
          information.st_size <= 4096
    else { throw FixtureError.invalid }
    let bytes = Array((app + "\n").utf8)
    guard bytes.count <= 101, write(descriptor, bytes, bytes.count) == bytes.count else {
        throw FixtureError.invalid
    }
    return information.st_size == 0
}

private func recordProcess() throws {
    let path = try required("ELLIE_PACKAGED_RUNTIME_HELPER_PID")
    let descriptor = open(path, O_WRONLY | O_APPEND | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw FixtureError.invalid }
    defer { close(descriptor) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_nlink == 1,
          information.st_uid == getuid(),
          Int(information.st_mode & 0o7777) == 0o600,
          information.st_size >= 0,
          information.st_size <= 4096
    else { throw FixtureError.invalid }
    let bytes = Array("\(getpid())\n".utf8)
    guard write(descriptor, bytes, bytes.count) == bytes.count else { throw FixtureError.invalid }
}

private func releaseRequested() throws -> Bool {
    let descriptor = open(try required("ELLIE_PACKAGED_RUNTIME_HELPER_RELEASE"),
                          O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    if descriptor < 0 {
        if errno == ENOENT { return false }
        throw FixtureError.invalid
    }
    defer { close(descriptor) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_nlink == 1,
          information.st_uid == getuid(),
          Int(information.st_mode & 0o7777) == 0o600,
          information.st_size > 0,
          information.st_size <= 64
    else { throw FixtureError.invalid }
    var data = Data(count: Int(information.st_size))
    let count = data.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
    let token = try required("ELLIE_PACKAGED_RUNTIME_TOKEN")
    guard count == data.count,
          String(data: data, encoding: .utf8) == token
    else { throw FixtureError.invalid }
    return true
}

private func acknowledgeRelease() throws {
    let token = try required("ELLIE_PACKAGED_RUNTIME_TOKEN")
    let descriptor = open(try required("ELLIE_PACKAGED_RUNTIME_HELPER_ACK"),
                          O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard descriptor >= 0 else { throw FixtureError.invalid }
    defer { close(descriptor) }
    let bytes = Array(token.utf8)
    guard write(descriptor, bytes, bytes.count) == bytes.count else { throw FixtureError.invalid }
}

private func waitForRelease() throws {
    let deadline = DispatchTime.now().uptimeNanoseconds + 15_000_000_000
    while DispatchTime.now().uptimeNanoseconds < deadline {
        if try releaseRequested() {
            try acknowledgeRelease()
            return
        }
        usleep(20_000)
    }
    throw FixtureError.invalid
}

private func secrets() throws -> [String: String] {
    let descriptor = open(try required("ELLIE_PACKAGED_RUNTIME_SECRETS"), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw FixtureError.invalid }
    defer { close(descriptor) }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_nlink == 1,
          information.st_uid == getuid(),
          information.st_size >= 0,
          information.st_size <= 4096
    else { throw FixtureError.invalid }
    var data = Data(count: Int(information.st_size))
    var offset = 0
    while offset < data.count {
        let count = data.withUnsafeMutableBytes {
            read(descriptor, $0.baseAddress?.advanced(by: offset), $0.count - offset)
        }
        guard count > 0 else { throw FixtureError.invalid }
        offset += count
    }
    guard
          let value = try JSONSerialization.jsonObject(with: data) as? [String: String]
    else { throw FixtureError.invalid }
    return value
}

@main
enum PackagedRuntimeHelper {
    static func main() {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 32_768,
                  let request = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { throw FixtureError.invalid }
            if let command = request["command"] as? String {
                if command == "keychain.get" {
                    guard let account = request["account"] as? String,
                          account.count <= 100,
                          let value = try secrets()[account]
                    else { throw FixtureError.invalid }
                    try emit(["value": value])
                } else if command == "doctor" {
                    try emit(["accessibility": true, "ok": true])
                } else if command == "telemetry" {
                    try emit(["thermal": "nominal", "lowPowerMode": false])
                } else {
                    throw FixtureError.invalid
                }
                return
            }
            guard request["tool"] as? String == "app.open",
                  let app = request["app"] as? String,
                  ["company.thebrowser.Browser", "com.apple.Safari"].contains(app)
            else { throw FixtureError.invalid }
            try recordProcess()
            let first = try appendEffect(app)
            if first {
                // The first effect remains unsettled until the runner explicitly releases this
                // synthetic invocation through its private, per-run token file.
                try waitForRelease()
            }
            try emit(["ok": true, "message": "Done."])
        } catch {
            exit(2)
        }
    }
}
