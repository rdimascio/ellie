# Validation

## Automated

From a clean checkout with workspace dependencies installed, run the release-candidate gate on a physical Mac:

```sh
node scripts/smoke-macos.mjs
```

The gate requires macOS, Node.js 24, the Xcode Command Line Tools, `codesign`, the macOS-provided OpenSSL/LibreSSL command, and a clean Git checkout. It runs strict TypeScript checking and Node tests, compiles and ad-hoc signs the native helper in a temporary directory, and compiles and executes `tests/GeometryTests.swift`. It does not read `~/.ellie`, initialize an identity, install the helper, change permissions, request Accessibility, start a service, or send a command. A missing dependency or failed required check makes the command exit nonzero with a direct explanation.

The Node suite covers deterministic command mapping, safe input rejection, capability and allowlist enforcement, isolated private state, hashed credentials, invitation expiry/single use, pinned HTTPS, peer isolation, command timeouts, context updates, actual server/node round trips with a simulated native executor, independent compute scheduling, bounded local runner requests, and runtime memory-policy rechecks.

No real model, cloud API, microphone, browser session, or personal fixture is required. A synthetic local HTTP endpoint exercises the model adapter. Certificate tests explicitly invoke `/usr/bin/openssl` on macOS, so CI covers the system implementation. Tests generate ephemeral test credentials and certificates in memory/temporary directories, and delete their fixture state after completion. No private key fixture is committed.

The geometry test covers primary, above, below, and negative-coordinate screens. Automated tests cannot verify Accessibility consent or a real application's window behavior.

To request a sanitized machine-readable result, provide a new output path explicitly:

```sh
node scripts/smoke-macos.mjs --report "$HOME/ellie-server-smoke.json"
```

The script refuses to replace an existing report. It records the non-unique hardware model, architecture, macOS and Node versions, Git revision, check status, and an uncompleted manual-check template. It does not record the computer or user name, serial number, network address, private path, model ID, runner output, credentials, or Ellie configuration. Review even sanitized evidence before sharing it.

An already-running model server on the same Mac can be checked separately during readiness:

```sh
node scripts/smoke-macos.mjs \
  --model-endpoint http://127.0.0.1:8080 \
  --model-id 'your-installed-model-id'
```

The endpoint must be a literal loopback origin and redirects are rejected. The script checks inventory and requests one short completion without printing the model ID or response. Supplying no model flags produces `SKIP ... unconfigured (not required)` and does not fail the gate. Supplying both flags makes that requested probe required, so an unavailable runner, absent model, or invalid response fails the gate. The script never reads private configuration to discover a runner.

## Manual acceptance on physical Macs

Use two physical Macs on one trusted local network: a **server Mac** and an **execution Mac** with a logged-in graphical session. Arc and Messages must be installed on the execution Mac; two displays are preferred for the largest-display command. Do not forward port `7437` from the router.

Before starting, run the automated gate above in a clean checkout on each Mac. Record only these machine fields from each report: hardware model, architecture, macOS version, Node version, Git revision, and overall result. Do not use `system_profiler SPHardwareDataType` as evidence because its output includes a serial number. If `~/.ellie/server.json` already exists on the server Mac or `~/.ellie/node.json` already exists on the execution Mac, stop. Use dedicated test Macs or fresh test user accounts; do not delete, replace, or reuse an existing identity for this acceptance run.

Install the tested helper on the execution Mac only after the smoke gate passes:

```sh
bun run build:macos
```

This explicit setup command writes `~/.ellie/bin/ellie-macos`; the smoke script itself never installs it.

### Initialize and pair

1. On the server Mac, initialize exactly once and start the coordinator. Initialization must say that the server was initialized; it must refuse rather than replace existing state.

   ```sh
   bun run ellie server init --lan
   bun run ellie server start
   ```

2. In a second server-Mac terminal, create one invitation:

   ```sh
   bun run ellie server pair
   ```

3. On the execution Mac, begin pairing:

   ```sh
   bun run ellie node pair
   ```

   Enter the server's `https://LAN-ADDRESS:7437` URL. Compare the entire SHA-256 fingerprint shown on the execution Mac with the value shown locally on the server Mac before entering the hidden one-time code. Do not put the code, fingerprint, address, certificate, or node ID in the acceptance record. Expected: pairing succeeds and the invitation is consumed once.

4. Add the terminal application and `~/.ellie/bin/ellie-macos` to **System Settings → Privacy & Security → Accessibility** on the execution Mac. Then run:

   ```sh
   bun run ellie doctor
   bun run ellie node start
   ```

   Expected: `doctor` lists all four tools, the node remains ready, and `bun run ellie nodes` on the server Mac shows the newly paired node. Inspect that output locally because it contains an opaque node ID and may contain model inventory and telemetry.

### Run the five desktop commands

Keep the server and node terminals running. In another terminal on the execution Mac, use a normal, non-minimized Arc window and run each command separately:

```sh
bun run ellie say "Ellie, open Arc"
bun run ellie say "put it in the top-left"
bun run ellie say "open Netflix"
bun run ellie say "move Arc to the big monitor and make it fullscreen"
bun run ellie say "put Messages next to it"
```

Record a result for every row. `Done.` alone is insufficient; verify the visible effect too.

| Step                                                 | Expected behavior                                                                                              | Result      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------- |
| `Ellie, open Arc`                                    | Installed Arc opens or activates; client receives `Done.`                                                      | PASS / FAIL |
| `put it in the top-left`                             | Arc's target window occupies the usable top-left quarter; client receives `Done.`                              | PASS / FAIL |
| `open Netflix`                                       | Arc opens the configured HTTPS site using its existing browser profile; client receives `Done.`                | PASS / FAIL |
| `move Arc to the big monitor and make it fullscreen` | Arc moves to the largest display by logical desktop area and enters native fullscreen; client receives `Done.` | PASS / FAIL |
| `put Messages next to it`                            | Arc leaves fullscreen; Arc is left and Messages is right on that display; client receives `Done.`              | PASS / FAIL |

### Probe an optional installed model

This step is optional. If no local runner was configured, record `SKIP (unconfigured)`; that is an accepted result and desktop acceptance remains valid. Do not install or download a model just for this gate.

If an already-installed model and loopback runner were explicitly configured using [the worker instructions](inference-workers.md), perform the full Ellie-path probe before revocation. On the server Mac, inspect `nodes` locally to confirm the worker is fresh and eligible, then substitute the exact configured ID:

```sh
bun run ellie nodes
bun run ellie infer your-installed-model-id "Write one short greeting."
```

Expected: the command returns non-empty model text within the deadline. A configured probe failure is a failure, not an unconfigured skip. Record only PASS or FAIL and a sanitized limitation; do not copy the model ID, response, node listing, prompt history, or telemetry into shared evidence.

### Revoke and verify

On the server Mac, identify the newly paired test node in the local `nodes` output and revoke that exact opaque ID:

```sh
bun run ellie nodes
bun run ellie server revoke NODE_ID
```

Expected: the CLI prints `Node revoked.`, the waiting node loses authorization, and a subsequent command from the execution Mac fails explicitly. Do not paste the real ID into the record.

```sh
bun run ellie say "Ellie, open Arc"
```

Confirm no new app activation occurs after revocation. A native action already in progress at the moment of revocation may still complete; record that observation rather than retrying automatically.

### Acceptance record

Keep one sanitized record with:

- date and Git revision;
- hardware model, architecture, macOS version, Node version, and automated-gate result for each Mac;
- PASS or FAIL for initialization, pairing, each of the five commands, and revocation;
- PASS, FAIL, or `SKIP (unconfigured)` for the optional model probe;
- observed visible behavior and known limitations, using generic app and display descriptions.

Do not include user or computer names, serial numbers, IP addresses, opaque node IDs, fingerprints, pairing codes, certificates, model IDs, model output, private paths, configuration, or Keychain data. This checklist is not a record of a completed hardware test until an operator fills in every result on two physical Macs.

macOS can constrain sizes, delay Space transitions, or limit operations on minimized, modal, and unusual windows. Use a standard non-minimized window for first validation. Report OS/app versions and sanitized behavior, without sharing live config, node output, certificate material, or private paths.
