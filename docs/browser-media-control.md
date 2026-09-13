# Browser media control

Ellie must control content inside streaming websites. Opening a URL does not satisfy this requirement. The first household workflow is: select the Mac and browser tab, move down the catalogue, move right within a row, open a selected title, start playback, then pause. The same interaction should eventually work for Netflix, YouTube, YouTube TV and Disney+. The remote remains native SwiftUI on Mac and iPhone.

## Current status

The installed node has four desktop operations: app opening, URL opening, window placement and adjacent placement. It cannot inspect or operate a website. The native YouTube playlist widget has a separate embedded player; its acceptance does not establish control of youtube.com or YouTube TV.

The first companion is in development on `codex/browser-media-control`, based on `9e75923`. Its branch was successfully pushed before implementation. It is an isolated development extension, not an installed browser integration, a native remote release or verified streaming-service support.

## WebMCP and browser adapters

WebMCP lets a site publish structured tools; it does not automatically add tools to a website. The [10 September 2026 draft](https://webmachinelearning.github.io/webmcp/) describes `document.modelContext.getTools()` and `executeTool(RegisteredTool, input, options)` for in-page agents. Browser agents have a different discovery mechanism. Legacy `navigator.modelContext` examples do not establish current compatibility. The draft is not a W3C Standard.

[Chrome's guide](https://developer.chrome.com/docs/ai/webmcp) describes an origin trial from Chrome 149 and a local development flag. Discover actual tools on the selected page. No first-party WebMCP integration has been verified for the four requested services; absence of an announcement does not establish absence of tools.

Prefer a reviewed binding to a site tool when available. Otherwise use a browser companion with tested, visible page controls. Page text, tool descriptions and outputs are untrusted content, not instructions or grants. Do not execute tools just because their names resemble media actions. Require an exact origin, expected schema and reviewed meaning. The first companion includes bounded read-only discovery, not arbitrary tool execution; it does not enable flags or restart the user's browser.

## Delivery slices

1. **Companion and browser tests.** An unpacked Manifest V3 extension uses `activeTab` and `scripting` on a selected tab. A minimal development popup exercises inspection, vertical scroll, horizontal row movement, title selection and player actions. Production origins initially cover Netflix and YouTube; both remain experimental until real-site workflows pass. YouTube TV and Disney+ need separate observed adapters. Use an isolated test profile and separately generated fixture-only build.
2. **Native node bridge.** Connect the extension through a bounded native messaging host with one allowed extension ID and a private local user channel. Add explicit media grants; existing app, URL, data and speech grants authorize no page control. Bind each command to a node, browser, tab, document generation and exact origin. Negotiate capabilities, propagate cancellation and prevent crash replay.
3. **SwiftUI remote and voice.** Show the selected service, current rows/titles and playback state in native controls. Resolve “right,” “open that” and “pause” against fresh state in the selected tab. Voice changes the input method, never authority. Accept the complete physical phone-to-Mac-to-browser flow before calling it household-ready.
4. **Service expansion.** Add YouTube TV and Disney+ against actual controls; then search, captions, volume and supported seeking. Test navigation, tab closure, browser restart, sleep/wake and revocation. Refresh state to recover from interruption; never automatically repeat an action.

[Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) requires a local user gesture and expires on cross-origin navigation or tab closure. A phone command cannot create that grant. The initial attended extension therefore needs a further explicit tab-connection flow for the persistent native remote. [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) supplies a browser-to-native transport, not household authorization. Arc supports Chrome extensions, but its native-host registration and current API compatibility need their own acceptance test; do not infer them from Chromium ancestry.

## Actions and outcomes

- Inspect only bounded visible titles, row handles and player state. Targets are transient handles bound to one tab/document snapshot. Do not export cookies, hidden account data or arbitrary HTML.
- Vertical scroll moves one bounded viewport. Left/right selects a specific horizontal row; ambiguous or unsupported controls return an unavailable result.
- Open revalidates the inspected element, destination and origin before selecting it. Stale or replaced targets are rejected. Navigation does not prove playback.
- Play, pause and seek are separate operations, not blind shortcut toggles. Confirm playing state and advancing media time; confirm paused state. Report blocked autoplay or unobservable state truthfully.
- Submit mutations once with a deadline. A timeout, navigation or cancellation may leave an unknown result. Inspect to recover; never replay automatically.
- Use the browser's normal authenticated player. Do not copy profiles, extract media URLs, bypass DRM or change subscriptions/accounts. Keep login and user-gesture requirements visible.

Netflix's [keyboard shortcuts](https://help.netflix.com/en/node/24855) describe player interaction, not reliable catalogue navigation or playback verification. YouTube's [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference) controls embedded players; it is not an API for youtube.com browsing, YouTube TV or another service.

## Acceptance

First load the actual companion into an isolated browser and run a synthetic catalogue with horizontal rows, title navigation and real HTML media. Demonstrate vertical scroll, row movement, selection, advancing playback and pause through the extension. Cover wrong origins, stale targets, ambiguous players and interruption without replay. Fake WebMCP tools validate protocol handling only, not service adoption.

Then run the sequence on each claimed service in an explicitly selected, authenticated browser tab. Record browser/service, observed results and missing controls without publishing viewing history or account data. A Netflix pass does not count as Disney+ or YouTube TV acceptance. The final household gate starts from the native iPhone and crosses the real coordinator/node connection.

Report synthetic browser, public-site browser, authenticated service, and physical phone-to-browser results separately. No such new acceptance is claimed by this plan.
