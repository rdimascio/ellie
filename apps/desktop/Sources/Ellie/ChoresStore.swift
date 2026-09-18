import Combine
import Foundation

@MainActor
final class ChoresStore: ObservableObject {
    @Published private(set) var state: ChoresState
    @Published var error: String?

    let fileURL: URL
    private var recoveryRequired = false

    var timeZone: TimeZone { TimeZone(identifier: state.householdTimeZone)! }

    init(fileURL: URL? = nil, defaultTimeZone: TimeZone = .current) {
        self.fileURL = fileURL ?? Self.defaultFileURL()
        state = ChoresModel.emptyState(timeZone: defaultTimeZone)
        guard FileManager.default.fileExists(atPath: self.fileURL.path) else { return }
        do {
            let values = try self.fileURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else { throw ChoresStoreError.unsafeStateFile }
            guard let size = values.fileSize, size <= ChoresModel.maximumSerializedBytes else { throw ChoresModelError.dataTooLarge }
            let handle = try FileHandle(forReadingFrom: self.fileURL)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: ChoresModel.maximumSerializedBytes + 1) ?? Data()
            state = try ChoresModel.decode(data)
        } catch {
            recoveryRequired = true
            self.error = "Saved chores could not be opened: \(error.localizedDescription) The file was left unchanged."
        }
    }

    func chores(on day: ChoreDay) -> [Chore] {
        state.chores.filter { $0.dueDay == day }.sorted {
            if ($0.completedDay != nil) != ($1.completedDay != nil) { return $0.completedDay == nil }
            if $0.member != $1.member { return $0.member.localizedCaseInsensitiveCompare($1.member) == .orderedAscending }
            return $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending
        }
    }

    func remaining(on day: ChoreDay) -> [Chore] { chores(on: day).filter { $0.completedDay == nil } }

    func add(title: String, member: String, body: String = "", dueDay: ChoreDay) {
        mutate { $0.chores.append(Chore(id: UUID().uuidString.lowercased(), title: title, member: member, body: body, dueDay: dueDay)) }
    }

    func update(id: String, title: String, member: String, body: String = "", dueDay: ChoreDay) {
        mutate { state in
            guard let index = state.chores.firstIndex(where: { $0.id == id }) else { throw ChoresModelError.unknownChore }
            state.chores[index].title = title
            state.chores[index].member = member
            state.chores[index].body = body
            state.chores[index].dueDay = dueDay
        }
    }

    func setCompleted(id: String, completed: Bool, now: Date = Date()) {
        mutate { state in
            guard let index = state.chores.firstIndex(where: { $0.id == id }) else { throw ChoresModelError.unknownChore }
            state.chores[index].completedDay = completed ? ChoreDay.from(now, timeZone: TimeZone(identifier: state.householdTimeZone)!) : nil
        }
    }

    func delete(id: String) {
        mutate { state in
            guard let index = state.chores.firstIndex(where: { $0.id == id }) else { throw ChoresModelError.unknownChore }
            state.chores.remove(at: index)
        }
    }

    func updateTimeZone(_ identifier: String) { mutate { $0.householdTimeZone = identifier } }

    func completionsByDay(forWeekContaining day: ChoreDay) -> [(day: ChoreDay, count: Int)] {
        ChoresModel.weekDays(containing: day, timeZone: timeZone).map { target in
            (target, state.chores.filter { $0.completedDay == target }.count)
        }
    }

    private func mutate(_ change: (inout ChoresState) throws -> Void) {
        guard !recoveryRequired else { error = ChoresStoreError.recoveryRequired.localizedDescription; return }
        var candidate = state
        do {
            try change(&candidate)
            try persist(candidate)
            state = candidate
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func persist(_ candidate: ChoresState) throws {
        let data = try ChoresModel.encode(candidate)
        let directory = fileURL.deletingLastPathComponent()
        let directoryExisted = FileManager.default.fileExists(atPath: directory.path)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        if !directoryExisted || fileURL.standardizedFileURL == Self.defaultFileURL().standardizedFileURL {
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        }
        let staging = directory.appendingPathComponent(".chores-\(UUID().uuidString).tmp")
        do {
            try data.write(to: staging, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: staging.path)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: staging, backupItemName: nil, options: .usingNewMetadataOnly)
            } else { try FileManager.default.moveItem(at: staging, to: fileURL) }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch { try? FileManager.default.removeItem(at: staging); throw error }
    }

    private static func defaultFileURL() -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Ellie", isDirectory: true).appendingPathComponent("choresv1.json")
    }
}

private enum ChoresStoreError: LocalizedError {
    case unsafeStateFile, recoveryRequired
    var errorDescription: String? {
        switch self {
        case .unsafeStateFile: "The chores state path is not a regular file."
        case .recoveryRequired: "Saved chores need recovery before changes can be written. Move the malformed choresv1.json aside to start fresh."
        }
    }
}
