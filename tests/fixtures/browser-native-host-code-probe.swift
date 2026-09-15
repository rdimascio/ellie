enum BrowserNativeHostCodeProbeFailure: Error { case step(Int32) }

@main
enum BrowserNativeHostCodeProbe {
  private static func sameIdentity(_ left: stat, _ right: stat) -> Bool {
    left.st_dev == right.st_dev && left.st_ino == right.st_ino && left.st_uid == right.st_uid
      && left.st_mode == right.st_mode
  }

  private static func run() throws {
    guard CommandLine.arguments.count == 2 else { throw BrowserNativeHostCodeProbeFailure.step(2) }
    let executable = URL(fileURLWithPath: CommandLine.arguments[1])
      .resolvingSymlinksInPath().standardizedFileURL
    var template = Array("/tmp/ellie-code.XXXXXX".utf8CString)
    guard mkdtemp(&template) != nil else { throw BrowserNativeHostCodeProbeFailure.step(3) }
    let directory = String(cString: template)
    var ownedDirectory = stat()
    guard lstat(directory, &ownedDirectory) == 0, (ownedDirectory.st_mode & S_IFMT) == S_IFDIR,
      ownedDirectory.st_uid == getuid(), (ownedDirectory.st_mode & 0o777) == 0o700
    else { throw BrowserNativeHostCodeProbeFailure.step(4) }
    let socketPath = directory + "/peer.sock"
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { _ = rmdir(directory); throw BrowserNativeHostCodeProbeFailure.step(5) }
    var ownedSocket: stat?
    defer {
      Darwin.close(listener)
      if let expected = ownedSocket {
        var current = stat()
        if lstat(socketPath, &current) == 0, sameIdentity(current, expected) { _ = unlink(socketPath) }
      }
      var currentDirectory = stat()
      if lstat(directory, &currentDirectory) == 0,
        sameIdentity(currentDirectory, ownedDirectory)
      { _ = rmdir(directory) }
    }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8) + [0]
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
      throw BrowserNativeHostCodeProbeFailure.step(6)
    }
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: pathBytes) }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    var boundAddress = address
    let bound = withUnsafePointer(to: &boundAddress) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        bind(listener, $0, socklen_t(address.sun_len))
      }
    }
    var socketInfo = stat()
    guard bound == 0, chmod(socketPath, 0o600) == 0, listen(listener, 1) == 0,
      lstat(socketPath, &socketInfo) == 0, (socketInfo.st_mode & S_IFMT) == S_IFSOCK,
      socketInfo.st_uid == getuid(), (socketInfo.st_mode & 0o777) == 0o600
    else { throw BrowserNativeHostCodeProbeFailure.step(7) }
    ownedSocket = socketInfo

    let child = Process()
    child.executableURL = executable
    child.arguments = [
      "-e",
      "const n=require('node:net');const t=setTimeout(()=>process.exit(13),10000);const s=n.connect(process.argv[1]);s.on('data',()=>{clearTimeout(t);s.destroy();process.exit(0)});",
      socketPath,
    ]
    child.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"]
    do { try child.run() } catch { throw BrowserNativeHostCodeProbeFailure.step(8) }
    defer {
      if child.isRunning { child.terminate() }
      let deadline = ProcessInfo.processInfo.systemUptime + 12
      while child.isRunning && ProcessInfo.processInfo.systemUptime < deadline { usleep(10_000) }
      if child.isRunning {
        FileHandle.standardError.write(Data("cleanup_uncertain\n".utf8))
      } else {
        child.waitUntilExit()
        FileHandle.standardError.write(Data("cleanup_certain\n".utf8))
      }
    }

    var waiting = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
    guard poll(&waiting, 1, 10_000) > 0, (waiting.revents & Int16(POLLIN)) != 0 else {
      throw BrowserNativeHostCodeProbeFailure.step(9)
    }
    var client = accept(listener, nil, nil)
    guard client >= 0 else { throw BrowserNativeHostCodeProbeFailure.step(10) }
    defer { if client >= 0 { Darwin.close(client) } }
    var token = audit_token_t()
    var tokenSize = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(client, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenSize) == 0,
      tokenSize == MemoryLayout<audit_token_t>.size
    else { throw BrowserNativeHostCodeProbeFailure.step(11) }

    let hash = nativeHostCodeHash(token, expectedExecutable: executable)
    let wrongExecutable = URL(fileURLWithPath: "/usr/bin/false").standardizedFileURL
    let wrongRejected = nativeHostCodeHash(token, expectedExecutable: wrongExecutable) == nil
    guard let hash, hash.count == 20 || hash.count == 32, wrongRejected else {
      throw BrowserNativeHostCodeProbeFailure.step(12)
    }
    let output: [String: Any] = [
      "hashBytes": hash.count,
      "wrongExecutableRejected": wrongRejected,
      "peerPidMatchesAudit": audit_token_to_pid(token) == child.processIdentifier,
    ]
    guard JSONSerialization.isValidJSONObject(output),
      let encoded = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
    else { throw BrowserNativeHostCodeProbeFailure.step(13) }
    FileHandle.standardOutput.write(encoded)
    FileHandle.standardOutput.write(Data("\n".utf8))
    _ = Darwin.write(client, [UInt8(1)], 1)
    Darwin.close(client)
    client = -1
    let deadline = ProcessInfo.processInfo.systemUptime + 10
    while child.isRunning && ProcessInfo.processInfo.systemUptime < deadline { usleep(10_000) }
    guard !child.isRunning else { throw BrowserNativeHostCodeProbeFailure.step(14) }
  }

  static func main() {
    do { try run() }
    catch {
      FileHandle.standardError.write(Data("probe_failed\n".utf8))
      exit(1)
    }
  }
}
