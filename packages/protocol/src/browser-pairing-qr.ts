const BROWSER_PAIRING_CODE = /^[a-f0-9]{64}$/;
const BROWSER_PAIRING_QR_PREFIX = "ellie-pair:v1:";

export function browserPairingQr(code: string): string {
  if (!BROWSER_PAIRING_CODE.test(code)) throw new Error("Invalid browser pairing code.");
  return `${BROWSER_PAIRING_QR_PREFIX}${code}`;
}

export function parseBrowserPairingQr(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(BROWSER_PAIRING_QR_PREFIX)) return undefined;
  const code = value.slice(BROWSER_PAIRING_QR_PREFIX.length);
  return BROWSER_PAIRING_CODE.test(code) ? code : undefined;
}
