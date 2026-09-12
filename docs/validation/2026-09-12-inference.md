# Local inference validation — 2026-09-12

This records a bounded development check on one physical MacBook at PR 8 commit `5cbfddf`. It is not multi-Mac inference or household-alpha acceptance. Personal paths, addresses, node and job IDs, credentials, configuration, prompts, and model output are intentionally excluded.

## Environment and safeguards

- A cached 3B instruction model in GGUF Q4_K_M format was loaded by its existing local runner with a 2,048-token context. No model or runner download occurred.
- The runner listened only on literal loopback. Its first observed load completed in about 17 seconds.
- The installed Ellie helper, persistent configuration, Keychain entries, services, and privacy permissions were not changed. A separately built temporary helper supplied the PR 8 memory reading.
- The runner began stopped with no loaded models. Cleanup restored that state and removed the temporary worktree, helper, LaunchAgents, plists, and logs.

## Real hardware results

| Check                  | Observed result                                                                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct worker adapter  | `LocalInferenceWorker` found the explicitly configured model in the runner inventory and returned a nonempty completion. Inventory plus completion took about 475 ms in one run.                                                                                                             |
| Admission telemetry    | After the model was loaded, the Mach free-plus-inactive estimate was about 4.75 GiB. Inactive pages estimate reclaimable capacity and are not guaranteed immediately allocatable memory.                                                                                                     |
| Coordinator scheduling | The running coordinator selected a temporary compute-only `runNode` worker in the logged-in GUI session. A GUI controller request returned the expected synthetic marker, and payload-free durable metadata recorded the inference job as `completed` with outcome `succeeded` after 278 ms. |
| Local policy           | The temporary worker advertised no desktop capabilities. Its test-only additional-memory threshold was 2 GiB, below the measured post-load estimate; this value is evidence for this bounded check, not a general model recommendation.                                                      |
| Worker removal         | On shutdown the temporary worker re-registered without compute or execution capabilities, so its previously fresh model advertisement did not remain eligible.                                                                                                                               |

The latency values are single observations on a lightly loaded machine with a short deterministic request. They are not throughput, tail-latency, long-context, or sustained-load measurements.

## Limits

- The coordinator and inference worker ran on the same physical Mac. LAN inference and cross-Mac model execution were not exercised.
- Multiple workers, concurrent placement, sustained load, cancellation during generation, coordinator or runner interruption, and sleep/wake were not exercised on hardware.
- No model was installed or transferred to the Mac mini, and optional distributed MLX remains untested.
