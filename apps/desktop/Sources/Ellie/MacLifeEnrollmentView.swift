#if os(macOS)
import SwiftUI

struct MacLifeEnrollmentView: View {
  @ObservedObject var enrollment: NativeEnrollmentStore
  @State private var code = ""

  var body: some View {
    NavigationStack {
      Group {
        switch enrollment.phase {
        case .idle:
          ContentUnavailableView {
            Label("Connect Ellie Life", systemImage: "person.badge.key")
          } description: {
            Text("Paste a fresh enrollment code from the shared Ellie coordinator.")
          } actions: {
            Button("Enter enrollment code") { code = ""; enrollment.startScanning() }
          }
        case .checking, .working:
          ProgressView("Connecting to Ellie…")
        case .scanning:
          Form {
            TextField("Enrollment code", text: $code, axis: .vertical)
              .accessibilityIdentifier("life-enrollment-code")
            HStack {
              Button("Cancel", role: .cancel) { code = ""; enrollment.cancelTransient() }
              Button("Review connection") {
                let submitted = code
                code = ""
                enrollment.scanned(submitted)
              }
                .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
          }.padding()
        case .confirming(let payload):
          Form {
            LabeledContent("Coordinator", value: payload.origin.absoluteString)
            LabeledContent("Device", value: payload.label)
            LabeledContent(
              "Certificate",
              value: "\(payload.certificateSha256.prefix(12))…\(payload.certificateSha256.suffix(12))")
            Section("Requested app access") {
              ForEach(payload.grants, id: \.target) { grant in
                VStack(alignment: .leading) {
                  Text(grant.target)
                  Text(grant.capabilities.joined(separator: ", "))
                    .font(.caption).foregroundStyle(.secondary)
                }
              }
            }
            Text("Life account access must also be granted by the coordinator owner.")
              .foregroundStyle(.secondary)
            HStack {
              Button("Cancel", role: .cancel) { code = ""; enrollment.cancelTransient() }
              Button("Pair this Mac") { code = ""; enrollment.confirm() }
            }
          }.padding()
        case .enrolled(let credential):
          LifeWebView(credential: LifeWebCredential(enrollment: credential))
            .id(credential.client.id)
            .toolbar {
              Button("Disconnect Life", role: .destructive) { enrollment.logout() }
            }
        case .pairingUncertain:
          ContentUnavailableView {
            Label("Pairing may have completed", systemImage: "exclamationmark.triangle")
          } description: {
            Text("Check the coordinator before trying a different code.")
          } actions: {
            Button("Recover pairing") { enrollment.recover() }
            Button("Remove local credential", role: .destructive) {
              enrollment.removeLocalCredential()
            }
          }
        case .logoutUncertain:
          ContentUnavailableView {
            Label("Disconnect needs review", systemImage: "exclamationmark.triangle")
          } description: {
            Text("Check whether the coordinator session is still active.")
          } actions: {
            Button("Check session") { enrollment.checkLogout() }
          }
        case .failed(let message):
          ContentUnavailableView {
            Label("Life connection unavailable", systemImage: "exclamationmark.triangle")
          } description: { Text(message) } actions: {
            Button("Try another code") { code = ""; enrollment.startScanning() }
          }
        }
      }
      .navigationTitle("Ellie Life")
      .onDisappear { code = ""; enrollment.cancelTransient() }
    }
  }
}
#endif
