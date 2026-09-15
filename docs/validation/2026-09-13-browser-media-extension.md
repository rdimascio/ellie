# Browser media companion validation — 2026-09-13

This is an isolated browser-side development slice based on household-state commit `9e75923`. The branch `codex/browser-media-control` was successfully pushed before implementation. No installed browser, household service, native phone or watch integration was changed.

## Synthetic browser

The dedicated Node/Playwright suite loads a real Manifest V3 extension in a persistent, isolated bundled Chromium profile. Its copied source allowlist is explicitly replaced with a loopback fixture origin and its test manifest adds fixture-only host access. Commands are sent through an extension page to the actual service worker and injected controller. The production popup buttons and real `activeTab` user gesture are separate, unvalidated boundaries.

The two browser scenarios pass. The positive workflow scrolls down, inspects title handles, scrolls horizontally within a row, inspects again, selects a title, observes same-tab navigation, and plays then pauses a locally generated HTML video. Playing requires advancing media time; the source contains no remote recording or streaming account.

Negative cases exercise wrong origin, detached/stale targets, document reload invalidation, ambiguous visible videos, unavailable playback, pre-cancellation, a concurrent busy result, cancellation, duplicate IDs and WebMCP discovery timeout. Final review regressions reject a repeated mutation ID after reload, exclude download/new-window anchors and changed target attributes without opening another tab, and verify that an injected controller invocation with an expired worker deadline leaves scroll state unchanged.

The deadline regression exercises the expired invocation boundary; it is not physical browser suspension or OS sleep/wake acceptance. The fixture's public API metadata is synthetic. It does not prove WebMCP adoption by a streaming service.

## Checks and coordinating review

The implementation baseline passed the full Node 24/Bun 1.4.2 check: 234 tests passed, one existing platform skip, plus lint, formatting, contract drift, type checking and the prototype build. After the final browser-only hardening, the dedicated browser suite passed again and lint/format/type checks passed. Root independently repeated the loaded-extension suite and shipping manifest/origin policy check before publication.

Review fixed document targeting, missing command bounds, stale title validation, clipped/ambiguous player selection, invalid row directions, unbounded play waiting, popup busy ownership, misleading discovery errors, invocation deadlines, replay across reload and new-window/download candidates. A bounded per-tab worker ledger is explicitly non-durable across worker/browser restart; no automatic replay is added.

## Public-page inspection and outstanding acceptance

Root separately inspected the public Netflix landing page. Its trending titles were buttons and the document exposed no WebMCP tools through the available browser tool discovery. That observation does not establish the authenticated catalogue's behavior or all Netflix pages. No Netflix account was used. Temporary research tabs were closed.

Netflix and YouTube remain experimental origins; this slice does not establish authenticated browsing or DRM playback on either. YouTube TV, Disney+, actual Arc/Chrome installation, the browser user gesture, native messaging, phone controls, watch controls, locked-phone operation and physical network/sleep recovery remain pending. The standalone embedded YouTube player's earlier hardware acceptance is unrelated to this site's controller.

Feature expansion is now parked behind the stable native release backlog. Publication of this companion is not deployment or household acceptance.
