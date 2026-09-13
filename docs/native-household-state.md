# Native household state contract

This document freezes the implementation boundary for the first authenticated household-state slice. It describes work to be implemented; it is not evidence that the routes, stores, or clients exist.

## Authority boundary

Native enrollment remains version 1. Its bearer authenticates one current `native_phone_controller` session and supplies a stable server-generated client ID for that session lifetime. Pairing and existing `app.open` grants confer **zero household-data authority**. No dashboard, chore, shared-profile, or private-profile permission is inferred from an execution grant, role, label, prior local file, or possession of a bearer.

Household authorization is stored separately and is granted explicitly by a controller to an active native client ID. Every native data request must first authenticate the bearer against the current native-auth state and then read the current data grant. A native-session expiry, logout, or revocation denies the next data request even if an orphaned data-grant record remains. Re-enrollment creates a new client ID and inherits no prior data grant.

The first profile model has two classes:

- `shared` names one household namespace that may be granted to multiple clients.
- `private` resolves to the authenticated client ID. Another native client can never address, receive a revision for, or receive contents from that private namespace.

Every profile/document pair requires an explicit `read` or `write` grant; `write` includes read. Supported document kinds are `dashboards` and `chores`. A private profile is device-private in this slice, rather than a durable person identity. Sharing one person's private state across several devices requires a later explicit profile-identity design and may justify a future enrollment contract. It is not approximated by labels or matching grants.

## Serialized authorization and mutation

Data-grant mutations, document mutations, and their authorization checks have a defined serialization point. A document PUT enters the household-state mutation queue, re-authenticates the native session and re-reads the applicable data grant while holding the serialized mutation boundary, verifies the conditional revision, validates the complete document, and only then persists it. A racing grant or native-session revocation is ordered against the PUT: either the PUT commits first under the authority that was still current at its serialization point, or revocation commits first and the PUT is denied. An authorization check performed before queue entry is insufficient.

Controller grant and revoke responses are successful only after their state is durable. A failed authority or document save poisons that in-memory store. It then rejects authentication-dependent reads and all mutations until the coordinator reopens and revalidates the private file. No failure path falls back to cached grants or stale documents.

Durable document bytes are inert data. Loading, importing, syncing, reopening, or recovering them cannot enqueue a desktop command, replay an action, widen a grant, create a routine, or trigger widget/provider work.

## Durable stores

Two new files live in Ellie's existing private state directory:

- `data-authority.json`, version 1, contains unique bounded rows `{clientId, profile, kind, access}`.
- `household-documents.json`, version 1, contains unique bounded rows `{profile, ownerClientId?, kind, revision, value}`. Shared rows omit `ownerClientId`; private rows require the owning native client ID.

Both stores reuse the hardened authorization-file lifecycle: a real same-UID `0700` directory; same-UID regular, single-link `0600` files; `O_NOFOLLOW` and nonblocking bounded reads; fatal UTF-8 decoding; exact-key/version validation; exclusive no-overwrite initialization; fsynced temporary contents; atomic rename; post-rename validation; and parent-directory fsync. Malformed, unsupported, oversized, or unsafe existing files are preserved and fail closed. There is one coordinator-owned writer and no cross-process last-writer-wins behavior.

Initial limits are part of the wire and persistence contract:

- at most 128 authority rows;
- at most 256 document rows globally across both profile classes and document kinds;
- at most 128 KiB for a dashboard value and 256 KiB for a chores value;
- at most 1 MiB serialized for `data-authority.json` and 32 MiB serialized for `household-documents.json`;
- revision values are nonnegative JSON safe integers, from 0 through `9_007_199_254_740_991`.

The implementation must reject a mutation that would exceed any row, value, or serialized-file limit before changing in-memory state. Revision 0 represents a missing document and is never persisted. A successful PUT increments the current revision by exactly one. When a persisted revision is already the maximum safe integer, further writes fail with a fixed exhaustion response; the revision never wraps, resets, or becomes a floating-point approximation.

A missing dashboard reads as the canonical version-1 empty dashboard state `{ "version": 1, "dashboards": [] }` at revision 0. A missing chores document reads as canonical version-1 UTC state `{ "version": 1, "householdTimeZone": "UTC", "chores": [] }` at revision 0. Reading either default performs no write. The server validates complete values with shared typed protocol parsers matching the native schema bounds and unknown-key rejection. The frontend package is not imported into the server; reusable validators belong in the protocol package.

Existing native Mac and iPhone application-container files remain local. There is no startup migration, automatic upload, automatic download, implicit shared profile, or replacement of the browser-v1 import/export path. The first upload is an explicit user action against revision 0.

## Routes and responses

Controller management uses the existing pinned controller bearer and accepts no native bearer, node credential, browser cookie, Origin, or Fetch authority:

- `GET /v1/household/authorities` lists bounded public grant rows.
- `POST /v1/household/authorities` accepts exact JSON `{clientId, profile, kind, access}` and grants or replaces that exact row after confirming the client is currently active.
- `POST /v1/household/authorities/revoke` accepts exact JSON `{clientId, profile, kind}` and removes only that row.

The native listener uses only the native bearer and its existing exact Host, header, cookie/Origin rejection, TLS, connection, deadline, and body bounds:

- `GET /native/v1/household/authority` returns only the authenticated client's current data grants.
- `GET /native/v1/household/{shared|private}/{dashboards|chores}` returns the authorized document projection.
- `PUT /native/v1/household/{shared|private}/{dashboards|chores}` replaces one complete document after conditional revision and fresh authorization checks.

GET and successful PUT return exact JSON `{profile, kind, revision, value}` and an ETag formatted as `"ellie-revision-N"`. PUT requires exactly one matching `If-Match` value. Missing precondition returns 428. A stale revision returns 412 with only `{profile, kind, revision}` for the same already-authorized document; it does not return the current value. The client must make a separate authorized GET to inspect current contents. An unauthorized or cross-private request returns a fixed 401 or 403 without confirming whether the document exists, its revision, its owner, or another client's grant. Unsupported routes return 404. Responses and errors are `no-store`, bounded, exact-shape JSON with fixed redacted messages.

## Client conflict and offline behavior

A client edits an immutable local draft derived from revision N and explicitly saves the complete document with `If-Match: "ellie-revision-N"`. Success returns N+1. A 412 preserves the draft and records only that the server revision changed; the next explicit or user-visible recovery GET may present the current value for replace or rebase. There is no automatic merge.

Timeout, cancellation, connection loss, or a malformed success response makes a PUT outcome unknown. The client retains its immutable draft and performs a read-only GET when the user asks to recover. It compares the returned revision and canonical value to the attempted value. It never automatically repeats the PUT. Household-state recovery is independent of the desktop-action lifecycle and cannot replay an `app.open` request.

## First implementation slice

The initial pull request contains the shared dashboard/chores protocol validators, the two hardened stores, serialized authorization and conditional document service, controller management routes, native listener routes, generated contracts/OpenAPI, and controller CLI commands to list, grant, and revoke data authority. This backend boundary must be usable end to end through the CLI and HTTPS APIs.

Native sync UI is the next slice. It adds explicit profile selection, explicit first upload, explicit save, revision display, conflict/recovery state, and local-draft preservation to the existing Mac and iPhone stores. It does not silently replace local state on launch.

Open implementation choices for review are the internal lock composition between native auth, authority, and document stores; whether authority rows use an enum or separate read/write booleans internally; and the exact fixed error text. These choices must preserve the serialization, privacy, durability, and wire behavior above.

## Required synthetic acceptance

Tests use only owned temporary private directories and synthetic HTTPS clients:

1. Two clients receive shared write grants. A writes revision 0 to 1; B reads 1; A writes 1 to 2; B's stale write at 1 receives 412 and does not change the document.
2. A lost successful response is recovered by one GET. The request log proves no second PUT and no desktop command.
3. Client A's private dashboard and chores are inaccessible to B. B receives no owner, revision, or contents even when B has grants for its own private documents.
4. A native client with only `app.open` receives 403 for all household routes. Granting data access does not add an execution grant.
5. A data-grant revoke racing a PUT produces one serialized outcome: either the PUT commits before durable revoke, or revoke wins and the PUT is denied. Every later request is denied.
6. Data-grant revocation leaves `app.open` unchanged. Native-session revocation denies both household data and app opening even if the authority row remains.
7. Both stores reopen with exact revisions and values. Unsafe paths, malformed/future versions, duplicate rows, oversized values/files, global count limits, failed persistence, and safe-integer exhaustion fail closed without replacing the original file.
8. Concurrent writes with the same revision produce exactly one success and one 412. Reads of missing documents return the canonical revision-0 defaults without writing a file.
