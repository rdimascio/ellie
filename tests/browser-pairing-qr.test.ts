import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { browserPairingQr, parseBrowserPairingQr } from "@ellie/protocol";
import QRCode from "qrcode";
import { terminalBrowserPairingQr } from "../apps/cli/src/browser-qr.ts";

const jsQR = createRequire(import.meta.url)("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: { inversionAttempts: "dontInvert" },
) => { data: string } | null;

test("browser pairing QR envelope round trips an exact lowercase 256-bit code", () => {
  const code = "0123456789abcdef".repeat(4);
  const payload = browserPairingQr(code);
  assert.equal(payload, `ellie-pair:v1:${code}`);
  assert.equal(parseBrowserPairingQr(payload), code);
});

test("qrcode produces a scan-decodable pairing envelope with a quiet zone", () => {
  const code = "abcdef0123456789".repeat(4);
  const payload = browserPairingQr(code);
  const matrix = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const scale = 4;
  const margin = 4;
  const width = (matrix.size + margin * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4);
  pixels.fill(255);

  for (let row = 0; row < matrix.size; row++) {
    for (let column = 0; column < matrix.size; column++) {
      if (!matrix.data[row * matrix.size + column]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const pixel = ((row + margin) * scale + y) * width + (column + margin) * scale + x;
          pixels[pixel * 4] = 0;
          pixels[pixel * 4 + 1] = 0;
          pixels[pixel * 4 + 2] = 0;
        }
      }
    }
  }

  const decoded = jsQR(pixels, width, width, { inversionAttempts: "dontInvert" });
  assert.equal(decoded?.data, payload);
  assert.equal(parseBrowserPairingQr(decoded?.data), code);
});

test("terminal QR output preserves a four-module quiet zone and decodes", async () => {
  const code = "abcdef0123456789".repeat(4);
  const terminal = await terminalBrowserPairingQr(code);
  const prefix = "\u001b[47m\u001b[30m";
  const suffix = "\u001b[0m";
  const lines = terminal.split("\n").map((line) => {
    assert.ok(line.startsWith(prefix));
    assert.ok(line.endsWith(suffix));
    return line.slice(prefix.length, -suffix.length);
  });
  assert.ok(lines.length > 4);
  assert.match(lines[0]!, /^ +$/);
  assert.match(lines[1]!, /^ +$/);
  assert.match(lines.at(-1)!, /^ +$/);
  for (const line of lines) assert.match(line, /^ {4}.* {4}$/);

  const scale = 4;
  const width = lines[0]!.length * scale;
  const height = lines.length * 2 * scale;
  const pixels = new Uint8ClampedArray(width * height * 4);
  pixels.fill(255);
  const dark = (character: string, half: "top" | "bottom") =>
    character === "█" || (half === "top" ? character === "▀" : character === "▄");
  for (let row = 0; row < lines.length; row++) {
    for (let column = 0; column < lines[row]!.length; column++) {
      const character = lines[row]![column]!;
      for (const [half, offset] of [
        ["top", 0],
        ["bottom", 1],
      ] as const) {
        if (!dark(character, half)) continue;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const pixel = ((row * 2 + offset) * scale + y) * width + column * scale + x;
            pixels[pixel * 4] = pixels[pixel * 4 + 1] = pixels[pixel * 4 + 2] = 0;
          }
        }
      }
    }
  }
  const decoded = jsQR(pixels, width, height, { inversionAttempts: "dontInvert" });
  assert.equal(parseBrowserPairingQr(decoded?.data), code);
});

test("browser pairing QR contract rejects malformed codes and envelopes", () => {
  for (const code of [
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    `${"a".repeat(64)}\n`,
  ])
    assert.throws(() => browserPairingQr(code), /Invalid browser pairing code/);

  for (const value of [
    undefined,
    null,
    1,
    {},
    "a".repeat(64),
    `ellie-pair:v2:${"a".repeat(64)}`,
    `ellie-pair:v1:${"a".repeat(63)}`,
    `ellie-pair:v1:${"A".repeat(64)}`,
    `ellie-pair:v1:${"a".repeat(64)}:extra`,
  ])
    assert.equal(parseBrowserPairingQr(value), undefined);
});
