# Browser media companion development slice

This is an unpacked development extension for exercising page controls inside a selected browser tab. It is not installed automatically by an Ellie service. The product remote remains SwiftUI.

The source is `apps/browser-media-extension`. Its production manifest requests `activeTab`, `scripting`, and local `nativeMessaging`. Its code permits the exact HTTPS origins `www.netflix.com`, `www.youtube.com`, and `tv.youtube.com`; there are no persistent all-site permissions, website-to-native HTTP server, browser-cookie reads or household credentials.

## Scope

The popup provides explicit inspection, vertical scrolling, rightward movement within a scrollable title row, opening an inspected title, and play/pause/seek for an unambiguous visible HTML video. Inspection returns transient title handles and bounded playback state. Selection validates the existing element and snapshot before acting. There are no arbitrary JavaScript, selector or tool-name commands.

Player actions distinguish observed playback from a submitted request: play requires advancing media time, pause requires the paused state and navigation alone is not playback. Cancellation stops waiting where possible; an already submitted action may still have taken effect. Unknown outcomes must be recovered by inspection, not automatic resubmission.

Mutation IDs are retained per tab by the extension worker, including across document reload, up to 256 actions. Capacity is refused instead of evicting replay protection. This ledger is not durable across a worker/browser restart; the companion never automatically resubmits old actions. The worker supplies an absolute deadline checked by the controller before mutation so an invocation that starts late cannot act after its deadline. Downloads and explicit new-window title links are excluded.

All three production origins remain experimental. A synthetic catalogue passing tests does not establish authenticated Netflix, YouTube, or YouTube TV control. The Netflix title adapter recognizes bounded same-origin title/video links and scrollable row containers; it does not cover every service layout, carousel, overlay or player. The public Netflix landing page does not provide authenticated playback. The separate YouTube TV companion reports only a gated page or a single observed player and permits vertical scroll or play/pause after a fresh read; search, title selection and horizontal rows are unavailable. It does not identify which program a video contains. Disney+ remains disabled. No DRM, authentication or subscription behavior is bypassed.

For an explicitly selected Netflix tab, the native companion uses the existing native-host connection and a distinct `companion` result source. It accepts a bounded read, vertical scroll, a horizontal scroll against an explicitly chosen observed row, selection of an item from that read, and play/pause from one observed watch-page player. Row IDs are opaque, tied to the read, capped at eight and rechecked against the current DOM before dispatch; over-cap or stale rows are unavailable. Search requires one unambiguous accessible search input pinned by a fresh read, rechecked before one bounded input event. Search dispatch alone does not prove results: explicit refresh/read must observe a `/search?q=…` results page and fresh title identities before selection. Missing or changed search controls and ambiguous controls are unavailable. Every dispatched mutation invalidates the old binding and has an unknown result until a new explicit refresh/read. Synthetic browser fixtures do not verify Netflix account content or real playback.

WebMCP discovery is read-only and bounded. It checks the current `document.modelContext.getTools` surface, reports legacy API presence separately, and distinguishes unavailable, failed and timed-out discovery. Returned tool metadata is untrusted. No discovered tool is executed or treated as a media grant. No streaming-service WebMCP implementation has been accepted.

## Development use

Use a separate browser profile for development. In a Chromium browser that supports unpacked Manifest V3 extensions, open the Extensions page, enable developer mode in that profile and load `apps/browser-media-extension`. Open a permitted service and invoke **Ellie Media Companion** on the intended tab. The extension's local user gesture supplies temporary `activeTab` access; receiving a phone command cannot create this browser grant.

For a packaged development release, load the immutable extension directory at `RELEASE/payload/lib/ellie/apps/browser-media-extension`, where `RELEASE` is the exact selected release directory. Install the native messaging host from that same captured release using the [supported host command](browser-native-host-management.md); do not mix a checkout extension or another release's host with it. The builder validates the manifest entrypoints and every literal relative JavaScript dependency, copies the complete extension tree, then validates the copied closure. The native installer verifies the complete per-file manifest when staging the release. This supplies a version-matched directory for an attended browser installation; it does not install an extension, grant `activeTab`, notarize it or establish real-site acceptance.

Use **Inspect titles** after navigation or when a title list changes. Select only an inspected title, and check the page when an action cannot be verified. The popup remains a developer control surface; the existing native phone route separately requires an authenticated node, explicit browser grants, selected document and fresh observation. Synthetic end-to-end tests cover that route, while installed Arc/native-host and real-service acceptance remain separate owner-attended checks. The Watch remote depends on the same selected session; this extension alone supplies neither a Watch grant nor physical acceptance.

## Automated validation

With Node 24, Bun 1.4.2 and the repository's frozen dependencies:

```sh
bun install --frozen-lockfile
node node_modules/@playwright/test/cli.js install chromium
bun run test:browser-media
```

The browser tests copy the extension into an owned temporary directory and replace its exact production allowlist with a fixture origin. The test manifest grants that loopback origin access, so these tests do not validate the real user's `activeTab` gesture. They load the actual service worker and controller into a separate Chromium profile and send commands from an extension page. Synthetic HTML media is generated locally; no streaming account or household credential is used. Ordinary Node checks separately validate the shipping permission/origin policy.

Keep evidence separate: extension-driven synthetic browser tests, actual public-site behavior, authenticated streaming playback, installed-browser access, and the physical phone/watch-to-Mac path. Only claim the stages recorded in the dated validation document.
