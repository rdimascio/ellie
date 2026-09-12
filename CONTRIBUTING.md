# Contributing

Use Node.js 24. Run `npm ci` and `npm run check` before proposing a change. Native changes also need `npm run build:macos` and the relevant physical-Mac checks in `docs/testing.md`.

Keep deterministic actions free of model dependencies. Validate every network payload at the receiver. New tools must have a typed contract, declared capability, native/local permission enforcement, clear failure semantics, and meaningful behavioral tests. Personality and provider integrations must remain independently replaceable.

Never commit installation state or realistic personal fixtures. Keep private state in `~/.ellie/` and secrets in Keychain or the owning application. Review `git diff --cached` before committing. Remove personal paths, addresses, usernames, cookies, and tokens from issue/PR text and logs. Use synthetic fixtures and no telemetry by default.

The packages are private npm workspaces for source development; the repository is MIT licensed. Publishing packages, releasing binaries, and installing background services are separate future milestones.
