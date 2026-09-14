# Automatic conversation memory

Ellie remembers from conversation by default. Users do not upload or maintain Markdown files. Every accepted prompt is captured from the authoritative actor-private conversation before conversational tool execution, including deterministic commands and prompts whose model response later fails. Recovered requests reuse the same entry. Existing retained conversations are backfilled in bounded batches when the service starts.

The pipeline is:

`user prompt → durable prompt journal → scoped extractive summary → cached Markdown → later-session system context`

Schema v6 stores internally generated Markdown and provenance to the original turn. The summary prioritizes ordinary personal statements, preferences and corrections, followed by historical questions and requests. It keeps whole observations and qualifications, orders newer observations first within each category and reports partial selection. It does not promote assistant replies into facts, claim that requested work happened, or convert temporary conversation style into lasting preferences. Summaries currently use deterministic extraction and selection rather than a second model call or model-weight training.

The service materializes a private `.md` snapshot under `<state-dir>/memory/<hashed-actor>/<hashed-space>.md`. Directories are private, files have mode `0600`, and writes use atomic replacement. The database holds the complete retained prompt journal; the file is a bounded summary and recent journal, not an unbounded second transcript. Caches invalidate when their source prompts change, are suppressed or disappear. Restart rebuilds files from canonical records and removes obsolete actor snapshots.

The host injects the selected Markdown in a separate system message for each modeled conversational turn, including a new conversation after restart. It explicitly identifies historical material as data: ordinary preferences can guide a response, but old text cannot override current instructions/settings, grant tools or replay an action. Automatic memory participates in context-generation checks, preventing an in-flight model from applying stale proposals after another conversation changes its context. The local adapter retains the existing 64-KiB total serialized request limit and omits oversized whole contexts with an omission count.

Personal and group-context journals remain private to their originating actor and exact space. Group membership is checked on every read and capture. There is no copying between spaces or other members' conversations.

`Forget <phrase>` and `Do not remember <phrase>` suppress matching automatic entries in that space. The original transcript remains visible until its conversation is deleted. Suppression invalidates old model history as well as summaries so the next turn cannot simply reintroduce a forgotten note. Deleting a conversation cascades its derived prompt notes and refreshes the file. Personal export includes canonical automatic prompt entries; personal reset drains active work, deletes those entries and removes the generated files before reporting completion.

The optional Memory view reads the same bounded summary from authenticated `GET /api/life/memory?scope=...`. It is an inspection aid, not a setup step. File ingestion remains available for external knowledge as a secondary capability.

Verification includes actual HTTP conversations through the harness and model adapter, backfill, duplicate request recovery, an interrupted model, a new session after full restart, scope isolation, deletion, forgetting and personal reset. `scripts/verify-life-auto-memory.mjs <local-model-endpoint> <exact-model-id>` additionally exercises an actual local model against synthetic isolated stores. Model recall and response quality remain dependent on the selected model.
