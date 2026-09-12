# macOS background services

Ellie provides per-user coordinator and node LaunchAgents for a source checkout. Both run in the logged-in user's `gui/<uid>` domain, restricted to an Aqua session. The node retains the graphical session needed by the Accessibility helper. This follows [Apple's user-agent lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) and the local `launchctl(1)` and `launchd.plist(5)` manuals. These services start after graphical login, stop at logout, and cannot control the desktop at the FileVault login screen.

This is a developer installation. Keep the checkout and its installed dependencies at a stable location. LaunchAgents invoke an absolute Node.js 24 executable directly; Bun 1.4.2 continues to manage dependencies and CLI scripts. Shell aliases, shell startup files, version-manager shims, and terminal environment variables are not needed at login. Moving the checkout or replacing the pinned Node installation requires stopping and reinstalling the service. Stop services before changing the source checkout or dependencies that they run.

## Install and manage

First complete the existing `server init` or `node pair` flow, build the native helper, and grant the required permissions. Existing installations should **not** initialize or pair again. Installation checks for existing configuration, private file permissions, a helper executable, and Node 24. It never generates an identity or writes Keychain credentials.

Stop each existing foreground process with Control-C before starting its service. On the coordinator Mac:

```sh
bun run ellie service install coordinator
bun run ellie service start coordinator
bun run ellie service status coordinator
bun run ellie doctor coordinator
```

On the paired execution Mac:

```sh
bun run ellie service install node
bun run ellie service start node
bun run ellie service status node
bun run ellie doctor node
```

Use the same commands for both roles if one Mac runs both. Never use `sudo`. A logged-in graphical session must exist when starting, stopping, or uninstalling a registered service. Installation writes only the selected definition in `~/Library/LaunchAgents/`; it does not start a process immediately. A newly installed, enabled service starts at the next graphical login. Run `service start` to enable and start it now. macOS may require allowing Ellie's background item in System Settings.

`service start` is idempotent and does not kill a running process. `service status` reports installed, GUI session, enabled, loaded, running/waiting/stopped state, PID, and last exit code when launchd supplies them. A PID confirms a process exists, not that it is ready; use role-specific doctor checks for readiness. The human-readable `launchctl print` format is parsed conservatively and may require adjustment for future macOS releases.

```sh
bun run ellie service stop node
bun run ellie service start node
bun run ellie service logs node
bun run ellie service uninstall node
```

`stop` disables future login starts and uses `bootout` to remove the running service. Sending a signal alone would let KeepAlive relaunch it. `start` explicitly enables it again. `uninstall` removes only that role's managed plist after stopping it. Identities, certificates, pairing, the helper, job metadata, logs, and Keychain credentials remain intact. Repeated install and uninstall are safe; existing unmanaged plist files are preserved. To change an installed checkout/runtime path, stop, install from the intended checkout, then start.

## Diagnostics and logs

`doctor` retains the original native-tool check. `doctor coordinator` and `doctor node` additionally check private configuration permissions, certificate dates, existing Keychain access, helper signature, GUI and LaunchAgent state, pinned authenticated reachability, and the node's registration freshness. Optional local model availability is a warning and does not fail a working desktop node. Unlock the login Keychain and allow the existing helper if macOS requests access. A terminal's successful Accessibility check does not establish permission for launchd: verify a harmless desktop command through the running service on each execution Mac and grant the service's responsible executable if System Settings requires it.

`nodes` lists registered node processes. A coordinator-only Mac does not appear in that list: a MacBook coordinator and one Mac mini node should produce one entry. `doctor node` reports terminal helper tools separately from registered node tools and fails when a desktop-enabled node has not advertised all four capabilities. If the terminal sees window tools but the node advertises only app/URL opening, check that `~/.ellie/bin/ellie-macos` is enabled in the execution Mac's Accessibility settings, then stop/start the node service to refresh its registration. If the mismatch persists, the LaunchAgent's Accessibility context still needs investigation; the terminal result alone is not a service acceptance pass.

Role-specific doctor output contains fixed diagnostic messages. It omits credentials, identities, addresses, paths with usernames, models, command text, and raw tool errors. `nodes`, `say`, and `infer` remain interactive commands that can print private output; do not pipe them into service logs.

Service processes write only allowlisted timestamped events to `~/.ellie/logs/coordinator.jsonl` or `node.jsonl`. The directory is `0700` and files are `0600`. Each file rotates at 128 KiB with one backup; repeated identical events are suppressed for one minute. `service logs` reads at most the last 100 validated entries and drops any extra fields. No error messages, stack traces, command payloads, prompts, results, node identifiers, URLs, model names, credentials, or external analytics are recorded. Raw stdout/stderr goes to `/dev/null`, and core dumps are disabled, so dependency/runtime failures before logging initializes appear through launchd's exit status and doctor. Events include `starting`, `ready`, `connected`, `reconnecting`, `stopping`, and fixed failure categories such as `configuration_missing` and `port_in_use`.

## Failure, network, and sleep behavior

launchd keeps each enabled role alive with a 30-second restart throttle. Shutdown receives SIGTERM with a 15-second grace period before launchd can force termination. A process exit never proves whether a native action completed. Durable job recovery and cancellation must be deployed before using unattended desktop services: delivered work has an unknown outcome after a coordinator crash, and no desktop action is automatically replayed. Check the Mac before explicitly submitting another command.

The node owns network recovery; the plist deliberately has no network-dependent KeepAlive condition. Disconnections and coordinator restarts trigger bounded request deadlines and capped reconnect delays. Sleep suspends useful work; waking lets the current request expire or reconnect. This does not prevent sleep, wake another Mac, discover a changed coordinator address, bypass a locked Keychain, or restore logged-out GUI sessions. A changed coordinator address must be corrected locally while preserving the pinned certificate and identity. Actual sleep/wake and outage recovery on the paired Macs remains an acceptance check.

## Validation record and acceptance

Automated tests use synthetic private directories, injected launchctl results, synthetic certificates, fake Keychain access, and fake capabilities. They check lifecycle idempotency, persistent disable/enable, missing GUI sessions, failed stops, unmanaged files, permissions, log rotation/redaction, optional-model warnings, and stale nodes. These tests do not grant Accessibility or execute native desktop actions.

`bun run smoke:services` (Node 24 on macOS) uses a uniquely named, inert temporary LaunchAgent to verify the generated plist, GUI startup, relaunch after SIGKILL, and removal with bootout. It does not use `~/.ellie`, Keychain, the real service labels, or native actions. This smoke passed on macOS 26.6.2 with Node 24.21.0 and Bun 1.4.2. It proves the launchd process policy, not household service acceptance.

The operator previously validated foreground operation: a MacBook coordinator paired to a Mac mini over LAN; doctor exposed all four tools; commands from the MacBook opened Arc, tiled windows, opened Netflix, and placed Messages alongside Arc on the mini. Exact hardware models and macOS versions for that record were not supplied. Actual model inference and distributed scheduling have not been hardware-validated.

Before treating services as household-ready, record these physical two-Mac checks:

1. Install/start both roles, close all terminal tabs, and confirm a harmless allowed desktop command works on the mini. Verify the helper's Accessibility and Keychain access in the LaunchAgent context.
2. Stop/start and repeat install/uninstall for each role. Verify stop remains stopped after logout/login and start enables the next login. Confirm pairing and identities survive.
3. Kill the coordinator during queued work and during a native action. After relaunch, inspect job state and verify no action runs automatically again; repeat for a node crash.
4. Interrupt and restore the LAN connection, then sleep/wake each Mac. Confirm recovery without a tight retry loop or replay, and confirm offline/stale state is reported honestly.
5. Cancel queued and executing work. Confirm the result explains that already-started native effects may finish, and that later actions in a multi-action command do not start.
6. Review redacted service logs and useful failure diagnostics for a locked Keychain, denied Accessibility, missing helper, and busy coordinator port. Keep optional inference validation separate.
