// Native sessions use the optional client HTTPS listener, never coordinator authority.
export const NATIVE_SESSION_CONTRACT = {
  version: 1,
  requestBodyBytes: 4096,
  invitationLifetimeMs: 600_000,
  sessionLifetimeMs: 7_776_000_000,
  routes: {
    pair: { method: "POST", path: "/native/v1/pair", operationId: "pairNativeClient" },
    session: { method: "GET", path: "/native/v1/session", operationId: "getNativeSession" },
    logout: { method: "POST", path: "/native/v1/logout", operationId: "logoutNativeClient" },
  },
} as const;

export function nativeSessionSchemas() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const identifier = {
    type: "string",
    minLength: 1,
    maxLength: 100,
    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$",
  };
  const secret = {
    type: "string",
    minLength: 64,
    maxLength: 64,
    pattern: "^[a-f0-9]{64}$",
    writeOnly: true,
  };
  const milliseconds = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
  const label = {
    type: "string",
    minLength: 1,
    maxLength: 64,
    pattern: "\\S",
    description:
      "One to 64 Unicode code points, no Unicode control/format/surrogate/private/unassigned characters, and no leading or trailing ECMAScript whitespace. Enforced by the nativeLabel runtime validator.",
    "x-ellie-validator": "nativeLabel",
  };
  const grants = {
    type: "array",
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
    items: ref("NativeGrant"),
    description:
      "Each target is unique. Native phone authority is restricted to app.open on explicitly granted targets.",
    "x-ellie-unique-key": "target",
  };
  return {
    NativeGrant: {
      type: "object",
      additionalProperties: false,
      required: ["target", "capabilities"],
      properties: {
        target: identifier,
        capabilities: { type: "array", minItems: 1, maxItems: 1, items: { const: "app.open" } },
      },
    },
    NativeInvitationSpec: {
      type: "object",
      additionalProperties: false,
      required: ["label", "grants"],
      properties: { label, grants },
    },
    NativeClient: {
      type: "object",
      additionalProperties: false,
      required: ["id", "role", "label", "grants", "createdAt", "expiresAt"],
      properties: {
        id: identifier,
        role: { const: "native_phone_controller" },
        label,
        grants,
        createdAt: milliseconds,
        expiresAt: milliseconds,
      },
      description:
        "Public metadata only. expiresAt minus createdAt is exactly 7,776,000,000 milliseconds (90 days). Expired clients do not authenticate.",
      "x-ellie-lifetime-ms": NATIVE_SESSION_CONTRACT.sessionLifetimeMs,
    },
    NativePairingPayload: {
      type: "object",
      additionalProperties: false,
      required: [
        "version",
        "origin",
        "certificateSha256",
        "invitation",
        "expiresAt",
        "label",
        "grants",
      ],
      properties: {
        version: { const: 1 },
        origin: {
          type: "string",
          format: "uri",
          maxLength: 2048,
          pattern: "^https://[^/?#@]+$",
          description:
            "Exact canonical HTTPS origin, without credentials, path, query or fragment. This identifies the optional client listener, not the coordinator API.",
        },
        certificateSha256: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          minLength: 64,
          maxLength: 64,
          description:
            "SHA-256 of the actual leaf certificate DER, verified along with hostname and validity.",
        },
        invitation: { ...secret, writeOnly: false, "x-ellie-sensitive": true },
        expiresAt: milliseconds,
        label,
        grants,
      },
      description:
        "Single-use bootstrap returned only by controller management. Canonical key order matches this required list. Encode compact ECMAScript JSON as UTF-8, unpadded base64url, prefixed ellie-native:v1:. The complete ASCII envelope is at most 2300 bytes; decoded JSON is at most 4096 bytes. Never place it in a URL, log it or persist the invitation.",
      "x-ellie-qr-max-bytes": 2300,
    },
    NativePairRequest: {
      type: "object",
      additionalProperties: false,
      required: ["invitation", "token"],
      properties: {
        invitation: secret,
        token: {
          ...secret,
          description:
            "Cryptographically random 32-byte candidate chosen by the native client before this single POST. Retain for read-only GET recovery after an uncertain response.",
        },
      },
    },
    NativeSessionResponse: {
      type: "object",
      additionalProperties: false,
      required: ["client"],
      properties: { client: ref("NativeClient") },
    },
    NativeLogoutRequest: { type: "object", additionalProperties: false, maxProperties: 0 },
    NativeLogoutResponse: {
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { const: true } },
    },
    NativeError: {
      type: "object",
      additionalProperties: false,
      required: ["error"],
      properties: { error: { type: "string" } },
      description:
        "A fixed, redacted server error. Clients display their own state-appropriate text, not raw error content.",
    },
  };
}
