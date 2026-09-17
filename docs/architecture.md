# Architecture

## Current execution flow

A text client submits a command to `ellie-server`. The pure router produces a typed plan, or returns an unsupported-command response. The server checks the target node's advertised capabilities and its own app/site allowlist. A waiting HTTPS long poll delivers the job immediately to `ellie-node`, which independently validates the wire message and checks its local allowlist. The Swift helper then executes a fixed native operation using structured JSON over stdin. No command text is interpolated into a shell, script, or AppleScript.

An explicitly configured [decision provider](decision-routing.md) can interpret unmatched desktop requests. It starts in shadow mode, which returns a proposed action without dispatch; a separate execution setting enables single-action plans through the same validation, permission checks, job lifecycle, and native executor. The optional provider is independent of the pure router and never runs for a recognized deterministic command. A node is reserved while inference is pending; cancellation, reconnect, revocation, and shutdown invalidate the proposal.

The node's outbound connection avoids opening an execution port on each Mac. Transport is behind a small client boundary; an authenticated private-network address can replace a LAN address later without changing tools. Tailscale is a possible deployment option, not a dependency or an implemented onboarding integration.

Each node has an opaque generated identity, transient pronoun context, one in-flight job, and separate execution/compute capability advertisements. Long polling has no periodic dispatch delay when idle. Unrelated nodes can execute concurrently. The server commits new pronoun context only after reported success. Capabilities are refreshed when a node reconnects; restart the node after granting Accessibility.

Jobs expire. Before dispatch, the coordinator stores only job identity, kind, target, lifecycle timestamps, state and enum outcome in SQLite. It commits `delivered` before writing the payload to the node, and the node acknowledges `running` before native execution. Delivered commands are not automatically replayed after disconnects or coordinator restart; recovered delivered/running work becomes `unknown`, while queued records are expired or safely abandoned because their payload was never persisted. The node also rejects recently seen job IDs and expired jobs. A timeout may mean an action completed but its acknowledgement was lost; the client reports this uncertainty. There is no exactly-once guarantee across crashes. Failed multi-window operations can partially apply and are not automatically rolled back.

Callers can cancel by job ID or abort a waiting transport request. Cancellation before delivery removes the in-memory work. After delivery, heartbeat responses carry the cancellation request to the node, which aborts the model request or spawned native helper when possible. Cancellation and connection-loss aborts do not claim that an already started native side effect was undone. Node reconnect uses bounded exponential backoff with jitter, resets after a stable connection, and emits status only when connection state changes; absolute request deadlines ensure a stalled LAN request eventually enters that reconnect path after a server restart, network interruption, or sleep/wake.

The server runs in the foreground for this milestone. LaunchAgent installation, daemon supervision, a menu bar client, node naming, and display aliases are future onboarding work. A running Mac must remain awake for reliable command delivery. The execution node requires an unlocked/logged-in graphical session for useful app control.

## Layer boundaries

| Layer       | Decision it owns                            | Status                                                                                |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Personality | How to speak; tone, values, style           | Default specification and replaceable contract                                        |
| Router      | Whether a known action can bypass inference | Deterministic implementation                                                          |
| Models      | Reasoning and language inference            | Optional independent local-worker probe; streaming provider contract remains separate |
| Knowledge   | Retrieval, evidence, uncertainty, citations | Provider contract only                                                                |
| Voice       | Audio input/output, timing, expressiveness  | Streaming contracts only                                                              |
| Tools       | Typed, capability-gated actions             | Four native macOS operations                                                          |
| Memory      | Explicitly permitted local persistence      | Interface only; no persistent memory                                                  |

The planned complexity and evidence path is: deterministic action → tiny local router for uncertain intent → stronger local conversational model → retrieval/research when evidence is needed → explicitly enabled frontier skill when appropriate. Uncertainty is not permission to run a guessed command. Clarification precedes ambiguous execution. A tiny routing model is not the authority for serious history, politics, literature, religion, philosophy, or other knowledge questions.

Model providers are replaceable. MLX is the intended optimized Apple Silicon backend; no particular model family, runner, API vendor, or prompt format is coupled to the current protocol. Cloud providers must require separate opt-in and data-disclosure permissions. None are called by the deterministic V1 path; the explicit `infer` probe can use an enabled local runner.

Voice will use local streaming STT → routing/tools/model → local streaming TTS. Push-to-talk ships before wake words. One cancellation scope per turn should connect VAD, barge-in, transcription, generation, speech synthesis, and queued audio. Personality influences phrasing and vocal expression through a voice adapter; it never weakens permissions. iPhone voice input comes later through a distinct client identity, not by reusing an execution node's credential.

Tools currently form a closed, versioned discriminated union. A later plugin registry must preserve runtime schema validation, declared capabilities, local grants, and separate provider configuration. Native code is intentionally isolated from networking and reasoning.

## Design limits

No voice, automatic conversational model routing, browser agent, wake word, semantic memory, native UI, or internet research is currently implemented. The explicit local inference probe is described below. Opening Netflix is an allowed HTTPS link opened by macOS; Ellie does not inspect Arc tabs, cookies, or page contents. Moving browser windows uses Accessibility and is independent of browser automation.

App launching and URL opening require only normal macOS app access. Window placement requires Accessibility. Screen Recording and microphone permissions are not requested. The helper reads window bounds and identifiers, not window titles, document text, or screen images.

## Execution and compute are separate node capabilities

A physical Mac can host an execution role, an inference-worker role, or both under its paired node identity. `executionCapabilities` describes permitted desktop tools; the legacy `capabilities` field is preserved for older clients. `computeCapabilities` independently describes the inference backend, independent-worker mode, and locally enabled installed models. Enabling compute grants no window or application permissions. Set `executionEnabled: false` for a compute-only Mac.

The coordinator remains the owner of routing, conversational context, permissions, and placement. Desktop commands retain their explicit target node. The controller-only `infer` probe returns model text and never interprets it as an action. `say` uses the deterministic route first, with optional bounded decision routing only when explicitly configured. The decision adapter calls its own coordinator-local runner or explicitly enabled hosted API; it does not use the independent worker scheduler.

### Implemented independent-worker path

1. Pair each Mac with its own identity. Configure an optional local model runner in its private `node.json`.
2. The node advertises both roles. The compute adapter intersects its configured model allowlist with the runner's `/v1/models` inventory. An unavailable runner withdraws compute capability while execution can continue.
3. Every 10 seconds, and after completing a job, compute workers report fresh resource metrics over authenticated, pinned HTTPS. Metrics describe that Mac, not pooled cluster memory. Execution-only nodes send a lightweight liveness heartbeat without resource telemetry.
4. The controller submits a model ID, bounded prompt, and token limit to `POST /v1/inference`. The coordinator selects one eligible independent worker and reserves its one in-flight slot before accepting another placement.
5. The existing outbound long poll delivers the typed inference job. The worker checks its own current memory, power, thermal, load, network, and model availability before calling its configured loopback runner. It cannot use a job-supplied endpoint or download an arbitrary model through Ellie.
6. The worker returns bounded text, or a failure. The server returns the selected worker ID. There is no replay or automatic cross-Mac retry. A new heartbeat is required after result/timeout before another placement.

Each Mac currently has one shared in-flight slot for desktop or inference work; different Macs run concurrently. This bounds resource use and avoids desktop/inference contention on the same agent. There is no persistent queue: if all workers are busy or unsuitable, the request fails with an actionable response. The current non-streaming developer probe has a 30-second deadline, defaults to 256 generated tokens, accepts at most 2,048 requested tokens, and returns at most 4,000 characters (with truncation marked). It is intended for small local models, not long research turns.

### Telemetry and admission

The server stamps telemetry receipt using its own clock, avoiding clock-skew decisions. Poll traffic refreshes liveness but cannot refresh an old resource sample. Samples older than 35 seconds are ineligible.

| Signal           | Collection and scheduling use                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Free/total RAM   | Conservative admission memory in bytes; the available amount must meet the model's explicitly configured `requiredFreeMemoryBytes`                                 |
| Active load      | Ellie active job count plus one-minute OS load divided by CPU count; one job maximum and normalized load below 1.5                                                 |
| Power/battery    | macOS `pmset -g batt` plus native low-power mode; AC preferred; battery below 30% or unknown battery percentage while on battery rejected; low-power mode rejected |
| Thermal state    | Native `ProcessInfo.thermalState`; serious/critical rejected; nominal preferred                                                                                    |
| Network quality  | RTT of successful heartbeat HTTP requests to the coordinator; above 500 ms is poor and rejected                                                                    |
| Installed models | Intersection of configured model IDs and the loopback runner inventory; unavailable models are never scheduled                                                     |

Unknown optional hardware/network readings are explicitly `unknown` or `null`, not healthy fabricated values. Unknown thermal/AC state is allowed with a lower preference; required memory and telemetry freshness must still be present. RTT measures responsiveness, not bandwidth, packet loss, or sustained throughput. OS load is not GPU utilization, and Ellie active jobs do not include unrelated processes or other clients of the model runner.

Admission memory is deliberately conservative. On macOS it includes free and inactive VM pages reported directly by Mach [`host_statistics64`](https://developer.apple.com/documentation/kernel/1502546-host_statistics); Apple's VM headers specify that the free count already includes speculative pages. Inactive pages estimate memory reclaimable under pressure, not guaranteed immediately allocatable headroom. Ellie omits other cache categories to avoid double counting and falls back to free pages alone if the native reading is unavailable or invalid. On other platforms it remains the OS free-memory reading. Compressed and swapped pages are not added explicitly. Inactive pages can include file-backed data such as mapped model weights, so `requiredFreeMemoryBytes` must be measured while the model is loaded. It is an operator-supplied **additional memory admission budget**, including generation/KV-cache headroom appropriate for the locally loaded model and configured context. It is not inferred from model filename or weight size. Measure on each Mac; a nominal 16 GB machine does not have 16 GB available. Unknown/insufficient capacity produces no placement, not an automatic model download, quantization change, or distributed fallback.

The local adapter accepts only literal loopback HTTP(S) origins, refuses redirects, and talks to an operator-managed OpenAI-compatible runner (`GET /v1/models`, `POST /v1/chat/completions`). MLX-LM provides a compatible server interface; see its [upstream implementation](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py). Runner installation, model download, startup, memory measurement, and model compatibility remain explicit operator tasks. Ellie does not send requests to a cloud provider. The operator must configure the runner itself for local-only models; Ellie cannot enforce a runner's internal network policy.

### Optional advanced distributed MLX

Distributed inference is a future explicitly enabled backend for a heavyweight model that cannot fit on any one eligible Mac. It is not the V1 control plane or default execution mode. Independent workers improve concurrent throughput without creating a shared memory pool. Three 16 GB Macs do not become one transparent 48 GB model host.

The protocol reserves a `DistributedMlxGroup` contract with a group identity, explicit member IDs, model, and explicit enablement. This release does **not** implement a shard-group runner; runtime requests for distributed mode are rejected. Merely adding Macs or running out of memory never opts a user into sharding.

Before activating that backend, implement and verify all of the following:

- Explicit operator opt-in per group and model, and per-node local consent to shard participation.
- A supported model/shard plan with measured per-member memory/KV-cache headroom; all members ready on fresh telemetry, preferably AC with healthy thermal state.
- Measured interconnect bandwidth/latency and a supported MLX communication backend. Ordinary heartbeat RTT alone cannot qualify a cluster. MLX's [distributed communication documentation](https://ml-explore.github.io/mlx/build/html/usage/distributed.html) describes its separate distributed runtime.
- Atomic reservation of every member, a gang lease, cancellation/deadline propagation, and whole-group teardown when a member sleeps, overheats, disconnects, or loses capacity. Do not retry only one shard or mix it with independently scheduled work.
- A single provider boundary returning the same inference result/stream contract. The rest of Ellie must not depend on ranks, shard topology, or the chosen interconnect.

V1 delivery order remains: reliable deterministic desktop control; independent local inference workers; conversational/knowledge and voice adapters; measured, opt-in sharding only when the model actually requires it.
