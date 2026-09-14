# Life on paired development devices

September 14, 2026. Architecture contract for the development milestone following main `0740fe0` / PR 94. This document separates the transport design from packaging, signing, deployment and OTA evidence owned by the distribution task. Implementation and test results must be recorded before this milestone is described as installable or released.

## Outcome and existing state

The coordinator Mac owns one configured Life account and its durable state. Explicitly authorized native clients on the user's Macs and iPhone open that same account through the existing pinned HTTPS listener. Conversation history, automatic memory, boards, settings, plans and generated apps come from the existing Life runtime. The dashboard, expanded apps and floating orb remain the product UI; native views provide connection, enrollment and a container rather than a second implementation of Life.

Before this milestone, Life runs as a separate loopback-only application, while the packaged coordinator provides native enrollment, device controls and household dashboard synchronization. Native pairing does not already grant access to Life. A native household private profile is enrollment-specific and is not a durable Life person identity. Neither a household grant nor a matching device label establishes ownership of someone's Life account.

The development slice uses one configured canonical Life actor. Multiple explicitly authorized devices can map to that actor. It does not migrate real household data, connect accounts, read existing credentials during tests, discover users from labels, or merge independent installations' stores. State remains on the coordinator; a device is not an offline replica.

## Authority and identity

Keep the version-one native invitation, QR and `app.open` grant contract unchanged. Add a separate persisted Life authority store, following the existing separation between native enrollment and household/speech authority.

The controller grants an active native `clientId` access to a host-configured `actorId`. The initial allowed actor set contains the canonical Life owner. The capability represents **Life account access**, including the Life spaces that this actor can already access. Existing LifeStore membership and record ownership checks remain authoritative. Native household membership, dashboard grants, device targets and pairing labels do not create Life memberships or supply actor identity.

Clients cannot choose the actor through a body field, URL, cookie contents or widget message. The controller management endpoint validates both the active enrollment and the configured actor allowlist. Grants have a monotonically changing authority revision, so revoking and later regranting access cannot revive an old web session. Creating a new enrollment requires a new Life grant.

Revoking one device stops that device's access. It does not delete the owner's conversations, connector accounts, reminders or other devices' grants. An accepted durable reminder or account research job belongs to the Life owner after admission; removing the initiating device does not cancel unrelated standing work. Personal reset remains the existing explicit, reviewed and journaled account operation.

## Native bootstrap and browser transport

The native app uses its existing enrolled HTTPS origin, certificate fingerprint and bearer credential in the pinned URLSession transport. It makes `POST /native/v1/life/session` with an empty JSON object and the existing native version/authentication headers. This endpoint retains the native prohibition on browser Origin, Cookie and Fetch Metadata headers.

The response is a bounded JSON object:

```ts
{
  sessionToken: string; // 32 random bytes, encoded as 64 lowercase hexadecimal characters
  expiresAt: number; // Unix milliseconds, at most 30 minutes and native enrollment expiry
  entryPath: "/life/";
}
```

This is a separate temporary web credential. It is never the native bearer, a local preview launch token, or a query/fragment parameter. Store only its digest in a bounded, in-memory session table: at most four sessions per client and 64 total. A new opening retires the same client's oldest excess session rather than locking that client out after four openings. Bind each session to client ID, actor ID and the current Life authority revision. Restart requires a new native bootstrap; it does not require a new device enrollment.

Swift validates the exact response shape, token and expiry, then installs a host-only `__Host-ellie_life` cookie using `WKHTTPCookieStore` on a nonpersistent website data store. The cookie is Secure, HttpOnly, SameSite=Strict and Path=/. It loads `/life/` only after cookie installation finishes. Neither the native bearer nor the web token is injected into JavaScript, localStorage, a generated widget, a launch URL or a script message handler.

The top-level WKWebView pins the same exact leaf certificate while retaining hostname and validity checks. Navigation remains at the exact enrolled HTTPS origin. Reject redirects, unexpected top-level paths, popups, downloads and arbitrary schemes. Existing generated widgets retain their opaque sandbox, restrictive content policy and typed host message channel; they gain no native bridge. User-initiated external links, when supported, go through a narrowly defined system-browser action without auth headers or cookie transfer.

Enrollment changes, logout, view teardown and authorization expiry cancel owned loads and clear the ephemeral website data. The container must not retain an old account's visible content when the enrollment changes. Renewal obtains another short-lived session through the native transport; web content cannot renew itself by reading a credential.

While the view is active, a bounded native check every thirty seconds uses `GET /native/v1/life/session` without minting a session. Its exact success response is `{allowed:true}`. Native enrollment failure returns 401, missing Life authority returns 403, and unavailable runtime/authority returns 503. Failure clears the private view. This check is necessary because API fetch failures inside the SPA do not pass through the WebView's navigation-response delegate. Cancel checks on teardown, reject stale callbacks and recheck on foreground when stale. A lost connection cannot provide instantaneous remote erasure; the server rejects each subsequent unauthorized request immediately, while the cooperative native view reacts to its next check.

## Gateway and Life runtime contract

Serve the existing Vite build at `/life/`, with relative asset paths resolving under `/life/assets/`. Keep the application API paths `/api/life/*` and `/api/connections/*`; they require the Life cookie, not the unrelated browser-control cookie. Static assets contain no personal state. A fixed map of built asset paths must not become an arbitrary file server.

Do not proxy an arbitrary URL, forward the existing local launch token, expose the one-actor loopback port remotely, or allow web-cookie requests through the native-only header gate. The HTTPS gateway calls an in-process handler:

```ts
interface NativeLifeApplication {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    context: {
      actorId: string;
      clientId: string;
      origin: string;
      signal: AbortSignal;
      isCurrent(): boolean;
    },
  ): Promise<boolean>;
}
```

The gateway supplies the fixed configured HTTPS origin and authenticated authority context. It validates canonical request paths, exact Host, allowed methods, duplicate headers and browser Origin before dispatch. Mutations require the exact origin; no CORS is enabled. Browser requests cannot carry an Authorization header or mint a native session. Query parameters are retained for the Life API's existing pagination, scope and revision checks. Local `POST /api/life/session` is unavailable through the embedded gateway.

Life checks the actor against its configured canonical owner, bypasses only the local launch-cookie/listener admission mechanism, and reuses the existing endpoint validation, body limits, revision checks, plugin policies and redacted errors. Streaming uploads, plugin HTML and paginated exports stay in the existing handlers; a blanket buffered JSON proxy must not truncate or reinterpret them.

Every request rechecks native enrollment, Life grant and web-session expiry. The captured `isCurrent` also fails after a grant revision change, shutdown or request cancellation. The gateway aborts active requests on native or Life revocation. Life folds that predicate into chat, pending-intent execution, plugin builds and improvement reviews and links the gateway signal to their controllers. It checks again after asynchronous extraction or queue waits and immediately before state-changing admission or publication. Suppressing a response after an unauthorized write is insufficient.

Once personal reset commits its durable authorization journal, recovery may finish after the initiating view disconnects. Check current device authority immediately before that journal is created, and do not bind subsequent host recovery to an expired request context. The same distinction applies to already accepted owner-level tasks: request cancellation stops uncommitted request work, not independently authorized durable schedules.

## Accounts, lifecycle and installation hook

Remote Life may inspect existing connected account status and use existing authorized account controls. It does not start Google authorization from a remote WebView. The current desktop Google flow needs a host loopback callback and an external system browser; using the remote HTTPS origin as that redirect is not equivalent. Return a clear setup-on-host response for remote account connection start/callback while preserving the existing local flow. A proper cross-device OAuth handoff is a later integration.

Add an embedded preparation phase to the Life application without binding its loopback server. It initializes the same stores, recovery, automatic-memory backfill and standing background work once. Track embedded requests and mutations in the same drain sets as local requests. Startup must finish the runtime preparation before gateway readiness; shutdown stops admission, aborts request work, drains actual handlers and only then closes stores. A drain timeout is an incomplete shutdown, not permission to close databases beneath running callbacks.

`@ellie/life/embedded` exports both cold `createLifeApplication` construction and the convenience `createEmbeddedLifeApplication` factory. The coordinator retains the cold application handle in `EmbeddedLifeLifecycle` before awaiting `prepareEmbedded`, so a preparation failure cannot lose ownership of callbacks that still need to drain. It acquires the JobStore lifetime lock, binds the coordinator and establishes native Life authority before constructing and preparing Life; the temporary gateway returns 503 until activation succeeds. Shutdown stops gateway admission, drains the owned Life application, and only then releases the coordinator lock. A failed drain keeps that lock held. A late factory result during shutdown is closed without activation.

Coordinator startup opts in with `--life-config PATH` or the path-only `ELLIE_LIFE_CONFIG` environment variable; using both is rejected. The private, bounded configuration has a closed version-one schema with an explicit canonical actor and state directory; optional model settings retain the existing loopback model restriction. OAuth client registration is an optional private-file reference. Secrets are not supplied in environment variables, and the operator cannot choose arbitrary UI assets: production uses the bundled build, while tests can inject an isolated asset directory through the application API. Missing configuration leaves the existing coordinator behavior unchanged; invalid explicitly selected configuration must be reported rather than represented as a working Life service.

Controller-side development setup uses `life-access grants`, `life-access grant CLIENT ACTOR` and `life-access revoke CLIENT`, through the existing authenticated controller transport. Pairing alone remains insufficient. These commands provide a concrete setup path; a graphical grant manager is not required to claim the bounded development slice and should not be implied until implemented.

The distribution owner consumes the application entry point, dependency closure, UI output, trusted configuration, state directory, readiness signal and shutdown hook. This Life work does not edit packaging, signing, activation policy, release feeds, OTA or installers. The packaging task decides how the trusted configuration path reaches the packaged coordinator, the actual artifact and rollout mechanism, and records its own verified evidence. No installable artifact or live service activation is implied by a successful source test.

The Mac path uses the existing `NativeEnrollmentStore` and a Life window with paste-enrollment controls. After pairing and the separate Life grant, it uses the same native session bootstrap as iPhone. The existing desktop coordinator controller identity is not forwarded as an enrolled client bearer. This keeps both devices on one verified identity and transport path; the local preview is not represented as the shared account.

## Ownership and acceptance

| Owner                | Independent responsibility                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Root integration     | Life embedded handler/lifecycle, runtime/package wiring, UI build base and configuration, final integration checks        |
| Sol backend engineer | Native Life authority, controller management, session/gateway routes, browser runtime wiring and synthetic protocol tests |
| Sol native engineer  | Shared Swift session transport and pinned web container, actual Mac/iPhone entry points, isolated native tests            |
| Astra architect      | This contract, async authority review, independent integrated review and blocker decisions                                |
| Distribution task    | Packaging, signing, installer/activation policy, coordinated development release and OTA artifacts                        |

Acceptance uses isolated synthetic state and credentials. It must demonstrate two granted clients reading and changing the same Life account across restart, an ungranted paired client denied, and a second person's records inaccessible. Exercise forged actor fields, malformed/duplicate cookies and headers, missing or wrong Origin, expiration, wrong certificate/hostname, session replay after revoke/regrant, and late uncooperative model/extractor completion after revocation. Confirm existing group checks still work without importing native household authority.

Browser coverage must load the real Life assets, preserve the dashboard/orb and generated widget isolation, exercise conversation memory and revision conflicts, and show setup-on-host account guidance. Native coverage must prove bootstrap stays in pinned URLSession, token installation precedes navigation, tokens do not enter URLs or scripts, and old account content is cleared on enrollment changes. Release claims additionally require the separately owned packaging/install checks; source and simulator tests do not prove deployment to physical devices.

## Current implementation status

The embedded runtime source is implemented. `tests/life-embedded.test.ts` passes five isolated tests on Node 24: the actual embedded factory shares durable records, conversations and automatic memory across two device contexts and restart; existing Life group access remains intact while another person's data is denied; relative assets and sandboxed plugin documents retain their route behavior; expired original-device authority suppresses progress and late model actions; extraction cancellation prevents late ingestion; and an already journaled personal reset completes as host work after its initiating device expires. The static asset fixture is synthetic, so that test does not establish native WebKit rendering of the production UI. TypeScript checking and targeted formatting/lint also passed at this checkpoint.

The production-UI browser test `apps/life-ui/tests/native.e2e.ts` passed through the native HTTPS gateway with synthetic paired clients. It exercises desktop and mobile layouts, the original Home/orb interface, shared plan creation and step completion, an actual arcade iframe and persistent storage, setup-on-host account guidance, one-client revocation without blocking the other, and retained plans after runtime restart. It also checks that the web session is absent from `document.cookie` and page content. Root inspected the desktop/mobile/arcade screenshots. This is Chromium coverage with synthetic TLS, not a claim that the native WebKit trust delegate or a physical iPhone has been tested; the final rerun and artifact receipt belong in the release validation record.

The shared Swift application compiles with the local Command Line Tools. `LifeWebSessionTests` now contains eight cases covering exact session/cookie validation, native-credential expiry bounds, short-session expiry, grant/session status mapping, strict read-only authority responses, navigation policy, stale authorization failure after reconnect, and cancellation of an active renewal without late cookie installation. The two lifecycle cases use actual isolated WebKit cookie stores while overriding navigation to make no network requests. These eight XCTest cases have **not run locally**: the selected Command Line Tools cannot import XCTest and no full Xcode installation is present. They remain required in the release owner's Xcode validation; a successful Swift build is not a substitute.

Backend protocol, startup ordering and browser integration are validated independently. Shared transport, physical-device rendering, installable artifacts and OTA status must be established from those checks and the distribution owner's evidence before marking the complete milestone released. This development work has not migrated real household state or changed live account permissions.
