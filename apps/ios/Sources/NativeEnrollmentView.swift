import AVFoundation
import SwiftUI

struct NativeEnrollmentView: View {
  @ObservedObject var store: NativeEnrollmentStore
  @ObservedObject var dashboards: DashboardStore
  @Environment(\.scenePhase) private var scenePhase
  @State private var syncCleanupError = false

  var body: some View {
    List {
      switch store.phase {
      case .idle:
        Section {
          Button("Scan enrollment code", systemImage: "qrcode.viewfinder") { store.startScanning() }
        } footer: {
          Text(
            "Scanning starts only when you tap. Ellie will show the coordinator and requested access before connecting."
          )
        }
      case .scanning:
        ProgressView("Starting camera…")
      case .confirming(let payload):
        Section("Coordinator") {
          LabeledContent("Origin", value: payload.origin.absoluteString)
          LabeledContent("Certificate", value: shortPin(payload.certificateSha256))
          LabeledContent("Label", value: payload.label)
        }
        Section("Requested access") {
          ForEach(payload.grants, id: \.target) { grant in
            Label("Open apps on \(grant.target)", systemImage: "macbook")
          }
        }
        Section {
          Button("Pair this iPhone") { store.confirm() }
          Button("Cancel", role: .cancel) { store.cancelTransient() }
        }
      case .checking, .working: ProgressView("Waiting…")
      case .enrolled(let credential):
        Section("Paired") {
          LabeledContent("Coordinator", value: credential.origin.absoluteString)
          LabeledContent("Device", value: credential.client.label)
          NavigationLink("Control a Mac") { PhoneControlView(credential: credential) }
          NavigationLink("Sync Dashboards") {
            DashboardSyncView(credential: credential, dashboards: dashboards)
          }
        }
        Section {
          Button("Log out from coordinator", role: .destructive) {
            clearPendingSync { store.logout() }
          }
          Button("Remove local credential", role: .destructive) {
            clearPendingSync { store.removeLocalCredential() }
          }
        }
        Section { Text("Removing the local credential does not revoke the coordinator session.") }
          .font(.footnote).foregroundStyle(.secondary)
      case .pairingUncertain(let pending):
        Section {
          Label("Pairing may have completed", systemImage: "exclamationmark.triangle")
          Text("Check the coordinator without submitting the invitation again.")
        }
        Section {
          Button("Recover pairing") { store.recover() }
          Button("Discard pending credential", role: .destructive) {
            clearPendingSync { store.removeLocalCredential() }
          }
        }
        Section("Coordinator") { Text(pending.origin.absoluteString) }
        Section {
          Text(
            "Discarding the local credential does not revoke a session that may exist on the coordinator."
          )
        }.font(.footnote).foregroundStyle(.secondary)
      case .logoutUncertain(let credential):
        Section {
          Label("Logout may have completed", systemImage: "exclamationmark.triangle")
          Text("Check the coordinator before removing the local credential.")
        }
        Section {
          Button("Check session") { store.checkLogout() }
          Button("Remove local credential", role: .destructive) {
            clearPendingSync { store.removeLocalCredential() }
          }
        }
        Section("Coordinator") { Text(credential.origin.absoluteString) }
        Section {
          Text("Removing the local credential does not confirm or complete coordinator logout.")
        }.font(.footnote).foregroundStyle(.secondary)
      case .failed(let message):
        ContentUnavailableView(
          "Enrollment unavailable", systemImage: "exclamationmark.triangle",
          description: Text(message))
        Button("Try another code") { store.startScanning() }
        Button("Remove saved pairing", role: .destructive) {
          clearPendingSync { store.removeLocalCredential() }
        }
        Text(
          "Removing the saved pairing affects only this iPhone. It does not revoke a session on the coordinator."
        ).font(.footnote).foregroundStyle(.secondary)
      }
    }
    .navigationTitle("Coordinator")
    .sheet(
      isPresented: Binding(
        get: { if case .scanning = store.phase { true } else { false } },
        set: { if !$0 { store.cancelTransient() } })
    ) {
      NavigationStack {
        NativeQRScanner { result in
          switch result {
          case .success(let code): store.scanned(code)
          case .failure: store.scannerFailed()
          }
        }
        .ignoresSafeArea()
        .navigationTitle("Scan Ellie code")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { store.cancelTransient() }
          }
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in if phase == .background { store.cancelTransient() } }
    .onDisappear { store.cancelTransient() }
    .alert("Couldn’t Clear Pending Dashboard Sync", isPresented: $syncCleanupError) {
      Button("OK", role: .cancel) {}
    } message: {
      Text("Logout is blocked until Ellie can clear its private pending dashboard copy.")
    }
  }
  private func clearPendingSync(_ action: () -> Void) {
    do { try clearPendingDashboardSync(action: action) }
    catch { syncCleanupError = true }
  }
  private func shortPin(_ pin: String) -> String { "\(pin.prefix(12))…\(pin.suffix(12))" }
}

private struct NativeQRScanner: UIViewControllerRepresentable {
  let completion: (Result<String, NativeEnrollmentFailure>) -> Void
  func makeUIViewController(context: Context) -> ScannerController {
    let controller = ScannerController()
    controller.completion = completion
    return controller
  }
  func updateUIViewController(_ uiViewController: ScannerController, context: Context) {}
  static func dismantleUIViewController(_ uiViewController: ScannerController, coordinator: ()) {
    uiViewController.stop()
  }
}

private final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var completion: ((Result<String, NativeEnrollmentFailure>) -> Void)?
  private let session = AVCaptureSession()
  private let captureQueue = DispatchQueue(label: "org.ellie.ios.enrollment.camera")
  private var preview: AVCaptureVideoPreviewLayer?
  private var generation = 0
  private var active = false

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    start()
  }
  override func viewWillDisappear(_ animated: Bool) {
    stop()
    super.viewWillDisappear(animated)
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  private func start() {
    captureQueue.async {
      self.generation += 1
      let expected = self.generation
      self.active = true
      AVCaptureDevice.requestAccess(for: .video) { allowed in
        self.captureQueue.async {
          guard allowed, self.active, self.generation == expected else {
            if !allowed { self.finish(.failure(.unavailable), generation: expected) }
            return
          }
          guard let camera = AVCaptureDevice.default(for: .video),
            let input = try? AVCaptureDeviceInput(device: camera), self.session.canAddInput(input)
          else {
            self.finish(.failure(.unavailable), generation: expected)
            return
          }
          self.session.beginConfiguration()
          self.session.addInput(input)
          let output = AVCaptureMetadataOutput()
          guard self.session.canAddOutput(output) else {
            self.session.removeInput(input)
            self.session.commitConfiguration()
            self.finish(.failure(.unavailable), generation: expected)
            return
          }
          self.session.addOutput(output)
          output.setMetadataObjectsDelegate(self, queue: self.captureQueue)
          output.metadataObjectTypes = [.qr]
          self.session.commitConfiguration()
          guard self.active, self.generation == expected else {
            self.teardown()
            return
          }
          DispatchQueue.main.async {
            let layer = AVCaptureVideoPreviewLayer(session: self.session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = self.view.bounds
            self.view.layer.addSublayer(layer)
            self.preview = layer
          }
          self.session.startRunning()
          self.captureQueue.asyncAfter(deadline: .now() + 60) {
            if self.active && self.generation == expected {
              self.finish(.failure(.cancelled), generation: expected)
            }
          }
        }
      }
    }
  }
  func stop() {
    if Thread.isMainThread {
      completion = nil
    } else {
      DispatchQueue.main.sync { self.completion = nil }
    }
    captureQueue.async {
      self.generation += 1
      self.active = false
      self.teardown()
    }
  }
  private func teardown() {
    if session.isRunning { session.stopRunning() }
    session.beginConfiguration()
    session.inputs.forEach(session.removeInput)
    session.outputs.forEach(session.removeOutput)
    session.commitConfiguration()
    DispatchQueue.main.async {
      self.preview?.removeFromSuperlayer()
      self.preview = nil
    }
  }
  private func finish(_ result: Result<String, NativeEnrollmentFailure>, generation expected: Int) {
    guard active, generation == expected else { return }
    active = false
    generation += 1
    teardown()
    DispatchQueue.main.async {
      guard let completion = self.completion else { return }
      self.completion = nil
      completion(result)
    }
  }
  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
    else { return }
    finish(.success(value), generation: generation)
  }
}
