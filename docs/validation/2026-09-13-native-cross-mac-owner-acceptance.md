# Native cross-Mac owner acceptance — 2026-09-13

The owner reported successful coordinator connection and an explicit Arc launch on the paired Mac mini from the corrected native Mac preview: “it worked! and arc opened”. This accepts the native MacBook-to-coordinator-to-mini command path for this development artifact. The action was performed and observed by the owner, not by an automated UI runner.

Artifact:

- Source: `e23db80dcaeb8d27adb269c48a41d4968ad550bd`, [PR50](https://github.com/rdimascio/ellie/pull/50).
- Archive: `Ellie-0.1.0-dev-e23db80d.zip`.
- SHA-256: `2b33e46317c139010d39375485a345d2d33bf05ee980f810fee667a0792ec4b4`.
- The build was made from clean source. The copied archive, extracted plist, strict ad-hoc signature and embedded source provenance were verified on the MacBook before handoff.
- MacBook: macOS 15.1. Mac mini: macOS 26.6.2. The existing coordinator and node services, configuration and credentials were retained.

Before handoff, the production certificate generator reproduced the original native trust failure on pristine `0838a00c`. The limited legacy certificate compatibility fix passed 158 Swift tests and the full Node gate (249 passed, one platform skip). A separate QA app bundle on the MacBook used the exact production transport code with normal ATS policy, read one synthetic node and rejected a wrong certificate pin before any additional HTTP request. That synthetic app-bundle check is separate from the owner acceptance above.

The owner also noticed a disconnected mini in the inventory. Current coordinator code retains registrations until revocation or coordinator process termination; native status treats contact older than 60 seconds as offline and disables Open. Clarification remains pending about whether the owner saw a separate offline registration or the successful target itself becoming offline. No registration was deleted, revoked or re-paired to alter the list.

This acceptance does not establish physical microphone input, native iPhone enrollment or commands, browser-site interaction, Apple Watch, unattended service installation, restart/login/sleep/wake reliability, signed distribution or notarization. The archive contains the native interface; the background services still use the existing checkout and Node installation. Current native CI failures are tracked separately in the delivery queue and must pass before merging the affected stack.
