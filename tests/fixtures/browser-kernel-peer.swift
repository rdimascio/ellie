import Darwin
import Foundation

private func address(_ path: String) -> (sockaddr_un, socklen_t) {
  var value = sockaddr_un()
  value.sun_family = sa_family_t(AF_UNIX)
  withUnsafeMutableBytes(of: &value.sun_path) { $0.copyBytes(from: Array(path.utf8) + [0]) }
  return (value, socklen_t(MemoryLayout<sockaddr_un>.size))
}
private func framed(_ value: [String: Any]) -> Data {
  let payload = try! JSONSerialization.data(withJSONObject: value)
  var size = UInt32(payload.count).littleEndian
  var result = Data(bytes: &size, count: 4)
  result.append(payload)
  return result
}
private func send(_ fd: Int32, _ data: Data) {
  data.withUnsafeBytes { raw in _ = Darwin.write(fd, raw.baseAddress, raw.count) }
}

@main enum BrowserKernelPeer {
  static func main() {
    let home = ProcessInfo.processInfo.environment["HOME"]!
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var target = address(home + "/Library/Application Support/Ellie/BrowserBridge/browser-webmcp-v1.sock")
    let connected = withUnsafePointer(to: &target.0) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, target.1) }
    }
    guard connected == 0 else { exit(2) }
    // The broker must derive ancestry from the accepted socket, never this claimed diagnostic PID.
    send(fd, framed(["type": "native-host.hello", "version": 1, "parentPid": 1]))
    var header = [UInt8](repeating: 0, count: 4)
    guard Darwin.read(fd, &header, 4) == 4 else { exit(3) }
    let size = header.withUnsafeBytes { UInt32(littleEndian: $0.loadUnaligned(as: UInt32.self)) }
    var payload = [UInt8](repeating: 0, count: Int(size))
    guard Darwin.read(fd, &payload, payload.count) == payload.count,
      let request = try? JSONSerialization.jsonObject(with: Data(payload)) as? [String: Any],
      let id = request["id"] as? String else { exit(4) }
    send(fd, framed(["protocol": "ellie.browser-webmcp.v1", "id": id, "type": "result",
      "status": "ok", "value": ["bindingId": "binding-1", "documentId": "document-1",
        "origin": "https://www.youtube.com", "url": "https://www.youtube.com/watch?v=iTHUUjTA-LI",
        "expiresAt": 4_102_444_800_000, "availability": "accessibility"]]))
    if CommandLine.arguments.dropFirst() == ["--disconnect"] {
      usleep(50_000)
      Darwin.close(fd)
      return
    }
    var waiter = pollfd(fd: fd, events: Int16(POLLIN | POLLHUP), revents: 0)
    _ = poll(&waiter, 1, 5_000)
    Darwin.close(fd)
  }
}
