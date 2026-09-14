import AppKit
import ApplicationServices
import Darwin.Mach
import Security

struct HelperError: Error { let message: String }
func fail(_ message: String) -> HelperError { HelperError(message: message) }
func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
}
func text(_ request: [String: Any], _ key: String) throws -> String {
    guard let value = request[key] as? String, !value.isEmpty, value.utf8.count <= 16384 else { throw fail("Invalid helper input.") }
    return value
}
func waitUntil(_ seconds: TimeInterval, _ test: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while !test() {
        if Date() >= deadline { return false }
        RunLoop.current.run(until: Date().addingTimeInterval(0.04))
    }
    return true
}
func availableMemoryBytes() -> UInt64? {
    var statistics = vm_statistics64()
    var count = mach_msg_type_number_t(MemoryLayout<vm_statistics64_data_t>.size / MemoryLayout<integer_t>.size)
    let host = mach_host_self()
    defer { mach_port_deallocate(mach_task_self_, host) }
    let status = withUnsafeMutablePointer(to: &statistics) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            host_statistics64(host, HOST_VM_INFO64, $0, &count)
        }
    }
    guard status == KERN_SUCCESS else { return nil }
    var pageSize: vm_size_t = 0
    guard host_page_size(host, &pageSize) == KERN_SUCCESS else { return nil }

    // Apple's VM headers say speculative pages are already included in free_count.
    // Inactive pages estimate memory reclaimable under pressure. Omit other cache
    // categories so this admission estimate stays conservative and does not double count.
    let (pages, pagesOverflow) = UInt64(statistics.free_count).addingReportingOverflow(UInt64(statistics.inactive_count))
    guard !pagesOverflow else { return nil }
    let (bytes, bytesOverflow) = pages.multipliedReportingOverflow(by: UInt64(pageSize))
    return bytesOverflow ? nil : bytes
}
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success else { return nil }
    return value
}
func setAttribute(_ element: AXUIElement, _ key: String, _ value: CFTypeRef) throws {
    guard AXUIElementSetAttributeValue(element, key as CFString, value) == .success else {
        throw fail("This app refused the window change. Check Accessibility permission and whether the window supports resizing.")
    }
}
func launch(_ bundle: String) throws -> NSRunningApplication {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw fail("App is not installed. Install it or change the private app aliases.") }
    var app: NSRunningApplication?
    var finished = false
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: config) { launched, _ in
        app = launched; finished = true
    }
    guard waitUntil(5, { finished }), let launched = app else { throw fail("App did not launch in time.") }
    return launched
}
func window(_ app: NSRunningApplication) throws -> AXUIElement {
    guard AXIsProcessTrusted() else { throw fail("Allow the terminal and Ellie helper in System Settings > Privacy & Security > Accessibility, then restart the node.") }
    let application = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 2)
    var found: AXUIElement?
    _ = waitUntil(4) {
        if let focused = attribute(application, kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
            found = (focused as! AXUIElement)
        } else if let windows = attribute(application, kAXWindowsAttribute) as? [AXUIElement] {
            found = windows.first
        }
        return found != nil
    }
    guard let target = found else { throw fail("No controllable window is open for this app. Open a normal window and try again.") }
    AXUIElementSetMessagingTimeout(target, 2)
    return target
}
func frame(_ window: AXUIElement) throws -> CGRect {
    guard let position = attribute(window, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attribute(window, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { throw fail("Cannot read this window's bounds.") }
    var point = CGPoint.zero; var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { throw fail("Invalid window bounds.") }
    return CGRect(origin: point, size: dimensions)
}
func fullscreen(_ window: AXUIElement, _ value: Bool) throws {
    let current = attribute(window, "AXFullScreen") as? Bool ?? false
    if current == value { return }
    try setAttribute(window, "AXFullScreen", value ? kCFBooleanTrue : kCFBooleanFalse)
    guard waitUntil(4, { (attribute(window, "AXFullScreen") as? Bool ?? false) == value }) else { throw fail("Fullscreen transition did not complete.") }
    // Spaces transitions can continue after AXFullScreen changes.
    RunLoop.current.run(until: Date().addingTimeInterval(0.5))
}
func screenFor(_ window: AXUIElement, monitor: String) throws -> NSScreen {
    let screens = NSScreen.screens
    guard let primary = screens.first else { throw fail("No active display is available.") }
    if monitor == "primary" { return primary }
    if monitor == "largest" { return screens.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) ?? primary }
    let bounds = try frame(window)
    return screens.max(by: {
        let a = accessibilityRect($0.frame, primaryTop: primary.frame.maxY).intersection(bounds)
        let b = accessibilityRect($1.frame, primaryTop: primary.frame.maxY).intersection(bounds)
        return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
    }) ?? primary
}
func move(_ window: AXUIElement, to target: CGRect) throws {
    var point = target.origin; var size = target.size
    guard let position = AXValueCreate(.cgPoint, &point), let dimensions = AXValueCreate(.cgSize, &size) else { throw fail("Invalid target bounds.") }
    try setAttribute(window, kAXPositionAttribute, position)
    try setAttribute(window, kAXSizeAttribute, dimensions)
    try setAttribute(window, kAXPositionAttribute, position)
    guard waitUntil(1, {
        guard let actual = try? frame(window) else { return false }
        return abs(actual.minX - target.minX) < 8 && abs(actual.minY - target.minY) < 8 && abs(actual.width - target.width) < 8 && abs(actual.height - target.height) < 8
    }) else { throw fail("Window moved, but the app or macOS constrained its size or position. The requested layout was not fully applied.") }
}
func place(_ window: AXUIElement, layout: String, monitor: String) throws {
    try fullscreen(window, false)
    let screen = try screenFor(window, monitor: monitor)
    guard let primary = NSScreen.screens.first else { throw fail("No display available.") }
    let area = accessibilityRect(screen.visibleFrame, primaryTop: primary.frame.maxY)
    try move(window, to: tileRect(area, layout: layout))
    if layout == "fullscreen" { try fullscreen(window, true) }
}
func keychain(_ request: [String: Any], command: String) throws {
    let account = try text(request, "account")
    guard account.range(of: "^[a-zA-Z0-9._-]{1,100}$", options: .regularExpression) != nil else { throw fail("Invalid Keychain account.") }
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "org.ellie.assistant", kSecAttrAccount as String: account]
    if command == "keychain.set" {
        let value = Data(try text(request, "value").utf8)
        var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: value] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = value
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw fail("Unable to save to macOS Keychain.") }
        emit(["value": ""])
    } else {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw fail("Keychain credential unavailable.") }
        emit(["value": value])
    }
}
@main
enum EllieHelper {
    static func main() {
        do {
            let data = FileHandle.standardInput.readDataToEndOfFile()
            guard data.count <= 32768, let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw fail("Invalid helper request.") }
            if let command = request["command"] as? String {
                if command == "keychain.get" || command == "keychain.set" { try keychain(request, command: command); return }
                if command == "telemetry" {
                    let thermal: String
                    switch ProcessInfo.processInfo.thermalState {
                    case .nominal: thermal = "nominal"
                    case .fair: thermal = "fair"
                    case .serious: thermal = "serious"
                    case .critical: thermal = "critical"
                    @unknown default: thermal = "unknown"
                    }
                    var status: [String: Any] = ["thermal": thermal]
                    if #available(macOS 12.0, *) { status["lowPowerMode"] = ProcessInfo.processInfo.isLowPowerModeEnabled }
                    if let memory = availableMemoryBytes() { status["availableMemoryBytes"] = memory }
                    emit(status); return
                }
                if command == "doctor" { emit(["accessibility": AXIsProcessTrusted(), "ok": true]); return }
                throw fail("Unsupported helper command.")
            }
            let tool = try text(request, "tool")
            guard ["app.open", "url.open", "window.place", "window.adjacent"].contains(tool) else { throw fail("Unsupported tool.") }
            let appID = try text(request, "app")
            if tool == "url.open" {
                guard let url = URL(string: try text(request, "url")), url.scheme == "https", url.user == nil, url.password == nil,
                      let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: appID) else { throw fail("Invalid HTTPS site or browser not installed.") }
                var finished = false; var succeeded = false
                NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: NSWorkspace.OpenConfiguration()) { app, error in
                    succeeded = app != nil && error == nil; finished = true
                }
                guard waitUntil(5, { finished }), succeeded else { throw fail("Unable to open site in the configured browser.") }
            } else {
                let app = try launch(appID)
                if tool == "window.place" {
                    let layout = try text(request, "layout"); let monitor = try text(request, "monitor")
                    guard ["top-left","top-right","bottom-left","bottom-right","left","right","maximize","fullscreen"].contains(layout), ["current","largest","primary"].contains(monitor) else { throw fail("Unsupported window layout.") }
                    try place(window(app), layout: layout, monitor: monitor)
                } else if tool == "window.adjacent" {
                    let anchorID = try text(request, "anchor")
                    guard anchorID != appID else { throw fail("Choose two different apps.") }
                    let anchorApp = try launch(anchorID)
                    let anchorWindow = try window(anchorApp)
                    try fullscreen(anchorWindow, false)
                    let screen = try screenFor(anchorWindow, monitor: "current")
                    guard let primary = NSScreen.screens.first else { throw fail("No display available.") }
                    let area = accessibilityRect(screen.visibleFrame, primaryTop: primary.frame.maxY)
                    try move(anchorWindow, to: tileRect(area, layout: "left"))
                    _ = app.activate(options: [])
                    let target = try window(app)
                    try fullscreen(target, false)
                    try move(target, to: tileRect(area, layout: "right"))
                }
            }
            emit(["ok": true, "message": "Done."])
        } catch {
            emit(["ok": false, "message": (error as? HelperError)?.message ?? "Native operation failed."])
            exit(1)
        }
    }
}
