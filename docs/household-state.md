# Household dashboards and chores API

The coordinator can durably store version-1 dashboard and chores documents for explicitly authorized native clients. Pairing a phone to open apps gives it no household-data access. Household state uses a separate authority store and does not change the phone's existing execution grants.

This backend is intended for the native SwiftUI clients. Their existing local files remain unchanged: there is no automatic upload, download, migration, merge or provider activation. Native profile/save/conflict screens follow this API in a separate slice.

## Grant access from the coordinator

The coordinator's existing controller identity manages data grants. First identify the native client with `bun run ellie native clients`, then use its actual ID:

```sh
bun run ellie household grants
bun run ellie household grant CLIENT_ID shared dashboards write
bun run ellie household grant CLIENT_ID shared chores read
bun run ellie household revoke CLIENT_ID shared dashboards
```

The profile is `shared` or `private`; the document is `dashboards` or `chores`; access is `read` or `write`. Write includes read. Granting access requires a currently active native client. Listing and revocation do not expose document contents. If a grant or revocation response cannot be confirmed, the CLI directs you to inspect `household grants` before retrying.

A shared profile is one household namespace. A private profile belongs only to the authenticated native client ID: two devices belonging to the same person have separate private state in this slice. Re-enrollment creates a new client ID and inherits no data authority. Removing a data grant leaves app-opening access unchanged; native-session revocation or expiry denies both. Revocation removes access, not stored document bytes.

## Read and conditionally save

Native requests use the dedicated pinned HTTPS listener, the native bearer, the exact configured Host and `x-ellie-version: 1`. Browser cookies, Origin/Fetch request channels, node credentials and controller credentials are not native data authority.

- `GET /native/v1/household/authority` returns the current client's data grants.
- `GET /native/v1/household/{shared|private}/{dashboards|chores}` reads one authorized document.
- `PUT` to that same path requires JSON `{ "value": DOCUMENT }` and exactly one `If-Match: "ellie-revision-N"` header.

Successful document responses contain exactly `{profile, kind, revision, value}`, with a matching ETag. Missing documents return revision 0 and a canonical empty dashboard document or empty UTC chores document; reads do not create a document row. The first explicit upload uses revision 0.

An accepted write advances the revision by one. A stale write returns 412 with only `{profile, kind, revision}` and preserves the server document. Missing `If-Match` returns 428; malformed or duplicate preconditions return 400. An ungranted client receives 403; an expired or revoked native credential receives 401. Responses are not cached. The generated coordinator and native OpenAPI contracts describe the exact document and authority shapes.

Retain the local draft after a conflict or an unknown write outcome. A connection loss or cancellation can occur after the server has saved the data. Recover with a fresh authorized GET and compare the revision/value; do not automatically replay the PUT. Household document reads and writes never enqueue or replay desktop actions.

## Durability and limits

`data-authority.json` and `household-documents.json` reside in the existing private coordinator state directory, separately from native credentials. The runtime opens them only when the dedicated client listener is configured. Unsafe permissions, links, malformed data and unsupported versions fail closed while preserving the original file. Persistence uses owned temporary files, fsync and atomic replacement. A failed durable commit prevents later use of that store until restart and successful validation. Capacity rejection preserves the previous document and permits later valid work.

The initial limits are 128 data-grant rows, 256 document rows, 128 KiB per dashboard value, 256 KiB per chores value, 1 MiB for the authority file and 32 MiB for the document file. Document revisions are monotonic safe integers; an exhausted revision cannot wrap or reset. The runtime is the single writer. Private state, notes and chores do not enter routine telemetry or external analytics.

All requests authenticate afresh. A queued document operation rechecks expiry and its data grant at the serialization point. Native revocation and document writes have a defined order, so an operation cannot rely on a grant that was revoked before it was admitted.

See the [dated validation record](validation/2026-09-13-household-state.md) for tested behavior and remaining acceptance work.
