import Foundation

struct DashboardSyncImportPresentation: Equatable {
  private(set) var error: String?

  var isPresentingError: Bool { error != nil }

  @MainActor
  mutating func replace(with remote: DashboardState, dashboards: DashboardStore) {
    guard error == nil, let data = try? DashboardModel.encode(remote) else { return }
    dashboards.importData(data)
    error = dashboards.error
  }

  @MainActor
  mutating func dismissError(dashboards: DashboardStore) {
    guard let presentedError = error else { return }
    if dashboards.error == presentedError { dashboards.error = nil }
    self.error = nil
  }
}
