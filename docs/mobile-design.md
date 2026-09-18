# Ellie mobile design

The mobile interface uses midnight blue surfaces, pearl text, ice blue controls, and a violet orbital form for Ellie. The assistant is the visual focal point; schedule, finances, integrations, and settings screens use quiet surfaces and clear type.

## Design system

| Token     | Color     | Role                    |
| --------- | --------- | ----------------------- |
| Midnight  | `#080D19` | App background          |
| Deep blue | `#111A2B` | Raised surfaces         |
| Pearl     | `#F1F5FC` | Primary text            |
| Ice       | `#A2D5F8` | Actions and focus       |
| Mist      | `#9AAAC2` | Secondary text          |
| Violet    | `#AAA4ED` | Ellie and plan progress |

Avenir Next provides the web interface's rounded, readable typography with system fallbacks. The native app uses Dynamic Type. The mobile layout puts the assistant invitation first, followed by the current time, agenda, plans, and installed apps. The floating navigation dock reserves its center for Ellie. On desktop the assistant control has a dedicated right gutter. The presence is drawn with CSS and native SwiftUI shapes; there are no downloaded images, font requests, or decorative animation loops.

The design uses existing data and actions. Agenda times respect the profile time zone; plan loading and error states remain distinct. The new assistant invitation opens the existing conversation. It does not start recording or submit a prompt. The native home adds a direct Ellie Life link only when a paired credential is available; the existing Life authorization still applies.

The mobile dock is Home, Today, Ellie, Finances, and Integrations. Memory and custom tools remain accessible under Settings → Library and tools, and saved plans still open their existing detail view. Changing screens resets the page scroll position.

Finances displays personal Plaid connections and current financial observations from those connections. Expired insights, invalidated sources, inactive connections, and records from other people or shared spaces are excluded. Account loading, errors with retry, and empty states are explicit. Asking Ellie about an insight opens an editable draft without submitting it. The service does not expose balances or a transaction ledger, and this screen does not invent them.

Integrations brings the existing Gmail, Google Calendar, and Plaid connection controls into a dedicated screen. OAuth handoff, connection modes, refresh, and disconnect retain their existing behavior. New Plaid linking is not yet available in the connector service; the provider card reports this when unconfigured. The preview includes synthetic connected accounts and one financial insight solely for design review.

## Scope and files

- `apps/life-ui/src/interface.css`: visual tokens, mobile layout, navigation, conversation, secondary screens, focus, reduced motion, and contrast support.
- `apps/life-ui/src/InterfaceIcon.tsx`: consistent line icons and the CSS orbital form.
- `apps/life-ui/src/App.tsx`: assistant invitation, agenda times, plan progress, navigation semantics, and a composer that grows with its draft.
- `apps/life-ui/src/Finances.tsx` and `financial-insights.ts`: financial accounts, current personal observations, loading, error, and empty states.
- `apps/life-ui/src/Connections.tsx`: dedicated Integrations presentation using the existing connection operations.
- `apps/ios/Sources/IOSAppearance.swift`: native palette, surfaces, and orbital form.
- Native dashboard, widget sheets, pairing, sync, Mac control, browser, and voice views share the new appearance. Existing stores, authorization, command dispatch, persistence, and recovery logic are unchanged.

Mobbin was requested and its search connector was called. It returned a paid-plan requirement and supplied no visual references. This design is original and does not claim to reproduce a Mobbin screen.

## Interactive review

Use Node.js 24 and the repository's pinned Bun version:

```sh
bun run life:design-preview
```

Open `http://127.0.0.1:4187/review`. The review page lets you choose a 320, 390, or 430 pixel phone frame and interact with the actual production UI. The fixture serves synthetic data only on loopback. Requests that change data are rejected with an explicit preview message; it has no coordinator connection, credential, model access, or ability to execute commands.

## Validation

```sh
bun run life:test:design
ELLIE_DESIGN_BROWSER=webkit node apps/life-ui/tests/mobile-design.e2e.ts
bun run life:test:mobile-orb
node apps/life-ui/tests/life.e2e.ts
node apps/life-ui/tests/connections.e2e.ts
```

The new acceptance test covers all primary mobile views, 320/390/430/1024 pixel widths, horizontal overflow, navigation selection and scroll reset, 44 pixel navigation hit areas, retained drafts, composer focus, Escape and close behavior, financial loading errors and recovery, unconfigured Plaid state, and no write requests while navigating or drafting. Financial insight unit tests cover source freshness, personal scope, and connection eligibility. Screenshots are written to the ignored `test-results/mobile-redesign` directory. WebKit checks browser rendering, not a physical iPhone or its keyboard and permission dialogs.

The initial redesign passed workspace `bun run check`: 889 tests passed, one was skipped, and none failed; lint, formatting, generated contracts, TypeScript, and both web production builds passed. The navigation follow-up is validated with focused financial tests, mobile acceptance tests, connection and Life end-to-end suites, lint, formatting, TypeScript, and the Life production build.

The existing Life end-to-end suite passed against the redesign, including conversation, dashboard editing, source, plan, and data-management behavior. The desktop orb assertion now verifies separation from dashboard controls rather than its former exact screen-center coordinate.

Swift syntax parsing and Xcode project property-list validation pass. A native iOS build, simulator screenshots, Dynamic Type review, and the existing XCTest suite still require full Xcode; this machine has Command Line Tools only. No native build or device installation is claimed.
