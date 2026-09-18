# Distributed MLX: technical reference

For the two-Mac setup steps, see [the short guide](distributed-mlx.md). This page explains the backend, limits, and recovery behavior.

Ellie can explicitly run one language-model request across a configured group of two to eight Macs. Each node launches one local Python process. The coordinator reserves every Mac, waits until every rank has passed local preparation, and returns rank zero's text only after all ranks have exited successfully. Ordinary `infer MODEL "..."` still selects one independent worker; distributed inference requires `infer --group GROUP MODEL "..."`.

This backend is experimental. Automated tests cover the HTTPS coordinator, node agents, admission, barrier, cancellation, and subprocess supervision with synthetic workers. Real MLX generation, model compatibility, throughput, memory use, and Thunderbolt RDMA have **not** been hardware-validated for Ellie. Nothing downloads a model, installs Python packages, changes network settings, or enables a group automatically.

## Runtime and interconnect

Each participating Mac needs an operator-managed Python environment containing compatible MLX and MLX-LM versions and the same locally installed model revision. Use an absolute virtual-environment Python path. Ellie runs Python with `-I`, offline Hugging Face/Transformers settings, and remote tokenizer/model code disabled. Preparation checks that MLX-LM's `sharded_load` supports the explicit `tokenizer_config` argument. Pin the same tested package versions on all members when qualifying the cluster.

The implementation follows MLX's [distributed environment variables](https://ml-explore.github.io/mlx/build/html/usage/distributed.html#distributed-without-mlx-launch) and MLX-LM's [sharded loading](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/utils.py) and [distributed chat](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/chat.py) APIs. It calls `mlx.core.distributed.init(strict=True, backend=...)`, supplies an explicit pipeline or tensor group to `sharded_load`, and generates deterministically on all ranks.

- **Ring + pipeline:** configure a ring hostfile on each Mac using the same rank order. It contains an array of address arrays, for example `[["192.168.10.10:5100"], ["192.168.10.11:5100"]]`. The selected model must support MLX-LM pipelining and include `model.safetensors.index.json` from an MLX conversion. Model support is verified by MLX-LM at load time; unsupported models fail the whole group.
- **JACCL + tensor or pipeline:** supply the JACCL device matrix as the communication file and the same rank-zero coordinator address on every member. Configure and qualify RDMA separately using the [upstream JACCL instructions](https://ml-explore.github.io/mlx/build/html/usage/distributed.html#getting-started-with-jaccl). Ellie does not enable RDMA or run privileged network configuration. This slice restricts tensor parallelism to JACCL.

The Ellie control channel uses authenticated, pinned HTTPS. **MLX's tensor communication is a separate transport and does not inherit Ellie's HTTPS authentication or encryption.** Use a trusted isolated interconnect with restricted peer access. Neither heartbeat RTT nor the sum of installed RAM qualifies that interconnect or proves the model fits.

## JACCL configuration differences

Follow the [two-Mac guide](distributed-mlx.md) for the shared group and per-node settings. To use JACCL, change `backend` to `jaccl` in the coordinator and every node's `plan`. Choose `strategy: "tensor"` only for a model that MLX-LM can tensor shard; JACCL also supports the pipeline strategy. On each node, point `communicationFile` to the JACCL device matrix and add a `coordinator` address such as `"192.168.10.10:5100"` beside it. Use the same rank-zero coordinator address on every node. Set up the Thunderbolt RDMA link using [MLX's JACCL instructions](https://ml-explore.github.io/mlx/build/html/usage/distributed.html#getting-started-with-jaccl), measure that interconnect, then refresh the qualification in `server.json`.

The ordered node IDs, model ID, backend, strategy, and `planId` must match exactly on all members. `planId` is a revision label chosen by the operator. It does not prove that files are identical on different Macs. Local model, Python, and communication paths may differ by Mac and never come from a network job. Each node's `requiredFreeMemoryBytes` is its own measured budget for loading its shard and generating text; the 4 GiB value in the short guide is illustrative.

A group starts only when every node has recent telemetry, enough free memory, low initial load, AC power, low-power mode off, known nominal/fair thermals, and a responsive control connection. The group also needs fresh operator-supplied bandwidth and latency measurements that meet its thresholds and remain valid through the request deadline. Ellie checks those values; it does not run or attest the network benchmark. It does not reapply the cold-load memory budget after weights have consumed it; allocation failure cancels the whole group.

## Lifecycle and recovery

- Every rank's metadata is committed in one SQLite transaction before any rank is delivered. Model text, prompts, Python paths, and topology payloads are not stored in the job database.
- All participating Macs share their existing single slot with desktop and independent inference work. Reservations remain occupied even when one rank finishes early.
- Each rank verifies its locally enabled plan and prepares before the shared start barrier. The process initializes the explicitly selected backend; a one-rank world is rejected.
- Cancel any active rank ID with `bun run ellie cancel JOB_ID`, or interrupt the submitting CLI. Cancellation, rank failure, coordinator disconnect, expired deadline, revoked membership, or unhealthy telemetry stops the whole group. No rank is replayed on another Mac.
- Cancellation reaches running nodes through heartbeats (normally within 10 seconds). A lost control connection or local deadline also aborts the rank. The node sends SIGTERM, escalates to SIGKILL after one second, and waits for process exit before acknowledging teardown. The Python helper also watches its parent and deadline, and a local file lock excludes a second process for that configured group.
- The controller may receive a failure before teardown finishes. `groups` keeps those Macs reserved until every delivered rank acknowledges stopping. A temporary reconnect retries only the stopped-rank acknowledgement, never generation.
- A hard node crash or revoked credential can prevent an acknowledgement entirely. This first slice deliberately leaves that group reserved. Stop the participating node services, confirm their MLX rank processes are gone, then restart the coordinator and nodes to clear the abandoned lease. Coordinator startup marks previously delivered metadata unknown and never restores prompts or replays ranks. Do not delete lock files to bypass a live process.

Streaming, warm persistent model processes, automatic topology discovery/measurement, and automatic reclamation after a hard member crash remain follow-up work. Requests are bounded to 120 seconds including preparation and cold loading, 2,048 generated tokens, and a short text result. A model that cannot load and generate within that bound is not supported by this experimental probe.
