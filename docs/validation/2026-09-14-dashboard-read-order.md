# Dashboard stale-read regression — 2026-09-14

The app-hosted CI failure at merge commit `61312c46502c7a96b989969f8cbea65694314ce7`
reported revision 3 after the test expected revision 9. The old test used one `Task.yield()`
before cancellation, which did not prove that the first transport call had entered and consumed
the revision 3 response. The result is compatible with the newer request consuming revision 3;
the retained result does not directly trace the scheduler ordering.

The corrected test uses separate entry and release gates. It proves that the old request consumed
revision 3, cancels it, starts and completes the revision 9 request, and only then releases and
awaits the old request. The entry waits and revision observation have monotonic two-second bounds;
every failure path releases its owned gates and awaits the captured tasks.

The negative control is run from an owned temporary source copy by removing the production
generation admission around the read result and running this same corrected regression. The
negative source is never copied back into the worktree. No production source or persistence
behavior changed.

Validation uses synthetic transports only. It does not contact a household coordinator, read an
installed credential, or exercise a physical iPhone.

On the macOS 15 validation Mac, the full Swift run passed 158 tests, including all 12 dashboard tests;
its output is retained at `/tmp/ellie-dashboard-read-order-final-swift.log`. The final cleanup-only
revision then passed all 12 focused tests; its output is
`/tmp/ellie-dashboard-read-order-final-cleanup-focused.log`. The full suite was not repeated for that
last cleanup branch. The mutation control failed on revision 3 as expected; its output is retained
at `/tmp/ellie-dashboard-read-order-negative-control.log`.

An earlier full run omitted the required Node 24 path, so its ten coordinator network fixtures
could not start their synthetic Node servers. That setup failure is retained at
`/tmp/ellie-dashboard-read-order-full.log`; it is not evidence about the dashboard change and was
superseded by the 158-test run with the explicit Node 24.21.0 path.
