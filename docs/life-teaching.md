# Teaching through content

`@ellie/life-teaching` stores explicitly adopted guidance as versioned routine records. Ingesting a source never creates or activates guidance. A caller acting on a direct user request can create a guide from selected instructions and exact source revisions, then enable it in that same user or group space.

`LifeTeaching(store)` provides `create`, `get`, `list`, `revise`, `setEnabled`, `rollback`, and `resolve`. Creation is paused by default. A guide contains up to 4,000 instruction characters and twelve same-scope source references. The latest eight instruction versions retain the adopting actor and time. Record revisions guard edits and activation; rollback creates a new version and refuses stale source references. Ordinary record-body edits cannot silently replace the active version.

Model context can use `resolve(actor, scope)`, which returns at most eight active guides and 16,000 instruction characters. A source replacement, deletion, invalidated provenance, or lost access excludes the affected guide. Review the new source and explicitly revise the guide to restore it. The current list uses the latest 500 routine records; this is a bounded working window rather than a full archive query.

The Life service exposes scoped list/detail/create and revision-checked revise, enable and rollback routes. Your world's Guidance view displays instructions and retained versions, opens current linked sources for review, and requires explicit selection when adopting updated evidence. Ordinary record editing does not bypass this version history. Each change invalidates the corresponding conversation context so a reply already in flight cannot reintroduce the older guidance.

Adopted guidance customizes responses and planning within the existing capability boundary. It cannot grant tools, change identity, widen sharing, or authorize a consequential external action. Instructions inside ordinary source evidence remain data. A user's current instruction takes precedence over an older guide.

Tests cover inert ingestion, explicit activation and restart, scoped sharing, source replacement/deletion, revoked membership, stale revisions, bounded history/context, rollback and unversioned edits. This is inspectable configuration; it does not alter model weights or claim to undo information in an already downloaded export.
