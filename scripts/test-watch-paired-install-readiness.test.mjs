import assert from "node:assert/strict";
import { test } from "node:test";
import {
  requireEmptyPairs,
  requireInstalledWatchInfo,
  requireOnlyOwnedPair,
  requireOwnedPairAbsent,
  requireOwnedActivePair,
} from "./watch-paired-install-readiness.mjs";

const pair = "11111111-1111-1111-1111-111111111111";
const watch = "22222222-2222-2222-2222-222222222222";
const phone = "33333333-3333-3333-3333-333333333333";
const text = (state = "active, connected", watchID = watch) =>
  `== Device Pairs ==\n${pair} (${state})\n    Watch: Fixture Watch (${watchID}) (Booted)\n    Phone: Fixture Phone (${phone}) (Booted)\n`;

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
