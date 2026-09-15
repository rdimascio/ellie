# Browser WebMCP bridge

This slice connects an explicitly selected browser tab to a local native-messaging host and
private node-side Unix socket. Canonical job permissions and native browser controls consume
this transport through the node executor. The shipping reviewed origin/tool map is empty;
installation and real-site acceptance remain open. The packaged node uses the authenticated
Swift broker and [Accessibility runtime](browser-accessibility.md) when an explicitly bound
page does not offer reviewed WebMCP tools.

The browser uses the current `document.modelContext.getTools()` and
`executeTool(RegisteredTool, arguments, { signal })` interface. Only exact reviewed tool
metadata is exposed. Tool handles belong to the selected document. Same-origin navigation
invalidates old handles and refreshes the connection identity; unpermitted navigation,
tab closure and expiry revoke the connection. A tool response is not independent proof of
visible playback or another page effect.

Native messaging permits one exact extension identity. The node-side directory and socket
are private to the user. Requests and responses have closed, size-bounded framing and
grammar. There is one outstanding request. Cancellation reaches pending discovery as well
as dispatched execution, and an interrupted operation retains its reservation while its
outcome remains uncertain. A post-dispatch disconnection or unknown result never authorizes
a retry or an accessibility fallback. The job caller supplies its deadline signal.

Malformed frames close their connection without crashing the node. Old connections cannot
settle a new connection's pending request. Cleanup removes only the socket whose identity
the bridge retained. The original Node transport seam refuses existing sockets; the packaged
Swift broker can recover a verified stale socket using its retained private lock record.
Neither path replaces a live or foreign socket.

The isolated Chromium fixtures exercise loaded extension scripts against synthetic WebMCP
tools, including cancellation before injection, delayed discovery, same-origin navigation,
stale handles and media-companion regressions. Native-host stream tests exercise the real
Unix relay, malformed framing and disconnected outcomes. These tests do not establish
WebMCP availability on Netflix, YouTube, Disney+, Safari or Arc, an installed extension,
actual player effects, or the physical iPhone voice flow.

## Real-browser acceptance runner

`bun run accept:browser-webmcp` drives an owned HTTPS page through an isolated
agent-browser profile, the production extension scripts, an owner-provided staged development
native host artifact, the real Unix bridge seam and the canonical browser-operation executor. The page registers its read
and scroll tools with the browser's native `document.modelContext.registerTool()` implementation.
The runner records the exact source, release, extension fixture changes, browser executable,
registry, snapshots and screenshots. It requires a measured scroll offset and visible text change,
then reverses that one action only after both the WebMCP result and page effect are known. An
unknown result forbids replay, Accessibility fallback and rollback dispatch.

Use the immutable owner-provided staged development artifact and an explicit Chrome for Testing
executable. This artifact has no authenticated publisher admission:

```sh
ELLIE_BROWSER_ACCEPTANCE_RELEASE=/absolute/path/to/staged-development-artifact \
ELLIE_BROWSER_ACCEPTANCE_BROWSER=/absolute/path/to/Google\ Chrome\ for\ Testing \
bun run accept:browser-webmcp
```

The gate requires a clean checkout. A developer can set
`ELLIE_BROWSER_ACCEPTANCE_ALLOW_DIRTY=1` while iterating, but that run records dirty source and is
not release evidence.

All browser profiles, manifests, private runtime state and certificates are created beneath one
owned temporary root. The HTTPS exception is scoped to the fixture leaf's SPKI and hostname; the
runner does not change the user trust store or cross a security interstitial. A passing run proves
the reviewed Chrome 152 dialect (serialized schemas, JSON-string arguments and results), extension,
packaged native host and reviewed Node Unix bridge seam. The current WebMCP draft instead takes an
object argument while retaining serialized schemas, so the reviewed origin/tool policy selects the
argument dialect explicitly before dispatch. Schema representation is never used as the dialect
signal, and an action is never retried with another representation. This run does not prove
authenticated publisher admission, the packaged Swift broker's Arc ancestry check, an Arc WebMCP
implementation, Accessibility, a streaming provider, or a physical phone path.
