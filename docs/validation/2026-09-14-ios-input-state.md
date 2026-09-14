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
