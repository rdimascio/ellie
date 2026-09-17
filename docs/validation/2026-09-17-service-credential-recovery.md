# Service credential recovery — September 17, 2026

The native phone-to-website milestone remains in engineering. This record separates the installed development-package observations from automated browser checks and earlier owner acceptance.

## Observed package update

The development package from `a7a01019faefe2d00783d9bafdc8c6758312ffba` includes PR149's packaged diagnostics, PR150's launchctl output correction and PR151's structured disconnected-browser result. All three changes passed their hosted checks before merging. The package's 556 manifest files, tracked source, native signatures and ZIP roundtrip were verified before staging. Its credential helper was byte-identical to the preceding development package; that did not establish permission to read each host's credentials.

On the physical coordinator Mac, the managed stop, selection, start and status checks passed. Its HTTPS listener became ready, and the existing execution node reconnected after the interruption. Existing identity and configuration fingerprints were unchanged.

On the physical execution Mac, selection and launchd status passed, but startup then reported a Keychain timeout after 60 seconds. The previous package and its exact browser-native-host ownership record were restored. That package also failed to start after 60 seconds. The node was explicitly stopped to contain automatic restart attempts. Metadata-only inspection reported unlocked login and default Keychains; it did not read an item or prove why credential access stalled.

After the owner reported approval, a separately reviewed one-shot check attempted to read the execution Mac's existing credential. It failed after 60 seconds; the owned helper exited and the finished diagnostic LaunchAgent was unloaded. The check made no network requests, service changes or credential writes. The execution node remains stopped. The location and type of the reported approval still require clarification before another attended attempt; the failed read does not establish that approval was denied or the credential was lost.

These observations do not establish a completed two-Mac upgrade, unchanged macOS consent across updates, sleep/wake recovery or an accepted daily-use release. A running launchd process is not sufficient evidence that the authenticated endpoint or node registration is ready.

## Helper cleanup follow-up

The reviewed `b7880e2` follow-up preserves the 60-second credential deadline and caps helper output at 65,536 bytes. A timeout or output failure now stops the retained child, escalates from TERM to KILL after 250 milliseconds if needed, and waits for its close event. Failure to confirm closure within three seconds produces the fixed `keychain_cleanup_uncertain` event. Late output cannot turn an expired request into a success. Credentials remain on stdin and in memory; the change neither reads another account nor alters permissions.

The focused config and service tests passed 19 cases. Timeout and late-output checks use a real owned synthetic Node helper with an advanced test clock; the missing-close case uses an explicit fake child. These checks do not access the real Keychain. This cleanup change does not modify launchd's restart policy: an operator must still stop a service that repeatedly fails credential access before an attended recovery attempt.

PR152 merged the cleanup change and PR153 added native HTTPS authorization through the production coordinator and node for a disconnected browser-status request. Their merged source, `a7ec76c`, passed post-merge CI: 904 Node tests with one platform skip, 197 Swift tests, six iPhone Simulator UI tests, and the app-hosted pinned HTTPS/Keychain gate. These automated checks do not establish physical Keychain recovery or website acceptance. The new cleanup code is not part of the installed package described above.

## Automated browser evidence

An isolated loopback test used the exact staged package's coordinator, client, node and browser-operation selector with a synthetic disconnected browser bridge. One explicit status request and one explicit refresh returned structured `unavailable` results. Both durable jobs ended as failed, without accessibility dispatch, node reconnection or replay. Owned fixture processes and state were closed and removed.

This is packaged software evidence with a synthetic bridge. The earlier real browser-status timeout remains an unknown durable job and was not replayed. No new physical browser-status request or website action was performed during this update.

## Next acceptance boundary

The coordinator must first resolve the execution Mac's credential access with the owner, then provide the exact package, preserved-identity checks, managed start procedure and rollback steps. Do not replace credentials or re-enroll a paired client to mask a startup failure. A timed-out helper request is not evidence that an item is missing.

The temporary native-phone listener expired with its identity and pairing state retained. Resuming that listener or adopting its identity into an installed runtime requires a separate concrete handoff. Earlier [PH01–PH02 owner results](2026-09-17-native-phone-app-opening.md) remain historical acceptance of pairing and reviewed app opening. PH03 and the complete [IP01–IP07 website journey](../manual-qa.md) remain pending.
