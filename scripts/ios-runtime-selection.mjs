const maximumRuntimes = 64;
const versionPattern = /^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})(?:\.(0|[1-9][0-9]{0,2}))?$/;

export function parseAppleVersion(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 11) {
    throw new Error("Apple platform version is invalid.");
  }
  const match = versionPattern.exec(value);
  if (!match) throw new Error("Apple platform version is invalid.");
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function selectCompatibleIOSRuntime(runtimes, sdkVersion) {
  if (!Array.isArray(runtimes) || runtimes.length > maximumRuntimes) {
    throw new Error("Simulator runtime inventory is invalid.");
  }
  const sdk = parseAppleVersion(sdkVersion);
  const compatible = [];
  for (const runtime of runtimes) {
    if (
      !runtime ||
      typeof runtime !== "object" ||
      typeof runtime.identifier !== "string" ||
      !runtime.identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-")
    ) {
      continue;
    }
    if (runtime.isAvailable !== true) continue;
    const version = parseAppleVersion(runtime.version);
    if (version[0] >= 17 && compareVersions(version, sdk) <= 0) {
      compatible.push({ runtime, version });
    }
  }
  compatible.sort((left, right) => compareVersions(right.version, left.version));
  if (!compatible[0]) {
    throw new Error(
      "No installed iOS Simulator runtime is compatible with the selected Xcode SDK.",
    );
  }
  return compatible[0].runtime;
}
