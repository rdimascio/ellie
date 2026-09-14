import { browserPairingQr } from "@ellie/protocol";
import QRCode from "qrcode";

export async function terminalBrowserPairingQr(code: string): Promise<string> {
  return terminalPairingQr(browserPairingQr(code));
}

export async function terminalPairingQr(payload: string): Promise<string> {
  const modules = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const margin = 4;
  const width = modules.size + margin * 2;
  const rows: string[] = [];
  const pixel = (row: number, column: number) =>
    row >= margin &&
    row < modules.size + margin &&
    column >= margin &&
    column < modules.size + margin &&
    modules.data[(row - margin) * modules.size + column - margin];
  for (let row = 0; row < width; row += 2) {
    let line = "\x1b[47m\x1b[30m";
    for (let column = 0; column < width; column++) {
      const top = pixel(row, column);
      const bottom = pixel(row + 1, column);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    rows.push(`${line}\x1b[0m`);
  }
  return rows.join("\n");
}
