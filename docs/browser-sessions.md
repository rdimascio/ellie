# Browser session foundation

Ellie's browser authorization state is implemented as an isolated foundation. It is not connected
to a network listener, UI, CLI command, certificate, node credential, or desktop operation yet.
The next slice must establish trusted local HTTPS and wire only the bootstrap routes before any
household data or actions become available.

## State and roles

Browser authorization uses a separate versioned `~/.ellie/browser-auth.json` file. Existing
`auth.json`, coordinator and node configuration, pinned certificates, and Keychain accounts are not
read or changed by this module. The private browser file contains only SHA-256 credential verifiers,
server-generated IDs, roles, private device labels, grants, and lifecycle timestamps. Raw invitation
codes and session tokens are never persisted.

An invitation fixes all authority before it is issued:

- `phone_controller` requires one or more explicit target and capability grants. A browser pairing
  request cannot add, replace, or widen them.
- `tv_viewer` requires an empty grant list. Session management is its only mutation; future TV data
  routes must remain read-only and return a privacy-safe projection.

Labels are private metadata, limited to 64 printable Unicode code points, and have no security or
device-attestation meaning. Targets use Ellie's existing identifier rules. Capabilities must come
from the operation registry, cannot be empty within a grant, and cannot be duplicated. Each target
can appear only once.

Invitations and sessions use independent random 256-bit bearer values. Invitations expire after 10
minutes and sessions after 14 days; the exact expiry instant is no longer valid. At most 32 active
invitations and 128 active sessions are accepted. Expired records are pruned on successful state
mutations. Pairing consumes one invitation and stores the new session verifier in one serialized
mutation. The session token is issued only after that state is durably saved. Revocation and logout
also become visible only after their state update succeeds.

## Future HTTP boundary

The foundation provides a cookie formatter and a pure request-boundary guard for the next listener.
The session cookie is named `__Host-ellie-session` and always carries `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/`, and the fixed session lifetime. It has no `Domain` attribute. Browsers
still share cookies across ports on the same host, including cookies with the `__Host-` prefix. The
existing agent listener must therefore continue to ignore cookie credentials and require its Bearer
credential, while the future browser listener must never accept an agent Bearer credential.

The future browser listener must have one canonical HTTPS origin. Its Host header must exactly match
the configured host and port. Every supplied Origin must exactly match that origin, and every method
other than GET or HEAD must supply the matching Origin. GET and HEAD must remain free of side effects.
The listener should serve its UI and API from that origin, emit no cross-origin credential policy,
and retain bounded JSON bodies, `Cache-Control: no-store`, and restrictive content security headers.

These helpers do not make a LAN origin trustworthy. The next slice needs a separate browser TLS
identity and an optional listener. It must preserve the existing certificate pinned by paired nodes.
Apple documents that a local server certificate needs a matching local-network name or IP Subject
Alternative Name, and that an unmanaged iPhone requires the user to install a root certificate and
explicitly enable full TLS trust. A `.local` hostname has link-local meaning and can change after a
Bonjour name conflict, so initialization must persist the selected origin and diagnostics must flag
hostname drift instead of silently changing it.

Relevant platform specifications:

- [Apple: Creating an Identity for Local Network TLS](https://developer.apple.com/documentation/Network/creating-an-identity-for-local-network-tls)
- [Apple: Trust manually installed certificate profiles](https://support.apple.com/en-au/102390)
- [Apple: Local hostnames and Bonjour](https://support.apple.com/en-ie/guide/mac-help/mchlp2322/mac)
- [Apple: Requirements for trusted TLS certificates](https://support.apple.com/en-hk/103769)
- [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/)
- [WHATWG Fetch Standard](https://fetch.spec.whatwg.org/)
- [RFC 10025: Cookies](https://auth48-transition.rfc-editor.org/authors/rfc10025.html)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/info/rfc9110/)

Automated tests use only in-memory state and synthetic private directories. They do not start a
listener, write to `~/.ellie`, access Keychain, install a certificate, contact a phone or TV, or
execute a desktop action. Trusted HTTPS and session behavior in Safari and a target TV browser remain
physical acceptance checks for later slices.
