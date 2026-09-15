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
