# Ellie

A local-first personal assistant for macOS. Warm, playful, thoughtful, and built to act quickly across your Macs.

Ellie is at its first developer milestone: text commands → deterministic routing → authenticated HTTPS → native macOS app and window control. Normal operation needs **no model download, cloud account, API key, or paid service**. Voice, conversational models, retrieval, and browser automation are planned, not implemented yet.

## Try the first milestone

You need macOS, Node.js 24, Xcode Command Line Tools (`xcode-select --install`), and `openssl` on each Mac. The execution Mac needs a logged-in graphical session. Install Arc for the default browser commands. There are no runtime npm dependencies beyond the workspace packages.

Clone this repository using GitHub's **Code → HTTPS** clone URL, then run on **both Macs** from the checkout:

```sh
npm ci
npm run check
npm run build:macos
```

On the **server Mac**, start the coordinator:

```sh
npm run ellie -- server init --lan
npm run ellie -- server start
```

`--lan` enables listening on local network interfaces. Without it, initialization defaults to loopback. Allow incoming local connections if macOS Firewall asks. Do not forward the port from your router. Keep the server terminal running. In a **second terminal on the server Mac**:

```sh
npm run ellie -- server pair
```

On the **execution Mac**:

```sh
npm run ellie -- node pair
```

The prompts ask for the server's HTTPS LAN address with port `7437`, the SHA-256 fingerprint printed by the server, and its one-time pairing code. Get the server's current address from **System Settings → Network → your connection → Details → TCP/IP**. Enter it only into the prompt. Verify the fingerprint against the server terminal. The code is hidden when entered and expires after 10 minutes.

Enable the terminal application you use and `~/.ellie/bin/ellie-macos` in **System Settings → Privacy & Security → Accessibility**. In the file picker, press **Command-Shift-G** and enter that helper path. Then:

```sh
npm run ellie -- doctor
npm run ellie -- node start
```

Keep the node terminal running. Open **another terminal on the execution Mac**, in the checkout:

```sh
npm run ellie -- say "Ellie, open Arc"
npm run ellie -- say "put it in the top-left"
npm run ellie -- say "open Netflix"
npm run ellie -- say "move Arc to the big monitor and make it fullscreen"
npm run ellie -- say "put Messages next to it"
```

The command should return `Done.` after the native helper reports success. App installation, Accessibility, and window constraints can produce actionable errors. If a window is already open, Ellie selects that app's focused window, falling back to its first window.

- “Big monitor” selects the largest display by logical desktop area; it does not infer physical inches. “Primary monitor” selects the main display.
- “Fullscreen” uses macOS native fullscreen. “Maximized” fills the usable desktop without creating a fullscreen Space.
- “Next to it” exits fullscreen, places the previous app on the left, and the requested app on the right on that display. This is ordinary window tiling, not macOS Split View.
- “It” refers to the last successfully commanded app on that node. It does not track every app you manually focus.
- Some apps enforce minimum window sizes. Ellie reports incomplete placement instead of claiming success.

For additional Macs, create a fresh invitation and repeat node pairing. On the server, `npm run ellie -- nodes` lists connected node IDs, and `npm run ellie -- say --node NODE_ID "open Arc"` targets one explicitly. These are opaque local IDs; do not paste diagnostic output into public issues without reviewing it.

## Workspace

| Location | Responsibility |
| --- | --- |
| `apps/server` | Routing, node sessions, command lifecycle, pairing and credential revocation |
| `apps/node` | Outbound connection, local permission checks, native execution |
| `apps/cli` | Generated onboarding, diagnostics, text command client |
| `packages/protocol` | Versioned wire types and runtime validation |
| `packages/router` | Pure deterministic grammar, with no LLM on the fast path |
| `packages/macos`, `packages/windows` | Swift Accessibility/Keychain helper and window/display contracts |
| `packages/config`, `packages/permissions`, `packages/transport` | Private state, capabilities, allowlists, pinned HTTPS |
| `packages/personality` | Replaceable identity, independent of tools and models |
| `packages/knowledge`, `packages/speech`, `packages/memory`, `packages/browser` | Future integration contracts; no providers run in V1 |

## Privacy and development

Public examples belong in `examples/`. Generated installation state belongs exclusively in `~/.ellie/`, outside the checkout. Secrets are stored in macOS Keychain; server-side credential verifiers are hashes. Browser sessions remain browser-owned. Commands and conversation context are not persisted. There is no telemetry.

Run `npm run check` for strict TypeScript checks and Node tests, including actual HTTPS server/node integration with a simulated native executor. macOS CI additionally compiles the helper and tests monitor geometry. A physical Mac with Accessibility permission is required to verify real window actions; CI cannot grant that permission or substitute for the manual checklist.

Read [architecture](docs/architecture.md), [security and private state](docs/security.md), [Ellie's personality](docs/personality.md), and [manual macOS validation](docs/testing.md). See [CONTRIBUTING.md](CONTRIBUTING.md) before sharing logs or fixtures. MIT licensed.
