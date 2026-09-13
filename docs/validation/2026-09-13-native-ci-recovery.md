# Native CI recovery — 2026-09-13

PR35's original push workflow failed while the iOS UI test tapped a text element without reaching the Coordinator screen. The test now locates a stable accessibility identifier on the actual navigation control and waits for the destination and idle scan button. The exact owned simulator rerun passed both UI tests, with zero failures (52.888 seconds). Scanning was not started.

A concurrent GitHub native job built the Swift target but produced no test suite output for roughly 38 minutes and was cancelled. A local repeated run separately reproduced an XCTest process blocked in `NSConcreteTask.waitUntilExit` after a synthetic TLS rejection fixture had exited: iteration 9 of 10 exceeded its 45-second outer deadline. That local process sample establishes a fixture wait bug; the limited GitHub output does not establish that the cancelled CI job had the same cause.

Fixture teardown now uses bounded termination and kill handling, including throwing and cancelled paths before temporary-directory cleanup. OpenSSL subprocess execution is bounded. The shared `desktop:test` command now streams output through a runner with a unique scratch directory, a 10-minute absolute deadline and owned process-group cleanup. The runner retains its process group after the parent exits, so a descendant that ignores TERM cannot survive cleanup unnoticed.

Validation:

- Twenty consecutive focused enrollment runs passed after replacing the blocking wait.
- The final Node24/full-Xcode bounded runner on the authorized MacBook passed 28 Swift tests, including 18 enrollment tests, with zero failures (18.02-second build, 1.649-second test run).
- Two deterministic 50ms deadline fixtures passed cleanup checks: parent and descendant both ignore TERM; parent exits on TERM while its descendant ignores it. Both returned nonzero and the captured descendant processes no longer existed.
- Full Node24/Bun repository checks passed, with 182 tests passed and one platform skip.
- Swift formatting, Node syntax and diff checks passed. Owned remote validation directories were removed.

All certificates, server requests, test identities and simulator data were synthetic. No physical phone, installed household service, owner Keychain identity or privacy permission was changed. GitHub acceptance must be read from the new published commit, separately from these local results.

A final parser review replaced Foundation regular-expression end anchors with whole-string ASCII validation for native tokens and identifiers. Terminal LF/CR/CRLF can no longer match a valid prefix. The focused regression passed and the final full Swift suite passed 29 tests. One initial test mistakenly treated an alphanumeric identifier suffix as invalid; the assertion was corrected to use a disallowed punctuation suffix without changing the production fix. These remain synthetic parser tests.
