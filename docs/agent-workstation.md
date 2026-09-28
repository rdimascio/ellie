# Agent workstation (design)

Status: proposed, 2026-09-28. Nothing here is implemented.

## Problem

The household runs coding agents (Claude Code, Codex) on two Macs: a MacBook that travels and sleeps, and a Mac mini that is always on. Each agent keeps a large, hand-built setup on disk: skills, hooks, global instructions, settings, per-project memory, plans, an append-only todo list, a review ledger, and a set of background jobs.

Today that setup is moved and kept in step by hand:

- `~/.claude` is a git repository pushed to a private GitHub repository. An allowlist `.gitignore` tracks configuration only; transcripts, history, caches and credentials stay local. `.jsonl` files and memory indexes merge with `merge=union`.
- `~/.claude/sync/sync.mjs` commits, rebases and pushes. A hand-written LaunchAgent runs it every 15 minutes on each Mac.
- Four singleton jobs (an artifact web server, its Cloudflare tunnel, a factory watchdog, a nightly benchmark) were moved to the mini by unloading LaunchAgents on one Mac and loading them on the other.
- Secrets (`~/.cloudflared`, provider keys) and tools (Homebrew formulae, `node_modules`) were copied or installed by hand.

This works, but nothing checks it. A job loaded on both Macs double-fires (two tunnel connectors split traffic between two servers with different content). A job on a Mac that is asleep silently stops. A new Mac needs an hour of manual steps. Ellie already owns paired Mac identities, LaunchAgent installation, liveness heartbeats and redacted service logs, so it is the natural owner.

## Goals

1. **One command to set up a Mac.** `ellie agents bootstrap` turns a paired Mac into an agent workstation: config repositories in place, tools installed, sync running, doctor green.
2. **Config stays in step.** Every paired workstation syncs each agent's config repository on a schedule, with the same allowlist and merge rules as today. Two agents in v1: Claude Code (`~/.claude`) and Codex (`~/.codex`).
3. **Each singleton job runs on exactly one Mac.** The coordinator decides where. Moving a job is one command, and never leaves it running on two Macs.
4. **Honest status.** `ellie agents status` shows the last sync per Mac, each job's host, and its health, without printing secrets or paths with usernames.

## Non-goals (v1)

- Automatic failover. When the mini is down, the coordinator is usually down with it, and the MacBook cannot tell "mini is off" from "network is split". A split-brain tunnel is worse than a stopped one. Moving a job stays an explicit command.
- Moving secrets. Ellie reports a missing secret; the operator copies it. Secret transfer over the pinned channel is future work.
- Syncing transcripts, history or caches.
- Managing the agents themselves (logins, model settings, MCP connector auth).

## Design

### Repositories

The node's private config `~/.ellie/agents.json` lists the agent repositories this Mac syncs:

```json
{
  "version": 1,
  "repositories": [
    { "name": "claude", "path": "~/.claude", "remote": "https://github.com/<owner>/claude-config.git", "branch": "config" },
    { "name": "codex", "path": "~/.codex", "remote": "https://github.com/<owner>/codex-config.git", "branch": "config" }
  ]
}
```

Each repository carries its own allowlist `.gitignore` and `.gitattributes`. For Codex the allowlist covers `config.toml`, `AGENTS.md`, `skills/`, `rules/` and `prompts/`; it excludes `auth.json`, every `*.sqlite*` file (history, logs, state, thread history), `sessions/`, `cache/`, `log/`, `tmp/` and generated images. `config.toml` holds machine-specific values (MCP server commands with absolute paths, local tool settings). Today the two Macs have different `config.toml` files; they must be reconciled by hand once before Codex sync is enabled. Whether Codex can load a local override file is not verified (open question 1).

### Workstation manifest

A repository may carry one `sync/workstation.json`. Only the `claude` repository does in v1. It is the contract between the repository and Ellie. It is data only; Ellie never runs a string from it through a shell.

```json
{
  "version": 1,
  "sync": { "intervalMinutes": 15 },
  "tools": { "brew": ["node", "cloudflared", "gh"], "npmInstall": ["skills/every-watch", "skills/panel"] },
  "jobs": [
    {
      "id": "artifact-server",
      "kind": "keepalive",
      "program": ["/opt/homebrew/bin/node", "~/.claude/skills/artifact-publish/server.mjs"],
      "environment": { "ARTIFACT_PORT": "8787", "ARTIFACT_ROOT": "~/.claude/artifacts" },
      "placement": ["mac-mini"],
      "requires": { "files": [], "binaries": ["/opt/homebrew/bin/node"] },
      "group": "artifacts"
    },
    {
      "id": "artifact-tunnel",
      "kind": "keepalive",
      "program": ["/opt/homebrew/bin/cloudflared", "tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:8787", "claude-artifacts"],
      "placement": ["mac-mini"],
      "requires": { "files": ["~/.cloudflared/cert.pem"], "binaries": ["/opt/homebrew/bin/cloudflared"] },
      "group": "artifacts"
    },
    { "id": "router-benchmark", "kind": "daily", "at": "03:00", "timeZone": "America/Los_Angeles", "program": ["/bin/bash", "~/.claude/tools/router-benchmark/nightly.sh"], "placement": ["mac-mini"] }
  ]
}
```

- `kind` is `keepalive`, `interval` (with `minutes`) or `daily`/`weekly` (wall clock, IANA zone). These map directly to launchd keys.
- `placement` is an ordered list of Mac names. The first live, eligible Mac wins at assignment time.
- `group` pins jobs to the same Mac (the tunnel must sit next to its server).
- `requires` is checked on the target before a job is placed; a missing file or binary blocks placement and appears in status.
- `~` expands to the target user's home. Absolute paths only after expansion; no `PATH` lookup.

### Roles and where work runs

| Part | Runs on | Why |
| --- | --- | --- |
| Config sync | Every workstation, inside the node service | Must keep working when the coordinator is offline. |
| Job placement and assignment | Coordinator | One owner of truth for "which Mac runs job X". |
| Job execution | The assigned node, as a managed LaunchAgent | Survives node restarts; launchd owns relaunch and throttling. |
| Doctor checks | Each node, reported to the coordinator | Only the target can check its own files and binaries. |

A Mac that is not paired as a node cannot hold jobs. A coordinator-only Mac can sync config but holds no jobs.

### Config sync

The node service runs sync as a node-local timer, not as a coordinator task, so a sleeping or absent coordinator does not stop it.

Each run: `git add --all` under the allowlist, commit when there are staged changes, `pull --rebase --autostash`, `push`. Before commit, a secret scanner runs over the staged diff (the same patterns as today's pre-push scan: provider keys, private keys, JWTs, generic `key = "<long>"` assignments). A hit aborts the run, leaves the change staged, and reports `needs_attention` with the file path relative to the repository. A rebase conflict aborts the rebase, keeps local commits, and reports `needs_attention`; Ellie never resolves a conflict itself.

Sync events go to the existing redacted node log: `sync_ok`, `sync_no_changes`, `sync_conflict`, `sync_secret_blocked`, `sync_push_failed`. No file contents or commit messages are logged.

### Job assignment

The coordinator keeps one assignment per job in its SQLite store: `jobId`, `nodeId`, `generation`, `state` (`assigned`, `blocked`, `moving`, `unassigned`).

- **Assign.** On manifest change or `ellie agents jobs apply`, the coordinator walks `placement`, skips nodes that are offline or report unmet `requires`, and assigns the first eligible node. Group members are assigned together or not at all.
- **Deliver.** The assignment rides the existing long poll as a typed `agents.jobs` message listing the jobs this node must run, with their generation. The node installs or removes managed LaunchAgents (label `io.ellie.job.<id>`) to match, then acknowledges the generation.
- **Move.** `ellie agents jobs move <id> --to <mac>` sets `moving`, tells the old node to remove the job, waits for its acknowledgement, then assigns the new node. If the old node is offline, the move stops at `moving` and needs `--force-orphan`, which prints the risk (the old Mac may still run the job when it wakes) and records it. There is no silent takeover.
- **Stale node.** A node that wakes with a generation older than the coordinator's removes jobs it no longer holds before it installs anything new.

Managed LaunchAgents follow the rules in [services.md](services.md): `gui/<uid>` domain, Aqua session, absolute runtime paths, no `sudo`, and unmanaged plists are never touched.

### Bootstrap

`ellie agents bootstrap` on a paired Mac:

1. Checks `gh auth status` and git access to the remote. Stops with guidance if either fails.
2. If `~/.claude` exists and is not the repository: copies each file that the checkout would overwrite into `~/.claude/backups/pre-bootstrap-<timestamp>/`, then `git init`, adds the remote, fetches, and checks out the branch. Untracked local files that the allowlist covers are committed on the next sync, so memory written on the new Mac is kept.
3. Installs `tools.brew` formulae that are missing, and runs `npm ci` in each `tools.npmInstall` directory.
4. Enables config sync in the node service.
5. Runs `ellie agents doctor` and prints what is still missing: secrets named in `requires.files`, logins (`claude`, `codex`, `gh`).

Bootstrap never copies secrets, never logs in, and never assigns jobs. Assignment stays explicit.

### Status and doctor

`ellie agents status` (coordinator) prints, per workstation: last successful sync time, `needs_attention` reason if any, and per job: assigned Mac, launchd state, last exit code. `ellie agents doctor` (any Mac) checks repository health, remote reachability, sync timer, tools, and each assigned job's `requires`. Output follows the existing doctor redaction rules.

## Security

- The config repository is private, and its allowlist `.gitignore` is the first line of defense. The pre-commit secret scan is the second. Neither replaces the other.
- The manifest is data. Programs are argument arrays run by launchd, never shell strings. Environment values are literal.
- A job runs as the logged-in user with no Ellie capability grants. Ellie's desktop and Life permissions do not extend to jobs.
- Assignments travel only over the pinned, authenticated coordinator channel. A node rejects `agents.jobs` from anything else, like any other job.

## Testing

Automated coverage target: 80% or more of new lines in the new packages.

- **Unit:** manifest validation (bad kinds, relative paths, shell strings, unknown fields), placement with synthetic node lists and telemetry, group assignment, move and orphan paths, stale-generation cleanup, secret scanner patterns (each one fails on a planted key), sync conflict handling with a temporary bare repository.
- **Smoke (`bun run smoke:agents`):** an inert temporary job LaunchAgent is installed, runs once, is moved to "another node" in a synthetic two-node coordinator, and is removed; the same approach as `smoke:services`, never touching real labels, `~/.claude` or Keychain.
- **Two-Mac acceptance (recorded under `docs/validation/`):**
  1. Bootstrap a Mac from an existing `~/.claude`; confirm backups exist and memory written before bootstrap reaches the other Mac.
  2. Edit a todo on each Mac within the same interval; confirm both lines survive.
  3. Plant a fake key in a tracked file; confirm the sync blocks and reports it.
  4. Move `artifacts` from the mini to the MacBook and back; confirm the tunnel is never connected from both Macs (Cloudflare dashboard connector count).
  5. Put the mini to sleep during a move; confirm the move stops at `moving` and nothing starts twice.

## Migration from today

1. Create the private `codex-config` repository with the Codex allowlist, and write `sync/workstation.json` in the Claude repository describing the four jobs and the tools already installed.
2. Build and ship the feature behind the node config flag `agents.enabled` (off by default).
3. On the mini: enable, run `ellie agents jobs apply`. Ellie finds the existing hand-written plists (`com.rdimascio.*`) as unmanaged and refuses to install duplicates; the operator unloads each one, then applies again.
4. Remove `~/.claude/sync/sync.mjs` and its LaunchAgent on both Macs once Ellie sync has run cleanly for a week.

## Open questions

1. Can Codex load a machine-local override next to a shared `config.toml`? If not, `config.toml` stays out of the Codex allowlist and only skills, rules, prompts and `AGENTS.md` sync.
2. Is a manual `move` enough, or do we want a "prefer the mini, fall back to the MacBook only when the mini has been offline for 24 hours and the operator confirms from the phone" flow?
