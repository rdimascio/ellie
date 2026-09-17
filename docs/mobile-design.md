# Ellie mobile design

The mobile interface uses midnight blue surfaces, pearl text, ice blue controls, and a violet orbital form for Ellie. The assistant is the visual focal point; schedule, finances, integrations, and settings screens use quiet surfaces and clear type.

This candidate contains only the Life web interface, its tests, preview fixture, npm scripts, and documentation. It was extracted from the owner-approved design work on `codex/mobile-redesign` at `6d5d404cda0c809ecd104a4b350e753d015ff1bf` onto fresh main `8c058ddbcc34e47aa1bde95fd4aab367a94e5e47`. The source changes were uncommitted. [The provenance manifest](mobile-design-provenance.json) records SHA-256 hashes for every selected source file and lists excluded native files.

The selected files have no overlapping upstream changes between those commits. The original native enrollment appearance edit overlaps upstream `apps/ios/Sources/NativeEnrollmentView.swift` and is explicitly excluded, along with all other native edits. The original worktree and port 4187 preview remain intact. This candidate does not alter the Xcode project, enrollment, voice, native applications, or service rollout.

The byte-identical extraction was committed as `23fd936e4fc71fdd1b25837d9ecbd8f6c7a2f4a7`. Subsequent review corrections tighten financial provenance and test cleanup only in the candidate; their paths and purpose are recorded separately in the manifest. Original source hashes continue to describe the initial extraction, not these later corrections.

## Design system

| Token     | Color     | Role                    |
| --------- | --------- | ----------------------- |
| Midnight  | `#080D19` | App background          |
| Deep blue | `#111A2B` | Raised surfaces         |
| Pearl     | `#F1F5FC` | Primary text            |
| Ice       | `#A2D5F8` | Actions and focus       |
| Mist      | `#9AAAC2` | Secondary text          |
| Violet    | `#AAA4ED` | Ellie and plan progress |

Avenir Next provides the web interface's rounded, readable typography with system fallbacks. The mobile layout puts the assistant invitation first, followed by the current time, agenda, plans, and installed apps. The floating navigation dock reserves its center for Ellie. On desktop the assistant control has a dedicated right gutter. The presence is drawn with CSS; there are no downloaded images, font requests, or decorative animation loops.

The design uses existing data and actions. Agenda times respect the profile time zone; plan loading and error states remain distinct. The new assistant invitation opens the existing conversation. It does not start recording or submit a prompt.

The mobile dock is Home, Today, Ellie, Finances, and Integrations. Memory and custom tools remain accessible under Settings → Library and tools, and saved plans still open their existing detail view. Changing screens resets the page scroll position.

Finances displays personal Plaid connections and current financial observations from those connections. The bootstrap contains record summaries without connected metadata or provenance, so Finances reads full candidate records through the existing authenticated detail API. Account-derived labels require a derived provenance reference to the same `connected-source-{connectionId}`, with no invalidated provenance. Missing or empty provenance, expired insights, invalidated sources, inactive connections, and records from other people or shared spaces are excluded. A summary's `valid` status alone is insufficient; full record responses need no summary-only status field. Account loading, errors with retry, and empty states are explicit. Details that fail to load are hidden with a retry notice. Asking Ellie about an insight opens an editable draft without submitting it. The service does not expose balances or a transaction ledger, and this screen does not invent them.

Integrations brings the existing Gmail, Google Calendar, and Plaid connection controls into a dedicated screen. OAuth handoff, connection modes, refresh, and disconnect retain their existing behavior. New Plaid linking is not yet available in the connector service; the provider card reports this when unconfigured. The preview includes synthetic connected accounts and one financial insight solely for design review.

## Scope and files

- `apps/life-ui/src/interface.css`: visual tokens, mobile layout, navigation, conversation, secondary screens, focus, reduced motion, and contrast support.
- `apps/life-ui/src/InterfaceIcon.tsx`: consistent line icons and the CSS orbital form.
- `apps/life-ui/src/App.tsx`: assistant invitation, agenda times, plan progress, navigation semantics, and a composer that grows with its draft.
- `apps/life-ui/src/Finances.tsx` and `financial-insights.ts`: financial accounts, current personal observations, loading, error, and empty states.
- `apps/life-ui/src/Connections.tsx`: dedicated Integrations presentation using the existing connection operations.

Mobbin was requested and its search connector was called. It returned a paid-plan requirement and supplied no visual references. This design is original and does not claim to reproduce a Mobbin screen.

## Interactive review

Use Node.js 24 and the repository's pinned Bun version:

```sh
bun run life:design-preview
```

Open `http://127.0.0.1:4187/review`. The review page lets you choose a 320, 390, or 430 pixel phone frame and interact with the actual production UI. The fixture serves synthetic data only on loopback. Requests that change data are rejected with an explicit preview message; it has no coordinator connection, credential, model access, or ability to execute commands.

The owner's existing preview uses that port in the original worktree. Do not stop or replace it for review. Automated design tests build this candidate and use an ephemeral loopback port instead.

## Validation

```sh
bun run lint
bun run format:check
bun run contracts:check
bun run typecheck
bun run life:test:design
ELLIE_DESIGN_BROWSER=webkit node apps/life-ui/tests/mobile-design.e2e.ts
bun run life:test:mobile-orb
node apps/life-ui/tests/life.e2e.ts
node apps/life-ui/tests/connections.e2e.ts
```

The new acceptance test covers all primary mobile views, 320/390/430/1024 pixel widths, horizontal overflow, navigation selection and scroll reset, 44 pixel navigation hit areas, retained drafts, composer focus, Escape and close behavior, financial loading errors and recovery, unconfigured Plaid state, and no write requests while navigating or drafting. Financial insight unit tests cover source freshness, personal scope, connection eligibility, and missing, empty, non-derived, mismatched, or invalidated provenance. A cleanup test injects a browser launch failure and verifies that the owned preview server closes. Screenshots are written to the ignored `test-results/mobile-redesign` directory. WebKit checks browser rendering, not a physical iPhone or its keyboard and permission dialogs.

The connected-account end-to-end test publishes a real Plaid insight through the connector broker using fixture settled transactions. It verifies the production summary/detail split and displays that insight in Finances, while a lookalike memory created through the signed-in record route remains hidden. This uses deterministic local fixtures and no model or live account access.

The candidate is validated with the gates above: lint, formatting, generated-contract drift, TypeScript, Life production build, financial eligibility tests, Chromium and WebKit mobile acceptance, mobile orb regression, and the existing Life and connection end-to-end suites. The earlier full workspace result on the original redesign is historical evidence only, not a full-suite claim for this candidate.

The existing Life end-to-end suite passed against the redesign, including conversation, dashboard editing, source, plan, and data-management behavior. The desktop orb assertion now verifies separation from dashboard controls rather than its former exact screen-center coordinate.

No native build, device job, model job, merge, deployment, or service rollout is part of this candidate. Browser screenshots do not validate physical iPhone keyboard or permission behavior.
