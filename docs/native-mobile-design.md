# Native iPhone appearance candidate

The Swift interface carries Ellie's midnight surfaces, pearl text, ice blue controls, and static orbital presence into the dashboard, widgets, enrollment, sync, phone control, browser control, and voice screens. System text styles retain Dynamic Type. The home invitation stacks vertically below 390 points and at accessibility text sizes, keeping the orb separate from the text. Dashboard and coordinator cards remain scrollable navigation links with their existing accessibility identifiers.

This candidate ports the ten-file native appearance delta from source base `6d5d404cda0c809ecd104a4b350e753d015ff1bf` onto main `45151925e3342c61e69e8e75fafa8be3052de140`. It is separate from the Life web design in PR 146. A browser preview or web owner acceptance does not validate this native implementation.

Main `6b38548da7c8235e7e0a6a5c62042e6e069ce954` was subsequently integrated through history-preserving merge `e22e3ef33caf3de5ab854067fc09e4c03033d6ec`, without conflicts.

## Behavior and integration

- The home invitation exposes **Open Ellie Life** only while the existing enrollment store is enrolled. Navigation is explicit. It uses the existing authenticated `LifeWebView` and client identity; being paired does not grant Life access. Session authorization, pinned transport, cookies, expiry, revocation, and grants are unchanged.
- Dashboard creation, notes, editing, import/export, sync, and cancellation behavior retain their existing implementations. Viewing the home screen does not start enrollment or an action.
- `ellieScreen()` supplies a dark environment as well as the dark presentation preference, so native forms and standalone fixture roots use readable system foregrounds. Sheets keep their native controls and destructive/disabled semantics. The orb is static and hidden from accessibility.
- Xcode keeps the scanner fixture's existing references. The appearance helper and DEBUG home fixture use separate new references. App routing retains the scanner and browser fixtures.
- Enrollment adds only a screen appearance modifier. Scanner dismissal still uses `scannerDismissed()`; the decoded review, explicit confirm/cancel, scanner run gate, and capture teardown remain unchanged.
- Shared stores, credentials, transports, permissions, and entitlements are unchanged. The UI runner adds only opt-in result retention after successful cleanup; its build, test, timeout, and simulator ownership behavior is unchanged.

## Focused coverage

Two new cases in `EllieIOSUITests` exercise the actual dashboard with an isolated DEBUG fixture:

| Case                                                                   | What it checks                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `testHomeLifeEntryRequiresExplicitTapAndFollowsEnrollment`             | Idle home has no Life link and performs no vault read or enrollment transport call. Loading a synthetic stored pairing exposes one link without opening its destination. Tapping opens a synthetic destination for the expected client; removing the pairing removes the link. |
| `testNarrowHomeKeepsNavigationReachableAtRegularAndAccessibilitySizes` | The dashboard at 320 points with regular and accessibility size 5 text keeps its title inside the viewport. Dashboard/coordinator controls remain at least 44 points high and reachable by scrolling. Coordinator navigation does not start enrollment.                        |

The fixture uses an in-memory vault, rejecting transport, and a DEBUG-only destination override. It performs no real enrollment, Keychain access, Life session authorization, or network request. Existing session tests cover those unchanged authorization paths; the new UI case establishes explicit navigation only. Existing dashboard and coordinator UI cases now scroll to the requested link when needed, retaining their original assertions.

## Screenshot evidence

The two home tests keep six named `XCTAttachment` screenshots from the isolated home fixture only:

- `native-home-normal` and `native-home-normal-life-entry`: standard-width home and its explicit Life entry.
- `native-home-320-regular-invitation` and `native-home-320-regular-navigation`: narrow layout before and after scrolling to its controls.
- `native-home-320-accessibility5-invitation` and `native-home-320-accessibility5-navigation`: the same narrow viewport at the largest accessibility text size.

CI sets `ELLIE_IOS_KEEP_RESULT=1` only on the existing UI test step. Successful cleanup still removes the owned simulator and derived data, but preserves `test-results/native-ios.xcresult`. The existing `native-iphone-test-result` artifact retains that exact bundle and `native-ios-runner-diagnostic.txt` for three days after an attempted UI run, including success. No broader directory is uploaded; existing failure evidence remains available. The bundle contains the full UI test report, while these six deliberately kept screenshots capture only synthetic home-fixture content. Other automatic failure attachments may also appear in the report.

Download that artifact from the **native** job for the exact PR head, unzip it, and open `native-ios.xcresult` in Xcode. In the test report, select the two home cases and inspect the six named attachments. Record the run URL, tested head/runtime/device, attachment name, and visual PASS/FAIL/BLOCKED. A failed or interrupted run may have only partial screenshots; missing views remain unreviewed. The images demonstrate actual Simulator rendering, not physical-device acceptance. Local runs retain the prior delete-on-success behavior unless the flag is explicitly set to `1`.

## Validation status and next window

Native compilation, Simulator tests, and physical-device acceptance are **pending**. Static project and diff checks are separate evidence and do not establish that this Swift candidate builds or renders correctly.

In one coordinated native window:

1. Build and run the `EllieIOS` UI scheme, including the two new cases and the six existing dashboard, scanner, browser, voice, target-change, and relaunch cases. The existing `bun run ios:test` runner owns its simulator and bounds build/test/cleanup; it does not forward test selectors.
2. Retain the scanner run-gate regression checks in `EllieIOSUnitTests/NativeEnrollmentATSTests` and the existing shared Life session authorization/teardown tests. Reuse exact-head required CI evidence where available; do not repeat a full native gate solely for this visual change. The app-hosted runner checks whole-suite fixture counts and must not be filtered without a separately coordinated test invocation.
3. Review actual native screenshots at narrow and standard widths, regular and accessibility text sizes, including widget editor/gallery, decoded enrollment review, sync, phone/browser control, voice review, and the Life entry. Check contrast, VoiceOver ordering, reachable controls, keyboard and sheet behavior. Record revision, device/runtime, case, PASS/FAIL/BLOCKED, and evidence.

Publishing or installing a build and testing real camera/microphone permissions or household connectivity are separate release actions. No live deployment or permission change is included here.
