# Ellie life interface

`apps/life-ui` is an additive React/Vite client for the life harness. It does not replace the native clients or command-center demo.

## Local build

```sh
node node_modules/vite/bin/vite.js build --config apps/life-ui/vite.config.ts
node node_modules/vite/bin/vite.js --config apps/life-ui/vite.config.ts
```

The development server uses `http://127.0.0.1:4180`. Production hosting is an opt-in localhost service supplied by the life harness.

## Authentication

The CLI prints a private URL ending in `#token=…`. The client reads the token into memory, removes the fragment immediately, then sends it to `POST /api/life/session`. All later requests use the HttpOnly, same-origin session cookie. A missing or expired session shows instructions to reopen the CLI link; the UI never creates a substitute credential.

## API boundary

`src/api.ts` is the only HTTP adapter. It sends JSON writes with same-origin credentials and exposes typed methods for bootstrap, chat, scoped records, source teaching, settings, feedback, activity, and plugins. Bootstrap contains bounded record summaries and a cursor rather than full source text. Your world loads additional summary pages explicitly, searches indexed source passages within the active scope, and fetches the authorized full record only when someone opens it. This keeps routine refreshes small without truncating editable source bodies. Scope and request epochs prevent an old search, page, chat, or refresh response from crossing a scope change.

Activity loads bounded task detail on demand. It shows child status, recent progress, and a verified aggregate summary with source titles and references. When a cited source is missing or revised, the service withholds the stored result and the UI offers to run the task again. Your space exposes retained plugin revision metadata, plain-language revision, rollback with an expected current version, and intentional removal. Generated HTML and task result objects are never dumped into the ordinary interface.

Conversations are durable private transcripts, even when a conversation uses a group as context. The client restores only a conversation named in its non-secret URL, pages older turns and scoped history on demand, and does not put transcript text in browser storage. Every chat submission carries one stable request ID and the current server chat epoch. A lost connection leaves an explicit recovery state; checking it reads the authoritative stored outcome instead of sending the instruction again. New conversation, scope changes, reset epochs, and component teardown abort client requests and reject late UI updates, without claiming that an HTTP abort cancelled work already accepted by the service. The read-only model status distinguishes built-in behavior from an optional configured local model and never exposes runner credentials or starts inference.

An incomplete reminder or event remains a revisioned draft attached to its private conversation for up to 24 hours. The conversation shows the server-authored kind, title, missing detail, and follow-up question above the composer; ordinary chat replies supply the answer. Only an awaiting draft exposes **Clear draft**, which uses a revision check. Executing and interrupted intents direct the person to authoritative request recovery and Activity instead of presenting a client-side cancel, while expired drafts remain visibly inert. Starting another conversation leaves the old draft with its original conversation, and personal reset removes it with the transcript.

Guidance in Your world uses the versioned teaching routes rather than the generic record editor. Each guide exposes its active or paused state, retained instructions, and rollback history. When a linked source revision changes, the UI loads the authorized current source detail, leaves every source unchecked, and requires the person to choose the current revisions before adopting revised instructions. The ordinary routine editor filters teaching guides and cannot apply an unversioned body update.

Source teaching accepts up to 20 selected files into a visible, sequential queue. Every file keeps an independent queued, uploading, review, completed, failed, or cancelled state; one failure does not hide the result of another. DOCX, PDF, PNG, and JPEG files use the authenticated raw binary route with `application/octet-stream`, avoiding base64 expansion and the former small-request ceiling. Text formats remain JSON uploads, while calendar and contact files pause individually for explicit import review. Active upload and preview requests are aborted when the view unmounts or the scope changes, and late results are ignored across that scope boundary.

Settings treats personal-data export and reset as global user operations, independent of the selected conversation scope. A fresh review reports concrete counts, byte size, preserved shared categories, and a short-lived token bound to the life, task, and plugin generations. Export follows every cursor for all three stores and retains each store's format and generation in one downloaded archive. Browser assembly is bounded across all stores to 3,000 pages, 10,000 items, and 25 MB of serialized item data, and is cancelled when Settings unmounts. Larger archives report the current browser limit; the underlying authenticated APIs remain paged. There is no standalone local export command yet. Reset requires a typed acknowledgement and the fresh review token, then displays the durable drain/delete status with non-overlapping polling and retry support. Settings discovers an incomplete journal after reload so an interrupted reset cannot become unreachable. Reset removes private records, settings, tasks, watches, personal apps, and the person's keys inside shared app storage; group membership and shared records, tasks, and apps remain.

Plugin views use a trusted service-hosted broker around a nested iframe with `sandbox="allow-scripts"` and no same-origin permission. A bootstrap script that runs before plugin code creates a dedicated `MessageChannel`, retains the plugin end in the opaque child, and transfers only the host-facing end upward. The broker accepts each child port once and closes both ends if the child navigates; the React host never transfers an authenticated capability port down during iframe load. Plugins may request only `storage.get`, `storage.set`, and `mlb.snapshot`; the React host validates each message and forwards it through the authenticated plugin action endpoint. Channels close when the view unmounts. Plugins receive no session token, cookie access, or host state.

No synthetic records appear in the default client. Empty, pending, authentication, and request-failure states are part of the production interface; demo fixtures belong in explicit tests only.
