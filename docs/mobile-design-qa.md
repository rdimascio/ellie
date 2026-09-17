# Mobile Life owner QA

This is the **web interface** reviewed in [draft PR #146](https://github.com/rdimascio/ellie/pull/146). It runs in a browser or the existing authenticated Life WebView; it is not a new Swift app build. The branch includes main `45151925e3342c61e69e8e75fafa8be3052de140` through a history-preserving merge.

## Preview identity

- Check out the candidate revision supplied with the review and record `git rev-parse HEAD` before building.
- The preview is a loopback design fixture with **synthetic data**. The page explicitly labels sample data; writes are rejected. Displayed Gmail/Plaid accounts and financial observations are not live connections or balances.
- Record the tested revision, browser, viewport width, and evidence with each result. Machine-specific preview and worktree preservation details belong in the private release handoff.

To start the candidate preview with Node 24 and Bun 1.4.2, when port 4196 is free:

```sh
bun run life:build
node --input-type=module -e 'const { startDesignPreview } = await import("./apps/life-ui/tests/design-preview.ts"); const { origin } = await startDesignPreview(4196); console.log(`${origin}/review`);'
```

Open the printed `/review` URL. If port 4196 is occupied, select another free port in the command.

## Acceptance pass

| Case  | Action                                                                   | PASS criteria                                                                                                                                           |
| ----- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DES01 | Try the 320, 390, and 430 pixel phone widths.                            | Typography, orbital assistant, and controls remain readable without horizontal overflow; the dock shows Home, Today, Ellie, Finances, and Integrations. |
| DES02 | Open Ellie, type a draft, close it, and reopen.                          | The draft remains; opening, editing, and closing it sends nothing.                                                                                      |
| DES03 | Open Finances.                                                           | Sample accounts and a sample source-backed insight appear; balances and a full transaction history are explicitly unavailable.                          |
| DES04 | Open Integrations.                                                       | Gmail, Calendar, and Plaid are recognizable; connection changes are disabled in the preview. Real sign-in is outside visual acceptance.                 |
| DES05 | Open Settings → Library and tools. Then scroll a screen and change tabs. | Memory and existing custom tools remain reachable; the next screen starts at the top.                                                                   |

Report each case using `DES01 | PASS/FAIL/BLOCKED | observed result and evidence`, replacing the ID and choosing exactly one result. **PASS** means all criteria were observed, **FAIL** records a deviation, and **BLOCKED** records what prevented execution. Include the revision, browser, and widths tested. These instructions do not record an owner acceptance result.

## Preserved Swift delta, separate from this PR

Native Swift styling is a separate planned deliverable and is not validated by this web QA. The ten-file appearance delta based on `6d5d404cda0c809ecd104a4b350e753d015ff1bf` includes a new `IOSAppearance.swift` palette/card/screen/orb implementation and project reference; root tint/dark mode; dashboard cards and a credential-gated Life link; widget styling; and appearance modifiers in sync, enrollment, Mac control, browser control, and voice views. Its paths are listed under `excludedPaths` in [the provenance manifest](mobile-design-provenance.json).

The integrated main base has changed three of those same paths: `EllieIOS.xcodeproj/project.pbxproj`, `EllieIOSApp.swift`, and `NativeEnrollmentView.swift`. Those edits require a separate port that preserves current enrollment and project behavior, followed by native validation. This PR includes no native appearance changes or native acceptance result.
