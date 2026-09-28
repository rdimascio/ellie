# Agent workstation (design)

Status: proposed, 2026-09-28, revised after a two-seat review. Nothing here is implemented.

## Problem

The household runs coding agents (Claude Code, Codex) on two Macs: a MacBook that travels and sleeps, and a Mac mini that is always on. Each agent keeps a large, hand-built setup on disk: skills, hooks, global instructions, settings, per-project memory, plans, an append-only todo list, a review ledger, and a set of background jobs.

Today that setup is moved and kept in step by hand:

- `~/.claude` is a git repository pushed to a private GitHub repository on branch `config`. An allowlist `.gitignore` tracks configuration only; transcripts, history, caches and credentials stay local. `.jsonl` files merge with `merge=union`.
- `~/.claude/sync/sync.mjs` commits, rebases and pushes. A hand-written LaunchAgent runs it every 15 minutes on each Mac. It has no secret scan; the first commit was scanned once by hand.
- Four singleton jobs run only on the mini, moved there by unloading LaunchAgents on one Mac and loading them on the other: the artifact web server, its Cloudflare tunnel, the factory watchdog, and the nightly router benchmark.
- Secrets (`~/.cloudflared`), tools (Homebrew formulae, `node_modules`) and repositories outside `~/.claude` (`~/.agents`, the factory evidence repository, the adversarial-review skill repository) were copied or installed by hand.

Nothing checks any of it. A job loaded on both Macs double-fires; two tunnel connectors split traffic between two servers with different content. A new Mac needs an hour of manual steps. Ellie already pairs these Macs, installs LaunchAgents and writes redacted service logs, so it is the natural owner.

## Topology

The mini runs the Ellie coordinator and a node. The MacBook runs a node only. Today both Macs hold a `server.json` and a `node.json`; the MacBook's coordinator config is retired as the first migration step. Everything below assumes one coordinator, on the mini.

## Goals

1. **Config stays in step.** Every Ellie Mac syncs each agent's config repository on a schedule. Two agents in v1: Claude Code (`~/.claude`) and Codex (`~/.codex`).
2. **Each singleton job runs on exactly one Mac, and never on two.** The coordinator records where. Moving a job is one command.
3. **A new Mac is one command plus a printed checklist.** `ellie agents bootstrap` puts the repositories in place and starts sync; `ellie agents doctor` lists what is still missing.
4. **Honest status** per Mac and per job, with the existing redaction rules.

## Non-goals (v1)

- Automatic failover. The coordinator is on the mini, so a dead mini means no coordinator to decide anything, and the MacBook cannot tell "mini is off" from "network is split".
- Installing tools or copying secrets. Doctor reports what is missing by absolute path; the operator installs or copies it.
- Syncing transcripts, history, caches, or any per-machine config.
- Managing the agents themselves (logins, model settings, MCP connector auth).

## Design

### 1. Config sync

**Runner.** Sync is its own small managed LaunchAgent, `org.ellie.assistant.agents-sync`, running `ellie agents sync` every 15 minutes (`StartInterval`). It does not live in the node or coordinator process, so it works on any Ellie Mac regardless of role and keeps running when the node service pauses on a Keychain failure.

**Repositories.** `~/.ellie/agents.json` (private, `0600`) lists what this Mac syncs:

```json
{
  "version": 1,
  "repositories": [
    { "name": "claude", "path": "~/.claude", "remote": "https://github.com/<owner>/claude-config.git", "branch": "config" },
    { "name": "codex", "path": "~/.codex", "remote": "https://github.com/<owner>/codex-config.git", "branch": "config" }
  ],
  "external": [
    { "path": "~/.claude/factory", "remote": "https://github.com/<owner>/every-factory-evidence.git" },
    { "path": "~/.claude/skills/adversarial-review", "remote": "https://github.com/<owner>/adversarial-review-skill.git" }
  ]
}
```

Each repository owns its allowlist `.gitignore` and `.gitattributes`. The Codex allowlist is `AGENTS.md`, `skills/` and `rules/` only. `config.toml` is excluded: it holds per-machine project trust entries keyed by absolute path and MCP `env` blocks, and it commonly holds tokens. `auth.json`, every `*.sqlite*` file, `sessions/`, `cache/`, `log/` and `tmp/` stay local.

`external` lists repositories that live inside a synced path but are excluded from it and have their own remote. Sync never touches them; doctor checks that they are cloned.

`merge=union` applies to `*.jsonl` only. Markdown memory files are edited in place, and a union merge of an in-place edit silently keeps both versions; they conflict normally instead.

**One run, per repository, under a per-repository lock (`~/.ellie/agents-sync-<name>.lock`):**

1. `git add --all` (the allowlist decides what is staged); commit if anything is staged.
2. `git pull --rebase --autostash`. On conflict: `git rebase --abort`, keep local commits, record `sync_conflict`, skip the push.
3. Scan every outgoing commit, `origin/<branch>..HEAD`, each commit's diff, not only the final tree. A hit anywhere in the range blocks the push and records `sync_secret_blocked` with the repository-relative path. Pull still happens on every run, so inbound sync never stops because of a local hit.
4. `git push`.

**Secret scanner.** New code; nothing scans today. It checks added lines in every text file under 5 MB for: Anthropic, OpenAI, GitHub, Slack, Linear, PostHog, Stripe and AWS key shapes; PEM private-key headers; JWTs; `Bearer` tokens over 40 characters; and quoted assignments to names containing `key`, `secret`, `token` or `password` with a value of 24 or more characters. It has no entropy heuristic in v1. An allowlist file in the repository (`sync/scan-allow.txt`, one `path:pattern-name` per line) silences reviewed test fixtures. Each pattern has a unit test that fails on a planted value.

**Reporting.** Events go to `~/.ellie/logs/agents-sync.jsonl` with the existing redaction rules: `sync_ok`, `sync_no_changes`, `sync_conflict`, `sync_secret_blocked`, `sync_push_failed`. `ellie agents doctor` on that Mac shows the latest event per repository; the coordinator shows it too when the Mac's node is online.

### 2. Singleton jobs

**Names.** Ellie nodes have opaque ids today. The coordinator's `server.json` gains an operator-set map `nodeNames: { "<node id>": "mac-mini" }`, shown by `ellie nodes`. Job hosts refer to these names. A node cannot name itself.

**Definitions live on the coordinator, not in the synced repository.** The synced repository is written continuously by agent sessions and hooks on both Macs. If job definitions were read from it, any agent turn or injected tool call that edited them would run a new program on the mini within 15 minutes. So:

- The operator keeps a draft at `~/.claude/sync/jobs.json`. It is only a draft.
- `ellie agents jobs apply --from ~/.claude/sync/jobs.json`, run on the coordinator Mac in an interactive terminal, prints the full diff of every `program`, `environment` and schedule against the last applied set, and requires typing `apply`. The coordinator stores the applied definitions in its SQLite store.
- Nodes receive definitions only from the coordinator. They never read `jobs.json`.
- `apply` never changes a job's host. Host changes happen only through `move`.

Security states the remaining truth plainly: whoever can edit a script that an applied job runs (`nightly.sh`, `server.mjs`) can run code on the host. Applying pins the program and arguments, not the script contents.

**Definition shape.**

```json
[
  { "id": "artifact-server", "host": "mac-mini", "kind": "keepalive",
    "program": ["/opt/homebrew/bin/node", "/Users/ryan/.claude/skills/artifact-publish/server.mjs"],
    "environment": { "ARTIFACT_PORT": "8787", "ARTIFACT_ROOT": "/Users/ryan/.claude/artifacts" },
    "requires": ["/opt/homebrew/bin/node"] },
  { "id": "artifact-tunnel", "host": "mac-mini", "kind": "keepalive",
    "program": ["/opt/homebrew/bin/cloudflared", "tunnel", "--no-autoupdate", "run", "--credentials-file", "/Users/ryan/.cloudflared/<tunnel-uuid>.json", "--url", "http://127.0.0.1:8787", "<tunnel-uuid>"],
    "requires": ["/opt/homebrew/bin/cloudflared", "/Users/ryan/.cloudflared/<tunnel-uuid>.json"] },
  { "id": "factory-watchdog", "host": "mac-mini", "kind": "keepalive",
    "program": ["/opt/homebrew/bin/node", "/Users/ryan/.claude/tools/factory-watchdog/watchdog.mjs"],
    "requires": ["/opt/homebrew/bin/node"] },
  { "id": "router-benchmark", "host": "mac-mini", "kind": "daily", "hour": 3, "minute": 20,
    "program": ["/bin/bash", "/Users/ryan/.claude/tools/router-benchmark/nightly.sh"],
    "requires": ["/Users/ryan/every-io/every"] }
]
```

- `kind` is `keepalive`, `interval` (`minutes`) or `daily` (`hour`, `minute`). Daily times are the host's local time; launchd has no per-job time zone.
- Paths are absolute. No `~`, no `PATH` lookup, no shell. Arrays are passed to launchd as `ProgramArguments`.
- `requires` is a list of absolute paths that must exist on the host. The tunnel runs by UUID with an explicit credentials file, so the account-level `cert.pem` is not needed on the host.
- No placement lists, no groups. The artifact server and tunnel share a host because both say `mac-mini`.

**Delivery: desired state in the heartbeat.** The node's `/v1/heartbeat` response already carries `cancelJobIds`. It gains `agentJobs`: the full applied definitions assigned to this node. The node's heartbeat request gains `installedAgentJobs`: the ids it currently has installed. The node reconciles on every heartbeat (about every 10 seconds): install what is desired and missing, remove what is installed and not desired. Job delivery does not touch the `/v1/poll` path, the job store or the one-in-flight slot.

**Never on two Macs.** The coordinator adds a job to a node's desired state only when no other node's latest heartbeat lists it as installed. `ellie agents jobs move <id> --to <name>` changes the job's host; the old node's next heartbeat removes it, and only after that heartbeat reports it gone does the new node receive it. If the old node is offline, the move waits. `--force-orphan` skips the wait after printing that the old Mac will run the job again until its first heartbeat after waking, and records the override. A node that wakes reconciles removals before installs.

**Job LaunchAgents.** A new generic plist generator, next to the role-bound one in `apps/cli/src/services.ts`, not a reuse of it. Label `org.ellie.assistant.job.<id>`, `gui/<uid>`, Aqua session, `EnvironmentVariables` with `HOME` and a fixed `PATH` (`/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`) plus the job's `environment`, `ThrottleInterval` 30, stdout and stderr to `~/.ellie/logs/jobs/<id>.log` rotated at 1 MiB with one backup. The node only touches plists that carry Ellie's managed marker. An existing unmanaged plist with the same program is reported, never replaced.

**Status.** `ellie agents status` on the coordinator prints, per job: host, installed-on (from heartbeats), launchd state, last exit code, and whether any `requires` path is missing.

### 3. Bootstrap

`ellie agents bootstrap` on an Ellie Mac, per repository in `agents.json`:

1. Check that git can reach the remote. Stop with guidance if not.
2. Path missing: clone. Path exists and is already this repository: nothing to do.
3. Path exists and is not a repository: `git init`, commit the whole local tree (under the allowlist) on a temporary branch `bootstrap/<hostname>`, fetch, and rebase that branch onto `origin/<branch>`. `.jsonl` files union; any other file that differs stops the rebase with `needs_attention` and the list of paths, and the operator resolves them. On success, check out the branch. Nothing local is overwritten silently, and memory written on the new Mac reaches the other Mac on the next sync.
4. Install and start the sync LaunchAgent.
5. Run `ellie agents doctor`.

Bootstrap installs no tools, runs no package manager, copies no secrets and assigns no jobs.

**Doctor checklist** (read-only, each item a pass or a named gap): each repository is present, on its branch, and reached its remote within the last hour; the sync agent is loaded; each symlink under `~/.claude/skills` and `~/.codex/skills` resolves (catches a missing `~/.agents`); the separate repositories listed in `agents.json` under `external` (factory evidence, adversarial-review skill) are cloned; every `requires` path of jobs assigned to this Mac exists; `claude`, `codex` and `gh` are logged in.

## Security

- The synced repositories are private. The allowlist is the first guard, the outgoing-range secret scan the second.
- Synced files are code: skills, hooks and job scripts run on both Macs. Write access to the repository, including every agent session on either Mac, is the real trust boundary. Ellie does not widen it: job definitions are applied by hand on the coordinator, and nodes take them only from the coordinator over the pinned, authenticated channel.
- Jobs run as the logged-in user with no Ellie capability grants.

## Testing

Coverage target: 80% or more of new lines.

- **Unit:** job-definition validation (relative paths, `~`, shell strings, unknown kinds and fields); reconcile (install missing, remove extra, removals before installs); the never-on-two rule under every interleaving of move, heartbeat and offline node, including `--force-orphan`; apply never changing a host; the scanner (each pattern fails on a planted value; a secret added then deleted in a later commit is still caught; the allowlist file silences only its listed path); sync against a temporary bare repository: conflict aborts the rebase and skips push, a scan hit still pulls, and the lock serializes two concurrent runs; bootstrap rebase with an identical file, a differing Markdown file (stops) and differing `.jsonl` (unions).
- **Smoke (`bun run smoke:agents`):** a synthetic coordinator and two synthetic nodes move an inert temporary job LaunchAgent from one to the other; the job is never installed on both. Same approach as `smoke:services`: real launchd, no real labels, no `~/.claude`, no Keychain.
- **Two-Mac acceptance (recorded under `docs/validation/`):**
  1. Bootstrap the MacBook from an existing `~/.claude` that has a memory file the remote also has, with different content; confirm the stop and the path list.
  2. Append a todo on each Mac in the same interval; confirm both lines survive.
  3. Commit a fake key, then delete it in a second commit; confirm the push is blocked and pull still works.
  4. Move the artifact server and tunnel to the MacBook and back; confirm the Cloudflare connector count never exceeds one.
  5. Sleep the mini during a move; confirm the move waits and nothing runs twice.

## Migration from today

1. Retire the MacBook's coordinator config; the mini is the only coordinator. Add `nodeNames`.
2. Create the private `codex-config` repository with the Codex allowlist. Change `~/.claude/.gitattributes` to union `*.jsonl` only.
3. Ship behind the node config flag `agents.enabled`, off by default.
4. On both Macs: unload the legacy `com.rdimascio.claude-config-sync` LaunchAgent (keep the file for rollback), then run `ellie agents bootstrap`. Only one runner ever touches a repository.
5. On the mini: unload the four hand-written job plists, then `ellie agents jobs apply`. The node refuses to install a job while an unmanaged plist with the same program is loaded.
6. Delete the legacy files after a week of clean sync.
