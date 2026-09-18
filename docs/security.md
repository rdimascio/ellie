# Security and private state

## What belongs where

| Data                                                                  | Location                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Public code, generic defaults, synthetic fixtures                     | Git repository                                                    |
| Server bind configuration and local preferences                       | `~/.ellie/server.json`                                            |
| Node identity, server address, local preferences                      | `~/.ellie/node.json`                                              |
| Public TLS certificate and verified server certificate                | `~/.ellie/server-cert.pem`, `~/.ellie/node-server-cert.pem`       |
| Credential hashes, single-use invitation hash and expiry              | `~/.ellie/auth.json`                                              |
| Server TLS private key, controller credential, node bearer credential | macOS Keychain, service `org.ellie.assistant`                     |
| Native helper                                                         | `~/.ellie/bin/ellie-macos`                                        |
| Job ID, target, lifecycle timestamps and enum outcome                 | `~/.ellie/jobs.sqlite`, mode `0600`                               |
| Command text, actions, prompts, responses and pronoun context         | Process memory, cleared on restart; context removed on revocation |
| Browser cookies and authenticated sessions                            | Browser-owned profiles only                                       |

State directories are created with mode `0700`; JSON writes use atomic replacement and mode `0600`. The job database is a regular, single-link file owned by the current user with mode `0600`; its directory must be owned by the current user with mode `0700`. Startup and lifecycle writes prune terminal metadata older than 30 days and cap terminal history at 10,000 rows; a stopped or completely idle coordinator prunes on its next startup or lifecycle write. Initialization refuses to overwrite existing configuration. Private configuration cannot be directed into the checkout. The default `.gitignore` is a backstop, not a substitute for reviewing what you commit. Never commit actual machine names, addresses, accounts, paths, credentials, recordings, histories, or memories. Public examples contain only generic defaults.

## Pairing and authentication

1. Server initialization generates a self-signed TLS certificate with a generic identity. OpenSSL/LibreSSL writes the certificate and key to explicit files inside an ephemeral `0700` directory. The matching pair is validated, the key is read into memory, and the temporary directory is removed in a `finally` block before the key is stored through the native Keychain helper. Abrupt OS/process termination can leave temporary files; no durable PEM key is part of installation state.
2. The server-side local controller issues a cryptographically random 256-bit invitation valid for 10 minutes. Only its hash is persisted. A new invitation invalidates the old one.
3. The operator enters the server fingerprint on the new node. Certificate discovery is a TLS handshake only; it sends no HTTP payload or credentials. The fingerprint must match before the pairing code is sent.
4. Subsequent HTTPS requests trust that exact certificate, verify its fingerprint, enforce certificate validity, and require TLS 1.2 or newer. Generic `ellie.local` is the TLS identity; the verified certificate is the authority for whichever LAN address the operator entered. System-wide TLS verification is never disabled.
5. Pairing consumes the invitation once, atomically, and issues a separate random node credential. The client stores it in Keychain; the server stores only its hash. Node credentials can submit commands only to their own node and cannot invite or revoke peers.

The discovery handshake intentionally skips CA validation because trust is established by the operator-supplied SHA-256 fingerprint; this is isolated from every HTTP request. A wrong pin fails before any pairing secret or bearer token is sent. HTTP, browser-origin requests, unknown protocol versions, arbitrary tool names, oversized bodies, and disallowed targets are rejected. App and site allowlists are enforced both at the server and execution node.

Use a trusted local network. Do not expose this initial service directly to the internet or forward its port. Connection, body, and header limits exist, but this milestone is not an internet-facing, independently audited service. Any enrolled node is trusted to accurately report its own execution results and capabilities. A compromised server can invoke already granted actions, but cannot expand a node's local allowlist. An account with control of the local OS is outside this boundary.

## Revocation, changes, and recovery

On startup, Ellie never reconstructs job payloads from SQLite because no payload is stored. It marks previously delivered, running, or cancellation-requested work `unknown`; it expires overdue queued work and safely abandons other queued records. Inspect metadata with `bun run ellie jobs` or `bun run ellie job JOB_ID` before deciding whether to repeat an action. Corrupt databases and schemas from newer Ellie versions fail closed with instructions to preserve the file for diagnosis and restore a supported backup or move it aside. Cancellation is best effort after delivery: the client and node receive the request, and Ellie aborts the native helper or inference request when possible, but an already applied side effect is not rolled back.

On the server Mac, run `bun run ellie nodes` to find the node ID, then `bun run ellie server revoke NODE_ID`. It rejects future requests, ends a waiting poll, and clears server context. A native action already in progress may still complete. Removing a server credential does not erase a node's Keychain item; remove obsolete `org.ellie.assistant` items through Keychain Access when decommissioning.

To re-pair an existing node, revoke its previous ID, remove its local `node.json` and `node-server-cert.pem`, then run `node pair` with a fresh invitation. If pairing was accepted but local saving failed, the server may retain an unused identity; revoke it from the server's private auth state before retrying. No raw token can be recovered from its hash.

TLS certificates currently expire after one year. Automated rotation is future work. For deliberate identity rotation, stop the server, revoke/decommission paired nodes, remove the server's local configuration/certificate/auth files and associated Keychain entries, then initialize and pair again. Never bypass fingerprint verification to get around a changed or expired certificate.

If only the server's network address changes, update `serverUrl` in the node's private config; keep the verified certificate. Onboarding generates these files automatically. The current advanced settings are JSON; editing apps/sites on both ends and restarting is required to customize the allowlist. A settings UI is planned.

The server Keychain must be accessible in the logged-in session. Rebuilding the ad-hoc signed helper may require a new Keychain or Accessibility grant. Developer signing and a notarized installer are future work.

## Optional decision routing

Decision routing is absent by default. Hosted TypeSafe routing requires `cloudDisclosure: true` in coordinator configuration, set explicitly by `routing typesafe --allow-cloud`. That command stores the key in macOS Keychain under `decision.typesafe`. Both shadow and execution modes disclose unmatched requests, app/site candidate descriptions, and successful-app context to the fixed TypeSafe endpoint. Deterministic commands make no provider call. Ellie does not persist request/response content; the provider controls its own retention. The local adapter accepts only literal loopback origins and never silently switches to cloud.

Responses must match the question set, enum choices, and finite probability distributions. Probability thresholds do not establish user authorization or semantic correctness. Code builds one allowed operation, and existing coordinator/node policy still applies. Shadow proposals do not create jobs or commit context. Disconnect, deadline, revocation, re-registration, and shutdown cancel pending interpretation; a cancelled or stale proposal cannot dispatch later. Model errors are sanitized, input/output sizes are bounded, redirects are rejected, and the adapter does not retry. See [setup, disclosure, and evaluation](decision-routing.md).

## Optional compute workers

Compute is disabled unless configured in the private node configuration. Enabled workers report free/total memory, load, Ellie job count, power/battery, thermal state, coordinator RTT, and the locally enabled model inventory. These samples stay in coordinator process memory and are not sent to an analytics service. Model IDs may reveal what a user has installed; review node diagnostics before sharing. Each node can inspect only its own status; the controller can inspect all nodes.

Only the controller may request inference across the worker pool. Enrollment plus compute configuration opts that Mac into receiving controller-submitted prompts. No prompt/response logging or persistence is added. The local endpoint is restricted to literal loopback origins and rejects redirects; a network job cannot supply a different endpoint. The adapter returns text only and never interprets model output as a tool call. The runner itself is operator-managed and must use local models; its internal behavior is outside Ellie's enforcement boundary.

Telemetry is self-reported by a trusted enrolled node, not remotely attested. Required memory budgets are explicit local policy and are checked again at dispatch. Unknown optional sensors are labeled as such. A failed inference is never replayed automatically. Revocation rejects subsequent worker requests; an already running model request may continue until cancellation or its deadline reaches the runner.

The old LibreSSL initialization command may have left a file literally named `-` in the application directory. Treat it as possible private-key material, do not share it, and remove it if confirmed to be the failed initialization output. New generation never writes private keys into the checkout; the legacy filename is now ignored.

## Experimental distributed inference

Distributed MLX additionally requires an explicitly configured group/model and matching local consent on every member. Network jobs cannot select a Python executable, model path, topology file, or communication endpoint. The rank helper uses offline model loading with remote model/tokenizer code disabled; prompts travel over stdin and library stderr is discarded. The coordinator reserves the entire group and never retries an individual rank. Job metadata contains no prompts, responses, or local paths.

MLX data traffic uses its own TCP or RDMA transport, outside Ellie's authenticated HTTPS control channel. Restrict it to a trusted isolated interconnect. Qualification metrics and plan revisions are operator-supplied assertions, not attestation. Cancellation is propagated by heartbeat and local deadline, and the node waits for subprocess exit before reporting teardown. A hard crash or revocation can leave a group reserved until explicit recovery; see [the distributed lifecycle](distributed-mlx-reference.md#lifecycle-and-recovery).
