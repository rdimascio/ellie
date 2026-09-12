# Contributing

Use Node.js 24 and the Bun version pinned in `.bun-version`. Run `bun install --frozen-lockfile` and `bun run check` before proposing a change. Node remains the production runtime and test runner. Native changes also need `bun run build:macos` and the relevant physical-Mac checks in `docs/testing.md`.

Keep deterministic actions free of model dependencies. Validate every network payload at the receiver. New tools must have a typed contract, declared capability, native/local permission enforcement, clear failure semantics, and meaningful behavioral tests. Personality and provider integrations must remain independently replaceable.

Never commit installation state or realistic personal fixtures. Keep private state in `~/.ellie/` and secrets in Keychain or the owning application. Review `git diff --cached` before committing. Remove personal paths, addresses, usernames, cookies, and tokens from issue/PR text and logs. Use synthetic fixtures and no external analytics. Resource telemetry is limited to explicitly enabled compute workers and their paired coordinator.

The packages are private Bun workspaces for source development; the repository is MIT licensed. Publishing packages, releasing binaries, and installing background services are separate future milestones.
