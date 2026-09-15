import AppKit
import Darwin
import Foundation
import Security

private let frameLimit = 32_768
private var failureCleanup: () -> Void = {}

private func fail(_ file: StaticString = #fileID, _ line: UInt = #line) -> Never {
  #if ELLIE_AX_BROKER_DIAGNOSTIC
  FileHandle.standardError.write(Data("broker failure \(file):\(line) errno=\(errno)\n".utf8))
  #endif
  failureCleanup()
  exit(1)
}

private func frame(_ value: [String: Any]) -> Data? {
  guard JSONSerialization.isValidJSONObject(value),
    let payload = try? JSONSerialization.data(withJSONObject: value),
    payload.count > 0, payload.count <= frameLimit
  else { return nil }
  var length = UInt32(payload.count).littleEndian
  var result = Data(bytes: &length, count: 4)
  result.append(payload)
  return result
}

private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
  data.withUnsafeBytes { raw in
    guard let base = raw.baseAddress else { return false }
    var offset = 0
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    while offset < raw.count {
      let remaining = deadline - ProcessInfo.processInfo.systemUptime
      if remaining <= 0 { return false }
      var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      if poll(&ready, 1, Int32(remaining * 1_000)) <= 0 { return false }
      let count = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
      if count > 0 { offset += count; continue }
      if count < 0 && errno == EINTR { continue }
      return false
    }
    return true
  }
}

private func writeAllAt(_ fd: Int32, _ data: Data, _ initialOffset: off_t = 0) -> Bool {
  data.withUnsafeBytes { raw in
    guard let base = raw.baseAddress else { return false }
    var offset = 0
    while offset < raw.count {
      let count = pwrite(fd, base.advanced(by: offset), raw.count - offset,
        initialOffset + off_t(offset))
      if count > 0 { offset += count; continue }
      if count < 0 && errno == EINTR { continue }
      return false
    }
    return true
  }
}

private func readExact(_ fd: Int32, _ count: Int) -> Data? {
  var result = Data()
  let deadline = ProcessInfo.processInfo.systemUptime + 2
  while result.count < count {
    let remaining = deadline - ProcessInfo.processInfo.systemUptime
    if remaining <= 0 { return nil }
    var ready = pollfd(fd: fd, events: Int16(POLLIN | POLLHUP), revents: 0)
    guard poll(&ready, 1, Int32(remaining * 1_000)) > 0,
      (ready.revents & Int16(POLLIN)) != 0 else { return nil }
    var bytes = [UInt8](repeating: 0, count: min(4_096, count - result.count))
    let readCount = Darwin.read(fd, &bytes, bytes.count)
    if readCount > 0 { result.append(contentsOf: bytes.prefix(readCount)); continue }
    if readCount < 0 && errno == EINTR { continue }
    return nil
  }
  return result
}

private func readFrame(_ fd: Int32) -> Data? {
  guard let header = readExact(fd, 4) else { return nil }
  let length = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
  guard length > 0, length <= frameLimit, let payload = readExact(fd, Int(length)) else { return nil }
  var result = header
  result.append(payload)
  return result
}

private func socketAddress(_ path: String) -> (sockaddr_un, socklen_t)? {
  guard path.utf8.count > 0, path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path)
  else { return nil }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8) + [0]
  withUnsafeMutableBytes(of: &address.sun_path) { target in
    target.copyBytes(from: bytes)
  }
  address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
  return (address, socklen_t(address.sun_len))
}

private struct PeerIdentity {
  let token: audit_token_t
  let pid: Int32
  let pidVersion: Int32
  let codeHash: Data
  let browserPID: Int32
  let browser: BrowserAccessibilityBrowser
  let browserIdentity: BrowserProcessIdentity
}

private func nativeHostCodeHash(_ token: audit_token_t, expectedExecutable: URL) -> Data? {
  var copiedToken = token
  let auditData = Data(bytes: &copiedToken, count: MemoryLayout<audit_token_t>.size)
  let attributes = [kSecGuestAttributeAudit as String: auditData] as CFDictionary
  var code: SecCode?
  let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures)
  guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code,
    SecCodeCheckValidityWithErrors(code, flags, nil, nil) == errSecSuccess
  else { return nil }
  var staticCode: SecStaticCode?
  guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
    SecStaticCodeCheckValidityWithErrors(staticCode, flags, nil, nil) == errSecSuccess
  else { return nil }
  var information: CFDictionary?
  guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
    &information) == errSecSuccess, let values = information as? [String: Any],
    let executable = values[kSecCodeInfoMainExecutable as String] as? URL,
    executable.resolvingSymlinksInPath().standardizedFileURL == expectedExecutable,
    let codeHash = values[kSecCodeInfoUnique as String] as? Data,
    codeHash.count == 20 || codeHash.count == 32
  else { return nil }
  return codeHash
}

private func tokenWords(_ token: audit_token_t) -> [UInt32] {
  withUnsafeBytes(of: token) { Array($0.bindMemory(to: UInt32.self)) }
}

private func ownExecutableURL() -> URL? {
  var buffer = [CChar](repeating: 0, count: 4_096)
  guard proc_pidpath(getpid(), &buffer, UInt32(buffer.count)) > 0 else { return nil }
  return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().standardizedFileURL
}

private func peerIdentity(_ fd: Int32) -> PeerIdentity? {
  func rejected(_ stage: String) -> PeerIdentity? {
    #if ELLIE_AX_BROKER_DIAGNOSTIC
    FileHandle.standardError.write(Data("peer rejected \(stage) errno=\(errno)\n".utf8))
    #endif
    return nil
  }
  var token = audit_token_t()
  var tokenSize = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenSize) == 0,
    tokenSize == MemoryLayout<audit_token_t>.size
  else { return rejected("token") }
  var peerPID: Int32 = 0
  var pidSize = socklen_t(MemoryLayout<Int32>.size)
  guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &pidSize) == 0,
    pidSize == MemoryLayout<Int32>.size, peerPID > 0,
    audit_token_to_pid(token) == peerPID
  else { return rejected("pid") }
  var executable = [CChar](repeating: 0, count: 4_096)
  var copiedToken = token
  guard proc_pidpath_audittoken(&copiedToken, &executable, UInt32(executable.count)) > 0,
    let own = ownExecutableURL()
  else { return rejected("path-read") }
  let actualExecutable = URL(fileURLWithPath: String(cString: executable))
    .resolvingSymlinksInPath().standardizedFileURL
  let expectedExecutable = own.deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("bin/node").resolvingSymlinksInPath().standardizedFileURL
  guard actualExecutable == expectedExecutable else { return rejected("path") }
  #if ELLIE_AX_BROKER_TEST
  let codeHash = Data(repeating: 0, count: 20)
  #else
  guard let codeHash = nativeHostCodeHash(token, expectedExecutable: expectedExecutable)
  else { return rejected("code") }
  #endif
  var current = peerPID
  var browserMatch: (BrowserAccessibilityBrowser, BrowserProcessIdentity)?
  for _ in 0..<6 {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(current, PROC_PIDTBSDINFO, 0, &info, size) == size else {
      return rejected("ancestry")
    }
    current = Int32(info.pbi_ppid)
    guard current > 0 else { break }
    #if ELLIE_AX_BROKER_TEST
    if current == getppid(), let (seconds, microseconds) = browserProcessStartIdentity(current) {
      browserMatch = (.arc, BrowserProcessIdentity(processID: current, startSeconds: seconds,
        startMicroseconds: microseconds, codeHash: Data(repeating: 0, count: 20)))
      break
    }
    #else
    let verifier = MacBrowserAccessibilityBackend()
    if let identity = try? verifier.browserProcessIdentity(browser: .arc, processID: current) {
      browserMatch = (.arc, identity); break
    }
    if let identity = try? verifier.browserProcessIdentity(browser: .safari, processID: current) {
      browserMatch = (.safari, identity); break
    }
    #endif
  }
  guard let (browser, browserIdentity) = browserMatch else { return rejected("browser") }
  return PeerIdentity(token: token, pid: peerPID,
    pidVersion: Int32(audit_token_to_pidversion(token)), codeHash: codeHash,
    browserPID: browserIdentity.processID,
    browser: browser, browserIdentity: browserIdentity)
}

private func peerStillValid(_ expected: PeerIdentity, _ fd: Int32) -> Bool {
  guard let current = peerIdentity(fd) else { return false }
  return current.pid == expected.pid && current.pidVersion == expected.pidVersion
    && current.browserPID == expected.browserPID
    && current.codeHash == expected.codeHash
    && current.browser == expected.browser && current.browserIdentity == expected.browserIdentity
    && tokenWords(current.token) == tokenWords(expected.token)
}

private func pathStillBound(
  _ directory: String, _ expectedDirectory: stat, _ path: String, _ expectedSocket: stat
) -> Bool {
  var currentDirectory = stat()
  var currentSocket = stat()
  return lstat(directory, &currentDirectory) == 0
    && currentDirectory.st_dev == expectedDirectory.st_dev
    && currentDirectory.st_ino == expectedDirectory.st_ino
    && currentDirectory.st_uid == expectedDirectory.st_uid
    && currentDirectory.st_mode == expectedDirectory.st_mode
    && lstat(path, &currentSocket) == 0
    && currentSocket.st_dev == expectedSocket.st_dev && currentSocket.st_ino == expectedSocket.st_ino
    && currentSocket.st_uid == expectedSocket.st_uid && currentSocket.st_mode == expectedSocket.st_mode
}

private func privateDirectory() -> (String, stat)? {
  guard let home = ProcessInfo.processInfo.environment["HOME"], home.hasPrefix("/"),
    !home.contains("\0") else { return nil }
  let parent = home + "/Library/Application Support/Ellie"
  let directory = parent + "/BrowserBridge"
  var info = stat()
  for component in [home, home + "/Library", home + "/Library/Application Support", parent] {
    guard lstat(component, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
      info.st_uid == getuid(), (info.st_mode & 0o022) == 0
    else { return nil }
  }
  let created = mkdir(directory, 0o700) == 0
  if !created && errno != EEXIST { return nil }
  if created && chmod(directory, 0o700) != 0 { return nil }
  guard lstat(directory, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
    info.st_uid == getuid(), (info.st_mode & 0o777) == 0o700
  else { return nil }
  return (directory, info)
}

private func acquireInstanceLock(_ directory: String) -> (Int32, stat, Bool, String)? {
  let path = directory + "/broker.lock"
  let created = open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, 0o600)
  let fd: Int32
  if created >= 0 {
    fd = created
    guard fchmod(fd, 0o600) == 0 else { Darwin.close(fd); return nil }
  } else {
    guard errno == EEXIST else { return nil }
    fd = open(path, O_RDWR | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { return nil }
  }
  var held = stat()
  var named = stat()
  guard fstat(fd, &held) == 0, lstat(path, &named) == 0,
    (held.st_mode & S_IFMT) == S_IFREG, held.st_uid == getuid(), held.st_nlink == 1,
    (held.st_mode & 0o777) == 0o600, held.st_size >= 0, held.st_size <= 128,
    named.st_dev == held.st_dev, named.st_ino == held.st_ino, named.st_uid == held.st_uid,
    named.st_mode == held.st_mode, named.st_nlink == held.st_nlink,
    flock(fd, LOCK_EX | LOCK_NB) == 0
  else { Darwin.close(fd); return nil }
  var bytes = [UInt8](repeating: 0, count: Int(held.st_size))
  if !bytes.isEmpty && pread(fd, &bytes, bytes.count, 0) != bytes.count {
    Darwin.close(fd); return nil
  }
  guard let record = String(bytes: bytes, encoding: .utf8),
    record.isEmpty || record.range(of: #"^v1 [0-9]+ [0-9]+\n$"#, options: .regularExpression) != nil
  else { Darwin.close(fd); return nil }
  return (fd, held, created >= 0, record)
}

private func removeOwnedEntry(_ path: String, _ expected: stat) -> Bool {
  var current = stat()
  return lstat(path, &current) == 0 && current.st_dev == expected.st_dev
    && current.st_ino == expected.st_ino && current.st_uid == expected.st_uid
    && current.st_mode == expected.st_mode && unlink(path) == 0
}

private func ownedEntryStillBound(_ path: String, _ expected: stat) -> Bool {
  var current = stat()
  return lstat(path, &current) == 0 && current.st_dev == expected.st_dev
    && current.st_ino == expected.st_ino && current.st_uid == expected.st_uid
    && current.st_mode == expected.st_mode
}

private func removeStaleSocket(_ path: String, lockRecord: String, newLock: Bool) -> Bool {
  var existing = stat()
  if lstat(path, &existing) != 0 { return errno == ENOENT }
  guard (existing.st_mode & S_IFMT) == S_IFSOCK, existing.st_uid == getuid(),
    (existing.st_mode & 0o777) == 0o600, !newLock,
    lockRecord == "v1 \(existing.st_dev) \(existing.st_ino)\n",
    let (rawAddress, rawLength) = socketAddress(path)
  else { return false }
  let probe = socket(AF_UNIX, SOCK_STREAM, 0)
  guard probe >= 0, fcntl(probe, F_SETFL, O_NONBLOCK) == 0 else {
    if probe >= 0 { Darwin.close(probe) }
    return false
  }
  defer { Darwin.close(probe) }
  var address = rawAddress
  let connected = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(probe, $0, rawLength) }
  }
  guard connected != 0, errno == ECONNREFUSED || errno == ENOENT else { return false }
  if errno == ENOENT { return true }
  return removeOwnedEntry(path, existing)
}

@main
enum BrowserRuntimeBrokerMain {
  static func main() {
    guard let (directory, directoryIdentity) = privateDirectory() else { fail() }
    guard let (lockFD, lockIdentity, newLock, lockRecord) = acquireInstanceLock(directory)
    else { fail() }
    let directoryFD = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK)
    var heldDirectory = stat()
    guard directoryFD >= 0, fstat(directoryFD, &heldDirectory) == 0,
      heldDirectory.st_dev == directoryIdentity.st_dev,
      heldDirectory.st_ino == directoryIdentity.st_ino,
      heldDirectory.st_uid == directoryIdentity.st_uid,
      heldDirectory.st_mode == directoryIdentity.st_mode
    else {
      if directoryFD >= 0 { Darwin.close(directoryFD) }
      fail()
    }
    let lockPath = directory + "/broker.lock"
    defer { Darwin.close(directoryFD); Darwin.close(lockFD) }
    let path = directory + "/browser-webmcp-v1.sock"
    guard removeStaleSocket(path, lockRecord: lockRecord, newLock: newLock),
      let (rawAddress, rawLength) = socketAddress(path)
    else { fail() }
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { fail() }
    defer { Darwin.close(listener) }
    var address = rawAddress
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, rawLength) }
    }
    guard bound == 0, chmod(path, 0o600) == 0, listen(listener, 1) == 0 else { fail() }
    var ownedSocket = stat()
    var finalDirectory = stat()
    guard lstat(directory, &finalDirectory) == 0,
      finalDirectory.st_dev == directoryIdentity.st_dev,
      finalDirectory.st_ino == directoryIdentity.st_ino,
      finalDirectory.st_uid == directoryIdentity.st_uid,
      finalDirectory.st_mode == directoryIdentity.st_mode,
      lstat(path, &ownedSocket) == 0, (ownedSocket.st_mode & S_IFMT) == S_IFSOCK,
      ownedSocket.st_uid == getuid(), (ownedSocket.st_mode & 0o777) == 0o600
    else { fail() }
    let socketRecord = Data("v1 \(ownedSocket.st_dev) \(ownedSocket.st_ino)\n".utf8)
    guard writeAllAt(lockFD, socketRecord), ftruncate(lockFD, off_t(socketRecord.count)) == 0,
      fsync(lockFD) == 0, fsync(directoryFD) == 0
    else { fail() }
    failureCleanup = {
      Darwin.close(listener)
      var current = stat()
      if lstat(path, &current) == 0, current.st_dev == ownedSocket.st_dev,
        current.st_ino == ownedSocket.st_ino, current.st_uid == ownedSocket.st_uid,
        (current.st_mode & S_IFMT) == S_IFSOCK, (current.st_mode & 0o777) == 0o600
      { _ = unlink(path) }
    }
    defer {
      var current = stat()
      if lstat(path, &current) == 0, current.st_dev == ownedSocket.st_dev,
        current.st_ino == ownedSocket.st_ino, current.st_uid == ownedSocket.st_uid,
        (current.st_mode & S_IFMT) == S_IFSOCK, (current.st_mode & 0o777) == 0o600
      { _ = unlink(path) }
    }
    while true {
      var waiting = [
        pollfd(fd: listener, events: Int16(POLLIN), revents: 0),
        pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0),
      ]
      let ready = poll(&waiting, 2, 1_000)
      if ready < 0 && errno == EINTR { continue }
      guard ready >= 0,
        pathStillBound(directory, directoryIdentity, path, ownedSocket),
        ownedEntryStillBound(lockPath, lockIdentity)
      else { fail() }
      if (waiting[1].revents & Int16(POLLHUP)) != 0 { return }
      if (waiting[1].revents & Int16(POLLIN)) != 0 { fail() }
      if (waiting[0].revents & Int16(POLLIN)) == 0 { continue }
      let client = accept(listener, nil, nil)
      if client < 0 {
        if errno == EINTR { continue }
        fail()
      }
      guard let peer = peerIdentity(client), let helloFrame = readFrame(client),
        helloFrame.count >= 5,
        let hello = try? JSONSerialization.jsonObject(with: helloFrame.dropFirst(4))
          as? [String: Any],
        Set(hello.keys) == Set(["type", "version", "parentPid"]),
        hello["type"] as? String == "native-host.hello", hello["version"] as? Int == 1,
        let reportedParentPID = hello["parentPid"] as? Int, reportedParentPID > 0,
        reportedParentPID <= Int(Int32.max)
      else {
        Darwin.close(client)
        continue
      }
      let connectionID = UUID().uuidString.lowercased()
      guard let context = frame(["type": "broker.context", "version": 1,
        "nativeHostPid": peer.pid, "browserPid": peer.browserPID,
        "pidVersion": peer.pidVersion, "connectionId": connectionID,
        "browserStartSeconds": peer.browserIdentity.startSeconds,
        "browserStartMicroseconds": peer.browserIdentity.startMicroseconds,
        "browserCodeHash": peer.browserIdentity.codeHash.map { String(format: "%02x", $0) }.joined(),
        "authenticated": true]), writeAll(STDOUT_FILENO, context) else { fail() }
      let listenerCleanup = failureCleanup
      failureCleanup = { Darwin.close(client); listenerCleanup() }
      var connected = true
      while connected {
        var active = [
          pollfd(fd: client, events: Int16(POLLIN | POLLHUP), revents: 0),
          pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0),
        ]
        let activeReady = poll(&active, 2, 1_000)
        if activeReady < 0 && errno == EINTR { continue }
        guard activeReady >= 0,
          pathStillBound(directory, directoryIdentity, path, ownedSocket),
          ownedEntryStillBound(lockPath, lockIdentity)
        else { fail() }
        if activeReady == 0 {
          if !peerStillValid(peer, client) { connected = false }
          continue
        }
        if (active[0].revents & Int16(POLLIN)) != 0 {
          guard let next = readFrame(client), writeAll(STDOUT_FILENO, next) else {
            connected = false
            continue
          }
        }
        if (active[1].revents & Int16(POLLIN)) != 0 {
          guard peerStillValid(peer, client), let next = readFrame(STDIN_FILENO),
            writeAll(client, next) else { fail() }
        }
        if (active[1].revents & Int16(POLLHUP)) != 0 { return }
        if (active[0].revents & Int16(POLLHUP)) != 0 { connected = false }
      }
      failureCleanup = listenerCleanup
      Darwin.close(client)
      guard let disconnected = frame(["type": "broker.disconnected", "version": 1,
        "connectionId": connectionID]), writeAll(STDOUT_FILENO, disconnected) else { fail() }
    }
  }
}
