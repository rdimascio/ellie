import { nativePairingQr } from "../packages/protocol/src/native-pairing-qr.ts";
import { NATIVE_SESSION_CONTRACT } from "../packages/protocol/src/native-session-contract.ts";

export function nativePairingFixtures() {
  const referenceTime = 1_893_456_000_000;
  const payload = {
    version: 1 as const,
    origin: "https://coordinator.example:8444",
    certificateSha256: "a".repeat(64),
    invitation: "b".repeat(64),
    expiresAt: referenceTime + NATIVE_SESSION_CONTRACT.invitationLifetimeMs,
    label: "Test iPhone",
    grants: [{ target: "synthetic-mac", capabilities: ["app.open" as const] }],
  };
  const valid = [
    { name: "ascii", payload },
    { name: "unicode-and-escaping", payload: { ...payload, label: 'Kitchen "One" \\ 🏡 café' } },
    { name: "ipv6-origin", payload: { ...payload, origin: "https://[2001:db8::1]:8444" } },
    { name: "ipv4-origin", payload: { ...payload, origin: "https://127.0.0.1:8444" } },
    { name: "idna-origin", payload: { ...payload, origin: "https://xn--caf-dma.example" } },
    { name: "hex-like-dns-origin", payload: { ...payload, origin: "https://abc123:8444" } },
  ].map((entry) => ({ ...entry, qr: nativePairingQr(entry.payload) }));
  const raw = (value: unknown) =>
    `ellie-native:v1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
  const invalid = [
    { name: "unknown-field", qr: raw({ ...payload, extra: true }) },
    { name: "http-origin", qr: raw({ ...payload, origin: "http://coordinator.example" }) },
    {
      name: "origin-credentials",
      qr: raw({ ...payload, origin: "https://user@coordinator.example" }),
    },
    { name: "origin-path", qr: raw({ ...payload, origin: "https://coordinator.example/extra" }) },
    {
      name: "origin-trailing-slash",
      qr: raw({ ...payload, origin: "https://coordinator.example/" }),
    },
    ...[
      ["origin-default-port", "https://coordinator.example:443"],
      ["origin-uppercase-host", "https://Coordinator.example:8444"],
      ["origin-uppercase-scheme", "HTTPS://coordinator.example:8444"],
      ["origin-short-ipv4", "https://127.1:8444"],
      ["origin-integer-ipv4", "https://2130706433:8444"],
      ["origin-hex-ipv4", "https://0x7f000001:8444"],
      ["origin-zero-padded-ipv4", "https://127.000.000.001:8444"],
      ["origin-invalid-numeric-domain", "https://coordinator.123:8444"],
      ["origin-expanded-ipv6", "https://[2001:db8:0:0:0:0:0:1]:8444"],
      ["origin-uppercase-ipv6", "https://[2001:DB8::1]:8444"],
      ["origin-unicode-host", "https://café.example"],
      ["origin-encoded-host", "https://%63oordinator.example:8444"],
    ].map(([name, origin]) => ({ name: name!, qr: raw({ ...payload, origin }) })),
    { name: "uppercase-pin", qr: raw({ ...payload, certificateSha256: "A".repeat(64) }) },
    { name: "control-label", qr: raw({ ...payload, label: "Phone\nName" }) },
    { name: "blank-label", qr: raw({ ...payload, label: " " }) },
    { name: "label-leading-space", qr: raw({ ...payload, label: " Phone" }) },
    { name: "label-too-long", qr: raw({ ...payload, label: "x".repeat(65) }) },
    { name: "label-format-character", qr: raw({ ...payload, label: "Phone\u200b" }) },
    { name: "label-private-use", qr: raw({ ...payload, label: "Phone\ue000" }) },
    { name: "label-too-many-code-points", qr: raw({ ...payload, label: "e\u0301".repeat(33) }) },
    {
      name: "duplicate-target",
      qr: raw({ ...payload, grants: [...payload.grants, ...payload.grants] }),
    },
    {
      name: "unsupported-capability",
      qr: raw({
        ...payload,
        grants: [{ target: "synthetic-mac", capabilities: ["window.place"] }],
      }),
    },
    { name: "fractional-expiry", qr: raw({ ...payload, expiresAt: 1.5 }) },
    { name: "unsafe-integer-expiry", qr: raw({ ...payload, expiresAt: 9_007_199_254_740_992 }) },
    {
      name: "noncanonical-key-order",
      qr: raw(Object.fromEntries(Object.entries(payload).reverse())),
    },
    { name: "base64-padding", qr: valid[0]!.qr + "=" },
    // The ASCII fixture has two unused low bits in its final base64 digit.
    { name: "base64-nonzero-unused-bits", qr: valid[0]!.qr.slice(0, -1) + "1" },
    { name: "envelope-too-large", qr: "ellie-native:v1:" + "a".repeat(2300) },
    { name: "browser-qr", qr: "ellie-pair:v1:" + "b".repeat(64) },
  ];
  const client = {
    id: "synthetic-native-client",
    role: "native_phone_controller",
    label: payload.label,
    grants: payload.grants,
    createdAt: referenceTime,
    expiresAt: referenceTime + NATIVE_SESSION_CONTRACT.sessionLifetimeMs,
  };
  return {
    version: 1,
    referenceTime,
    valid,
    invalid,
    responses: { client, pair: { client }, session: { client }, logout: { ok: true } },
  };
}
