#if DEBUG
import Foundation
import SwiftUI

@MainActor
struct NativeScannerSheetUITestFixtureView: View {
  @StateObject private var enrollment: NativeEnrollmentStore
  @StateObject private var dashboards: DashboardStore

  init() {
    // The enrollment journey never mutates dashboards. Keep even its read path
    // distinct from the default store, with no file or directory to clean up.
    let dashboardFile = FileManager.default.temporaryDirectory.appendingPathComponent(
      "ellie-scanner-sheet-ui-\(UUID().uuidString).json")
    precondition(!FileManager.default.fileExists(atPath: dashboardFile.path))
    _enrollment = StateObject(
      wrappedValue: NativeEnrollmentStore(
        vault: ScannerSheetMemoryVault(), transport: ScannerSheetRejectTransport()))
    _dashboards = StateObject(
      wrappedValue: DashboardStore(fileURL: dashboardFile))
  }

  var body: some View {
    NavigationStack {
      NativeEnrollmentView(
        store: enrollment, dashboards: dashboards,
        uiTestScannerCode: ScannerSheetFixtureCode.value)
    }
  }
}

struct NativeScannerSheetUITestCamera: View {
  let code: String
  let completion: (Result<String, NativeEnrollmentFailure>) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    VStack(spacing: 24) {
      Button("Dismiss test scanner") { dismiss() }
        .accessibilityIdentifier("scanner-fixture-dismiss")
      Button("Decode synthetic code") { completion(.success(code)) }
        .accessibilityIdentifier("scanner-fixture-decode")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private enum ScannerSheetFixtureCode {
  static let value: String = {
    let json =
      #"{"version":1,"origin":"https://127.0.0.1:8444","certificateSha256":"\#(String(repeating: "a", count: 64))","invitation":"\#(String(repeating: "b", count: 64))","expiresAt":4102444800000,"label":"Fixture phone","grants":[{"target":"fixture-mac","capabilities":["app.open"]}]}"#
    let encoded = Data(json.utf8).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    return NativePairingPayload.prefix + encoded
  }()
}

private actor ScannerSheetMemoryVault: NativeCredentialVault {
  private var pending: PendingNativeEnrollment?
  private var active: NativeEnrollmentCredential?
  func loadPending() -> PendingNativeEnrollment? { pending }
  func loadActive() -> NativeEnrollmentCredential? { active }
  func savePending(_ value: PendingNativeEnrollment) { pending = value }
  func promote(_ value: NativeEnrollmentCredential) { pending = nil; active = value }
  func removePending() { pending = nil }
  func removeActive() { active = nil }
  func removeAll() { pending = nil; active = nil }
}

private actor ScannerSheetRejectTransport: NativeEnrollmentTransporting {
  func pair(payload: NativePairingPayload, pending: PendingNativeEnrollment) throws
    -> NativeClient
  { throw NativeEnrollmentFailure.unavailable }
  func recover(_ pending: PendingNativeEnrollment) throws -> NativeClient? {
    throw NativeEnrollmentFailure.unavailable
  }
  func logout(_ credential: NativeEnrollmentCredential) throws {
    throw NativeEnrollmentFailure.unavailable
  }
}
#endif
