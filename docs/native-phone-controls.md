# Native iPhone app controls

Ellie's primary Mac and iPhone interfaces are SwiftUI. The enrolled iPhone's Coordinator screen now links to native Mac controls. Refresh the configured devices, select a granted Mac and an application, then explicitly open it. This slice supports Arc, Safari and Messages through the existing `app.open` operation. It does not accept free-form instructions, arbitrary application paths or URLs.

Mac labels initially use the registered node ID; friendly device names remain separate work. The native credential remains in the existing device-only Keychain envelope. The client uses its confirmed listener origin, leaf certificate pin, hostname/validity checks and TLS 1.2 minimum. Enrollment and browser authority remain separate. These commands do not grant coordinator authority, create cookies or access unrelated telemetry.

## Reviewed voice to browser controls

An enrolled iPhone with separate `speech.transcribe`, `browser.read` and `browser.control` grants can use push-to-talk for the browser workflow. Transcription produces editable text and does not dispatch anything. The person must tap the reviewed command, and the selected Mac must have a current page snapshot before a search, result selection or playback action is admitted.

The controller CLI accepts `--allow CAPABILITIES`, where `CAPABILITIES` is a comma-separated explicit native scope. The Mac pairing sheet starts with only `app.open` selected and lets the controller choose each browser capability separately. The reviewed search, selection and playback demo requires both `browser.read` and `browser.control`; selecting control alone does not add read access. Neither surface infers browser or speech access. Both show the exact requested capabilities before the one-time code is used.

The voice screen keeps the transcript when that snapshot is missing and offers a read-only page request. After an explicitly dispatched search, the old snapshot is invalidated. A separate read shows the updated observed results, then the native browser screen exposes only those result handles plus Play and Pause. Empty result lists reject selection without issuing a command.

Leaving the controls or backgrounding the app cancels the active wait. Cancellation after dispatch reports an unknown outcome and clears the snapshot; reconnecting or reopening never repeats the mutation. The person must read the current page again before any further selection or playback command.

## Listener contract

The optional client HTTPS listener adds two routes to `contracts/native-openapi.v1.json`:

- `GET /native/v1/nodes`: at most 16 configured targets, filtered by the credential's explicit native grants. The response contains only ID, configured label, online state and granted `app.open`, `browser.read` or `browser.control` capabilities, bounded to 8192 bytes.
- `POST /native/v1/commands`: exact `{nodeId, action}` with `action` restricted to the closed `app.open`, `browser.status`, `browser.read`, `browser.scroll`, `browser.scrollRow`, `browser.search`, `browser.select` and `browser.playback` schemas. `browser.scrollRow` requires an opaque row ID from the fresh selected Netflix page and the separate browser-control grant; it is denied by WebMCP and Accessibility adapters. App opening accepts only `arc`, `safari` and `messages`. The operation's required native capability is checked before discovery, after discovery and at dispatch.

For a reviewed Netflix voice command such as “Scroll right,” the review screen shows the observed rows and requires an explicit row choice. It displays the chosen row and target Mac beside Run; choosing a row sends nothing. A fresh read or completed command clears that choice, and the next horizontal command needs a new choice.
For reviewed Netflix voice search, Run is enabled only after a fresh read exposes one accessible search field. The review names that field and target Mac. Sending the query consumes the observation; a separate read must identify an actual results page before opening a title.

For YouTube, the selected Mac's explicit Read first arms a scoped Accessibility observation, then the companion must expose one reviewed search field on a home or results page. If the Accessibility read fails, no actionable page is shown. The iPhone names the observed field before Run and does not infer that an unverified Search succeeded. A new read must identify the results document and its title handles before selection. The `browser.read` and `browser.control` grants remain separate; if companion inspection fails after Accessibility was armed, that completed read supports the ordinary scoped read-only fallback without advertising Search. The DEBUG-only synthetic voice fixture covers review, one dispatch, unknown result and explicit results/watch reads; its hosted Simulator execution remains pending.

Both require the existing native bearer and version header with the exact listener Host, no Cookie, Origin or Sec-Fetch headers. Request JSON is bounded to 4096 bytes. The installed coordinator creates the bridge lazily only when the optional client listener is configured. It uses the existing controller identity and pinned loopback coordinator transport, and owns that client through startup, listener failure and shutdown. Inventory comes from currently registered authenticated coordinator nodes, bounded to 16, and every client sees only its granted targets. Existing node allowlists, the operation registry and scheduler still apply. No command is sent during service startup; missing bridge credentials leave controls unavailable while enrollment can remain reachable.

Discovery has a five-second deadline. Dispatch has a 35-second deadline after discovery. Cancellation and client disconnect propagate to the upstream request. Native and browser commands share one active reservation per device. If an upstream ignores cancellation, that reservation stays occupied until it settles.

A known result is `completed` or `failed`. A lost response, malformed dispatch result or post-dispatch failure means `unknown`: the app may have opened. Stop waiting does not undo an action. The interface tells the person to check the selected Mac before another explicit command.

Commands are never saved or automatically retried. Loading the screen, refreshing, reconnecting and restarting do not submit actions. Existing coordinator durable-job recovery remains authoritative; a client request is not a replay queue.

## Validation boundaries

The server tests exercise the real HTTPS listener with synthetic auth, devices and upstream outcomes. They cover pairing into the native channel, grant filtering, exact command grammar, revocation during discovery, offline/incapable targets, browser/native mutual exclusion, deadlines, disconnects before and after dispatch, retained reservations, signal propagation and redacted unknown results.

Swift tests cover the native control store and strict wire decoding. Simulator build and UI evidence is recorded separately in the dated validation report. These tests do not constitute physical iPhone enrollment, microphone acceptance or a native phone-to-household-Mac command. Publishing this PR does not deploy the listener or replace the installed services.
