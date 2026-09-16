# Native phone recovery validation — September 16, 2026

The native phone now retains a warning when a browser command may have run before the app exits. An unsuccessful recovery read keeps that warning visible beside the actual read error or revoked-session status. A verified read of the same target can reconcile it before another explicit action. Target changes and cancellation do not replay commands.

## Landed changes

| Change                                                                                         | Reviewed head | Merge commit |
| ---------------------------------------------------------------------------------------------- | ------------- | ------------ |
| [PR135 — durable browser uncertainty](https://github.com/rdimascio/ellie/pull/135)             | `e2288e7`     | `5d5b269`    |
| [PR136 — process-relaunch UI regression](https://github.com/rdimascio/ellie/pull/136)          | `2b29d91`     | `37f43ec`    |
| [PR137 — visible warning after recovery failures](https://github.com/rdimascio/ellie/pull/137) | `2c158c4`     | `a413f24`    |

Each merge preserved its reviewed history and matched the tree tested by CI. The final product tree is `8bbaa01f9838f25824ccc2a348dd2cd4feeb53dd` at merge commit `a413f2409cd15f553783cd14ebd272fcc2769a2e`.

The private uncertainty record contains a hashed enrollment/target scope and an operation token, without command text or page content. The store flushes it before dispatch. A failed write blocks dispatch; a verified read or definitive reply clears only the matching operation. The warning follows the selected Mac, including A → B → A changes while cancellation is still settling. Unreadable safety state remains visible, and another Mac does not inherit the previous target's warning.

## Automated evidence

[PR137's completed CI](https://github.com/rdimascio/ellie/actions/runs/35077930237) passed all required jobs, alongside [Life browser acceptance](https://github.com/rdimascio/ellie/actions/runs/35077930365). The native job passed 194 Swift tests, including 22 browser-phone store tests, the iOS build, five iOS Simulator UI tests, and the app-hosted pinned HTTPS, speech, cancellation and Keychain fixture gate.

The extended process-relaunch UI case passed in 61.345 seconds. It uses the production phone target picker, browser controls and private file store with synthetic credentials and transport. It selects one Mac, admits one delayed synthetic mutation, observes its persisted marker, terminates the app and launches a new process with the same isolated fixture identity. After selecting that Mac again, it verifies the restored warning and zero new mutations during a bounded observation interval. One injected failed read preserves the error, warning and marker; a subsequent explicit verified read clears the warning before one new explicit mutation is admitted.

The DEBUG-only fixture uses a fresh UUID-scoped app-sandbox directory and cleans that test directory. The [earlier voice UI record](2026-09-15-native-phone-browser-ui.md) remains evidence for its own source and environment. The results above identify the newer integrated source; they do not transfer physical acceptance from older builds.

## Physical acceptance still required

The complete phone microphone → reviewed command → actual website search, result selection and visible play/pause journey remains unaccepted. These automated runs use synthetic audio or transport and Simulator devices. They do not establish physical microphone recording, the household's installed browser route, or public/streaming-site behavior.

The next owner session requires an identified current build signed and installed on a trusted iPhone, explicit enrollment and speech/browser grants for the selected Mac, and the coordinator's approved real browser target. Complete IP01–IP07 in the [manual QA catalogue](../manual-qa.md), including failed recovery reads, target changes and no replay after interruption. Record `PASS`, `FAIL` or `BLOCKED` against the supplied build and case ID. A prepared source archive alone is not an installed candidate or a manual QA handoff.
