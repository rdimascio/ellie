# Architecture

## Current execution flow

A text client submits a command to `ellie-server`. The pure router produces a typed plan, or returns an unsupported-command response. The server checks the target node's advertised capabilities and its own app/site allowlist. A waiting HTTPS long poll delivers the job immediately to `ellie-node`, which independently validates the wire message and checks its local allowlist. The Swift helper then executes a fixed native operation using structured JSON over stdin. No command text is interpolated into a shell, script, or AppleScript.

The node's outbound connection avoids opening an execution port on each Mac. Transport is behind a small client boundary; an authenticated private-network address can replace a LAN address later without changing tools. Tailscale is a possible deployment option, not a dependency or an implemented onboarding integration.

Each node has an opaque generated identity, transient pronoun context, one in-flight command, and a capability list. Long polling has no periodic dispatch delay when idle. Unrelated nodes can execute concurrently. The server commits new pronoun context only after reported success. Capabilities are refreshed when a node reconnects; restart the node after granting Accessibility.

Jobs expire. Delivered commands are not automatically replayed after disconnects. The node also rejects recently seen job IDs and expired jobs. A timeout may mean an action completed but its acknowledgement was lost; the client reports this uncertainty. There is no exactly-once guarantee across crashes. Failed multi-window operations can partially apply and are not automatically rolled back.

The server runs in the foreground for this milestone. LaunchAgent installation, daemon supervision, a menu bar client, node naming, and display aliases are future onboarding work. A running Mac must remain awake for reliable command delivery. The execution node requires an unlocked/logged-in graphical session for useful app control.

## Layer boundaries

| Layer | Decision it owns | Status |
| --- | --- | --- |
| Personality | How to speak; tone, values, style | Default specification and replaceable contract |
| Router | Whether a known action can bypass inference | Deterministic implementation |
| Models | Reasoning and language inference | Provider contract only |
| Knowledge | Retrieval, evidence, uncertainty, citations | Provider contract only |
| Voice | Audio input/output, timing, expressiveness | Streaming contracts only |
| Tools | Typed, capability-gated actions | Four native macOS operations |
| Memory | Explicitly permitted local persistence | Interface only; no persistent memory |

The planned complexity and evidence path is: deterministic action → tiny local router for uncertain intent → stronger local conversational model → retrieval/research when evidence is needed → explicitly enabled frontier skill when appropriate. Uncertainty is not permission to run a guessed command. Clarification precedes ambiguous execution. A tiny routing model is not the authority for serious history, politics, literature, religion, philosophy, or other knowledge questions.

Model providers are replaceable. MLX is the intended optimized Apple Silicon backend; no particular model family, runner, API vendor, or prompt format is coupled to the current protocol. Cloud providers must require separate opt-in and data-disclosure permissions. None are called by V1.

Voice will use local streaming STT → routing/tools/model → local streaming TTS. Push-to-talk ships before wake words. One cancellation scope per turn should connect VAD, barge-in, transcription, generation, speech synthesis, and queued audio. Personality influences phrasing and vocal expression through a voice adapter; it never weakens permissions. iPhone voice input comes later through a distinct client identity, not by reusing an execution node's credential.

Tools currently form a closed, versioned discriminated union. A later plugin registry must preserve runtime schema validation, declared capabilities, local grants, and separate provider configuration. Native code is intentionally isolated from networking and reasoning.

## Design limits

No voice, LLM inference, browser agent, wake word, semantic memory, native UI, or internet research is currently implemented. Opening Netflix is an allowed HTTPS link opened by macOS; Ellie does not inspect Arc tabs, cookies, or page contents. Moving browser windows uses Accessibility and is independent of browser automation.

App launching and URL opening require only normal macOS app access. Window placement requires Accessibility. Screen Recording and microphone permissions are not requested. The helper reads window bounds and identifiers, not window titles, document text, or screen images.
