# Paired Watch media simulator acceptance

The source-level Watch tests call `WatchMediaPhoneController` directly. This separate opt-in run
installs Ellie on a newly created paired iPhone and Watch Simulator, drives `WatchMediaView` with
watchOS UI tests, and carries messages through the apps' real `WCSession` delegates. The phone's
Mac inventory and browser result are DEBUG-only synthetic data. No coordinator, browser, player,
household account, Keychain identity, or physical device participates.

On the leased Xcode host, use `/Applications/Xcode.app/Contents/Developer` and choose
**installed** iOS and watchOS runtime/device-type identifiers from `xcrun simctl list -j`.
From the exact source checkout, use a new private output directory
under an existing parent:

```sh
node scripts/test-watch-paired.mjs \
  --execute leased \
  --out /absolute/private/new-watch-paired-run \
  --ios-runtime com.apple.CoreSimulator.SimRuntime.iOS-18-2 \
  --watch-runtime com.apple.CoreSimulator.SimRuntime.watchOS-11-2 \
  --ios-type com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro \
  --watch-type com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm
```

The identifiers above are examples, not a claim that those device types or runtimes are installed.
The runner refuses an existing output directory and records source hashes, the exact Xcode/SDK/runtime
versions, and Xcode result bundles. It retains one direct child handle and finite deadline for each
command; signals use the same bounded stop/reap path. It accepts only exact UUIDs from its two
Simulator creates, deletes only those IDs, and checks a final read-only inventory for their absence.
Before each reachable Watch test, the DEBUG iPhone fixture must publish bounded readiness evidence
for an activated session, paired and installed Watch, foreground app, and the exact expected fixture
Mac. Watch reachability is recorded but cannot be required until the Watch app launches. A missing
or malformed readiness record fails within 15 seconds and still enters owned Simulator cleanup;
the Watch UI test includes a fixed activation/reachability diagnostic if its Read control stays disabled.
If child or cleanup certainty is lost, it stops issuing commands and retains the IDs and evidence for
owner inspection. A test counts only when `xcresulttool` reports exactly one
executed pass with zero failed or skipped tests. The expected sequence is a fresh observed Mac A
page, one Play sent with an unknown result and disabled follow-up controls, termination of the
owned iPhone app process without restoring Watch action authority, then an explicit launch
selecting Mac B and a fresh B observation. WatchConnectivity may activate a terminated iPhone app
in the background, so the process-stop case is not an offline-device test. The phone's synthetic
event log must contain exactly one A Play, no additional event during process-stop recovery, and
no B mutation or replay. An actual unavailable-device case remains pending.

This verifies the paired UI/transport seam if it passes. It does not prove media playback, a real
browser action, physical-device reachability, or an old A observation remaining live during a
mid-request switch to B. Existing controller tests cover the stale epoch; a future paired scenario
must test that exact in-process transition before claiming it as UI acceptance.

Apple documents immediate WatchConnectivity messages only while the counterpart is reachable and
both sessions are active: [WCSession](https://developer.apple.com/documentation/watchconnectivity/wcsession).
Xcode supports watchOS UI test targets: [Setting up tests for your watchOS app](https://developer.apple.com/documentation/watchos-apps/setting-up-tests-for-your-watchos-app).
Simulator behavior must still be confirmed on the selected Xcode host.
