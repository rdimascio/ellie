# iPhone UI input synchronization — September 14

Two retained GitHub runs observed incomplete note text before Save. PR77 native job
`103914769068` read `Rememb` after requesting `Remember the blue mug`; PR78 job
`103918001852` read `Remember theg`, then saved `Remember the`. The editor stores text in local
SwiftUI state and updates the dashboard only on Save. These observations establish incomplete
input at the UI boundary; they do not prove an underlying XCTest, keyboard or framework cause.
The failed logs remain `ellie-pr77-37c9266-native-103914769068-failed.log` and
`ellie-pr78-1cdfde2-native-103918001852-failed.log`.

The test now waits for the input and keyboard, enters at most four characters per call, and waits
for the exact cumulative value before continuing. A mismatch stops the workflow before Save.
The note also waits for its state-backed character count before saving. Final saved text, relaunch
persistence and dashboard lifecycle assertions remain exact. No retries, arbitrary sleeps, product
changes or runner timeout extensions were added.

The final test source SHA-256 is
`88a9ccd71b810a04e8ccc8c6fec76b53b727bb235f19b8d363c38f55944568fb`.
One run through the existing bounded iOS runner passed both UI tests on the physical MacBook's
Simulator: Xcode 16.2, SDK 18.2, runtime 18.3.1, iPhone 16 type. XCTest took 62.870 seconds;
the runner took 115.458 seconds. The note/create/rename/relaunch/delete case passed in 52.522
seconds and coordinator navigation in 10.348 seconds. The source copy was isolated and the
changed-file hash was verified before execution. This is Simulator acceptance with synthetic
state, not physical iPhone typing or a household deployment.

The owned Simulator, derived data and source copy were removed after success. The retained log is
`ellie-ios-input-state-sync-macbook.log`, SHA-256
`425f803e8a5568b6fe756d6dce1983702c113fede541c0b5ac75b767d3630573`.
The passing run supports the state synchronization change; it does not establish elimination of
every intermittent CI input failure. GitHub acceptance of the published source remains separate.

A later exact-head push job `103931720739` stopped before Save after the second input chunk. Its
two-second predicate wait expected `Remember`, while a separate value read performed after the wait
returned `Remember`. The `Optional(...)` wrapper in that diagnostic came from formatting an optional
API value and does not establish a type mismatch. The retained evidence cannot distinguish a value
that arrived after the predicate deadline from stale predicate observation.

The predicate now reads and compares the element value explicitly as a `String`, records its last
in-predicate value and evaluation count, and labels a separate post-timeout value in the failure.
The two-second bound, four-character chunks, failure before Save, state-backed character-count gate,
and exact save and relaunch assertions are unchanged. This diagnostic correction does not retry input
or claim to identify the simulator cause; another changed-source Simulator run remains separate.

The changed diagnostic source, SHA-256
`244b0d87104cb26b5c6ae048d32fbbe71687623177fda1bc7b29e148c3af9d8c`, then passed one
run through the unchanged bounded runner on the physical MacBook Simulator. Xcode 16.2, SDK 18.2,
runtime 18.3.1 and the iPhone 16 device type executed both UI tests with no failures in 62.135
seconds; the full runner completed in 110.564 seconds. Coordinator navigation passed in 9.922
seconds, and the exact note/create/rename/relaunch/delete workflow passed in 52.212 seconds. The
runner reported Simulator shutdown and deletion plus derived-data removal. The owned remote source
and remote log were removed and their absence confirmed. The retained local log is
`/tmp/ellie-ios-predicate-review-final.log`, SHA-256
`33cafc025bbe4052ce034e5647920b0a593b6c94347b49c1d52fda0e34f1b887`. This remains synthetic
Simulator acceptance and does not reproduce or identify the intermittent hosted-runner cause.
