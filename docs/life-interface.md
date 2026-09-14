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

Plugin views use a trusted service-hosted broker around a nested iframe with `sandbox="allow-scripts"` and no same-origin permission. A bootstrap script that runs before plugin code creates a dedicated `MessageChannel`, retains the plugin end in the opaque child, and transfers only the host-facing end upward. The broker accepts each child port once and closes both ends if the child navigates; the React host never transfers an authenticated capability port down during iframe load. Plugins may request only `storage.get`, `storage.set`, and `mlb.snapshot`; the React host validates each message and forwards it through the authenticated plugin action endpoint. Channels close when the view unmounts. Plugins receive no session token, cookie access, or host state.

No synthetic records appear in the default client. Empty, pending, authentication, and request-failure states are part of the production interface; demo fixtures belong in explicit tests only.
