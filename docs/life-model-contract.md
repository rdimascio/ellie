# Local model contract

The optional local model interprets conversation and generates sandboxed applications. The host owns access checks, validation, durable changes and action receipts. A model response is a proposal; returning valid JSON does not establish that an operation happened.

The model-context module supplies the exact supported action shapes, field limits, temporal formats and optional fields. The contract covers replies, source search, explicit memory, reminders, events, needs, contacts, agenda queries and source summaries. A plan has at most eight actions and at most one mutation-family proposal, including a source-summary workflow or an incomplete action draft.

Reminder and event drafts have a separate action type. A draft must omit its required time; it cannot pass validation as an executable operation. The harness checks the originating direct request before asking the missing question and handing a typed continuation to the service. Executable intents retain their required fields. History, sources, remembered text and adopted guidance cannot grant additional action authority.

## Bounded context

The serialized plan messages have a hard 64 KiB UTF-8 ceiling, including JSON escaping. This is a byte limit, not a token estimate or a guarantee that a particular runner's context window is large enough. The current request is preserved; an oversized current request fails before inference.

Supported preferences, whole adopted instructions, a contiguous suffix of recent history and whole memory facts are admitted in that order. A partial selection of scoped people, needs, places and commitments follows, then selected source excerpts. Each category has its own budget, and the combined ceiling applies to every addition. Instructions, memory facts and projected world records are omitted whole so truncation cannot remove a qualification. A memory over 2,000 characters is omitted and counted rather than silently shortened. History never skips a large recent turn to present an older turn as the latest exchange.

The [world selection](life-context.md) is bounded to twelve records and 8 KiB. Saved budgets are not live prices, saved places do not establish current location or opening hours, and a missing item does not establish that it does not exist. Record facts and notes are untrusted observations; only the current direct request can authorize a host action. Conversation-specific style overlays saved preferences for that private conversation without changing the user's or group's defaults.

Source text may be excerpted at a Unicode code-point boundary, with an explicit excerpt flag. The model receives omission counts and instructions not to claim knowledge of omitted material. Scoped retrieval and current-source checks remain the caller's responsibility; compacting context never expands access.

## Transport behavior

The adapter uses an explicitly configured unauthenticated literal-IP HTTP loopback endpoint and rejects redirects. Its response limit is 256,000 bytes. A conversational plan has a thirty-second deadline. App generation has a separate ninety-second default, configurable up to two minutes; callers may choose shorter deadlines. This longer generation budget does not extend ordinary chat planning.

Deadline and cancellation return even if an injected transport ignores abort. At most four inference requests can remain active in one adapter instance. A timed-out fetch that has not actually settled retains its slot, so retries cannot create unlimited orphan requests. Response bodies are cancelled on abort, oversized headers or read failure, without waiting indefinitely for a cancellation callback.

Invalid JSON or an invalid action schema gets one repair attempt before the host receives any proposal. Repair retains the original direct request and includes at most 4,000 characters of untrusted diagnostic output. Both attempts share the original deadline and context ceiling. Transport failures are not retried, and a second invalid proposal fails without executing either proposal.

Synthetic model replies and transport fixtures establish host behavior. Separate [real-model acceptance](life-model-validation.md) exercises a pinned local model through the actual harness and temporary stores; it does not establish compatibility or quality for every model. The [readiness probe](life-model-status.md) checks inventory without running inference.

## App generation

The builder supplies the synchronous `window.ellie` SDK contract, including raw-value reads, acknowledged writes, initialization and error handling. Generated apps use inline classic JavaScript and CSS in the opaque plugin sandbox. Browser databases, external resources, navigation and modal dialogs are unavailable. The host supplies storage capability only; model instructions do not add new grants.

A revision includes the previous complete app as untrusted input and requests a complete replacement. Serialized builder messages have a 256-KiB UTF-8 ceiling. The adapter distinguishes invalid output, transport failure, timeout and cancellation through typed errors with static user-facing messages. The harness separately guards generation admission, scope, cancellation and current version before saving. No generated code executes on the server.

An app that passes JSON, syntax and capability checks can still have functional defects. Real browser acceptance must check the requested behavior, persistence and failure handling. Natural-language revisions create retained app versions, allowing a failed improvement to leave the existing version active and successful revisions to be rolled back.
