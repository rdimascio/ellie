import Darwin
import Foundation

private enum LifecycleFailure: Error {
  case rejected, recoveryRequired, busy, unavailable, unmanaged, enableRolledBack, partialEnable,
    partialDisable
  case enableUnknown, disableUnknown, startUnknown, stopUnknown
}
private struct LaunchResult {
  let code: Int32
  let output: Data
  let timedOut: Bool
}
private struct LaunchObservation {
  let loaded: Bool
  let selectedPath: Bool
  let running: Bool
  let enabled: Bool
}

private func lifecycleFail(_ error: Error) -> Never {
  if error is MigrationSwitchPendingFailure {
    FileHandle.standardError.write(Data((migrationSwitchRecovery + "\n").utf8))
    exit(1)
  }
  let message: String
  switch error as? LifecycleFailure {
  case .recoveryRequired:
    message = "Ellie service lifecycle requires selection recovery; no lifecycle command was sent."
  case .busy:
    message = "Another service lifecycle or selection command is running; no action was sent."
  case .unavailable:
    message = "Ellie could not verify the selected service state; no lifecycle command was sent."
  case .unmanaged:
    message = "The loaded service is not the selected managed service; it was preserved."
  case .enableRolledBack:
    message =
      "The start was not sent; the selected service's prior disabled state was restored."
  case .partialEnable:
    message =
      "The selected service was enabled, but start was not confirmed; run status before retrying."
  case .partialDisable:
    message =
      "The selected service was disabled, but stop was not confirmed; run status before retrying."
  case .enableUnknown:
    message = "The enable request may have taken effect; run status before taking another action."
  case .disableUnknown:
    message = "The disable request may have taken effect; run status before taking another action."
  case .startUnknown:
    message = "The start request may have taken effect; run status before taking another action."
  case .stopUnknown:
    message = "The stop request may have taken effect; run status before taking another action."
  default:
    message = "Ellie service lifecycle command was rejected; selected files were preserved."
  }
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

private func runLaunchctl(
  _ executable: String, _ arguments: [String], timeout: TimeInterval, capture: Bool = true
) throws -> LaunchResult {
  var output = [Int32](repeating: -1, count: 2)
  if capture {
    guard pipe(output.withUnsafeMutableBufferPointer({ $0.baseAddress! })) == 0 else {
      throw LifecycleFailure.unavailable
    }
    guard fcntl(output[0], F_SETFL, O_NONBLOCK) == 0 else {
      close(output[0])
      close(output[1])
      output = [-1, -1]
      throw LifecycleFailure.unavailable
    }
  }
  defer {
    if output[0] >= 0 { close(output[0]) }
    if output[1] >= 0 { close(output[1]) }
  }
  var actions: posix_spawn_file_actions_t?
  guard posix_spawn_file_actions_init(&actions) == 0 else {
    throw LifecycleFailure.unavailable
  }
  defer { posix_spawn_file_actions_destroy(&actions) }
  guard
    posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0) == 0,
    posix_spawn_file_actions_addopen(&actions, STDERR_FILENO, "/dev/null", O_WRONLY, 0) == 0
  else { throw LifecycleFailure.unavailable }
  if capture {
    guard
      posix_spawn_file_actions_adddup2(&actions, output[1], STDOUT_FILENO) == 0,
      posix_spawn_file_actions_addclose(&actions, output[0]) == 0,
      posix_spawn_file_actions_addclose(&actions, output[1]) == 0
    else { throw LifecycleFailure.unavailable }
  } else {
    guard
      posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO, "/dev/null", O_WRONLY, 0) == 0
    else { throw LifecycleFailure.unavailable }
  }
  var argv: [UnsafeMutablePointer<CChar>?] =
    ([executable] + arguments).map { strdup($0) } + [nil]
  defer { for pointer in argv { if let pointer { free(pointer) } } }
  var pid: pid_t = 0
  guard posix_spawn(&pid, executable, &actions, nil, &argv, environ) == 0 else {
    throw LifecycleFailure.unavailable
  }
  if output[1] >= 0 {
    close(output[1])
    output[1] = -1
  }
  let duration = UInt64(timeout * 1_000_000_000)
  let deadline = DispatchTime.now().uptimeNanoseconds + duration
  var bytes = Data()
  var status: Int32 = 0
  var exited = false
  var eof = !capture
  while !exited || !eof {
    if capture && !eof {
      var buffer = [UInt8](repeating: 0, count: 8 * 1024)
      let count = buffer.withUnsafeMutableBytes { read(output[0], $0.baseAddress!, $0.count) }
      if count > 0 {
        guard bytes.count + count <= 64 * 1024 else {
          if !exited {
            kill(pid, SIGTERM)
            usleep(50_000)
            kill(pid, SIGKILL)
          }
          if !exited { while waitpid(pid, &status, 0) < 0 && errno == EINTR {} }
          return LaunchResult(code: -1, output: Data(), timedOut: false)
        }
        bytes.append(buffer, count: count)
      } else if count == 0 {
        eof = true
      } else if errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR {
        if !exited {
          kill(pid, SIGKILL)
          while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
        }
        throw LifecycleFailure.unavailable
      }
    }
    if !exited {
      let waited = waitpid(pid, &status, WNOHANG)
      if waited == pid {
        exited = true
      } else if waited < 0 && errno != EINTR {
        if errno == ECHILD {
          throw LifecycleFailure.unavailable
        } else {
          kill(pid, SIGKILL)
          while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
          throw LifecycleFailure.unavailable
        }
      }
    }
    if DispatchTime.now().uptimeNanoseconds >= deadline {
      if !exited {
        kill(pid, SIGTERM)
        let killDeadline = DispatchTime.now().uptimeNanoseconds + 250_000_000
        while true {
          let waited = waitpid(pid, &status, WNOHANG)
          if waited == pid {
            exited = true
            break
          }
          if waited < 0 && errno != EINTR {
            if errno != ECHILD {
              kill(pid, SIGKILL)
              while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
            }
            throw LifecycleFailure.unavailable
          }
          if DispatchTime.now().uptimeNanoseconds >= killDeadline {
            kill(pid, SIGKILL)
            break
          }
          usleep(10_000)
        }
        if !exited {
          var waited: pid_t
          repeat { waited = waitpid(pid, &status, 0) } while waited < 0 && errno == EINTR
          guard waited == pid else { throw LifecycleFailure.unavailable }
        }
      }
      return LaunchResult(code: -1, output: Data(), timedOut: true)
    }
    if !exited || !eof { usleep(5_000) }
  }
  guard (status & 0x7f) == 0 else {
    return LaunchResult(code: -1, output: bytes, timedOut: false)
  }
  return LaunchResult(code: (status >> 8) & 0xff, output: bytes, timedOut: false)
}

private func text(_ data: Data) throws -> String {
  guard let value = String(data: data, encoding: .utf8), !value.contains("\0") else {
    throw LifecycleFailure.unavailable
  }
  return value
}
private func disabled(_ output: String, label: String) throws -> Bool {
  let escaped = NSRegularExpression.escapedPattern(for: label)
  let lineExpression = try NSRegularExpression(
    pattern: "^\\t\\t\\\"[^\\\"\\r\\n]{1,256}\\\" => (enabled|disabled|true|false)$")
  let expression = try NSRegularExpression(
    pattern: "^\\t\\t\\\"\(escaped)\\\" => (enabled|disabled|true|false)$")
  var selectedValues: [String] = []
  var lines = output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  while lines.first == "" { lines.removeFirst() }
  while lines.last == "" { lines.removeLast() }
  let unindented = lines.first == "disabled services = {" && lines.last == "}"
  let indented = lines.first == "\tdisabled services = {" && lines.last == "\t}"
  guard (unindented || indented), lines.count <= 258 else {
    throw LifecycleFailure.unavailable
  }
  for line in lines.dropFirst().dropLast() {
    let fullRange = NSRange(line.startIndex..<line.endIndex, in: line)
    guard lineExpression.firstMatch(in: line, range: fullRange)?.range == fullRange else {
      throw LifecycleFailure.unavailable
    }
    if let match = expression.firstMatch(in: line, range: fullRange), match.range == fullRange,
      let valueRange = Range(match.range(at: 1), in: line)
    {
      selectedValues.append(String(line[valueRange]))
    }
  }
  guard selectedValues.count <= 1 else { throw LifecycleFailure.unavailable }
  guard let value = selectedValues.first else { return false }
  switch value {
  case "enabled", "false": return false
  case "disabled", "true": return true
  default: throw LifecycleFailure.unavailable
  }
}
private func observation(
  executable: String, uid: uid_t, selected: LifecycleSelectedRole
) throws -> LaunchObservation {
  let domain = "gui/\(uid)"
  let gui = try runLaunchctl(executable, ["print", domain], timeout: 2, capture: false)
  guard !gui.timedOut, gui.code == 0 else { throw LifecycleFailure.unavailable }
  let disabledResult = try runLaunchctl(executable, ["print-disabled", domain], timeout: 2)
  guard !disabledResult.timedOut, disabledResult.code == 0 else {
    throw LifecycleFailure.unavailable
  }
  let isDisabled = try disabled(try text(disabledResult.output), label: selected.label)
  let target = domain + "/" + selected.label
  let result = try runLaunchctl(executable, ["print", target], timeout: 2)
  if result.code == 113 && !result.timedOut {
    return LaunchObservation(
      loaded: false, selectedPath: false, running: false, enabled: !isDisabled)
  }
  guard !result.timedOut, result.code == 0 else { throw LifecycleFailure.unavailable }
  let value = try text(result.output)
  var lines = value.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  if lines.last == "" { lines.removeLast() }
  guard lines.first == "\(target) = {", lines.last == "}", lines.count <= 256 else {
    throw LifecycleFailure.unavailable
  }
  var depth = 1
  var block: String?
  var path: String?
  var program: String?
  var state: String?
  var type: String?
  var pidSeen = false
  var arguments: [String] = []
  var blocks = Set<String>()
  let critical = Set(["path", "program", "state", "type", "pid", "arguments"])
  for (offset, line) in lines.dropFirst().dropLast().enumerated() {
    guard line.utf8.count <= 4 * 1024 else { throw LifecycleFailure.unavailable }
    let tabs = line.prefix(while: { $0 == "\t" }).count
    let content = String(line.dropFirst(tabs))
    if content.isEmpty { continue }
    if content == "}" {
      guard tabs == depth - 1, depth > 1 else { throw LifecycleFailure.unavailable }
      depth -= 1
      if depth == 1 { block = nil }
      continue
    }
    guard tabs == depth else { throw LifecycleFailure.unavailable }
    if depth > 1 {
      if let separator = content.range(of: " = ") {
        let nestedKey = String(content[..<separator.lowerBound])
        let nestedField = String(content[separator.upperBound...])
        // launchctl may report coalition metadata with its own type/state fields.
        // They are data at depth two, never the service's top-level authority fields.
        let coalitionField =
          depth == 2 && (block == "resource coalition" || block == "jetsam coalition")
          && (nestedKey == "type" || nestedKey == "state") && nestedField != "{"
        if critical.contains(nestedKey) && !coalitionField { throw LifecycleFailure.unavailable }
        if nestedField == "{" {
          depth += 1
          guard depth <= 4 else { throw LifecycleFailure.unavailable }
          continue
        }
      }
      if block == "arguments" { arguments.append(content) }
      continue
    }
    guard let separator = content.range(of: " = ") else { throw LifecycleFailure.unavailable }
    let key = String(content[..<separator.lowerBound])
    let field = String(content[separator.upperBound...])
    guard !key.isEmpty, key.utf8.count <= 128 else { throw LifecycleFailure.unavailable }
    if field == "{" {
      guard blocks.insert(key).inserted else { throw LifecycleFailure.unavailable }
      block = key
      depth += 1
      guard depth <= 4 else { throw LifecycleFailure.unavailable }
      continue
    }
    switch key {
    case "path":
      guard path == nil else { throw LifecycleFailure.unavailable }
      path = field
    case "program":
      guard program == nil else { throw LifecycleFailure.unavailable }
      program = field
    case "state":
      guard state == nil else { throw LifecycleFailure.unavailable }
      state = field
    case "type":
      guard type == nil else { throw LifecycleFailure.unavailable }
      type = field
    case "pid":
      guard !pidSeen, let pid = Int(field), pid > 0 else { throw LifecycleFailure.unavailable }
      pidSeen = true
    default: break
    }
    _ = offset
  }
  guard depth == 1, let path, path.hasPrefix("/"), path.utf8.count <= 1_024,
    let program, program.hasPrefix("/"), program.utf8.count <= 1_024,
    type == "LaunchAgent", let state, ["running", "waiting", "spawn scheduled"].contains(state),
    arguments.count == 2
  else { throw LifecycleFailure.unavailable }
  let selectedDefinition =
    path == selected.plistPath && program == selected.executablePath
    && arguments == [selected.executablePath, "--launch-agent"]
  return LaunchObservation(
    loaded: true, selectedPath: selectedDefinition, running: state == "running",
    enabled: !isDisabled)
}

private func emitStatus(_ role: String, selected: LifecycleSelectedRole?, value: LaunchObservation?)
{
  var object: [String: Any] = ["role": role, "selected": selected != nil]
  if let selected { object["releaseID"] = selected.releaseID }
  if let value {
    object["enabled"] = value.enabled
    object["state"] = value.loaded ? (value.running ? "running" : "waiting") : "stopped"
    object["loadedFromSelectedPlist"] = value.loaded && value.selectedPath
  } else {
    object["state"] = selected == nil ? "unselected" : "unavailable"
  }
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

private func emitRecoveryStatus(_ value: LifecycleSelectionRecovery) {
  let object: [String: Any] = [
    "details": value.details,
    "reason": value.reason,
    "role": value.role,
    "status": "recovery_required",
    "version": 1,
  ]
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

private func restoreDisabledAfterUnstartedEnable(
  executable: String, uid: uid_t, selected: LifecycleSelectedRole, prior: LaunchObservation
) -> Bool {
  let target = "gui/\(uid)/\(selected.label)"
  do {
    let result = try runLaunchctl(executable, ["disable", target], timeout: 20)
    guard !result.timedOut, result.code == 0 else { return false }
    let restored = try observation(executable: executable, uid: uid, selected: selected)
    return !restored.enabled && restored.loaded == prior.loaded
      && (!restored.loaded || restored.selectedPath)
  } catch {
    return false
  }
}

func runLifecycleCommand(_ input: [String]) throws -> Never {
  var args = input
  let command = args.removeFirst()
  var testHome: String?
  var executable = "/bin/launchctl"
  #if ELLIE_INSTALLER_TESTING
    if let index = args.firstIndex(of: "--test-home-root"), index + 1 < args.count {
      testHome = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
    if let index = args.firstIndex(of: "--test-launchctl"), index + 1 < args.count {
      executable = args[index + 1]
      args.removeSubrange(index...index + 1)
    }
  #endif
  guard ["status", "start", "stop"].contains(command), args.count == 1 else {
    throw LifecycleFailure.rejected
  }
  let requested = args[0]
  let roles = requested == "all" && command == "status" ? ["coordinator", "node"] : [requested]
  guard roles.allSatisfy({ $0 == "coordinator" || $0 == "node" }) else {
    throw LifecycleFailure.rejected
  }
  for role in roles {
    do {
      try withLifecycleSelection(
        role: role, testHome: testHome, exclusive: command != "status",
        diagnostics: command == "status"
      ) {
        selected, revalidate in
        guard let selected else {
          if command == "status" {
            emitStatus(role, selected: nil, value: nil)
            return
          }
          throw LifecycleFailure.rejected
        }
        let initial = try observation(executable: executable, uid: getuid(), selected: selected)
        if command == "status" {
          emitStatus(role, selected: selected, value: initial)
          return
        }
        if initial.loaded && !initial.selectedPath { throw LifecycleFailure.unmanaged }
        try revalidate()
        let target = "gui/\(getuid())/\(selected.label)"
        if command == "start" {
          var enableConfirmed = false
          if !initial.enabled {
            let enabled: LaunchResult
            do { enabled = try runLaunchctl(executable, ["enable", target], timeout: 20) } catch {
              throw LifecycleFailure.enableUnknown
            }
            guard !enabled.timedOut, enabled.code == 0 else { throw LifecycleFailure.enableUnknown }
            enableConfirmed = true
          }
          if initial.loaded {
            if enableConfirmed {
              do {
                let afterEnable = try observation(
                  executable: executable, uid: getuid(), selected: selected)
                try revalidate()
                guard afterEnable.loaded, afterEnable.selectedPath, afterEnable.enabled else {
                  throw LifecycleFailure.partialEnable
                }
                emitStatus(role, selected: selected, value: afterEnable)
              } catch {
                if restoreDisabledAfterUnstartedEnable(
                  executable: executable, uid: getuid(), selected: selected, prior: initial)
                {
                  throw LifecycleFailure.enableRolledBack
                }
                throw LifecycleFailure.partialEnable
              }
            } else {
              emitStatus(role, selected: selected, value: initial)
            }
            return
          }
          do {
            try revalidate()
            let before = try observation(executable: executable, uid: getuid(), selected: selected)
            guard !before.loaded else {
              if before.selectedPath, before.enabled {
                emitStatus(role, selected: selected, value: before)
                return
              }
              throw LifecycleFailure.unmanaged
            }
            try revalidate()
          } catch {
            if enableConfirmed {
              if restoreDisabledAfterUnstartedEnable(
                executable: executable, uid: getuid(), selected: selected, prior: initial)
              {
                throw LifecycleFailure.enableRolledBack
              }
              throw LifecycleFailure.partialEnable
            }
            throw error
          }
          do {
            let result = try runLaunchctl(
              executable, ["bootstrap", "gui/\(getuid())", selected.plistPath], timeout: 20)
            guard !result.timedOut, result.code == 0 else { throw LifecycleFailure.startUnknown }
            let after = try observation(executable: executable, uid: getuid(), selected: selected)
            try revalidate()
            guard after.loaded, after.selectedPath, after.enabled else {
              throw LifecycleFailure.startUnknown
            }
            emitStatus(role, selected: selected, value: after)
          } catch { throw LifecycleFailure.startUnknown }
        } else {
          let disabled: LaunchResult
          do { disabled = try runLaunchctl(executable, ["disable", target], timeout: 20) } catch {
            throw LifecycleFailure.disableUnknown
          }
          guard !disabled.timedOut, disabled.code == 0 else {
            throw LifecycleFailure.disableUnknown
          }
          if !initial.loaded {
            do {
              let afterDisable = try observation(
                executable: executable, uid: getuid(), selected: selected)
              try revalidate()
              guard !afterDisable.loaded, !afterDisable.enabled else {
                throw LifecycleFailure.partialDisable
              }
              emitStatus(role, selected: selected, value: afterDisable)
            } catch { throw LifecycleFailure.partialDisable }
            return
          }
          do {
            try revalidate()
            let before = try observation(executable: executable, uid: getuid(), selected: selected)
            guard before.loaded, before.selectedPath else {
              if before.loaded { throw LifecycleFailure.partialDisable }
              guard !before.enabled else { throw LifecycleFailure.partialDisable }
              try revalidate()
              emitStatus(role, selected: selected, value: before)
              return
            }
            try revalidate()
          } catch {
            throw LifecycleFailure.partialDisable
          }
          do {
            let result = try runLaunchctl(
              executable, ["bootout", "gui/\(getuid())", selected.plistPath], timeout: 20)
            guard !result.timedOut, result.code == 0 else { throw LifecycleFailure.stopUnknown }
            let after = try observation(executable: executable, uid: getuid(), selected: selected)
            try revalidate()
            guard !after.loaded, !after.enabled else { throw LifecycleFailure.stopUnknown }
            emitStatus(role, selected: selected, value: after)
          } catch { throw LifecycleFailure.stopUnknown }
        }
      }
    } catch let error as LifecycleFailure { throw error } catch let error
      as LifecycleSelectionRecovery
    {
      if command == "status" { emitRecoveryStatus(error) }
      throw LifecycleFailure.recoveryRequired
    } catch let error
      as MigrationSwitchPendingFailure
    {
      if command == "status" {
        emitRecoveryStatus(
          LifecycleSelectionRecovery(
            role: role, reason: "journal_pending", details: ["migration"]))
      }
      throw error
    } catch is LifecycleSelectionBusy {
      throw LifecycleFailure.busy
    } catch {
      if command == "status" {
        emitRecoveryStatus(
          LifecycleSelectionRecovery(
            role: role, reason: "selection_mismatch", details: ["unclassified"]))
      }
      throw LifecycleFailure.recoveryRequired
    }
  }
  exit(0)
}

func failLifecycleCommand(_ error: Error) -> Never { lifecycleFail(error) }
