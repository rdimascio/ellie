# Native calendar validation — 2026-09-13

## Scope

This validates the provider-neutral, imported agenda snapshot foundation. It does not validate a live calendar provider, Google Calendar, OAuth, account access, automatic refresh, or event writes; none are implemented in this slice.

## macOS Swift tests

Sources were copied to uniquely owned temporary directories on a validation Mac with full Xcode. Every Xcode command selected the developer directory explicitly. In these example commands, `$ELLIE_VALIDATION_ROOT` denotes an owned temporary checkout.

Focused command:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swift test --package-path apps/desktop --scratch-path "$ELLIE_VALIDATION_ROOT/.build-focused" --filter AgendaTests
```

Initial result: 3 tests passed, 0 failures. After storage and date-boundary review fixes, the focused suite was rerun after each storage change; the final ordering run passed 9 tests with 0 failures. The focused cases cover normalization and provenance; fractional RFC 3339 input; deterministic tied-start ordering; all-day exclusive-end behavior across the daylight-saving transition; timed exclusive endpoints; unknown-field and mixed-shape rejection; cache persistence and clearing; corrupt-cache recovery; exact nonrecursive clearing; failed persistence; an import/disconnect race, immediate FIFO/directory/symlink rejection before reading, and display-zone ordering between timed and civil all-day starts.

Full command:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun swift test --package-path apps/desktop --scratch-path "$ELLIE_VALIDATION_ROOT/.build-full"
```

Initial result: 23 tests passed, 0 failures. The post-review full rerun passed 27 tests with 0 failures. Two pre-existing WeatherTests compiler warnings report unused results inside throw assertions. The uniquely owned remote validation directory was removed after the runs.

Local `xcrun swift build` also completed successfully with the mini Command Line Tools installation. Local `swift test` remains unavailable because that installation does not contain XCTest.

## Node workspace

With Node `v24.21.0` and Bun `1.4.2`, dependencies were restored with `bun install --frozen-lockfile`, then `bun run check` passed. This covered lint, formatting, generated-contract consistency, both TypeScript checks, 163 Node tests (162 passed and one platform skip), and the Vite production build.

## Physical Mac UI review

A separately identified QA app ran on a physical Mac mini with compiled fallback paths to an owned mode-0700 directory and synthetic state. The native file picker imported a sample agenda containing tonight's dinner, tomorrow's all-day market, and an expired event. The expired event was absent. This review caught the initial UTC-versus-civil-date sort issue; after correction and rebuilding, dinner appeared before the next day's market with a localized all-day date.

Quitting and reopening preserved the imported snapshot. **Disconnect and Clear** returned the widget to its empty state, and a filesystem check confirmed that the agenda cache was gone while the dashboard remained. The QA app was then quit. No provider, account, real calendar content, system privacy setting, or household service was accessed.
