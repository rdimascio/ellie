import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAppleVersion,
  selectCompatibleIOSRuntime,
} from "../scripts/ios-runtime-selection.mjs";

const runtime = (version: string, isAvailable = true) => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`,
  version,
  isAvailable,
  supportedDeviceTypes: [],
});

test("selects the highest installed runtime compatible with the selected SDK", () => {
  assert.equal(
    selectCompatibleIOSRuntime(
      [runtime("17.5"), runtime("26.2"), runtime("18.4"), runtime("18.5")],
      "18.5",
    ).version,
    "18.5",
  );
  assert.equal(
    selectCompatibleIOSRuntime([runtime("17.5"), runtime("18.5")], "18.4").version,
    "17.5",
  );
});

test("rejects malformed versions and an unavailable compatible inventory", () => {
  for (const value of ["18", "18.05", "18.5\n", "18.5.0.1", "v18.5", "1000.1"]) {
    assert.throws(() => parseAppleVersion(value), /version is invalid/);
  }
  assert.throws(
    () => selectCompatibleIOSRuntime([runtime("18.5", false), runtime("26.2")], "18.5"),
    /No installed.*compatible/,
  );
  assert.throws(
    () => selectCompatibleIOSRuntime([runtime("18.next")], "18.5"),
    /version is invalid/,
  );
});
