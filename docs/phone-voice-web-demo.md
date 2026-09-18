# Native phone voice and website-control demo

The owner prioritized this milestone on September 14, 2026. Deliver a working native iPhone
voice flow through the coordinator and execution Mac to an actual browser page. Preserve the
release foundation and existing identities. The authenticated production-package producer is
paused while this demo is the next acceptance target.

## Current stage

Implementation is in progress. The existing native speech flow supports reviewed app-opening
commands. The browser companion preserved from PR40 has isolated popup-driven media controls and
read-only WebMCP discovery. Neither establishes phone-to-website control. Physical native phone
enrollment and microphone acceptance are still required.

The first implementation lanes are:

- An explicitly connected browser tab, bounded native messaging and private local node bridge,
  current WebMCP discovery/execution, cancellation and observed outcomes.
- Separate browser authority, closed operations and bounded structured results, followed by
  coordinator routes and node integration. Existing app-opening grants do not gain page control.
- Shared native voice intents, followed by a SwiftUI browser remote using current observed page
  state. A transcript changes the input method; it does not grant access or authorize privileged
  actions through speaker recognition.
- A bounded accessibility adapter for pages without usable WebMCP tools, using semantic elements
  and fresh page observations. Actual browser compatibility must be demonstrated before enablement.

Use [Chrome's current imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api):
`document.modelContext.getTools()` and `executeTool(RegisteredTool, arguments, { signal })`.
Discover actual capabilities. A website must expose WebMCP tools before those tools can be used.
The owner requires accessibility fallback where WebMCP is unsupported. Reviewed accessibility
adapters are a separate execution source and must be labeled accurately. Select the adapter before
dispatch while the exact page and browser grant remain valid. An unbound, revoked, stale or changed
target cannot trigger fallback. Once an action has been dispatched, a timeout, cancellation,
failure or unknown result cannot trigger another adapter or an automatic retry. Report an
unverified action honestly until its effect is observed.
No first-party Netflix, YouTube, YouTube TV or Disney+ WebMCP support has been verified here.

Same-origin navigation invalidates pending commands and old page handles. An existing permitted
tab connection may refresh its state without replaying an action. Closing the tab, losing access,
crossing an unpermitted origin, disconnecting or restarting must never deliver an old mutation to
a new page. Consequential account, purchase, message and settings actions are outside this demo.

## Readiness and owner acceptance

The coordinator must supply one exact installed phone build, coordinator/node/browser versions,
completed setup, remaining attended consent, selected target, named supported sites and a short
test script before announcing readiness. Private access URLs, credentials, identities and
device information stay outside this repository. A synthetic fixture or an extension popup is
engineering evidence, not the completed phone demo.

| Case  | Owner action and expected result once the candidate is ready                                                                                          |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| PVW01 | Open the identified native iPhone app. Confirm the intended Mac and connected page; denied or offline targets cannot receive controls.                |
| PVW02 | Use the actual microphone to request a supported search. The query reaches the chosen site and visible results correspond to the request.             |
| PVW03 | Ask to scroll down, move right in a supported row and open a displayed result. The expected page changes; stale result handles are rejected.          |
| PVW04 | Ask to play, then pause supported media. Observe the real player advance and stop; a submitted request alone is not success.                          |
| PVW05 | Invoke the named reviewed WebMCP workflow on its verified site. Confirm its actual result and execution source; missing support is reported clearly.  |
| PVW06 | Cancel a pending command, then interrupt/reconnect the phone or browser. Outcomes stay truthful, fresh state returns and no prior action is replayed. |
| PVW07 | Remove the temporary demo browser grant or disconnect its tab. Controls stop working for that target; other grants and household state remain.        |
| PVW08 | On a verified page without WebMCP tools, use the same voice controls through accessibility elements. Confirm the reported source and visible result.  |

These cases are **not ready to run yet**. Report `PVW02 PASS`, `PVW04 FAIL — expected …; saw …`,
or `PVW01 BLOCKED — …` against the supplied candidate. A passing simulator, synthetic audio,
URL launch, media fixture or earlier build does not substitute for physical phone acceptance.
