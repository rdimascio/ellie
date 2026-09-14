# Ellie extension API

Ellie Life uses a versioned local plugin store and an isolated browser view. Built-in arcade and MLB extensions use the same manifest, storage, view and host-action boundaries as generated custom applications.

## Manifest and lifecycle

An extension has a name, description, kind (`arcade`, `mlb`, or `custom`), and a capability list. Custom extensions include a single self-contained HTML document and initially receive only `storage`. Installation validates bounds and classic inline JavaScript syntax. Validation compiles scripts without executing them; the browser sandbox and response policy enforce authority.

Installed code is versioned, retaining the latest 100 revisions per extension. Revisions preserve extension kind and cannot add capabilities. Failed validation leaves the active version and data unchanged. Rollback creates a new active version containing a retained prior valid manifest, so the revision history remains inspectable. Storage schema is deliberately stable key/value data in this implementation; arbitrary data migrations are not run. Deletion removes that extension's stored values and version history.

`PluginStore` provides `install`, `list`, `get`, `history`, `update`, `rollback`, `remove`, `storageGet`, `storageSet`, `authorize`, and `view`. History returns retained revision metadata without generated HTML. Every method takes a canonical owner scope. The HTTP host derives owner scope from the authenticated user and current group membership; code inside the plugin cannot choose another owner or plugin identity.

## Browser bridge

The host embeds a trusted broker with `sandbox="allow-scripts"`, without same-origin access. The broker creates a second opaque frame for the extension. A trusted bootstrap in that original document sends a fresh channel outward; the broker passes authenticated host results through that channel. The extension receives its end in a local window message:

```js
// Executed by a plugin within its isolated view.
let elliePort;
window.addEventListener("message", (event) => {
  if (
    elliePort ||
    event.source !== window ||
    event.data?.type !== "ellie:connect" ||
    !event.ports[0]
  )
    return;
  elliePort = event.ports[0];
  elliePort.onmessage = ({ data }) => {
    // Correlate the request ID; inspect data.ok before using data.result.
  };
  elliePort.start();
  elliePort.postMessage({ id: "load-score", method: "storage.get", key: "highScore" });
});
```

Requests are `{id, method, key?, value?}`. Replies are `{id, ok: true, result}` or `{id, ok: false, error}`. The parent validates the message, routes only allowed methods to its authenticated endpoint, and closes the port when the view unmounts. Host services are never delivered to a navigated extension document through its WindowProxy. The original document owns the child channel; navigation discards that document’s endpoint. No session cookie, launch token, private source, or filesystem handle enters the iframe.

| Method         | Required capability | Result                                                        |
| -------------- | ------------------- | ------------------------------------------------------------- |
| `storage.get`  | `storage`           | One namespaced value, or null.                                |
| `storage.set`  | `storage`           | Stored value, bounded to 16 KiB and 128 keys per extension.   |
| `mlb.snapshot` | `mlb.read`          | Normalized standings and games with freshness/error metadata. |

Arcade scores use a user-specific key even in a group-owned extension. The host uses `groupStorageKey(userId, key)` with an encoded identity prefix so a colon in a user ID cannot collide with another user's key. The host accepts only bounded nonnegative integer high scores and retains the maximum. This is personal persistence, not an anti-cheat competitive leaderboard. Earlier unreleased prototype group keys are not automatically reinterpreted, because their raw identity prefixes can be ambiguous.

The MLB adapter calls fixed MLB endpoints, never an arbitrary URL supplied by a plugin. Requests have timeouts and response-size bounds; concurrent reads of the same date coalesce, at most four distinct dates refresh concurrently, and successful results cache for one minute. Failed refreshes label cached results stale. When there is no successful cache, the result is an explicit unavailable state. Opening the view starts periodic refresh while visible. This feature does not imply a commercial data availability guarantee.

## Verification and limits

The plugin tests exercise private data separation, per-user group scores, storage bounds, capability-preserving updates, restart persistence, rollback, failed-candidate preservation, template script syntax, and provider cache/failure behavior. Browser tests are recorded in the overnight checkpoint.

The current interface supports self-contained UI and two narrow host services. Native OS widgets, arbitrary server-side plugin processes, marketplace distribution, signed third-party packages, and general network connectors are not implemented. A browser sandbox restricts capabilities; it does not provide a hard CPU or memory budget for arbitrary generated JavaScript. Model-generated UI still needs preview and behavioral checking for usability beyond syntax validation.
