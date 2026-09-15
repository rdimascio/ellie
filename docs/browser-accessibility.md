# Browser accessibility primitive

Ellie includes a bounded macOS accessibility primitive for reading an authorized browser page and dispatching a small set of low-impact actions. It is an integration prerequisite, not a connected fallback or user-facing feature. No helper command currently exposes it.

The caller must obtain the browser process from a trusted native-host connection and correlate that process with the authorized browser, focused window, tab, and exact page URL and document revision. A process identifier supplied by a phone or network request is never authority. The primitive additionally verifies the live Safari or Arc process with Security.framework against fixed signing requirements and checks the executable information reported by `NSRunningApplication`.

An observation belongs to one adapter instance and one authorized page object. A later read invalidates its prior generation. Every action revalidates the process launch identity, focused window, WebArea, address field, full URL, document revision, generation, and retained accessibility element identity. Stale, ambiguous, revoked, unbound, or changed targets fail closed. Future selection of this adapter may occur only before dispatch when the primary browser API is unsupported or unavailable; an attempted operation is never retried through another backend.

Traversal limits node count, depth, attribute calls, text, items, and AX messaging time. The internal two-second value is a checked AX traversal budget. Security.framework verification is synchronous, so a future helper process must impose and enforce the whole-operation deadline.

Scroll, search, selection, and playback dispatch report an unverified effect. Search has separate value-setting and confirmation boundaries; failure after setting the value is terminal and unknown. The primitive never evaluates JavaScript, accepts selectors or arbitrary URLs as actions, or treats a successful accessibility call as proof that playback or navigation completed.

The included fixture uses synthetic accessibility trees. Actual Safari and Arc accessibility layouts, browser-parent correlation, TCC behavior, and end-to-end dispatch have not been accepted on real browsers.
