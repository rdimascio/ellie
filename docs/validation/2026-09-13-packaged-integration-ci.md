# Packaged integration CI at 0cb2a4ad

The combined candidate in [PR59](https://github.com/rdimascio/ellie/pull/59) at
`0cb2a4ad6f51ce9195bcc4f79b830f000ed97809` has mixed native CI results. Both
TypeScript jobs, both command-center jobs and the security check passed. The separate
PR65 runtime acceptance head has all seven checks passing, and PR67 migration preparation
has all ten checks passing. Those results do not replace the combined candidate's CI gate.

The [failed native job](https://github.com/rdimascio/ellie/actions/runs/34802205721/job/103846961266)
passed the 158 Swift tests and reached the iOS UI runner. Xcode compiled and installed the
runner, connected to testmanagerd and requested its launch, but the retained result contains
no UI test method start. The bounded runner terminated the attempt at its unchanged
600-second deadline. Its diagnostic reports `stage=xcode-test`, `outcome=timeout`,
`stageMs=605986`, and completed simulator shutdown and deletion. The partial result and
diagnostic were retained; ATS tests were not reached.

The [other native job on the identical head](https://github.com/rdimascio/ellie/actions/runs/34802203407/job/103846954221)
passed both UI tests in 83.509 seconds and completed its app-hosted HTTPS/Keychain checks.
It used a separate GitHub-hosted macOS runner. This does not establish contention or a
deterministic product defect in the failed job.

This launch-session timeout differs from the earlier `9f54b704` failure, where a UI test
had already begun and stalled during repeated per-character input. PR66's complete-value
input change ran successfully in the passing combined job, but it cannot establish that
every XCTest launch will succeed. No source fix, deadline extension or blind retry is
justified by the available failure evidence alone. The mixed result remains recorded while
the independently reviewable migration work proceeds.

These are CI and simulator results. They do not extend the owner's hardware acceptance
to the packaged installation, launchd, migration or physical iPhone.
