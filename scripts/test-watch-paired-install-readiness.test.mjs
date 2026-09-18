import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireEmptyPairs,
  requireInstalledWatchInfo,
  requireOnlyOwnedPair,
  requireOwnedPairAbsent,
  requireOwnedActivePair,
  requireOwnedPairState,
  ownedDeviceCleanupState,
} from "./watch-paired-install-readiness.mjs";

const pair = "11111111-1111-1111-1111-111111111111";
const watch = "22222222-2222-2222-2222-222222222222";
const phone = "33333333-3333-3333-3333-333333333333";
const text = (
  state = "active, connected",
  watchID = watch,
  watchState = "Booted",
  phoneState = "Booted",
) =>
  `== Device Pairs ==\n${pair} (${state})\n    Watch: Fixture Watch (${watchID}) (${watchState})\n    Phone: Fixture Phone (${phone}) (${phoneState})\n`;

test("only an empty preflight pair inventory admits owned activation", () => {
  assert.doesNotThrow(() => requireEmptyPairs({ pairs: {} }));
  for (const inventory of [{}, { pairs: [] }, { pairs: { [pair]: {} } }])
    assert.throws(() => requireEmptyPairs(inventory));
  assert.doesNotThrow(() => requireOnlyOwnedPair({ pairs: { [pair]: {} } }, pair));
  for (const inventory of [
    { pairs: {} },
    { pairs: { [phone]: {} } },
    { pairs: { [pair]: {}, [phone]: {} } },
  ])
    assert.throws(() => requireOnlyOwnedPair(inventory, pair));
});

test("final inventory must prove the exact owned pair was removed", () => {
  assert.doesNotThrow(() => requireOwnedPairAbsent({ pairs: {} }, pair));
  assert.doesNotThrow(() => requireOwnedPairAbsent({ pairs: { [phone]: {} } }, pair));
  assert.throws(() => requireOwnedPairAbsent({ pairs: { [pair]: {} } }, pair));
  assert.throws(() => requireOwnedPairAbsent({}, pair));
});

test("paired readiness requires the exact active connected booted owned pair", () => {
  assert.deepEqual(requireOwnedActivePair(text(), pair, watch, phone), {
    active: true,
    connected: true,
  });
  for (const inventory of [
    text("inactive, connected"),
    text("active, disconnected"),
    text("active, connected", phone),
    text() + `${pair} (active, connected)\n`,
    "== Device Pairs ==\n",
  ])
    assert.throws(() => requireOwnedActivePair(inventory, pair, watch, phone));
});

test("already active owned pair skips activation, but inactive exact pair requires it", () => {
  assert.deepEqual(
    requireOwnedPairState(
      text("active, disconnected", watch, "Shutdown", "Shutdown"),
      pair,
      watch,
      phone,
    ),
    {
      active: true,
      connected: false,
      watchState: "Shutdown",
      phoneState: "Shutdown",
    },
  );
  assert.equal(
    requireOwnedPairState(
      text("inactive, disconnected", watch, "Shutdown", "Shutdown"),
      pair,
      watch,
      phone,
    ).active,
    false,
  );
  assert.throws(() =>
    requireOwnedPairState(text("active, disconnected", phone), pair, watch, phone),
  );
  assert.throws(() => requireOwnedPairState(text() + text(), pair, watch, phone));
});

test("owned cleanup skips shutdown only for the exact already Shutdown device", () => {
  const fixture = (state, id = watch, name = "Ellie paired run watch") => ({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-2": [
        { udid: id, name, state, isAvailable: true },
      ],
    },
  });
  const runtime = "com.apple.CoreSimulator.SimRuntime.watchOS-11-2";
  assert.equal(
    ownedDeviceCleanupState(fixture("Shutdown"), watch, runtime, "Ellie paired run watch"),
    "Shutdown",
  );
  assert.equal(
    ownedDeviceCleanupState(fixture("Booted"), watch, runtime, "Ellie paired run watch"),
    "Booted",
  );
  assert.equal(
    ownedDeviceCleanupState(fixture("Shutdown", phone), watch, runtime, "Ellie paired run watch"),
    "absent",
  );
  for (const inventory of [
    fixture("Shutting Down"),
    fixture("Shutdown", watch, "Other Watch"),
    {
      devices: { [runtime]: [{ ...fixture("Shutdown").devices[runtime][0], isAvailable: false }] },
    },
    { devices: { [runtime]: [{ udid: 3 }] } },
    {
      devices: {
        [runtime]: [
          fixture("Shutdown").devices[runtime][0],
          fixture("Shutdown").devices[runtime][0],
        ],
      },
    },
    { devices: { other: fixture("Shutdown").devices[runtime] } },
  ])
    assert.throws(() =>
      ownedDeviceCleanupState(inventory, watch, runtime, "Ellie paired run watch"),
    );
});

test("installed Watch metadata must bind the exact companion", () => {
  const info = {
    CFBundleIdentifier: "org.ellie.dashboard.ios.watchkitapp",
    WKCompanionAppBundleIdentifier: "org.ellie.dashboard.ios",
    WKApplication: true,
    WKRunsIndependentlyOfCompanionApp: false,
  };
  assert.doesNotThrow(() =>
    requireInstalledWatchInfo(info, info.CFBundleIdentifier, info.WKCompanionAppBundleIdentifier),
  );
  for (const changed of [
    { CFBundleIdentifier: "another.watchkitapp" },
    { WKCompanionAppBundleIdentifier: "another.phone" },
    { WKApplication: false },
    { WKRunsIndependentlyOfCompanionApp: true },
  ])
    assert.throws(() =>
      requireInstalledWatchInfo(
        { ...info, ...changed },
        info.CFBundleIdentifier,
        info.WKCompanionAppBundleIdentifier,
      ),
    );
});
