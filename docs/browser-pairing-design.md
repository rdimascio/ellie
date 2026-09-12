# Pairing page

This slice connects a browser to Ellie and confirms its own revocable identity. It exposes no household information or desktop commands. Physical phone trust remains an acceptance gate before those features are connected.

The page extends the command-center design: Mist `#edf3f3`, Paper `#ffffff`, Ink `#18353b`, Slate `#536b70`, and Ellie's existing orange icon. Avenir Next and platform fallbacks keep every asset local. A single focused column places the device connection ahead of secondary explanations, with a 32 px heading, 16 px body, and touch controls at least 44 px tall. Labels and instructions are left-aligned. The connected state uses the same structure so the confirmation does not shift focus unpredictably.

```text
          Ellie icon and name
       Connect this device
       Where to get a code
       [ Pairing code      ]
       [ Connect to Ellie  ]
       Status and next step

       Connected to Ellie
       Assigned device name
       Phone / shared display
       Session expiry
       [ Disconnect device ]
```

A full dashboard or decorative room illustration would compete with the one action this page supports. The design keeps the existing brand and removes those elements. It states the current feature limit plainly: connection is available, household controls are not yet available in this version.

Codes stay out of URLs, storage, logs, and visible error text. Mutations happen only after a deliberate click and never retry automatically. If a pairing response is lost, the page checks its session before suggesting another attempt. Read-only connection checks use bounded timeouts and backoff; reconnecting or unavailable states never imply a confirmed session. A revoked or expired session returns to the pairing form.

Acceptance covers phone and desktop layouts, focus, safe code handling, role labels, revoked sessions, lost responses, disconnect failure, and unavailable service states. Browser viewport tests use synthetic responses. Separate real HTTPS tests exercise the server boundary with an explicitly trusted test CA; neither replaces physical Safari or TV acceptance.

The rendered review covered 390 px phone, 1440 px laptop, 1920 px display, and 320 px narrow layouts.
The orange icon, restrained green confirmation, left-aligned labels, and single primary action
retain Ellie's existing appearance. The narrow heading wraps cleanly and the code field and show
control remain usable without horizontal scrolling. Connected screens name the assigned device
and role before the disconnect action. The narrow screen scrolls vertically when recovery guidance
is present; controls and status remain in normal document flow. Browser regressions also verify
visible keyboard focus and code clearing. Physical touchscreen, Safari trust, and TV remote input
remain unvalidated.
