# Native calendar snapshot

Calendar is an offline, read-only foundation. A person explicitly imports an Ellie agenda JSON file; Ellie does not contact a calendar provider, request an account, retain the selected file path, or write events. The imported snapshot is copied to `agendav1.json` with owner-only permissions. **Disconnect and Clear** cancels an in-flight import, removes the in-memory agenda, and deletes that copy.

Schema version 1 contains a source (`id`, `name`), generation time, calendars (`id`, `name`, optional `#RRGGBB` color), and events. Timed events use RFC 3339 `start`/`end` (with optional fractional seconds) plus an IANA `timeZone`. All-day events instead use `startDate` and exclusive `endDate` as `YYYY-MM-DD`; this preserves civil dates without inventing a time zone. Every event names its calendar ID. Inputs are bounded to 128 KB, 32 calendars, 500 events, bounded ASCII IDs and display strings, and validated ranges. Events are deterministically ordered after import.

The widget identifies the imported source and each event’s calendar. Its status says that the data is an imported offline snapshot and marks snapshots older than 24 hours stale. Import errors leave the last valid snapshot in place. Corrupt saved data is preserved and blocks replacement until the user explicitly clears it.

This slice intentionally has no Google-specific wire model, OAuth, remote URL input, automatic refresh, canned live-looking events, or write API. A future provider adapter can produce the same Foundation-only `AgendaSnapshot` contract after explicit authorization.
