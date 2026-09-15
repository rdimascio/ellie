import SwiftUI

struct BrowserControlView: View {
  @ObservedObject var controls: PhoneControlStore
  @ObservedObject var browser: BrowserPhoneControlStore
  @State private var search = ""

  var body: some View {
    Form {
      Section("Browser target") {
        Text(controls.selectedNode?.label ?? "Choose a Mac in Mac controls")
          .font(.headline)
        Button("Read current page", systemImage: "doc.text.magnifyingglass") {
          browser.refresh(on: controls.selectedNode)
        }
        .disabled(browser.isBusy || controls.selectedNode == nil)
      }
      if let page = browser.page {
        Section("Current page") {
          if let title = page.title { Text(title).font(.headline) }
          if let summary = page.summary { Text(summary).foregroundStyle(.secondary) }
          Label(page.source == .webmcp ? "WebMCP" : "Accessibility", systemImage: "link")
            .font(.caption).foregroundStyle(.secondary)
        }
        Section("Search") {
          TextField("Search this page", text: $search)
          Button("Search") { browser.perform(.search(query: search), on: controls.selectedNode) }
            .disabled(search.isEmpty || browser.isBusy)
        }
        Section("Page controls") {
          HStack {
            Button("Up") { browser.perform(.scroll(.up), on: controls.selectedNode) }
            Button("Down") { browser.perform(.scroll(.down), on: controls.selectedNode) }
            Button("Left") { browser.perform(.scroll(.left), on: controls.selectedNode) }
            Button("Right") { browser.perform(.scroll(.right), on: controls.selectedNode) }
          }
          .disabled(browser.isBusy)
          HStack {
            Button("Play") { browser.perform(.play, on: controls.selectedNode) }
            Button("Pause") { browser.perform(.pause, on: controls.selectedNode) }
          }
          .disabled(browser.isBusy)
        }
        if !page.items.isEmpty {
          Section("Results") {
            ForEach(Array(page.items.enumerated()), id: \.element.id) { index, item in
              Button("\(index + 1). \(item.label)") {
                browser.perform(.openResult(index: index + 1), on: controls.selectedNode)
              }
              .disabled(browser.isBusy)
            }
          }
        }
      }
      status
      if browser.isBusy {
        Section { Button("Stop waiting", role: .cancel) { browser.cancel() } }
      }
    }
    .navigationTitle("Browser control")
    .onChange(of: controls.selectedNodeID) { _, value in browser.clearIfTargetChanged(to: value) }
    .onDisappear { browser.cancel() }
  }

  @ViewBuilder private var status: some View {
    switch browser.phase {
    case .idle, .ready: EmptyView()
    case .checking: Section { ProgressView("Checking browser connection…") }
    case .reading: Section { ProgressView("Reading current page…") }
    case .sending(let label): Section { ProgressView("Sending \(label)…") }
    case .cancelling: Section { ProgressView("Stopping…") }
    case .outcome(let message): Section("Result") { Label(message, systemImage: "checkmark.circle") }
    case .unknown(let message): Section("Result") { Label(message, systemImage: "questionmark.circle") }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked: Section { Label("This iPhone’s coordinator session was revoked.", systemImage: "lock.slash") }
    }
  }
}
