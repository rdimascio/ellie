# Browser session foundation

Ellie's browser authorization state and an optional HTTPS listener factory are implemented as
isolated foundations. They are not connected to a live service, UI, CLI command, certificate
installer, node credential, or desktop operation yet. The next slice must supply a trusted local
HTTPS identity and explicitly start the listener before any browser can connect.

## State and roles

Browser authorization uses a separate versioned `~/.ellie/browser-auth.json` file. Existing
`auth.json`, coordinator and node configuration, pinned certificates, and Keychain accounts are not
read or changed by this module. The private browser file contains only SHA-256 credential verifiers,
server-generated IDs, roles, private device labels, grants, and lifecycle timestamps. Raw invitation
codes and session tokens are never persisted.

The browser state file must be a regular, single-link file owned by the current user with mode
`0600`. Its directory must be a real directory owned by the current user with mode `0700`. Reads are
limited to 1 MiB and reject symbolic links, hard links, other file types, invalid UTF-8, malformed or
unsupported schemas, and unexpected ownership or permissions. Writes validate the same boundary,
create a `0600` temporary file with exclusive creation, fsync its contents, atomically rename it over
the checked state file, and fsync the parent directory. Temporary files are removed after failures
when possible.

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
also become visible only after that state update succeeds. A save can fail after the rename has
already taken effect, so any reported save failure permanently disables authentication and mutation
on that in-memory `BrowserAuth` instance. The coordinator must reopen and revalidate the file before
continuing.

`BrowserAuth` deliberately has no cross-process lock. The future coordinator process must be its only
writer and must own it under the coordinator's existing lifetime lock. CLI management must go
through authenticated coordinator routes instead of opening the file as a second writer. Parallel
file writers and last-write-wins reconciliation are outside this design.

## HTTPS listener boundary

The foundation provides a cookie formatter, a pure request-boundary guard, and
`createBrowserServer({ key, cert, origin, auth })`. The factory validates one canonical HTTPS origin
when it is created and returns `{ server, shutdown }`; it does not open a socket, persist or close
the injected authorization state, or change the existing agent listener. Its future owner must
explicitly call `server.listen(...)` while holding the coordinator lifetime lock and call
`shutdown()` during service teardown.

The session cookie is named `__Host-ellie-session` and always carries `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/`, and the fixed session lifetime. It has no `Domain` attribute. Browsers
still share cookies across ports on the same host, including cookies with the `__Host-` prefix. The
existing agent listener must therefore continue to ignore cookie credentials and require its Bearer
credential, while the future browser listener must never accept an agent Bearer credential.

The browser listener requires its Host header to exactly match the configured host and port. Every
supplied Origin must exactly match that origin, and every method other than GET or HEAD must supply
the matching Origin. Duplicate Host, Origin, and Authorization fields are rejected, and every
Authorization header is rejected so an agent Bearer credential cannot cross into the cookie-auth
boundary. Mutations accept only JSON bodies up to 4 KiB. The listener emits no cross-origin
credential policy and adds `Cache-Control: no-store`, a same-origin resource policy, frame denial,
content-type sniffing protection, no referrer, and a restrictive content security policy to every
application response.

The initial API has four routes:

- `GET /browser/v1/health` returns `{ "ok": true }` without household or identity data.
- `POST /browser/v1/pair` accepts only `{ "code": "..." }`, consumes the invitation through the
  injected single writer, sets the strict session cookie, and returns only the new public client.
- `GET /browser/v1/session` returns only the authenticated client's public identity and grants.
- `POST /browser/v1/logout` accepts `{}`, durably removes the session, and clears the cookie.

Errors use fixed JSON messages and do not include request values, credentials, file paths, URLs, or
internal exceptions. Unknown routes return 404. Invalid headers or bodies return 400, origin and
Authorization failures return 403, non-JSON mutations return 415, missing sessions return 401, and
authorization-state failures return 503. The listener supports TLS 1.2 or newer, caps headers at
8 KiB, caps concurrent connections at 32, caps requests per socket at 100, and bounds the TLS
handshake, headers, request, keep-alive, and inactive socket phases to between 5 and 10 seconds.

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

Automated tests use only in-memory state and synthetic private directories. They exercise fsynced
publication through temporary files and reject unsafe synthetic paths. Listener tests open only a
loopback socket with a short-lived synthetic CA that the Node test client trusts explicitly. They
cover TLS hostname validation, origin and header rejection, JSON limits, role escalation, invitation
replay, session projection, revocation, logout, static error redaction, and the configured connection
and timeout bounds. Tests do not write to `~/.ellie`, access Keychain, install a certificate, contact
a phone or TV, or execute a desktop action. Trusted HTTPS and session behavior in Safari and a target
TV browser remain physical acceptance checks for later slices.
