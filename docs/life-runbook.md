# Run Ellie Life

Ellie Life is an opt-in local development application. It runs alongside the existing native Ellie infrastructure and uses a separate private state directory. It does not require a model for supported life commands or the built-in arcade and MLB extensions.

## Start

Use Node.js 24 and the repository's Bun version. From this checkout:

```sh
bun install --frozen-lockfile
bun run life
```

For the isolated overnight checkout on this Mac, the ready-to-run command is:

```sh
cd /Users/ryan/ellie-life-harness
PATH=/Users/ryan/.volta/tools/image/node/24.21.0/bin:$PATH bun run life
```

Open the one-use link printed by the launcher. The sign-in token is removed from the browser address immediately after the client reads it. The local service binds to `127.0.0.1:7440`; `--port 0` selects an available port. Data defaults to `~/.ellie-life`. Stop the foreground process with Control-C. Restarting preserves records, installed apps, scores, settings, scheduled work and private conversation history. Browser authentication starts fresh. Interrupted chat requests remain visible as uncertain and are not automatically replayed.

For a separate state directory:

```sh
bun run life:build
bun run life:start --state-dir /absolute/private/directory --port 7441
```

The directory must be outside the source checkout, owned by the current OS user, and private (0700). Existing `~/.ellie` service state is deliberately rejected. Do not copy private life databases into Git.

## Automatic connected assistance

Open Settings → Connected accounts. Connecting with “Automatically create private preparation plans” selected gives Ellie standing permission to maintain private plans and reminders from that account. Observe keeps the analysis and inferred memories without creating preparations. A connection starts a durable sync and three bounded specialist checks; hourly sync and daily planning maintenance continue while the Life process runs. The ordinary dashboard, plan widget and conversation orb remain the interface.

The current Google Calendar and Gmail adapters need a registered Google desktop OAuth client supplied by the host. The native loopback flow uses PKCE and read-only scopes. Provider credentials live in a private encrypted vault under the separate Life state directory; they never enter generated widgets or personal exports. Plaid's read adapter accepts host-provisioned credentials, but consumer Link onboarding is not implemented. See [connected-life architecture and status](life-connected-plan.md) for supported providers and setup dependencies.

For developer account setup, append `--google-client-id REGISTERED_DESKTOP_CLIENT_ID` to `bun run life:start`. If Google issued a client secret, use `--google-oauth-client /absolute/private/google-desktop-client.json` instead. The loader accepts Google's downloaded `installed` client JSON; the file must be outside the repository, owned by the current user, and mode 0600. Token endpoints remain fixed. Registration and any required provider verification must be completed with Google; the application does not include a shared registered client. Ordinary account owners use the Connect button once the host is configured.

### Installed coordinator account setup

When Life runs inside the installed coordinator, configure that coordinator's private Life host file with the registered Google desktop client and restart through the reviewed rollout procedure. On the coordinator Mac, the local owner can then run:

```sh
bun run ellie life settings
```

The command authenticates to the current coordinator over its existing pinned loopback controller connection. The same running Life application lazily opens **Settings → Connected accounts** in the Mac's external system browser; it does not start a second Life process or open another copy of the state. Its launch capability is short-lived and one-use. Normal command output confirms only that settings opened and never prints the local URL, launch token or account credentials.

This command is available only on the coordinator host, only when Google OAuth is configured, and only while that configured Life application is current. Google authorization returns to that application's exact loopback callback. A remote native Life view can inspect existing connection status, but it still cannot start or complete OAuth; connect the account directly on the Mac hosting Ellie.

In Connected accounts, choose Google Calendar or Gmail separately; each requests only its own read-only scope. The “Automatically create private preparation plans” checkbox starts selected, so clear it for Observe mode. Finish Google sign-in in the external browser and return to Ellie; a denial clears the pending setup when the connection status updates. If the link expires or you abandon setup, use **Stop setup** to invalidate it before trying again. **Refresh** reads the connected account again. **Disconnect** removes Ellie's local credential and connection; it does not revoke consent at Google, which must be managed in the Google account if desired. If an action fails, read the displayed error and current connection state before retrying. Actual Google registration, consent, and account-data acceptance require the owner's account and remain separate from the synthetic test below.

After connecting Calendar, open **View imported activity** and choose **Calendar to read**. Ellie imports one selected calendar at a time; changing it clears that connection's old calendar cursor and imported evidence before the next background read. The panel shows up to ten private event previews, the last completed import and any sync error. Gmail's panel shows up to ten read-only message header/snippet previews without fetching bodies. Select one imported message to read its inline plain-text body on demand. Ellie displays at most 32 KiB, labels truncation or when only the first of multiple inline plain-text parts is shown, and says when only HTML or an external attachment is available; it does not render HTML, load remote images, fetch attachments, or send mail. The body remains transient in the open view and is cleared on refresh, account switch, unmount or disconnect. **Refresh** requests another provider read. A disconnected account no longer exposes its imported preview. Multi-calendar selection and actual Google account acceptance remain pending.

On an enrolled iPhone with an explicit `life.account` grant, the Calendar dashboard widget can select one authorized Google Calendar connection and read its already imported upcoming events. Its **Refresh** reads the host's existing selected-calendar evidence in the phone's display time zone; it does not call Google or start a provider sync. The widget labels the last import and read times, keeps a failed read's rows only as cached data in the current app session, and requires a new read after relaunch. Removing the account or revoking access clears private rows. Calendar choice and provider refresh remain in Connections on the host. Actual account and physical-phone acceptance are still pending.

With suitable connected evidence, Ellie can infer a tentative morning appointment preference, prepare for a confirmed doctor visit, recognize communication cadence and identify recurring settled expenses. Explicit preferences and corrections take precedence. A calendar booking or a message snippet does not prove an unfinished step was completed. Missing history remains missing evidence.

Run the complete connected workflow without real accounts or credentials:

```sh
bun run life:test:connections
```

This starts an isolated synthetic service, exercises background sync and plan creation, checks the existing mobile dashboard and account controls, and verifies export, disconnect and reset. It closes the fixture afterward. These tests do not connect your accounts.

## Direct chat requests and manual acceptance examples

Ordinary conversation captures and summarizes memories automatically; no Markdown upload is needed. The commands below remain useful for explicit corrections, new requests and developer acceptance. They are not a required setup script for connected assistance.

- “Remember that I prefer morning appointments.”
- “My friend's birthday is next Saturday. They love gardening. Help me get something under $40.”
- “Remind me to buy a garden gift when I'm at Target.”
- “I'm shopping at Target.”
- “Complete buy a garden gift.”
- “Set a timer for 2 minutes.”
- “Every Monday at 9 am remind me to plan the week.”
- “Create a plan called Doctor visit: Confirm appointment; Gather forms; Prepare questions.”
- “List plans.”
- “Complete step 2 of plan Doctor visit.”
- “Reopen step 2 of plan Doctor visit.”
- “List routines.”
- “Pause routine plan the week.”
- “Resume routine plan the week.”
- “Cancel routine plan the week.”
- “Could you remind me to phone Maya?” (Ellie asks when and keeps the draft.)
- “Create a group called Family.” (Open the returned space to add shared records.)
- “In this conversation, be brief.”
- “Use saved preferences again in this conversation.”
- “Build an arcade shooter with a high score widget.”
- “Build an MLB standings and today's games widget.”
- “Teach Ellie: Offer two options when helping me plan dinner.”
- “List guidance.”
- “Use Cooking handbook as guidance.” (For an uploaded source up to 4,000 characters.)
- “Summarize orchids in the background.” (Uses matching uploaded sources.)
- “Review my feedback and suggest an improvement.” (Uses recent private corrected examples.)
- “List improvements.”
- “Adopt improvement Two dinner options.” (Use the exact name of a reviewed proposal.)

Your world → Plans holds saved checklists and their progress. Complete or reopen a step there, or use the same commands in chat. Refresh plans to pick up changes made in another window. A stale checkbox update refreshes the current plan instead of overwriting it. These lists record your progress; their step text is not automatically executed.

Use Your world to inspect and correct the resulting records, teach from files, or review a calendar/contact import. Source lists use compact previews; opening a record loads its full content. Your space holds playable and readable extensions with retained revision controls. Activity shows durable work, source-worker progress, cited summaries and feedback. Today shows current commitments and delivered notifications. Settings supports default, active group and user preferences; authority remains separate from those preferences.

Adopted guidance is versioned configuration. Pause or resume a listed guide through chat using its title, or open Guidance in Your world to review linked sources, revise instructions and restore a retained version. Source changes exclude stale guidance until the current content is reviewed. Background summaries coordinate up to four source workers; deleted or changed source content is omitted, and an old stored result becomes unavailable when its citations are no longer current. See [teaching through content](life-teaching.md).

While the service is running, Ellie checks timed events within 48 hours and all-day events today or in the next two local calendar days on startup and every fifteen minutes. Preparation appears in Today using your time zone, proactivity preference and quiet hours. Pending preparation notices are deduplicated; checking again does not create a pile of reminders for the same event. Postponing or cancelling the linked event hides notices that are no longer relevant.

Delivery controls manage notification scheduling. Pausing preserves the original schedule and missed-run policy; it does not freeze a timer countdown. Cancellation stops remaining work where possible and preserves the saved record and prior outcomes. A completed scheduling step is separate from a verified delivered notification. Today, Your world and chat show this distinction.

Place-linked suggestions currently depend on explicit fresh context signals, including “I'm shopping at …”. They do not imply continuous phone location, access to unrelated apps, a retailer account, or a price-feed subscription. A sleeping or stopped coordinator cannot deliver new browser notifications. Timers that must sound while the coordinator is asleep need a future native local-delivery integration.

## Learn from corrections

In Activity, choose one to three private feedback examples for an improvement review. This selection is separate from evaluation export. Ellie proposes an instruction and shows the original reply beside an offline candidate reply. Review the exact instruction, then choose **Adopt as guidance** or **Dismiss proposal**. Nothing runs during the preview and no guidance changes until adoption. Adopted private guidance can be revised, paused or rolled back in Your world. It applies in the personal space.

A changed or deleted example blocks adoption of the old proposal and hides its replay. Existing adopted instructions remain your retained guidance until you edit, pause or delete them. Candidate replay output is private retained content and can be removed with its proposal or a personal reset. This is a user-reviewed improvement loop, not model-weight training or a quality score. See [private improvement review](life-improvement.md).

## Your personal data

In Settings, use **Inspect my data** to review the private records, sources, guidance, background work, apps and storage held by Ellie. **Download my archive** collects the personal store exports after checking their revisions. Shared group records, apps and tasks are excluded; your own values stored inside a shared app are included. A change during export requires a fresh review so the file cannot silently mix revisions.

Chat history belongs to its author, including conversations using a group context. History supports reopening and deleting conversations; transcripts are stored in the private service database, not browser local storage. Archives include your conversations in currently accessible spaces. Reset deletes all of your conversations, including those whose group access was later revoked. Historical messages can retain quoted or remembered text after a life record is changed; delete the conversation or reset personal data to remove those transcripts. Changed source or settings context is excluded from future model history.

Use **Manage shared spaces** to create, open or rename a locally owned space. Personal records remain personal when switching spaces. Space names and owner changes use revisions so an older window cannot overwrite a newer rename. Invitation, account linking and synchronization are not enabled by these controls.

Tone and Length at the top of chat send visible conversation commands. Temporary preferences survive reopening that conversation; a new conversation inherits saved preferences again. Explicit lasting instructions change personal preferences unless the user expressly requests a group setting and has authority to change it. Helpful/Needs work ratings keep the rated exchange in personal feedback even when the conversation uses a shared space.

**Review reset** shows the scope before you explicitly reset your private data. Reset pauses new mutations, settles active requests and private background work, and journals progress across the three stores. It preserves shared group content and memberships, and removes your own storage in shared apps. If work cannot stop immediately, the status remains pending and can be retried. A restarted service restores the pending pause. Previously downloaded files, device backups and external systems are outside this local reset.

## Optional local model

An explicitly configured, already running OpenAI-compatible local model can answer broader questions using scoped memories, preferences, source evidence and a partial selection of people, needs, places and commitments, and generate or revise self-contained custom applications:

```sh
bun run life:start --model-url http://127.0.0.1:8080/v1 --model YOUR_INSTALLED_MODEL_ID
```

Use your runner's literal loopback address and exact model ID. The launcher does not install a model, start a runner, or enable cloud processing. Model replies and generated UI need behavioral evaluation; a successful HTTP response or syntax check is not a guarantee of useful output. Built-in capabilities remain available if no model is configured.

The [model readiness check](life-model-status.md) reports whether the configured local runner lists that exact model. It makes a bounded inventory request without sending a prompt and distinguishes a missing model from an unavailable runner or an unsupported inventory endpoint.

The [model contract](life-model-contract.md) describes supported action formats, bounded context, missing-field drafts and inference deadlines.

## Verify

```sh
bun run check
bun run life:test
```

The first command checks formatting, lint, generated contracts, TypeScript, repository tests and both web builds. The second launches the actual service stack with private temporary state and Chromium for an authenticated browser workflow. PDF/image extraction uses macOS PDFKit and Vision through the Xcode Command Line Tools. Browser test state is removed after owned resources close. Set `ELLIE_E2E_ARTIFACT_DIR` to a chosen directory to retain screenshots.

See the [overnight checkpoint](overnight-build.md) for the exact latest checks and remaining integration work. The [life harness plan](life-harness-plan.md) describes the broader product direction; it is not a claim that every future connector or native capability is implemented.
