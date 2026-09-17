# Ellie Media Companion (experimental)

This unpacked Manifest V3 extension is a browser-side companion for explicit controls on the selected active tab. Its production permission surface is `activeTab`, `scripting`, and local native messaging; it has no persistent site access, browser-cookie reads, or website-to-household connection.

The exact reviewed origins are `https://www.netflix.com` and `https://www.youtube.com`. Netflix uses a distinct DOM companion source over the authenticated native-host selection, not the YouTube Accessibility adapter. It reads bounded same-origin title/watch links, scrolls vertically, scrolls horizontally only when one visible row is unambiguous, opens one item from a fresh read, and dispatches play or pause only from a single observed watch-page player state. Search, account/profile/payment controls, and multi-row horizontal choice are unsupported. A dispatched action is reported unknown until a separate fresh read; it is never replayed or switched to another adapter. YouTube TV and Disney+ remain unsupported. Actual authenticated Netflix, playback, and Arc acceptance are pending.

The popup can inspect currently visible title links, scroll one viewport or one real horizontal scroll container, open a fresh inspected candidate, and operate exactly one visible HTML video. Opening confirms navigation only. Playback controls verify observed media state and never replay an action after timeout or navigation.

WebMCP discovery is read-only and bounded. It detects the current `document.modelContext.getTools()` surface and reports legacy `navigator.modelContext` separately. Tool metadata is untrusted and no discovered tool is executed. Neither supported service has an accepted official WebMCP tool integration in this slice.

Run `bun run test:browser-media` to load a generated test-only extension copy in an isolated Chromium profile. The copy adds only a loopback fixture origin and host permission; the shipping manifest and scripts contain no loopback access. This synthetic workflow does not establish live provider support or an `activeTab` gesture initiated outside the browser.
