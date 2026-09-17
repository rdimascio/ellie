const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const header = /^([0-9a-f-]{36}) \((active|inactive), (connected|disconnected)\)$/i;
const device = /\(([0-9a-f-]{36})\) \((Booted|Shutdown)\)$/i;

export function requireEmptyPairs(inventory) {
  if (
    !inventory ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    !inventory.pairs ||
    typeof inventory.pairs !== "object" ||
    Array.isArray(inventory.pairs) ||
    Object.keys(inventory.pairs).length !== 0
  ) {
    throw new Error(
      "Paired run requires no preexisting Simulator pairs; no active pair will be changed.",
    );
  }
}

export function requireOnlyOwnedPair(inventory, pairID) {
  if (
    typeof pairID !== "string" ||
    !uuid.test(pairID) ||
    !inventory ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    !inventory.pairs ||
    typeof inventory.pairs !== "object" ||
    Array.isArray(inventory.pairs) ||
    Object.keys(inventory.pairs).length !== 1 ||
    !Object.keys(inventory.pairs).some((id) => id.toLowerCase() === pairID.toLowerCase())
  ) {
    throw new Error(
      "Owned Simulator pair is not the only pair; activation would affect another pair.",
    );
  }
}

export function requireOwnedPairAbsent(inventory, pairID) {
  if (
    !inventory ||
    typeof inventory !== "object" ||
    Array.isArray(inventory) ||
    !inventory.pairs ||
    typeof inventory.pairs !== "object" ||
    Array.isArray(inventory.pairs) ||
    (pairID !== undefined &&
      (typeof pairID !== "string" ||
        !uuid.test(pairID) ||
        Object.keys(inventory.pairs).some((id) => id.toLowerCase() === pairID.toLowerCase())))
  ) {
    throw new Error("Owned Simulator pair deletion could not be verified.");
  }
}

export function requireOwnedActivePair(output, pairID, watchID, phoneID) {
  if (![pairID, watchID, phoneID].every((id) => typeof id === "string" && uuid.test(id)))
    throw new Error("Owned Simulator pair identifiers are invalid.");
  const rows = output
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (rows.shift() !== "== Device Pairs ==" || rows.length !== 3)
    throw new Error("Owned Simulator pair inventory is malformed or contains another pair.");
  const pair = header.exec(rows[0]);
  const watch = rows[1].startsWith("Watch: ") ? device.exec(rows[1]) : null;
  const phone = rows[2].startsWith("Phone: ") ? device.exec(rows[2]) : null;
  if (
    !pair ||
    !watch ||
    !phone ||
    !uuid.test(pair[1]) ||
    !uuid.test(watch[1]) ||
    !uuid.test(phone[1]) ||
    pair[1].toLowerCase() !== pairID.toLowerCase() ||
    watch[1].toLowerCase() !== watchID.toLowerCase() ||
    phone[1].toLowerCase() !== phoneID.toLowerCase() ||
    pair[2].toLowerCase() !== "active" ||
    pair[3].toLowerCase() !== "connected" ||
    watch[2].toLowerCase() !== "booted" ||
    phone[2].toLowerCase() !== "booted"
  ) {
    throw new Error("Owned Simulator pair is not the active connected booted phone/Watch pair.");
  }
  return { active: true, connected: true };
}

export function requireInstalledWatchInfo(info, watchBundle, phoneBundle) {
  if (
    !info ||
    typeof info !== "object" ||
    Array.isArray(info) ||
    info.CFBundleIdentifier !== watchBundle ||
    info.WKCompanionAppBundleIdentifier !== phoneBundle ||
    info.WKApplication !== true ||
    info.WKRunsIndependentlyOfCompanionApp !== false
  ) {
    throw new Error(
      "Installed Watch bundle metadata does not identify the expected phone companion.",
    );
  }
}
