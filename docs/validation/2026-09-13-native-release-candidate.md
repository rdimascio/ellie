# Native macOS development candidate — 2026-09-13

The first release target remains native Mac dashboards and explicit cross-Mac control. Browser media, Apple Watch, physical iPhone distribution and provider integrations do not displace this acceptance gate.

## Exact artifact

- Source: `b48bed1899297a9400a8cdac475dd741f8a3d332`, [PR41](https://github.com/rdimascio/ellie/pull/41), based on native integration PR38.
- Archive: `Ellie-0.1.0-dev-b48bed18.zip`.
- SHA-256: `5c349e5bdcdbe8e71e2b3b7f2da625d762afd1c90a88dab776936e8ede8dbdd1`.
- Bundle: `org.ellie.dashboard`, version `0.1.0`, ad-hoc signature. It is not Developer ID signed or notarized.
- The earlier `88d15685` package was produced before build-script provenance review and is superseded. It was not overwritten.

The packager requires a completely clean committed source tree, including the builder and packager. It generates the app, verifies its strict code signature, archives it, extracts that archive into an owned temporary directory and verifies its layout, plist, exact source provenance and signature again. It refuses an existing output directory. This is a repeatable build procedure; bit-for-bit deterministic archives across toolchains are not claimed.

## Physical Mac acceptance

On an Apple silicon Mac mini running macOS 26.6.2, root verified the archive checksum and launched an extracted, unchanged app outside the repository. The app used a fresh, owned state directory.

Through the actual SwiftUI interface, root edited a synthetic note title and body, created a second dashboard, quit the app, relaunched the same extracted executable, and observed both the saved dashboard and note. The state file was mode `0600` beneath a `0700` directory. Both app instances exited normally. The owned extraction and synthetic state were removed afterward.

The test did not connect to a household coordinator, invoke a real desktop action, use a microphone, access a personal calendar, or replace an installed app or LaunchAgent. Existing user app instances and household identities were preserved.

## Supporting automated acceptance

[PR42](https://github.com/rdimascio/ellie/pull/42), source `b4945a3`, uses real coordinator/node processes over generated pinned HTTPS. A coordinator crash after a fake desktop effect produces `unknown_after_restart`; the interrupted action is not replayed, the surviving node reconnects, and fresh work succeeds. Queued cancellation and revocation prevent dispatch. A stalled-child test proves bounded termination and reaping before owned state cleanup. Both focused cases and the full Node check passed: 235 passed, one platform skip. Desktop effects are synthetic journal writes; this is not physical sleep/wake or active native-action cancellation acceptance.

[PR43](https://github.com/rdimascio/ellie/pull/43), source `1ecad24`, passed 247 Node tests with one platform skip. Review fixed a ten-second socket limit that interrupted valid transcription and a cancellation race during final authorization. Real pinned HTTPS tests cover a 10.5-second result and stalled upload termination. Three publication cancellation cases failed before the fix and passed afterward.

The combined iPhone validation snapshot matches that backend and the reviewed push-to-talk and sync sources. On an owned iOS 18.3.1 simulator, 11 app-hosted tests passed, including an 11-second transcription using the production pinned Swift transport, Node listener and Whisper adapter with a synthetic executable/model and WAV. Exactly five upload requests occurred, with no additional app-open dispatch. No physical microphone or iPhone was used. The earlier combined desktop suite passed 152 Swift tests.

## Remaining gates

The missing usable-candidate check joins the exact archived app to the real cross-Mac path: resolve its previously reported macOS Local Network consent, inventory the selected existing coordinator through Devices, explicitly open one allowlisted app on the paired Mac, and observe the actual outcome. Existing terminal/service connectivity is not proof that the native app has LAN access. Consent must not be bypassed.

This ZIP contains the Mac interface, not a checkout-free coordinator/node distribution. Current services still depend on their existing source checkout and Node 24 runtime. Stable signing and permission continuity, packaged service payloads, installer/rollback, separate-Mac Gatekeeper, physical login/reboot and sleep/wake remain distribution and unattended-reliability gates.

New PR native CI is pending. One earlier PR39 native CI run failed enrollment recovery with a fixed unavailable result; the retained logs do not establish its cause. Passing owned simulator tests do not justify labeling that failure a tooling flake. Reliability work is adding sanitized test-stage diagnostics while preserving strict TLS and bounded requests.
