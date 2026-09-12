import Foundation
import CoreServices
import Darwin

// A native bundle entry point gives macOS an application to attribute to the
// interpreter. execv preserves launchd's PID, signals, exit status and group.
// Apple DTS describes this trampoline pattern: developer.apple.com/forums/thread/720057
@main
enum EllieService {
    private struct Runtime: Decodable {
        let node: String
        let entrypoint: String
        let role: String
    }

    static func main() {
        if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--register" {
            exit(LSRegisterURL(Bundle.main.bundleURL as CFURL, true) == noErr ? 0 : 70)
        }
        guard CommandLine.arguments.count == 2,
              CommandLine.arguments[1] == "--launch-agent",
              let resource = Bundle.main.url(forResource: "runtime", withExtension: "json"),
              let data = try? Data(contentsOf: resource),
              let runtime = try? JSONDecoder().decode(Runtime.self, from: data),
              ["node", "coordinator"].contains(runtime.role),
              runtime.node.hasPrefix("/"), runtime.entrypoint.hasPrefix("/") else { exit(78) }
        let arguments = [runtime.node, runtime.entrypoint, "service", "run", runtime.role]
        let strings = arguments.map { strdup($0) }
        defer { strings.forEach { free($0) } }
        var argv = strings + [nil]
        execv(runtime.node, &argv)
        exit(70)
    }
}
