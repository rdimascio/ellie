import CoreServices
import CryptoKit
import Darwin
import Foundation

private let maximumManifestBytes = 4 * 1024 * 1024
private let maximumPayloadFiles = 2_048
private let maximumPayloadBytes = 512 * 1024 * 1024
private let maximumPayloadEntries = 4_096
private let maximumPayloadDepth = 16

private struct PayloadFile: Decodable {
    let path: String
    let mode: Int
    let size: Int
    let sha256: String
}

private struct Runtime: Decodable {
    let architecture: String
}

private struct Manifest: Decodable {
    let version: Int
    let sourceRevision: String
    let platform: String
    let architecture: String
    let minimumOS: String
    let runtime: Runtime
    let files: [PayloadFile]
}

private enum LauncherFailure: Error {
    case invalid
}

private func safeComponent(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 100 && value != "." && value != ".." &&
        value.utf8.allSatisfy {
                ($0 >= 48 && $0 <= 57) || ($0 >= 65 && $0 <= 90) ||
                ($0 >= 97 && $0 <= 122) || $0 == 32 || "._@+-".utf8.contains($0)
        }
}

private func safeRelative(_ value: String) -> Bool {
    !value.isEmpty && value.count <= 500 && !value.hasPrefix("/") &&
        !value.contains("\\") && value.split(separator: "/", omittingEmptySubsequences: false)
        .allSatisfy { safeComponent(String($0)) }
}

private func exactLowercaseHex(_ value: String, count: Int) -> Bool {
    value.utf8.count == count && value.utf8.allSatisfy {
        ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
    }
}

private func openRegular(_ path: String, maximum: Int, executable: Bool) throws -> (Int32, stat) {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard descriptor >= 0 else { throw LauncherFailure.invalid }
    var information = stat()
    guard fstat(descriptor, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFREG,
          information.st_nlink == 1,
          information.st_uid == getuid(),
          information.st_size >= 0,
          information.st_size <= maximum,
          Int(information.st_mode & 0o7777) == (executable ? 0o555 : 0o444)
    else {
        close(descriptor)
        throw LauncherFailure.invalid
    }
    return (descriptor, information)
}

private func readRegular(_ path: String, maximum: Int) throws -> Data {
    let (descriptor, information) = try openRegular(path, maximum: maximum, executable: false)
    defer { close(descriptor) }
    var result = Data(count: Int(information.st_size))
    var offset = 0
    while offset < result.count {
        let count = result.withUnsafeMutableBytes { bytes in
            read(descriptor, bytes.baseAddress?.advanced(by: offset), bytes.count - offset)
        }
        guard count > 0 else { throw LauncherFailure.invalid }
        offset += count
    }
    return result
}

private func validateDirectory(_ path: String) throws {
    var information = stat()
    guard lstat(path, &information) == 0,
          (information.st_mode & S_IFMT) == S_IFDIR,
          information.st_uid == getuid(),
          Int(information.st_mode & 0o7777) == 0o555
    else { throw LauncherFailure.invalid }
}

private func digest(_ path: String, expectedSize: Int, executable: Bool) throws -> String {
    guard expectedSize >= 0 && expectedSize <= 128 * 1024 * 1024 else {
        throw LauncherFailure.invalid
    }
    let (descriptor, information) = try openRegular(
        path,
        maximum: 128 * 1024 * 1024,
        executable: executable
    )
    defer { close(descriptor) }
    guard information.st_size == expectedSize else { throw LauncherFailure.invalid }
    var hasher = SHA256()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    var remaining = expectedSize
    while remaining > 0 {
        let count = buffer.withUnsafeMutableBytes { bytes in
            read(descriptor, bytes.baseAddress, min(bytes.count, remaining))
        }
        guard count > 0 else { throw LauncherFailure.invalid }
        hasher.update(data: Data(buffer[0 ..< count]))
        remaining -= count
    }
    let trailing = buffer.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, 1) }
    guard trailing == 0 else { throw LauncherFailure.invalid }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func payloadFiles(
    root: String,
    directory: String,
    relativeDirectory: String,
    allowedDirectories: Set<String>,
    depth: Int,
    entryCount: inout Int
) throws -> [String] {
    guard depth <= maximumPayloadDepth else { throw LauncherFailure.invalid }
    try validateDirectory(directory)
    var result: [String] = []
    guard let stream = opendir(directory) else { throw LauncherFailure.invalid }
    defer { closedir(stream) }
    while true {
        errno = 0
        guard let entry = readdir(stream) else {
            guard errno == 0 else { throw LauncherFailure.invalid }
            break
        }
        let name = withUnsafePointer(to: &entry.pointee.d_name) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                String(cString: $0)
            }
        }
        if name == "." || name == ".." { continue }
        guard safeComponent(name) else { throw LauncherFailure.invalid }
        entryCount += 1
        guard entryCount <= maximumPayloadEntries else { throw LauncherFailure.invalid }
        let path = directory + "/" + name
        let relative = relativeDirectory.isEmpty ? name : relativeDirectory + "/" + name
        var information = stat()
        guard lstat(path, &information) == 0 else { throw LauncherFailure.invalid }
        if (information.st_mode & S_IFMT) == S_IFDIR {
            guard allowedDirectories.contains(relative) else { throw LauncherFailure.invalid }
            result += try payloadFiles(
                root: root,
                directory: path,
                relativeDirectory: relative,
                allowedDirectories: allowedDirectories,
                depth: depth + 1,
                entryCount: &entryCount
            )
        } else if (information.st_mode & S_IFMT) == S_IFREG {
            result.append(relative)
        } else {
            throw LauncherFailure.invalid
        }
    }
    return result
}

private func hostArchitecture() -> String {
    #if arch(arm64)
        return "arm64"
    #elseif arch(x86_64)
        return "x64"
    #else
        return "unsupported"
    #endif
}

private func fixedRole() -> String {
    #if ELLIE_COORDINATOR
        return "coordinator"
    #else
        return "node"
    #endif
}

private func validatedRuntime(root: String) throws -> (node: String, entrypoint: String, helper: String) {
    try validateDirectory(root)
    let payload = root + "/payload"
    try validateDirectory(payload)
    let manifestData = try readRegular(root + "/manifest.json", maximum: maximumManifestBytes)
    let manifest = try JSONDecoder().decode(Manifest.self, from: manifestData)
    guard manifest.version == 1,
          manifest.platform == "darwin",
          manifest.architecture == hostArchitecture(),
          manifest.runtime.architecture == hostArchitecture(),
          manifest.minimumOS == "14.0",
          exactLowercaseHex(manifest.sourceRevision, count: 40)
    else { throw LauncherFailure.invalid }

    guard !manifest.files.isEmpty, manifest.files.count <= maximumPayloadFiles else {
        throw LauncherFailure.invalid
    }
    var declared: [String: PayloadFile] = [:]
    var totalSize = 0
    for record in manifest.files {
        guard safeRelative(record.path),
              declared[record.path] == nil,
              record.mode == 0o644 || record.mode == 0o755,
              record.size >= 0,
              record.size <= 128 * 1024 * 1024,
              exactLowercaseHex(record.sha256, count: 64)
        else { throw LauncherFailure.invalid }
        totalSize += record.size
        guard totalSize <= maximumPayloadBytes else { throw LauncherFailure.invalid }
        declared[record.path] = record
    }
    let requiredModes = [
        "bin/node": 0o755,
        "lib/ellie/apps/cli/src/main.ts": 0o644,
        "helpers/ellie-macos": 0o755,
    ]
    for (path, mode) in requiredModes {
        guard declared[path]?.mode == mode else { throw LauncherFailure.invalid }
    }
    var allowedDirectories: Set<String> = []
    for path in declared.keys {
        var components = path.split(separator: "/").map(String.init)
        components.removeLast()
        while !components.isEmpty {
            allowedDirectories.insert(components.joined(separator: "/"))
            components.removeLast()
        }
    }
    var entryCount = 0
    let actual = try payloadFiles(
        root: payload,
        directory: payload,
        relativeDirectory: "",
        allowedDirectories: allowedDirectories,
        depth: 0,
        entryCount: &entryCount
    )
    guard actual.count == declared.count, Set(actual) == Set(declared.keys) else {
        throw LauncherFailure.invalid
    }
    for relative in actual {
        guard let record = declared[relative] else { throw LauncherFailure.invalid }
        let executable = record.mode == 0o755
        let path = payload + "/" + relative
        guard try digest(path, expectedSize: record.size, executable: executable) == record.sha256
        else { throw LauncherFailure.invalid }
    }
    let paths = Dictionary(uniqueKeysWithValues: declared.keys.map { ($0, payload + "/" + $0) })
    guard let node = paths["bin/node"],
          let entrypoint = paths["lib/ellie/apps/cli/src/main.ts"],
          let helper = paths["helpers/ellie-macos"]
    else { throw LauncherFailure.invalid }
    return (node, entrypoint, helper)
}

@main
enum ElliePackagedService {
    static func main() {
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--register" {
            exit(LSRegisterURL(Bundle.main.bundleURL as CFURL, true) == noErr ? 0 : 70)
        }
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1] == "--launch-agent"
        else { exit(78) }
        do {
            let runtime = try validatedRuntime(root: FileManager.default.currentDirectoryPath)
            guard setenv("ELLIE_MACOS_HELPER", runtime.helper, 1) == 0 else { exit(70) }
            for name in [
                "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_ICU_DATA",
                "NODE_COMPILE_CACHE", "NODE_V8_COVERAGE", "NODE_TLS_REJECT_UNAUTHORIZED",
                "OPENSSL_CONF", "SSL_CERT_FILE", "SSL_CERT_DIR",
            ] {
                unsetenv(name)
            }
            let path = (runtime.node as NSString).deletingLastPathComponent +
                ":/usr/bin:/bin:/usr/sbin:/sbin"
            guard setenv("PATH", path, 1) == 0 else { exit(70) }
            let arguments = [runtime.node, runtime.entrypoint, "service", "run", fixedRole()]
            let strings = arguments.map { strdup($0) }
            defer { strings.forEach { free($0) } }
            var argv = strings + [nil]
            execv(runtime.node, &argv)
        } catch {
            exit(78)
        }
        exit(70)
    }
}
