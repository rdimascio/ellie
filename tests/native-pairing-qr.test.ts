import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_NATIVE_PAIRING_QR_BYTES,
  nativePairingQr,
  parseNativePairingQr,
} from "@ellie/protocol";
import QRCode from "qrcode";

const payload = {
  version: 1 as const,
  origin: "https://ellie.local:8444",
  certificateSha256: "a".repeat(64),
  invitation: "b".repeat(64),
  expiresAt: 1_000_000,
  label: "Ryan’s iPhone",
  grants: [{ target: "studio-mac", capabilities: ["app.open" as const] }],
};

test("native QR round trips exact trusted origin, pin, invitation and scope", () => {
  const qr = nativePairingQr(payload);
  assert.match(qr, /^ellie-native:v1:/);
  assert.deepEqual(parseNativePairingQr(qr), payload);
});

test("native QR rejects unknown fields, unsafe origins, invalid pins and browser payloads", () => {
  for (const value of [
    { ...payload, extra: true },
    { ...payload, origin: "http://ellie.local:8444" },
    { ...payload, origin: "https://user@ellie.local:8444" },
    { ...payload, certificateSha256: "A".repeat(64) },
    { ...payload, grants: [{ target: "studio-mac", capabilities: ["window.place"] }] },
  ])
    assert.throws(() => nativePairingQr(value));
  assert.equal(parseNativePairingQr(`ellie-pair:v1:${"b".repeat(64)}`), undefined);
  assert.equal(parseNativePairingQr("ellie-native:v1:not+base64"), undefined);
  assert.throws(() =>
    nativePairingQr({
      ...payload,
      origin: `https://${"a".repeat(2000)}`,
      grants: Array.from({ length: 16 }, (_, index) => ({
        target: `${index}${"x".repeat(98)}`,
        capabilities: ["app.open"],
      })),
    }),
  );
});

test("largest accepted native envelope fits the level-M terminal QR renderer", () => {
  const qr = nativePairingQr({
    ...payload,
    label: "x".repeat(64),
    grants: Array.from({ length: 16 }, (_, index) => ({
      target: `${String(index).padStart(2, "0")}${"x".repeat(42)}`,
      capabilities: ["app.open"],
    })),
  });
  assert.ok(qr.length > 2200);
  assert.ok(qr.length <= MAX_NATIVE_PAIRING_QR_BYTES);
  assert.ok(QRCode.create(qr, { errorCorrectionLevel: "M" }).modules.size > 0);
  assert.deepEqual(parseNativePairingQr(qr)?.grants.length, 16);
  assert.equal(
    parseNativePairingQr(`${qr}x`.padEnd(MAX_NATIVE_PAIRING_QR_BYTES + 1, "x")),
    undefined,
  );
});
