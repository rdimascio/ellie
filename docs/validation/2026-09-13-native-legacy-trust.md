# Existing coordinator certificate compatibility — 2026-09-13

The native preview rejected an existing coordinator identity even though the served certificate exactly matched the saved pin and was currently valid. The original CLI generator emits an extension-free, self-signed X.509 v1 certificate with only `CN=ellie.local`. On macOS 15.1, Apple's named SSL policy rejects that certificate for hostname and server-authentication EKU checks. The previously used synthetic native fixture included SAN and EKU extensions, so it did not reproduce the installed identity.

The native Mac client now tries the existing named SSL policy first. A fallback is restricted to the original certificate profile: extension-free v1, exactly matching issuer and subject containing only `ellie.local`, RSA of at least 2048 bits, and matching SHA-256/RSA signature algorithms. The client cryptographically verifies its self-signature. The existing exact DER pin, validity dates, sole private trust anchor, disabled trust-network fetching, and TLS private-key possession remain required. Modern certificates with an incorrect SAN or EKU do not qualify. No ATS exception, trust-store change, certificate replacement, re-pairing, or credential migration is introduced.

Validation on the MacBook running macOS 15.1 used synthetic identities and owned loopback HTTPS servers:

- The new network regression invokes the current production CLI certificate generator with macOS LibreSSL. It fails with `trustFailed` against pristine candidate `0838a00c` and passes with this patch.
- All 158 Swift/XCTest tests passed, including wrong legacy pins, tampered signatures, not-yet-valid and expired certificates, different names and algorithms, weak keys, and modern SAN/EKU rejection. The real HTTPS rejection tests confirm the server receives no HTTP request.
- `bun run check` passed: 249 Node tests, one platform skip, lint, formatting, generated-contract drift, typechecking, and the command-center production build.
- Independent security review found no blocker in the limited compatibility path.

The installed certificate was inspected read-only: its public DER matched the served identity, and a strict Node TLS probe using the saved pin succeeded. No authenticated request to the household coordinator was made during these diagnostics. The native GUI's connection and an attended desktop action against the real household remain owner acceptance checks for the corrected preview. These results do not establish physical iPhone, microphone, browser-media, or Apple Watch acceptance.
