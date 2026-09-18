import SwiftUI

struct BrowserControlView: View {
  @Environment(\.scenePhase) private var scenePhase
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
          Label(page.source == .webmcp ? "WebMCP" : page.source == .companion ? "Browser companion" : "Accessibility", systemImage: "link")
            .font(.caption).foregroundStyle(.secondary)
        }
        if let site = page.site {
          Section("Observed site") {
            Label(observedPageLabel(site), systemImage: "eye")
              .accessibilityIdentifier("browser-observed-site")
            if site.page == .watch {
              Text(observedPlaybackLabel(site.playback))
                .accessibilityIdentifier("browser-observed-playback")
              if let seconds = site.currentTimeSeconds {
                Text("Observed media position: \(Int(seconds)) seconds")
                  .font(.caption).foregroundStyle(.secondary)
              }
              Text("Visible media state does not confirm which video is playing.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            if site.provider == .netflix && site.searchControl == nil {
              Text("No unambiguous accessible Netflix search field was observed. Search is unavailable on this page.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            if site.provider == .youtube && site.searchControl == nil {
              Text("No unambiguous YouTube search field was observed in the selected browser document. Search is unavailable on this page.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            if site.provider == .netflix && site.page == .browse && site.rows?.isEmpty != false {
              Text("No safely identified horizontal rows are available on this page.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            if site.provider == .youtubeTV {
              Text("YouTube TV search, title selection, and horizontal rows are unavailable until their controls can be safely observed. Browsing and player controls require a fresh read.")
                .font(.footnote).foregroundStyle(.secondary)
            }
            if site.provider == .disneyplus {
              Text("On an observed Disney+ title page, Up and Down move the page when one viewport scroller is available; read again before selecting a visible title. Search, playback, profiles, and subscription controls are unavailable. Selection does not confirm playback.")
                .font(.footnote).foregroundStyle(.secondary)
            }
          }
          if site.provider == .netflix && site.page == .browse, let rows = site.rows,
            !rows.isEmpty {
            Section("Netflix rows") {
              Text("Choose a row, then use Left or Right. Read again after scrolling.")
                .font(.footnote).foregroundStyle(.secondary)
              ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                Button {
                  browser.selectObservedRow(row.id, on: controls.selectedNode)
                } label: {
                  HStack {
                    Text(row.label)
                    Spacer()
                    if browser.selectedRowID == row.id { Image(systemName: "checkmark") }
                  }
                }
                .accessibilityIdentifier("browser-netflix-row-\(index + 1)")
                .disabled(browser.isBusy || controls.selectedNode?.capabilities.contains("browser.control") != true)
              }
            }
          }
        }
        if controls.selectedNode?.capabilities.contains("browser.control") != true {
          Section {
            Label(
              "This Mac allows browser reading only. Browser actions require a separate grant.",
              systemImage: "lock")
              .accessibilityIdentifier("browser-read-only-grant-warning")
          }
        }
        Section("Search") {
          if let control = page.site?.searchControl {
            Text("Observed search field: \(control.label). Search effects remain unverified until you read the page again.")
              .font(.footnote).foregroundStyle(.secondary)
          }
          TextField("Search this page", text: $search)
          Button("Search") { browser.perform(.search(query: search), on: controls.selectedNode) }
            .disabled(!browser.canPerform(.search(query: search), on: controls.selectedNode))
        }
        Section("Page controls") {
          HStack {
            Button("Up") { browser.perform(.scroll(.up), on: controls.selectedNode) }
              .disabled(!browser.canPerform(.scroll(.up), on: controls.selectedNode))
            Button("Down") { browser.perform(.scroll(.down), on: controls.selectedNode) }
              .disabled(!browser.canPerform(.scroll(.down), on: controls.selectedNode))
            Button("Left") { browser.perform(.scroll(.left), on: controls.selectedNode) }
              .disabled(!browser.canPerform(.scroll(.left), on: controls.selectedNode))
            Button("Right") { browser.perform(.scroll(.right), on: controls.selectedNode) }
              .disabled(!browser.canPerform(.scroll(.right), on: controls.selectedNode))
          }
          .buttonStyle(.borderless)
          HStack {
            Button("Play") { browser.perform(.play, on: controls.selectedNode) }
              .disabled(!browser.canPerform(.play, on: controls.selectedNode))
            Button("Pause") { browser.perform(.pause, on: controls.selectedNode) }
              .disabled(!browser.canPerform(.pause, on: controls.selectedNode))
          }
          .buttonStyle(.borderless)
        }
        if !page.items.isEmpty {
          Section("Results") {
            ForEach(Array(page.items.enumerated()), id: \.element.id) { index, item in
              Button("\(index + 1). \(item.label)") {
                browser.perform(.openResult(index: index + 1), on: controls.selectedNode)
              }
              .accessibilityIdentifier("browser-result-\(index + 1)")
              .disabled(
                !browser.canPerform(.openResult(index: index + 1), on: controls.selectedNode))
            }
          }
        }
      }
      status
      if browser.showsSeparatePendingBrowserWarning {
        Section("Browser result") {
          Label(
            BrowserPhoneControlStore.pendingCommandWarningMessage,
            systemImage: "questionmark.circle")
            .accessibilityIdentifier("browser-status-pending-warning")
        }
      }
      if browser.showsPendingBrowserWarningError,
        let warningError = browser.pendingBrowserWarningError
      {
        Section("Browser result") {
          Label(warningError, systemImage: "exclamationmark.triangle")
            .accessibilityIdentifier("browser-status-pending-storage-error")
        }
      }
      if browser.isBusy {
        Section {
          Button("Stop waiting", role: .cancel) { browser.cancel() }
            .accessibilityIdentifier("browser-stop-waiting")
        }
      }
    }
    .ellieScreen()
    .navigationTitle("Browser control")
    .onChange(of: controls.selectedNodeID) { _, value in browser.clearIfTargetChanged(to: value) }
    .onChange(of: scenePhase) { _, phase in
      if phase != .active { browser.cancel() }
    }
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
    case .unknown(let message):
      Section("Result") {
        Label(message, systemImage: "questionmark.circle")
          .accessibilityIdentifier("browser-status-unknown")
      }
    case .failed(let message): Section { Label(message, systemImage: "exclamationmark.triangle") }
    case .revoked: Section { Label("This iPhone’s coordinator session was revoked.", systemImage: "lock.slash") }
    }
  }

  private func observedPageLabel(_ site: BrowserPhoneSite) -> String {
    if site.provider == .disneyplus {
      switch site.page {
      case .browse: return "Observed Disney+ title page"
      case .login: return "Observed Disney+ sign-in page"
      default: return "Observed Disney+ page is unsupported"
      }
    }
    if site.provider == .youtubeTV {
      switch site.page {
      case .browse: return "Observed YouTube TV page; program identity unavailable"
      case .watch: return "Observed YouTube TV player; program identity unavailable"
      case .login: return "Observed YouTube TV sign-in or welcome page"
      default: return "Observed YouTube TV page is unsupported"
      }
    }
    if site.provider == .netflix {
      switch site.page {
      case .browse: return "Observed Netflix catalogue"
      case .results: return "Observed Netflix search results"
      case .watch: return "Observed Netflix watch page"
      case .login: return "Observed Netflix sign-in page"
      case .unsupported: return "Observed Netflix page is unsupported"
      case .home: return "Observed Netflix page is unsupported"
      }
    }
    return switch site.page {
    case .home: "Observed YouTube home page"
    case .results: "Observed YouTube results page"
    case .browse: "Observed YouTube page is unsupported"
    case .watch: "Observed YouTube watch page"
    case .login: "Observed YouTube sign-in page"
    case .unsupported: "Observed YouTube page is unsupported"
    }
  }

  private func observedPlaybackLabel(_ playback: BrowserPhonePlayback) -> String {
    switch playback {
    case .playing: "Observed playback: playing"
    case .paused: "Observed playback: paused"
    case .unavailable: "Playback state is unavailable"
    case .ambiguous: "Playback state is unclear"
    }
  }
}
