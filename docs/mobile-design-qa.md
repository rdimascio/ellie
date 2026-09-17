# Mobile Life owner QA

This is the **web interface** reviewed in [draft PR #146](https://github.com/rdimascio/ellie/pull/146). It runs in a browser or the existing authenticated Life WebView; it is not a new Swift app build. The branch includes main `45151925e3342c61e69e8e75fafa8be3052de140` through a history-preserving merge.

## Preview identity

- Candidate: `http://127.0.0.1:4196/review`, served from the `ellie-mobile-life-web-review` worktree on `codex/mobile-life-web-review`.
- Original owner-approved preview: `http://127.0.0.1:4187/review`, served from the unchanged `ellie-mobile-redesign` worktree. It is preserved separately and is not the current PR head.
- Both are loopback design fixtures with **synthetic data**. The page explicitly labels sample data; writes are rejected. Displayed Gmail/Plaid accounts and financial observations are not live connections or balances.
- The release handoff supplies the exact current head, build assets, and CI runs. Check `git rev-parse HEAD` in the candidate worktree before rebuilding or restarting its preview.

To start the candidate preview with Node 24 and Bun 1.4.2, when port 4196 is free:

```sh
bun run life:build
node --input-type=module -e 'const { startDesignPreview } = await import("./apps/life-ui/tests/design-preview.ts"); const { origin } = await startDesignPreview(4196); console.log(`${origin}/review`);'
```

Do not stop or replace the original port 4187 preview.

## Acceptance pass

1. Try the 320, 390, and 430 pixel phone widths. Check typography, the orbital assistant, readable controls, and the Home/Today/Ellie/Finances/Integrations dock.
2. Open Ellie, type a draft, close it, and reopen. The draft should remain; this action sends nothing.
3. Open Finances. Sample accounts and a sample source-backed insight demonstrate the design. Balances and a full transaction history are explicitly unavailable.
4. Open Integrations. Review the Gmail, Calendar, and Plaid presentation. Connection changes in this preview are disabled; real sign-in is not part of visual acceptance.
5. In Settings, open Library and tools. Memory and existing custom tools remain reachable. Scroll a screen, change tabs, and confirm the next screen starts at the top.

## Preserved Swift delta, separate from this PR

The original worktree retains ten uncommitted native files based on `6d5d404cda0c809ecd104a4b350e753d015ff1bf`: a new `IOSAppearance.swift` palette/card/screen/orb implementation and project reference; root tint/dark mode; dashboard cards and a credential-gated Life link; widget styling; and appearance modifiers in sync, enrollment, Mac control, browser control, and voice views. The exact paths are listed under `excludedPaths` in [the provenance manifest](mobile-design-provenance.json).

Current main has changed three of those same paths: `EllieIOS.xcodeproj/project.pbxproj`, `EllieIOSApp.swift`, and `NativeEnrollmentView.swift`. The old native appearance edits need a separate coordinated port and native validation; they must not overwrite the current enrollment/project work. No preserved native source was edited or transferred, and no local Xcode, physical-device, model, or household deployment gate was run for this web review.
