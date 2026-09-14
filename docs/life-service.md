# Life service

Ellie Life is a separate, explicitly started local application. It does not start or modify the existing Ellie coordinator, services, household data, `~/.ellie`, or Keychain. Its default state is `~/.ellie-life`; tests and embedded callers should pass a dedicated private directory. The launcher rejects state inside the source checkout, canonicalizes the nearest existing ancestor before creating anything, and requires the resulting directory to be owned by the current user with mode `0700`. The life, task, and plugin databases enforce their own regular-file, ownership, link, mode, integrity, and schema checks.

Start it with Node 24:

```sh
node apps/life/src/main.ts --state-dir /private/path/to/life-state --port 7440
```

The state directory is optional and defaults to `~/.ellie-life`. Port `0` selects an ephemeral port for tests. A local OpenAI-compatible model is optional and requires both `--model-url http://127.0.0.1:PORT/` and `--model NAME`; non-loopback, authenticated, and non-HTTP model URLs are rejected before stores are opened. `runLife(args)` is available for root CLI dispatch. `createLifeApplication(options)` assembles `LifeStore`, `TaskRuntime`, `PluginStore`, local document extraction, the life harness, and the HTTP service, and exposes idempotent `listen()` and `close()` methods.

On readiness the launcher prints one URL containing a cryptographic token in its fragment. Fragments do not travel in HTTP requests. The UI removes the fragment and sends the token once to `POST /api/life/session`. The launch token expires after ten minutes and cannot be reused. A successful exchange issues a random opaque cookie with `HttpOnly`, `SameSite=Strict`, `Path=/`, and a twelve-hour lifetime. The cookie omits `Secure` because this first listener is local plain HTTP. Only hashes of launch and session tokens are retained by the server. Session attempts are rate limited.

The listener binds only `127.0.0.1` and validates the exact bound `Host` value. Every non-GET/HEAD request requires the exact local `Origin`. There is no CORS response. Every `/api/life/*` route except session exchange requires the session cookie. Responses use `nosniff`, `Referrer-Policy: no-referrer`, bounded request sizes and deadlines, and do not log request bodies or raw errors. Ordinary JSON is limited to 128 KiB; source requests are limited to 2 MiB. Writes require `application/json`.

Shutdown stops new admission, closes listener sockets, aborts service-owned extraction, and waits up to five seconds for active handlers. If model-backed or other work remains unsettled, close reports that condition and the application keeps its stores open; callers can retry after the handler settles. This prevents late handlers from using a database that shutdown already closed.

The authenticated API is:

- `GET /api/life/bootstrap?scope=user:local|group:ID` returns the profile, authorized groups, ISO-timestamped records and tasks, resolved settings as `{ values, origins }`, truthful reminder notification fields, and plugins. Arcade summaries include that user's high score. MLB summaries include a snapshot or an explicit unavailable/stale result.
- `POST /api/life/groups` creates a group owned by the local actor.
- `POST /api/life/records`, `PATCH /api/life/records/:id`, and `DELETE /api/life/records/:id?revision=N` provide record CRUD. Patches use `expectedRevision`; `revision` remains a compatibility alias.
- `POST /api/life/sources` imports text, Markdown, HTML, email, and transcripts. Binary content uses base64 plus the injected local extractor. Unsupported formats return an explicit error rather than pretending ingestion succeeded.
- `POST /api/life/import/preview` parses original ICS or vCard content into reviewable items and warnings without persisting it. `POST /api/life/import/commit` resubmits and reparses that original content with optional selected keys; client-supplied preview objects are ignored. Deterministic identities make repeats idempotent, while records edited after an earlier import are preserved and reported as conflicts.
- `POST /api/life/settings` applies a whole default, user, or owner-authorized group settings batch atomically. Authority-related keys remain forbidden.
- `POST /api/life/feedback` records inspectable feedback and accepts the richer learning fields for compatibility. `POST /api/life/learning` records a rating or correction; `GET /api/life/learning?scope=...` lists scoped history; `POST /api/life/learning/:id/selection` revision-selects a personal example; and `POST /api/life/learning/export` returns an explicit, local `{ format, count, jsonl }` export. Group examples and unselected personal examples cannot be exported. `POST /api/life/chat` invokes the life harness.
- `POST /api/life/signals` evaluates one explicit, scoped shopping, location, price, or preparation-check observation. Location coordinates are used for the immediate match and are not retained. The resulting notification record stores the reason and related record, while reported prices remain attributed to the caller-supplied source.
- `POST /api/life/notifications/:id/dismiss` and `POST /api/life/notifications/:id/complete` require `expectedRevision`. Completion atomically closes an authorized linked reminder or need, then cancels matching pending delivery work. Dismissal and completion remove the notification from subsequent bootstrap responses.
- `POST /api/life/tasks/:id/pause|resume|cancel|run` first finds the task under the user's authorized owner scopes, then performs the transition using that stored owner.
- `POST /api/life/plugins/build` installs a built-in arcade or MLB plugin, or uses the optional model-backed builder. It returns unavailable when custom generation is not configured.
- `GET /api/life/plugins/:id/view` serves only a plugin found by enumerating authorized owner scopes. `POST /api/life/plugins/:id/action` permits only declared `storage.get`, `storage.set`, or `mlb.snapshot` grants. Group arcade storage keys are prefixed by the active user.
- `POST /api/life/plugins/:id/revise`, `POST /api/life/plugins/:id/rollback`, and `DELETE /api/life/plugins/:id` expose scoped version changes, rollback, and removal. Revision preserves existing grants; it cannot acquire capabilities.

The service never accepts an HTTP user ID or capability list. Its trusted actor defaults to `local`; tests and embedding code can inject another stable user ID. User and group scopes are checked against `LifeStore` membership, while record, task, and plugin mutations resolve the stored owner before acting.

Static UI files contain no personal state. A plugin view first loads a trusted service-owned host document. That host creates a nested `sandbox=allow-scripts` frame for the untrusted plugin and brokers one child-only message port; navigating or reloading the child closes the bridge. Its inherited CSP denies default access, network, forms, objects, and base URLs, allows inline scripts/styles and data images, and permits framing only by the same-origin Ellie UI. Plugin code is served to the browser and is never executed by the server.

Current limitations are local HTTP, in-memory sessions, a single local trusted actor per process, and no remote access. Restarting the service requires a new launch-token exchange. At-rest encryption and HTTPS require a later deployment design; the current implementation relies on OS-user file isolation and loopback-only transport.
