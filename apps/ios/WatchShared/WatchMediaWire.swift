import Foundation

enum WatchMediaOperation: String { case read, play, pause }
enum WatchMediaState: String { case observed, unknown, unavailable, blocked, stale }

struct WatchMediaRequest {
  // Read-only observation tolerates cold delivery; mutations keep the shorter authority window.
  static let readLifetimeMilliseconds: Int64 = 20_000
  static let mutationLifetimeMilliseconds: Int64 = 10_000
  static func lifetimeMilliseconds(for operation: WatchMediaOperation) -> Int64 {
    operation == .read ? readLifetimeMilliseconds : mutationLifetimeMilliseconds
  }
  let id: String
  let operation: WatchMediaOperation
  let expiresAt: Int64
  let target: String?
  let epoch: String?
  let revision: String?

  static func make(
    _ operation: WatchMediaOperation, target: String? = nil, epoch: String? = nil,
    revision: String? = nil, now: Int64 = WatchMediaWire.now()
  ) -> Self {
    Self(
      id: UUID().uuidString.lowercased(), operation: operation,
      expiresAt: now + lifetimeMilliseconds(for: operation),
      target: target, epoch: epoch, revision: revision)
  }

  var message: [String: Any] {
    var value: [String: Any] = [
      "version": 1, "id": id, "operation": operation.rawValue, "expiresAt": expiresAt,
    ]
    if let target { value["target"] = target }
    if let epoch { value["epoch"] = epoch }
    if let revision { value["revision"] = revision }
    return value
  }

  static func decode(_ value: [String: Any], now: Int64 = WatchMediaWire.now()) -> Self? {
    guard let version = value["version"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
      let id = value["id"] as? String, WatchMediaWire.validUUID(id),
      let operationValue = value["operation"] as? String,
      let operation = WatchMediaOperation(rawValue: operationValue),
      let expiry = value["expiresAt"] as? NSNumber,
      CFGetTypeID(expiry) != CFBooleanGetTypeID(),
      expiry.doubleValue.rounded() == expiry.doubleValue,
      expiry.doubleValue > Double(now),
      expiry.doubleValue <= Double(now + lifetimeMilliseconds(for: operation)),
      expiry.int64Value > now,
      expiry.int64Value <= now + lifetimeMilliseconds(for: operation)
    else { return nil }
    switch operation {
    case .read:
      guard Set(value.keys) == Set(["version", "id", "operation", "expiresAt"]) else {
        return nil
      }
      return Self(id: id, operation: operation, expiresAt: expiry.int64Value,
                  target: nil, epoch: nil, revision: nil)
    case .play, .pause:
      guard Set(value.keys) == Set(["version", "id", "operation", "expiresAt", "target", "epoch", "revision"]),
        let target = value["target"] as? String, WatchMediaWire.validIdentifier(target),
        let epoch = value["epoch"] as? String, WatchMediaWire.validUUID(epoch),
        let revision = value["revision"] as? String, WatchMediaWire.validIdentifier(revision)
      else { return nil }
      return Self(id: id, operation: operation, expiresAt: expiry.int64Value,
                  target: target, epoch: epoch, revision: revision)
    }
  }
}

struct WatchMediaObservation {
  let target: String
  let targetLabel: String
  let epoch: String
  let revision: String
  let title: String?
  let playback: String
}

struct WatchMediaReply {
  let id: String
  let state: WatchMediaState
  let observation: WatchMediaObservation?

  var message: [String: Any] {
    var value: [String: Any] = ["version": 1, "id": id, "state": state.rawValue]
    if let observation {
      value["target"] = observation.target
      value["targetLabel"] = observation.targetLabel
      value["epoch"] = observation.epoch
      value["revision"] = observation.revision
      value["playback"] = observation.playback
      if let title = observation.title { value["title"] = title }
    }
    return value
  }

  static func decode(_ value: [String: Any], expectedID: String) -> Self? {
    guard let version = value["version"] as? NSNumber,
      CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
      let id = value["id"] as? String, id == expectedID,
      let stateValue = value["state"] as? String,
      let state = WatchMediaState(rawValue: stateValue)
    else { return nil }
    if state != .observed {
      guard Set(value.keys) == Set(["version", "id", "state"]) else { return nil }
      return Self(id: id, state: state, observation: nil)
    }
    let keys = Set(value.keys)
    guard keys == Set(["version", "id", "state", "target", "targetLabel", "epoch", "revision", "playback"])
        || keys == Set(["version", "id", "state", "target", "targetLabel", "epoch", "revision", "playback", "title"]),
      let target = value["target"] as? String, WatchMediaWire.validIdentifier(target),
      let label = value["targetLabel"] as? String, WatchMediaWire.validText(label, maximum: 100),
      let epoch = value["epoch"] as? String, WatchMediaWire.validUUID(epoch),
      let revision = value["revision"] as? String, WatchMediaWire.validIdentifier(revision),
      let playback = value["playback"] as? String,
      ["playing", "paused", "unavailable"].contains(playback),
      value["title"] == nil || (value["title"] as? String).map({ WatchMediaWire.validText($0, maximum: 500) }) == true
    else { return nil }
    return Self(id: id, state: state,
                observation: WatchMediaObservation(target: target, targetLabel: label,
                  epoch: epoch, revision: revision, title: value["title"] as? String,
                  playback: playback))
  }
}

enum WatchMediaWire {
  static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1_000) }
  static func validUUID(_ value: String) -> Bool {
    value.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                options: .regularExpression) != nil
  }
  static func validIdentifier(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$", options: .regularExpression) != nil
  }
  static func validText(_ value: String, maximum: Int) -> Bool {
    !value.isEmpty && value.utf8.count <= maximum
      && !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
  }
}
