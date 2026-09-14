# Native service migration switch validation — 2026-09-13

This slice adds the stopped-only `adopt-migration` and `recover-migration-switch` transaction. It
accepts exactly the installed legacy roles represented by a verified migration snapshot, requires
both fixed service labels to remain unloaded, publishes the packaged receipt last, and retains
canonical recovery evidence. Recovery tests cover interrupted journal, staged copy, application and
plist publication, receipt and completed-record writes; exact-prefix partial files under normal
`umask` modes; repeated recovery between exclusive evidence and restoration renames; competing or
malformed journals and receipts; ancestor replacement; late loaded state; single-role adoption; and
altered-prefix, extra-file, and changed retained-evidence refusal.

Reviewed source SHA-256 values:

- `ServicePayloadInstaller.swift`: `bd8b7f38d8d8d23ab4c096796a5455263c75a669bf8f3350a0da15729fd3ae35`
- `ServicePayloadLifecycle.swift`: `5b1b66c9ba617a9493d05f65c49e01903373abc21efd088bae30b4f42eea3754`
- `ServicePayloadMigration.swift`: `7da5b065b88cd1e926db544e51224fffdbaad3eb13fe2d8727ab99b9f160ce02`
- `ServicePayloadSelection.swift`: `dcc85fb1f53a8382230916c554ba7e7bd69fafdbd895793e1a86dc42a5a5eee0`
- `service-payload-installer.test.ts`: `075b23fe7ddcc5ca181112124594c146af9998c637bd8e7cc143320a464bedec`
- `service-distribution-plan.md`: `1a5fcccc64cede45d1a35d3cc05284a91a6d7113c34af8a94035e0f8d3897274`

Validation results:

- Full Node 24/Bun check: 226 passed, 1 skipped; lint, formatting, generated contracts,
  TypeScript, and command-center production build passed.
- Focused migration test on macOS 26.6.2: 1 passed in 9.631 seconds.
- Focused migration test on a physical macOS 15.1 MacBook using Node 24.21.0, Bun 1.4.2, and
  full Xcode: 1 passed in 13.571 seconds.

Both focused runs used owned synthetic applications, private temporary homes, and a fake launchctl
adapter. They did not install or start managed services and do not establish real launchd lifecycle,
Keychain identity, TCC continuity, state compatibility, rollback-after-start, or desktop-command
acceptance. Real fixed-label lifecycle acceptance still requires a fresh macOS user or VM, or later
authorized deployment.
