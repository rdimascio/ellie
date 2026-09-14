import CoreImage.CIFilterBuiltins
import Darwin
import Foundation
import SwiftUI

struct ManagedNativeGrant: Codable, Equatable, Sendable {
  let target: String
  let capabilities: [String]
}
struct NativeInvitation: Equatable, Sendable {
  let label: String
  let grants: [ManagedNativeGrant]
  let expiresAt: Date
  let qr: String
}
struct ManagedNativeClient: Codable, Identifiable, Equatable, Sendable {
  let id: String
  let role: String
  let label: String
  let grants: [ManagedNativeGrant]
  let createdAt: Int64
  let expiresAt: Int64
}
protocol CoordinatorManaging: Sendable {
  func createNativeInvitation(connection: CoordinatorConnection, label: String, nodeIDs: [String])
    async throws -> NativeInvitation
  func nativeClients(connection: CoordinatorConnection) async throws -> [ManagedNativeClient]
  func revokeNativeClient(connection: CoordinatorConnection, id: String) async throws -> Bool
}
enum PairingManagementFailure: Error, Equatable {
  case invalid, unavailable, unauthorized, unknownOutcome
}

@MainActor final class PairingManagementStore: ObservableObject {
  @Published var label = ""
  @Published var selected = Set<String>()
  @Published private(set) var invitation: NativeInvitation?
  @Published private(set) var clients: [ManagedNativeClient] = []
  @Published private(set) var loadedClients = false
  @Published private(set) var working = false
  @Published var message: String?
  private let client: any CoordinatorManaging
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var operation: Operation?
  init(client: any CoordinatorManaging = PinnedCoordinatorClient()) { self.client = client }
  func load(_ connection: CoordinatorConnection) {
    start { [client] in .clients(try await client.nativeClients(connection: connection)) }
  }
  func invite(_ connection: CoordinatorConnection) {
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    let nodes = selected.sorted()
    guard validManagedNativeLabel(label), trimmed == label, nodes.count > 0,
      nodes.count <= 16
    else {
      message = "Enter a label and choose at least one eligible Mac."
      return
    }
    guard !working else { return }
    invitation = nil
    start(.invite) { [client] in
      .invitation(
        try await client.createNativeInvitation(
          connection: connection, label: trimmed, nodeIDs: nodes))
    }
  }
  func revoke(_ id: String, connection: CoordinatorConnection) {
    start(.revoke) { [client] in
      .revoked(id, try await client.revokeNativeClient(connection: connection, id: id))
    }
  }
  func hideInvitation() {
    invitation = nil
    message = "Code hidden. It remains valid on the coordinator until its shown expiry."
  }
  func cancel() {
    guard working else { return }
    let cancelledOperation = operation
    generation = UUID()
    task?.cancel()
    task = nil
    working = false
    operation = nil
    switch cancelledOperation {
    case .invite:
      message =
        "Stopped waiting. A code may still be valid for up to 10 minutes. Wait before creating another code."
    case .revoke:
      message =
        "Stopped waiting. Revocation may have completed; refresh clients before trying again."
    case .load, nil:
      message = "Stopped loading clients."
    }
  }
  func close() {
    cancel()
    invitation = nil
    clients = []
    loadedClients = false
    selected = []
    label = ""
    message = nil
  }
  private enum Operation { case load, invite, revoke }
  private enum Result {
    case clients([ManagedNativeClient])
    case invitation(NativeInvitation)
    case revoked(String, Bool)
  }
  private func start(
    _ kind: Operation = .load, _ operation: @escaping @Sendable () async throws -> Result
  ) {
    guard !working else { return }
    let token = UUID()
    generation = token
    working = true
    self.operation = kind
    message = nil
    task = Task {
      do {
        let result = try await operation()
        guard generation == token else { return }
        switch result {
        case .clients(let value):
          clients = value
          loadedClients = true
        case .invitation(let value): invitation = value
        case .revoked(let id, let revoked):
          if revoked {
            clients.removeAll { $0.id == id }
          } else {
            message = "That client was not active."
          }
        }
      } catch {
        guard generation == token else { return }
        if let failure = error as? PairingManagementFailure,
          failure == .invalid || failure == .unauthorized
        {
          message =
            failure == .unauthorized
            ? "This identity is not allowed to manage native pairing. Reconnect as the coordinator."
            : "The coordinator rejected this request. Review the label and selected Macs."
          working = false
          self.operation = nil
          return
        }
        switch kind {
        case .load: message = "The coordinator did not provide a valid client list."
        case .invite:
          message =
            "The coordinator did not confirm the code request. A code may still be valid for up to 10 minutes; wait before trying again."
        case .revoke:
          message =
            "The coordinator did not confirm revocation. Refresh clients before trying again."
        }
      }
      if generation == token {
        working = false
        self.operation = nil
      }
    }
  }
}

struct PairingManagementView: View {
  @Environment(\.dismiss) private var dismiss
  let connection: CoordinatorConnection
  let nodes: [CoordinatorNode]
  @StateObject private var store: PairingManagementStore
  init(
    connection: CoordinatorConnection, nodes: [CoordinatorNode],
    store: PairingManagementStore? = nil
  ) {
    self.connection = connection
    self.nodes = nodes
    _store = StateObject(wrappedValue: store ?? PairingManagementStore())
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text("Pair an iPhone").font(.title2.bold())
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          if let invite = store.invitation {
            invitation(invite)
          } else {
            TextField("Phone label", text: $store.label).textFieldStyle(.roundedBorder)
            Text("Allow app opening on").font(.headline)
            ScrollView {
              VStack(alignment: .leading) {
                ForEach(nodes.filter { $0.capabilities.contains("app.open") }) { node in
                  Toggle(
                    "Mac · \(node.id.prefix(8))",
                    isOn: Binding(
                      get: { store.selected.contains(node.id) },
                      set: { enabled in
                        if enabled {
                          store.selected.insert(node.id)
                        } else {
                          store.selected.remove(node.id)
                        }
                      }))
                }
              }
            }.frame(maxHeight: 150)
            Button("Create one-time code") { store.invite(connection) }.buttonStyle(
              .borderedProminent
            ).disabled(store.working)
          }
          Divider()
          HStack {
            Text("Active iPhones").font(.headline)
            Spacer()
            Button("Refresh") { store.load(connection) }.disabled(store.working)
          }
          if store.loadedClients && store.clients.isEmpty {
            Text("No active iPhones.").foregroundStyle(.secondary)
          } else if !store.loadedClients && !store.working {
            Text("Active iPhones have not been loaded.").foregroundStyle(.secondary)
          }
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(store.clients) { client in
              HStack {
                VStack(alignment: .leading) {
                  Text(client.label)
                  Text(
                    client.grants.map { "Open apps on Mac \($0.target.prefix(8))" }.joined(
                      separator: ", ")
                  ).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Revoke", role: .destructive) {
                  store.revoke(client.id, connection: connection)
                }.disabled(store.working)
              }
            }
          }
          if let message = store.message { Text(message).font(.caption).foregroundStyle(.secondary) }
        }
      }
    }.padding(24).frame(width: 520, height: 620).task { store.load(connection) }.onDisappear {
      store.close()
    }
  }
  private func invitation(_ value: NativeInvitation) -> some View {
    VStack(spacing: 12) {
      if let image = ManagedPairingQRCode.image(value.qr) {
        Image(nsImage: image).interpolation(.none)
      }
      Text(value.label).font(.headline)
      Text(value.grants.map { "Open apps on Mac \($0.target.prefix(8))" }.joined(separator: "\n"))
        .multilineTextAlignment(.center)
      Text("Expires \(value.expiresAt.formatted(date: .omitted, time: .standard))").font(.caption)
      Button("Hide code") { store.hideInvitation() }
    }.frame(maxWidth: .infinity)
  }
}

enum ManagedPairingQRCode {
  static func image(_ text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    let context = CIContext()
    guard let output = filter.outputImage else { return nil }
    let paddedExtent = output.extent.insetBy(dx: -4, dy: -4)
    guard paddedExtent.width <= 185, paddedExtent.height <= 185 else { return nil }
    let white = CIImage(color: .white).cropped(to: paddedExtent)
    let padded = output.composited(over: white)
    guard let cg = context.createCGImage(padded, from: paddedExtent)
    else { return nil }
    return NSImage(
      cgImage: cg, size: NSSize(width: paddedExtent.width * 2, height: paddedExtent.height * 2))
  }
}
struct NativeInvitationRequest: Encodable {
  let label: String
  let grants: [ManagedNativeGrant]
}
struct NativeInvitationPayload: Decodable {
  let version: Int
  let origin, certificateSha256, invitation: String
  let expiresAt: Int64
  let label: String
  let grants: [ManagedNativeGrant]
}
struct NativeRevokeResponse: Decodable { let ok, revoked: Bool }
extension PinnedCoordinatorClient: CoordinatorManaging {}

func validManagedNativeIdentifier(_ value: String) -> Bool {
  value.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\z"#, options: .regularExpression) != nil
}

func validManagedNativeLabel(_ value: String) -> Bool {
  value == value.trimmingCharacters(in: .whitespacesAndNewlines)
    && (1...64).contains(value.unicodeScalars.count)
    && value.unicodeScalars.allSatisfy {
      switch $0.properties.generalCategory {
      case .control, .format, .surrogate, .privateUse, .unassigned: false
      default: true
      }
    }
}

func canonicalManagedNativeOrigin(_ value: String) -> URL? {
  guard value.utf8.count <= 2_048, value.hasPrefix("https://"), let url = URL(string: value),
    url.scheme == "https", !value.dropFirst(8).isEmpty,
    url.user == nil, url.password == nil, url.path.isEmpty, url.query == nil, url.fragment == nil
  else { return nil }
  let authority = value.dropFirst(8)
  let bareHost: String
  if authority.first == "[" {
    guard let close = authority.firstIndex(of: "]") else { return nil }
    bareHost = String(authority[authority.index(after: authority.startIndex)..<close])
    let suffix = authority[authority.index(after: close)...]
    guard suffix.isEmpty || (suffix.first == ":" && suffix.dropFirst().allSatisfy(\.isNumber))
    else { return nil }
  } else {
    let pieces = authority.split(separator: ":", omittingEmptySubsequences: false)
    guard pieces.count <= 2 else { return nil }
    bareHost = String(pieces[0])
    if pieces.count == 2 {
      guard !pieces[1].isEmpty, pieces[1].allSatisfy(\.isNumber) else { return nil }
    }
  }
  guard !bareHost.isEmpty else { return nil }
  var address4 = in_addr()
  var address6 = in6_addr()
  var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
  let normalizedHost: String
  if inet_pton(AF_INET, bareHost, &address4) == 1 {
    guard inet_ntop(AF_INET, &address4, &buffer, socklen_t(buffer.count)) != nil else { return nil }
    normalizedHost = String(cString: buffer)
  } else if inet_pton(AF_INET6, bareHost, &address6) == 1 {
    guard inet_ntop(AF_INET6, &address6, &buffer, socklen_t(buffer.count)) != nil else {
      return nil
    }
    normalizedHost = "[\(String(cString: buffer))]"
  } else {
    let finalLabel =
      bareHost.split(separator: ".", omittingEmptySubsequences: false).last.map(String.init) ?? ""
    let decimal =
      !finalLabel.isEmpty
      && finalLabel.unicodeScalars.allSatisfy(CharacterSet.decimalDigits.contains)
    let hexadecimal =
      finalLabel.lowercased().hasPrefix("0x") && finalLabel.count > 2
      && finalLabel.dropFirst(2).unicodeScalars.allSatisfy(
        CharacterSet(charactersIn: "0123456789abcdefABCDEF").contains)
    if decimal || hexadecimal { return nil }
    guard url.host == bareHost else { return nil }
    normalizedHost = bareHost.lowercased()
  }
  let port = url.port
  guard port == nil || (1...65_535).contains(port!), port != 443 else { return nil }
  let canonical = "https://\(normalizedHost)" + (port.map { ":\($0)" } ?? "")
  return canonical == value ? url : nil
}
