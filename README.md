# Ellie

A local-first personal assistant for macOS. Warm, playful, thoughtful, and built to act quickly across your Macs.

Ellie is at its first developer milestone: text commands → deterministic routing → authenticated HTTPS → native macOS app and window control. Normal operation needs **no model download, cloud account, API key, or paid service**. Voice, automatic conversational routing, retrieval, and browser automation are planned. An optional independent inference-worker probe is available for already installed local models; see [worker setup](docs/inference-workers.md).

## Try the first milestone

You need macOS, Node.js 24, Bun 1.4.2, Xcode Command Line Tools (`xcode-select --install`), and `openssl` on each Mac (the macOS-provided LibreSSL is supported). Node remains the production runtime and test runner; Bun installs the workspace and runs its scripts. The execution Mac needs a logged-in graphical session. Install Arc for the default browser commands. Bun installs the local runtime dependencies with the workspace.

Clone this repository using GitHub's **Code → HTTPS** clone URL, then run on **both Macs** from the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run build:macos
```

On the **server Mac**, start the coordinator:

```sh
bun run ellie server init --lan
bun run ellie server start
```

`--lan` enables listening on local network interfaces. Without it, initialization defaults to loopback. Allow incoming local connections if macOS Firewall asks. Do not forward the port from your router. Keep the server terminal running. In a **second terminal on the server Mac**:

```sh
bun run ellie server pair
```

On the **execution Mac**:

```sh
bun run ellie node pair
```

The prompts ask for the server's HTTPS LAN address with port `7437`, the SHA-256 fingerprint printed by the server, and its one-time pairing code. Get the server's current address from **System Settings → Network → your connection → Details → TCP/IP**. Enter it only into the prompt. Verify the fingerprint against the server terminal. The code is hidden when entered and expires after 10 minutes.

Enable the terminal application you use and `~/.ellie/bin/ellie-macos` in **System Settings → Privacy & Security → Accessibility**. In the file picker, press **Command-Shift-G** and enter that helper path. Then:

```sh
bun run ellie doctor
bun run ellie node start
```

Keep the node terminal running. Open **another terminal on the execution Mac**, in the checkout:

```sh
bun run ellie say "Ellie, open Arc"
bun run ellie say "put it in the top-left"
bun run ellie say "open Netflix"
bun run ellie say "move Arc to the big monitor and make it fullscreen"
bun run ellie say "put Messages next to it"
```

The command should return `Done.` after the native helper reports success. App installation, Accessibility, and window constraints can produce actionable errors. If a window is already open, Ellie selects that app's focused window, falling back to its first window.

- “Big monitor” selects the largest display by logical desktop area; it does not infer physical inches. “Primary monitor” selects the main display.
- “Fullscreen” uses macOS native fullscreen. “Maximized” fills the usable desktop without creating a fullscreen Space.
- “Next to it” exits fullscreen, places the previous app on the left, and the requested app on the right on that display. This is ordinary window tiling, not macOS Split View.
- “It” refers to the last successfully commanded app on that node. It does not track every app you manually focus.
- Some apps enforce minimum window sizes. Ellie reports incomplete placement instead of claiming success.

For additional Macs, create a fresh invitation and repeat node pairing. On the server, `bun run ellie nodes` lists connected node IDs, and `bun run ellie say --node ACTUAL_ID "open Arc"` targets one explicitly. Copy the exact ID that `nodes` prints; do not type `NODE_ID` or `ACTUAL_ID` literally. When `server.json` exists and exactly one desktop-capable node is online, `bun run ellie say "open Arc"` selects it automatically. The coordinator configuration takes precedence if that Mac also retains a `node.json`; a node-only Mac continues to target its own paired identity. These are opaque local IDs; do not paste diagnostic output into public issues without reviewing it.

The coordinator keeps payload-free job lifecycle metadata in `~/.ellie/jobs.sqlite`. Use `bun run ellie jobs`, `bun run ellie job JOB_ID`, and `bun run ellie cancel JOB_ID` on the server Mac to inspect or cancel work. Pressing Control-C while `say` or `infer` is waiting also requests cancellation. Once native execution begins, cancellation asks the helper or model request to stop but cannot undo a side effect that already happened.

After foreground setup, [install per-user background services](docs/services.md) to run without terminal tabs. Stop the foreground process, then run `bun run ellie service install coordinator` and `bun run ellie service start coordinator` on the server; use `node` instead of `coordinator` on the execution Mac. Run `bun run ellie doctor coordinator` or `bun run ellie doctor node` for service diagnostics. From the coordinator, `bun run ellie service test` performs a read-only readiness check; the documented `--desktop --app NAME` opt-in is required to submit a real app-opening test. Both roles require graphical login. The existing identities and Keychain credentials are preserved; physical two-Mac service acceptance is still pending.

## Workspace

| Location                                                                       | Responsibility                                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `apps/server`                                                                  | Routing, node sessions, command lifecycle, pairing and credential revocation                |
| `apps/node`                                                                    | Outbound connection, local permission checks, native execution and optional local inference |
| `apps/cli`                                                                     | Generated onboarding, diagnostics, text command client                                      |
| `packages/protocol`                                                            | Versioned wire types and runtime validation                                                 |
| `packages/compute`                                                             | Independent-worker admission and scheduling policy                                          |
| `packages/router`                                                              | Pure deterministic grammar, with no LLM on the fast path                                    |
| `packages/macos`, `packages/windows`                                           | Swift Accessibility/Keychain helper and window/display contracts                            |
| `packages/config`, `packages/permissions`, `packages/transport`                | Private state, capabilities, allowlists, pinned HTTPS                                       |
| `packages/personality`                                                         | Replaceable identity, independent of tools and models                                       |
| `packages/knowledge`, `packages/speech`, `packages/memory`, `packages/browser` | Future integration contracts; no providers run in V1                                        |

## Privacy and development

Public examples belong in `examples/`. Generated installation state belongs exclusively in `~/.ellie/`, outside the checkout. Secrets are stored in macOS Keychain; server-side credential verifiers are hashes. Browser sessions remain browser-owned. Command text, actions, prompts, responses, and conversation context are not persisted. The local job database contains IDs, targets, lifecycle timestamps and enum outcomes only. Startup and lifecycle writes prune terminal rows older than 30 days and cap terminal history at 10,000 rows. There is no external analytics. Explicitly enabled compute workers report resource telemetry only to their paired coordinator; it is kept in process memory.

Run `bun run check` for Oxlint, Oxfmt verification, generated-contract drift checks, strict TypeScript checking, and Node tests, including actual HTTPS server/node integration with a simulated native executor, independent-worker scheduling, and a synthetic loopback model server. Run `bun run format` to apply Oxfmt. macOS CI additionally compiles the helper and tests monitor geometry. A physical Mac with Accessibility permission is required to verify real window actions; CI cannot grant that permission or substitute for the manual checklist.

Read [architecture](docs/architecture.md), [operation and API contracts](docs/contracts.md), [security and private state](docs/security.md), [Ellie's personality](docs/personality.md), and [manual macOS validation](docs/testing.md). See [CONTRIBUTING.md](CONTRIBUTING.md) before sharing logs or fixtures. MIT licensed.

The [roadmap](docs/roadmap.md) separates the current developer prototype from the work required for an installable household command center, with ordered changes and acceptance criteria.

## Command-center preview

With Node 24 and Bun 1.4.2 selected, run:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run demo
```

Open the loopback URL printed by the command. The phone-sized remote and TV view use only synthetic household fixtures. Commands are simulated in browser memory; no authentication, calendar sync, analytics, or live coordinator connection is present. Use the Demo scenario selector to inspect loading, offline, empty, running, completed, failed, cancelled, and unknown outcomes.

`bun run check` includes the production UI build. For browser checks, run `node node_modules/@playwright/test/cli.js install chromium`, then `bun run demo:build` and `bun run demo:test`. The browser suite emulates phone, laptop, and TV viewport sizes; it does not claim physical phone or TV acceptance.

An optional coordinator HTTPS pairing page can connect a phone or shared display, show its own
identity, and disconnect it. Controller CLI commands display single-use QR invitations with a manual
code fallback and manage revocation. The phone pairing page scans QR codes locally after camera
permission. It exposes
no household data or commands yet. See [browser setup and acceptance](docs/browser-pairing.md) for
the separate TLS identity, service startup, and physical phone trust checks.

The preview binds only to loopback and uses a production build with network connections blocked by its content policy. Re-run `bun run demo` after source changes. See [the design and acceptance notes](docs/command-center-design.md).
