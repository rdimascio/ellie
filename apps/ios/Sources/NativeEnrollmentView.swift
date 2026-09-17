import AVFoundation
import SwiftUI

struct NativeEnrollmentView: View {
  @ObservedObject var store: NativeEnrollmentStore
  @ObservedObject var dashboards: DashboardStore
  #if DEBUG
  var uiTestScannerCode: String? = nil
  #endif
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
            if let access = nativeEnrollmentAccessDescription(grant) {
              Label("\(access) on \(grant.target)", systemImage: "macbook")
            } else {
              Label("Unsupported access on \(grant.target)", systemImage: "exclamationmark.triangle")
            }
          }
        }
        Section {
          Button("Pair this iPhone") { store.confirm() }
            .disabled(payload.grants.contains { nativeEnrollmentAccessDescription($0) == nil })
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
          NavigationLink("Open Ellie Life") {
            LifeWebView(credential: LifeWebCredential(enrollment: credential))
              .id(credential.client.id)
          }
          NavigationLink("Read Gmail") {
            IOSGmailInboxView(credential: credential)
              .id(credential.client.id)
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
    .ellieScreen()
    .navigationTitle("Coordinator")
    .sheet(
      isPresented: Binding(
        get: { if case .scanning = store.phase { true } else { false } },
        set: { if !$0 { store.scannerDismissed() } })
    ) {
      NavigationStack {
        Group {
          #if DEBUG
          if let uiTestScannerCode {
            NativeScannerSheetUITestCamera(code: uiTestScannerCode, completion: handleScan)
          } else {
            NativeQRScanner(completion: handleScan)
          }
          #else
          NativeQRScanner(completion: handleScan)
          #endif
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
  private func handleScan(_ result: Result<String, NativeEnrollmentFailure>) {
    switch result {
    case .success(let code): store.scanned(code)
    case .failure: store.scannerFailed()
    }
  }
}

func nativeEnrollmentAccessDescription(_ grant: NativeGrant) -> String? {
  guard validNativeCapabilities(grant.capabilities) else { return nil }
  return grant.capabilities.map { capability in
    switch capability {
    case "app.open": "Open applications"
    case "browser.read": "Read the current browser page"
    case "browser.control": "Control the current browser page"
    default: capability
    }
  }.joined(separator: ", ")
}

// A scan belongs to one presentation. Delayed authorization, preview, and timeout
// work must not revive a camera after dismissal or submit a second result.
final class NativeScannerRunGate {
  private let lock = NSLock()
  private var generation = 0
  private var state = 0 // 0 = new, 1 = scanning, 2 = finished or stopped

  func begin() -> Int? {
    lock.lock(); defer { lock.unlock() }
    guard state == 0 else { return nil }
    state = 1
    generation += 1
    return generation
  }
  func isCurrent(_ token: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return state == 1 && generation == token
  }
  func finish(_ token: Int) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state == 1 && generation == token else { return false }
    state = 2
    generation += 1
    return true
  }
  @discardableResult func stop() -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard state != 2 else { return false }
    state = 2
    generation += 1
    return true
  }
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
  private let run = NativeScannerRunGate()
  private var preview: AVCaptureVideoPreviewLayer? // Main thread only.
  private var activeToken: Int? // Capture queue only.
  private var timeoutWorkItem: DispatchWorkItem? // Capture queue only.

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
    guard let token = run.begin() else { return }
    captureQueue.async { [weak self] in
      guard let self, self.run.isCurrent(token) else { return }
      self.activeToken = token
      let timeout = DispatchWorkItem { [weak self] in
        self?.finish(.failure(.cancelled), token: token)
      }
      self.timeoutWorkItem = timeout
      self.captureQueue.asyncAfter(deadline: .now() + 60, execute: timeout)
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        self.configure(token: token)
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
          guard let self else { return }
          self.captureQueue.async { [weak self] in
            guard let self, self.run.isCurrent(token) else { return }
            if allowed { self.configure(token: token) }
            else { self.finish(.failure(.unavailable), token: token) }
          }
        }
      default:
        self.finish(.failure(.unavailable), token: token)
      }
    }
  }

  private func configure(token: Int) {
    guard run.isCurrent(token),
      let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
      let input = try? AVCaptureDeviceInput(device: camera)
    else { finish(.failure(.unavailable), token: token); return }
    session.beginConfiguration()
    guard session.canSetSessionPreset(.vga640x480), session.canAddInput(input) else {
      session.commitConfiguration()
      finish(.failure(.unavailable), token: token)
      return
    }
    session.sessionPreset = .vga640x480
    session.addInput(input)
    let output = AVCaptureMetadataOutput()
    guard session.canAddOutput(output) else {
      session.commitConfiguration()
      finish(.failure(.unavailable), token: token)
      return
    }
    session.addOutput(output)
    session.commitConfiguration()
    guard run.isCurrent(token) else { teardownCapture(); return }
    // Assigning an unavailable metadata type raises an Objective-C exception.
    guard output.availableMetadataObjectTypes.contains(.qr) else {
      finish(.failure(.unavailable), token: token)
      return
    }
    output.setMetadataObjectsDelegate(self, queue: captureQueue)
    output.metadataObjectTypes = [.qr]
    session.startRunning()
    guard run.isCurrent(token) else { teardownCapture(); return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.run.isCurrent(token), self.preview == nil else { return }
      let layer = AVCaptureVideoPreviewLayer(session: self.session)
      layer.videoGravity = .resizeAspectFill
      layer.frame = self.view.bounds
      self.view.layer.addSublayer(layer)
      self.preview = layer
    }
  }

  func stop() {
    let needsTeardown = run.stop() // Invalidate callbacks before capture-queue teardown.
    completion = nil
    removePreview()
    if needsTeardown { captureQueue.async { [self] in teardownCapture() } }
  }
  private func removePreview() {
    preview?.removeFromSuperlayer()
    preview = nil
  }
  private func teardownCapture() {
    timeoutWorkItem?.cancel()
    timeoutWorkItem = nil
    activeToken = nil
    for case let output as AVCaptureMetadataOutput in session.outputs {
      output.setMetadataObjectsDelegate(nil, queue: nil)
    }
    if session.isRunning { session.stopRunning() }
    if !session.inputs.isEmpty || !session.outputs.isEmpty {
      session.beginConfiguration()
      session.outputs.forEach(session.removeOutput)
      session.inputs.forEach(session.removeInput)
      session.commitConfiguration()
    }
  }
  private func finish(_ result: Result<String, NativeEnrollmentFailure>, token: Int) {
    guard run.finish(token) else { return }
    teardownCapture() // Release camera buffers and delegate before notifying SwiftUI.
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.removePreview()
      guard let completion = self.completion else { return }
      self.completion = nil
      completion(result)
    }
  }
  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let token = activeToken, run.isCurrent(token),
      let value = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue
    else { return }
    finish(.success(value), token: token)
  }
}
