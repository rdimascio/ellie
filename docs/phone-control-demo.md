# Opt-in phone control demo

The phone control page is a narrow demonstration of opening Arc, Safari, or Messages on an explicitly configured Mac. It is not a general command console. The server accepts only `open`, `launch`, or `start` for those three apps, with an optional `Ellie` prefix, and never forwards arbitrary browser text to the coordinator.

## What must be enabled

Phone control is off unless the browser server's caller injects a private `BrowserRemote` bridge. The normally installed browser service does not create or configure that bridge, so a standard installation shows **Phone controls aren't configured on this Mac**. The current bridge is intended for an attended demo harness that connects to an existing authenticated coordinator and supplies an explicit list of allowed node IDs and public labels. Private coordinator credentials, routes, and telemetry must remain outside browser responses and committed configuration.

The phone must pair as a `phone_controller` with an `app.open` grant for each intended node. Grants are fixed by the invitation and cannot be added by the browser. TV sessions are read-only. Revoking the browser client removes access, including when revocation happens while a device lookup is in progress.

## Using the demo

Open the trusted browser HTTPS origin, pair the phone, select an available Mac, and either tap an app shortcut or enter a supported command such as `Open Safari`. The selected Mac must be online and report the `app.open` capability.

The command field is ordinary text input. A phone's keyboard dictation button may convert speech to text using the phone's operating system, after which the page submits that text like any typed command. This demo has no native voice capture, microphone pipeline, speech recognition service, wake word, or voice authorization. Browser microphone access is disabled by the server's permissions policy.

Each node accepts one in-flight command. Commands are never retried automatically. If the connection fails after dispatch or the coordinator cannot confirm the outcome, check the Mac before sending the command again.

## Boundary and rollback

The browser API returns only configured node IDs, public labels, online state, and the `app.open` capability. It does not expose the coordinator's general node list, job list, command routes, credentials, or telemetry. Requests require the paired secure cookie, exact browser Host and Origin checks, JSON bodies for mutations, and a node-specific grant.

Keep the injected bridge limited to the attended demo. To disable phone control, stop the temporary harness or start the browser service without a `BrowserRemote`; revoke the temporary phone client as part of teardown. Follow [Browser pairing and physical-phone rollback](browser-pairing.md) for certificate and device cleanup.

## Validation

Node 24 validation passed 157 tests with one platform skip; Chromium and WebKit browser checks passed 91 tests. These browser checks use simulated responses. A separate strict-TLS API session paired, discovered the real execution Mac, sent `Open Arc` through the existing coordinator and node services, and received a successful native result. Logout returned success and subsequent access returned HTTP 401. This establishes the live API-to-Mac path; physical iPhone app control and keyboard dictation remain pending attended verification.
