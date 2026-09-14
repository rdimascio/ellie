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

Open the one-use link printed by the launcher. The sign-in token is removed from the browser address immediately after the client reads it. The local service binds to `127.0.0.1:7440`; `--port 0` selects an available port. Data defaults to `~/.ellie-life`. Stop the foreground process with Control-C. Restarting preserves records, installed apps, scores, settings and scheduled work; browser sessions and conversational context start fresh.

For a separate state directory:

```sh
bun run life:build
bun run life:start --state-dir /absolute/private/directory --port 7441
```

The directory must be outside the source checkout, owned by the current OS user, and private (0700). Existing `~/.ellie` service state is deliberately rejected. Do not copy private life databases into Git.

## Try a complete workflow

- “Remember that I prefer morning appointments.”
- “My friend's birthday is next Saturday. They love gardening. Help me get something under $40.”
- “Remind me to buy a garden gift when I'm at Target.”
- “I'm shopping at Target.”
- “Complete buy a garden gift.”
- “Set a timer for 2 minutes.”
- “Every Monday at 9 am remind me to plan the week.”
- “Build an arcade shooter with a high score widget.”
- “Build an MLB standings and today's games widget.”
- “Teach Ellie: Offer two options when helping me plan dinner.”
- “List guidance.”
- “Use Cooking handbook as guidance.” (For an uploaded source up to 4,000 characters.)
- “Summarize orchids in the background.” (Uses matching uploaded sources.)

Use Your world to inspect and correct the resulting records, teach from files, or review a calendar/contact import. Source lists use compact previews; opening a record loads its full content. Your space holds playable and readable extensions with retained revision controls. Activity shows durable work, source-worker progress, cited summaries and feedback. Today shows current commitments and delivered notifications. Settings supports default, active group and user preferences; authority remains separate from those preferences.

Adopted guidance is versioned configuration. Pause or resume a listed guide through chat using its title, or open Guidance in Your world to review linked sources, revise instructions and restore a retained version. Source changes exclude stale guidance until the current content is reviewed. Background summaries coordinate up to four source workers; deleted or changed source content is omitted, and an old stored result becomes unavailable when its citations are no longer current. See [teaching through content](life-teaching.md).

While the service is running, Ellie checks upcoming timed events on startup and every fifteen minutes. Preparation appears in Today using your proactivity preference and quiet hours. Pending preparation notices are deduplicated; checking again does not create a pile of reminders for the same event.

Place-linked suggestions currently depend on explicit fresh context signals, including “I'm shopping at …”. They do not imply continuous phone location, access to unrelated apps, a retailer account, or a price-feed subscription. A sleeping or stopped coordinator cannot deliver new browser notifications. Timers that must sound while the coordinator is asleep need a future native local-delivery integration.

## Your personal data

In Settings, use **Inspect my data** to review the private records, sources, guidance, background work, apps and storage held by Ellie. **Download my archive** collects the personal store exports after checking their revisions. Shared group records, apps and tasks are excluded; your own values stored inside a shared app are included. A change during export requires a fresh review so the file cannot silently mix revisions.

**Review reset** shows the scope before you explicitly reset your private data. Reset pauses new mutations, settles active requests and private background work, and journals progress across the three stores. It preserves shared group content and memberships, and removes your own storage in shared apps. If work cannot stop immediately, the status remains pending and can be retried. A restarted service restores the pending pause. Previously downloaded files, device backups and external systems are outside this local reset.

## Optional local model

An explicitly configured, already running OpenAI-compatible local model can answer broader questions using scoped memories, preferences and source evidence, and generate or revise self-contained custom applications:

```sh
bun run life:start --model-url http://127.0.0.1:8080/v1 --model YOUR_INSTALLED_MODEL_ID
```

Use your runner's literal loopback address and exact model ID. The launcher does not install a model, start a runner, or enable cloud processing. Model replies and generated UI need behavioral evaluation; a successful HTTP response or syntax check is not a guarantee of useful output. Built-in capabilities remain available if no model is configured.

## Verify

```sh
bun run check
bun run life:test
```

The first command checks formatting, lint, generated contracts, TypeScript, repository tests and both web builds. The second launches the actual service stack with private temporary state and Chromium for an authenticated browser workflow. PDF/image extraction uses macOS PDFKit and Vision through the Xcode Command Line Tools. Browser test state is removed after owned resources close. Set `ELLIE_E2E_ARTIFACT_DIR` to a chosen directory to retain screenshots.

See the [overnight checkpoint](overnight-build.md) for the exact latest checks and remaining integration work. The [life harness plan](life-harness-plan.md) describes the broader product direction; it is not a claim that every future connector or native capability is implemented.
