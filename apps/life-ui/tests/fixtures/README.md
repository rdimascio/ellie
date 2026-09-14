# Generated app acceptance fixture

`sdk-water-counter-v3.json` is the unchanged output of three sequential requests to the pinned local model documented in [`docs/life-model-validation.md`](../../../../../docs/life-model-validation.md). The browser test installs the returned HTML directly; it does not repair or rewrite generated code.

The exact generated fixture is excluded from automatic formatting to preserve its original bytes. SHA-256: `5c15842ae2e7d885a9f40ed609db9e455020725d06b96753d2d7161258fae274`.

Initial request:

> Build me a small water counter widget. Show the number of glasses of water I have had, with a button labeled Add a glass and a Reset button. Save the count so it survives closing and reopening Ellie. Start from zero for a new user. Use a calm blue design with large readable numbers.

First revision feedback:

> Fix the water counter. Reset currently never works because confirm() is blocked in Ellie's sandbox. Remove confirm(), alert() and all modal dialogs. Clicking Reset should save zero directly. Both buttons must be disabled in the initial HTML until saved data loads. Use Number.isSafeInteger to validate the loaded count. If loading fails, show an inline error and a Retry loading button; leave Add a glass and Reset disabled. While a write is pending, disable both buttons. Update the count only AFTER await window.ellie.storage.set succeeds. If a write fails, retain the previous count, show an inline error, and re-enable the buttons so the user can retry. Keep using the existing waterCount storage key and preserve the calm blue design. Produce the complete functional app.

Second revision feedback:

> The last revision still has broken write handling. Keep the HTML and CSS, but rewrite the entire JavaScript from scratch and remove every old handler and unused helper. Use one numeric variable count, one shared async load(), and one shared async save(next). In save(next), disable both buttons first; await window.ellie.storage.set('waterCount', next); only after that resolves assign count = next and update the displayed count. Catch failure by showing an inline error without changing count or its display. Finally re-enable both buttons. Add a glass calls save(count + 1); Reset calls save(0). No other function may write the displayed count during saving. load() disables both buttons, awaits storage.get, uses the value only if it is a nonnegative safe integer, updates count/display, then enables both buttons. On load failure keep them disabled and show a separate Retry loading button that calls load(). Buttons start disabled in HTML. Do not use alert/confirm/prompt. Do not use parseInt. Return the complete app.

The final generation took 54.2 seconds on September 14, 2026. The fixture still parses stored values permissively and exposes retry as a clickable error message rather than a semantic button. Acceptance covers its observed behavior without treating those choices as a general quality guarantee.
