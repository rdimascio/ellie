# Browser media control

Ellie must control content inside streaming websites. Opening a URL does not satisfy this requirement. The first household workflow is: select the Mac and browser tab, move down the catalogue, move right within a row, open a selected title, start playback, then pause. The same interaction should eventually work for Netflix, YouTube, YouTube TV and Disney+. The remote remains native SwiftUI on Mac and iPhone.

## Current status

The current production browser route supports an explicitly selected companion tab, reviewed WebMCP tools when present, and a scoped Accessibility adapter for YouTube when WebMCP is unavailable. Native browser status, read, search, result selection, and play/pause requests cross the authenticated coordinator and node. Accessibility mutations are dispatched once and reported as unknown until a separate read observes the page; the result never proves the prior command caused that state.

A fresh YouTube read now includes a bounded `view.site` observation of home, results, watch, login, or unsupported, plus unambiguous visible player state when available. Each Accessibility mutation consumes that observation and needs another read before a further action. Login, unsupported pages, stale documents and ambiguous player state block an unsupported action before dispatch. The field is optional for older companions. Synthetic browser and native-route tests cover this contract; they do not establish a successful real-site or physical iPhone-to-browser workflow. Actual Arc acceptance still requires an unobstructed selected page and the attended companion connection.

Apple Watch is now part of the requested media experience: while an Ellie-controlled session plays, the watch should surface its title, target device and supported player controls. This is a new requirement, not an existing Watch app or accepted system Now Playing integration.

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

## Apple Watch

Use the same observed media session for phone and watch. The first watch remote needs a native SwiftUI view showing the service, title, target Mac, play/pause and seek only when supported. Actions must include the selected session/document generation; an offline or replaced tab cannot receive an old command. A button shows a pending state until the browser confirms the change. Never queue media mutations for later delivery when the watch or phone reconnects.

Apple's [NowPlayingView](https://developer.apple.com/documentation/WatchKit/NowPlayingView) lets the system choose the current or recent watch/iPhone audio source. It is not an API that selects an arbitrary Mac browser tab. [MPNowPlayingInfoCenter](https://developer.apple.com/documentation/mediaplayer/mpnowplayinginfocenter) describes media the app plays. Do not assume publishing remote metadata will make Ellie the phone's system player, or use silent audio to force that behavior.

For automatic visibility, evaluate a playback Live Activity with a custom watch layout. Apple documents [Live Activities in the Smart Stack](https://developer.apple.com/videos/play/wwdc2024/10068/) starting with iOS 18 and watchOS 11, and [launching a watch app from a Live Activity](https://developer.apple.com/documentation/ActivityKit/launching-your-app-from-a-live-activity). System presentation preferences, permissions and background update delivery still apply. A native watch remote and a Smart Stack activity are separate from the built-in Now Playing app.

Before implementation, verify the command path and current SDK support for interactive watch Live Activities, WatchConnectivity reachability and locked/suspended-phone operation. Keep the default local-first; do not silently add Apple Push Notification service or claim continuous LAN polling while iOS is suspended. Show stale/disconnected state honestly. Watch pairing and explicit phone media authority must not become a new implicit household grant.

Accept in a paired simulator first, then on the user's signed physical iPhone/Watch: start browser playback, observe the watch surface, pause exactly once and verify the Mac player, resume, seek when supported, switch titles, close the tab and disconnect/reconnect. Test the phone locked and app suspended separately. Record what appears automatically under the user's actual settings and what requires opening Ellie. No physical Watch acceptance has occurred.
