# Browser session foundation

Ellie's coordinator can optionally serve a pairing page over a separate browser HTTPS identity.
The page pairs a phone or shared display, confirms its own identity, and disconnects it. Controller
CLI commands issue invitations, inspect connection status, list clients, and revoke sessions.
Household data and desktop operations are not exposed through this listener. Physical phone trust
remains an acceptance gate; see [setup and validation](browser-pairing.md).

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

`BrowserAuth` deliberately has no cross-process lock. The coordinator owns its only writer under
the existing JobStore lifetime lock. CLI management goes through authenticated coordinator routes.
First startup exclusively publishes an empty browser file only when it is absent; existing or
corrupt state is never replaced. Shutdown disables management, closes browser sockets, rejects new
mutations, and drains active persistence before releasing the coordinator lock. Parallel file
writers and last-write-wins reconciliation are outside this design.

## HTTPS listener boundary

The foundation provides a cookie formatter, a pure request-boundary guard, and
`createBrowserServer({ key, cert, origin, auth })`. The factory validates one canonical HTTPS origin
when it is created and returns `{ server, shutdown }`; it does not open a socket, persist or close
the injected authorization state, or change the existing agent listener. The optional browser
runtime owns those lifecycle steps while holding the coordinator lifetime lock. Missing browser
configuration does no browser Keychain, authorization-file, asset, or listener work. Configured
startup failures leave the agent listener running and report a fixed unavailable reason. Slow
identity or asset reads cannot initialize authorization or bind after shutdown; an already pending
Keychain helper read may remain alive until its own bounded timeout or LaunchAgent termination.

The session cookie is named `__Host-ellie-session` and always carries `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/`, and the fixed session lifetime. It has no `Domain` attribute. Browsers
still share cookies across ports on the same host, including cookies with the `__Host-` prefix. The
existing agent listener must therefore continue to ignore cookie credentials and require its Bearer
credential, while the browser listener never accepts an agent Bearer credential.

The browser listener requires its Host header to exactly match the configured host and port. Every
supplied Origin must exactly match that origin, and every method other than GET or HEAD must supply
the matching Origin. Duplicate Host, Origin, and Authorization fields are rejected, and every
Authorization header is rejected so an agent Bearer credential cannot cross into the cookie-auth
boundary. Mutations accept only JSON bodies up to 4 KiB. The listener emits no cross-origin
credential policy and adds `Cache-Control: no-store`, a same-origin resource policy, frame denial,
content-type sniffing protection, no referrer, and a restrictive content security policy to every
application response.

The browser API has four routes:

- `GET /browser/v1/health` returns `{ "ok": true }` without household or identity data.
- `POST /browser/v1/pair` accepts only `{ "code": "..." }`, consumes the invitation through the
  injected single writer, sets the strict session cookie, and returns only the new public client.
- `GET /browser/v1/session` returns only the authenticated client's public identity and grants.
- `POST /browser/v1/logout` accepts `{}`, durably removes the session, and clears the cookie.

The coordinator's agent listener additionally provides controller-only `GET /v1/browser`,
`POST /v1/browser/invitations`, `GET /v1/browser/clients`, and `POST /v1/browser/revoke`.
Node credentials, browser cookies, and requests carrying any Origin cannot use these management
routes. Only the pairing HTML at `/` and its bounded manifest dependency set under `/assets/` are
served by the browser listener. The synthetic dashboard, manifest, arbitrary paths, and private
state are not served. Build files must be regular, single-link, owned by the current user, and not
writable by other users; build directories receive equivalent checks.

Errors use fixed JSON messages and do not include request values, credentials, file paths, URLs, or
internal exceptions. Unknown routes return 404. Invalid headers or bodies return 400, origin and
Authorization failures return 403, non-JSON mutations return 415, missing sessions return 401, and
authorization-state failures return 503. The listener supports TLS 1.2 or newer, caps headers at
8 KiB, caps concurrent connections at 32, caps requests per socket at 100, and bounds the TLS
handshake, headers, request, keep-alive, and inactive socket phases to between 5 and 10 seconds.

These helpers do not make a LAN origin trustworthy. Browser setup creates a separate browser TLS
identity and preserves the existing certificate pinned by paired nodes.
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
