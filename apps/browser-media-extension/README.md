# Ellie Media Companion (experimental)

This unpacked Manifest V3 extension is a browser-side development companion for explicit controls on the active tab. Its production permission surface is `activeTab` and `scripting`; it has no persistent host access, native messaging, cookies, profile access, or remote connection.

The initial provider origins are Netflix and YouTube. YouTube title-link behavior is conservative and experimental. Authenticated Netflix catalogue browsing remains unaccepted because the observed public page exposes marketing controls rather than playable title links. YouTube TV, Disney+, and Arc compatibility are unsupported pending direct adapter and extension-runtime validation.

The popup can inspect currently visible title links, scroll one viewport or one real horizontal scroll container, open a fresh inspected candidate, and operate exactly one visible HTML video. Opening confirms navigation only. Playback controls verify observed media state and never replay an action after timeout or navigation.

WebMCP discovery is read-only and bounded. It detects the current `document.modelContext.getTools()` surface and reports legacy `navigator.modelContext` separately. Tool metadata is untrusted and no discovered tool is executed. Neither supported service has an accepted official WebMCP tool integration in this slice.

Run `bun run test:browser-media` to load a generated test-only extension copy in an isolated Chromium profile. The copy adds only a loopback fixture origin and host permission; the shipping manifest and scripts contain no loopback access. This synthetic workflow does not establish live provider support or an `activeTab` gesture initiated outside the browser.
