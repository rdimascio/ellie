# Ellie speed and polish decisions

September 14, 2026. This document records the implementation contracts for the user-directed polish work. Root owns integration, testing and PR merges. Separate native/installer work and live household services are outside this slice. The existing boards, widget grid, expanded apps and floating conversation orb remain the product structure.

## Conversation progress

The model still returns one complete, validated action plan. Streaming improves visible responsiveness without introducing a second inference or changing action authority.

```ts
type LifeModelProgress = {
  phase: "queued" | "drafting" | "validating";
  text?: string;
};

plan(request, signal?, onProgress?: (event: LifeModelProgress) => void);
```

- `text` replaces the entire provisional preview. Missing text clears the previous preview. Only the decoded top-level JSON `reply` string may appear; action JSON and raw model output never appear.
- Before a schema repair, emit `drafting` without text. The failed candidate must disappear. After response collection, `validating` describes host-bound validation, not successful execution.
- Emit at most ten text updates per second, with immediate phase transitions and the last replacement permitted. Observer exceptions must not fail inference, and no callback may run after cancellation.
- Retain standard JSON-response compatibility. SSE decoding must handle UTF-8, JSON escapes and event boundaries split across transport chunks. Bound the complete response and incomplete buffers. A transport/truncation failure cannot trigger an inference replay; the existing one-time schema repair remains the only automatic retry.
- Forward the trusted service abort signal through the harness into `plan`. Deadlines include response consumption. Uncooperative underlying transport must keep its admission slot until actual settlement.

The service attaches optional `progress: { phase, text?, revision }` to the existing pending request recovery envelope. It owns a monotonic revision for each request. Progress is in memory only, limited to sixteen active entries and an 8-KiB preview per entry, and cleared in `finally` and during reset/shutdown. A progress entry is readable only after the ordinary request ownership/access check, while the authoritative turn is pending and its original context remains current. Stale context must clear or suppress the preview immediately; cached text is not an authorization bypass.

The UI polls a pending request approximately every 300–500 ms and applies only newer revisions for the active request, conversation and scope. It labels provisional text as a draft, does not save it to history and replaces it with the final host response. Scope changes, reset, failures and completion clear it. Only the final durable response and action receipts establish that an operation occurred. Streaming a plausible claim must never be presented as a completed operation.

## Prompt size and inference admission

Keep the static instruction prefix stable and compact repeated prose while retaining every supported operation, permission boundary, date rule and real-model repair example. Preserve the 64-KiB serialized hard bound and omission accounting. Do not introduce heuristic tool removal that prevents an otherwise valid request from being represented. Keep whole memories, qualifications and a contiguous recent history suffix; do not cut facts merely to meet a smaller target.

The follow-on scheduler should permit one active local inference and at most three queued jobs. Foreground chat and its repair precede queued app builds and improvement work; equal priority is FIFO. Queue wait counts toward the existing whole-request deadline. Remove aborted queued work, never preempt a running generation, and release an active slot only when the underlying work actually settles. Admission must be shared by every adapter method. A running app build can still delay chat on a one-slot model runner; priority scheduling alone does not eliminate that delay.

## Automatic memory

The canonical actor-private prompt journal remains complete and retains every turn's provenance. Consolidation changes derived selection, not stored history or forgetting semantics.

- Deduplicate exact whole observations after conservative whitespace/case normalization, retaining the newest observation's provenance. Do not use fuzzy similarity that could collapse negation, changed quantities or qualifications.
- Add a bounded query-specific selection for model input while retaining the ordinary cached Memory inspection view. Rank lexical relevance with a recent-observation floor and explicit corrections; target approximately 4–6 KiB of whole observations. The current prompt can be excluded from selected historical context because it is already supplied as the direct request.
- Retain source order/timestamps for corrections and contradictory evidence. Newer explicit corrections outrank older statements; unsupported semantic reconciliation must not silently erase an older fact. Any narrowly recognized replacement rule needs adversarial qualification/negation cases.
- The model context validity token derives from the complete authoritative actor/scope context, not only selected observations. A forgotten, deleted, suppressed or changed source still invalidates in-flight proposals when it is absent from the selection.
- Actor and exact-space access checks precede ranking, limits and cache lookup. Forgetting and conversation deletion continue invalidating both summaries and model history. Historical text cannot grant tools or replay actions.

## Subsequent bounded polish

Generated-app improvements should extend the existing sandbox and SDK contract: consistent theme defaults, keyboard/focus behavior, labeled controls, responsive layout and visible async error/retry states. Keep script compilation and sandbox authority checks. A static HTML check cannot establish application correctness; browser acceptance must exercise the actual generated artifact, persistence across reload, rejected reads/writes and its meaningful controls. Do not describe a generated app as functionally verified solely because it parses.

Proactive suggestions already have scoped reasons, expiry, quiet hours and a durable twelve-hour issue cooldown. The next slice should add repeated-dismissal backoff linked to the suggestion's source and category, while preserving reminders and the underlying unfinished task. A person's dismissals must not silently become another group member's personal preference. Prefer actor-private feedback with source-scope provenance and bounded backoff; apply source access checks before reusing it. Completion and dismissal remain different outcomes.

## Acceptance gates

Before merge, exercise progressive reply display, malformed output and repair clearing, aborted/late callbacks, wrong-scope reads, stale context, reset, reload/request recovery and final action authority. Compare serialized prompt sizes and representative actual local-model timings, including first visible preview and final completion, without presenting one tiny request as a general performance benchmark. Memory checks cover duplicates, negation/qualifications, corrections, query relevance, deletion/forgetting and actor/group isolation. Run the repository's canonical checks and authenticated browser acceptance for the integrated candidate.
