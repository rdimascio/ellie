# Local inference validation — 2026-09-12

This records bounded development checks on a physical MacBook and Mac mini at PR 8 commits `5cbfddf` and `a82b3d3`. It is not household-alpha acceptance. Personal paths, addresses, node and job IDs, credentials, configuration, prompts, and model output are intentionally excluded.

## Single-Mac baseline

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

## Household-LAN inference

The MacBook coordinator scheduled a temporary compute-only node on the Mac mini over the authenticated household LAN. The worker used the official Apple Silicon archive from the [`llama.cpp` b10900 prerelease](https://github.com/ggml-org/llama.cpp/releases/tag/b10900), reported as `0.4.0-dev` at commit `50182a53f`. The downloaded runner archive matched GitHub's published SHA-256 digest and remained in a private temporary directory.

The already-cached 3B instruction GGUF was copied over authenticated SSH. Its source and destination SHA-256 digests matched; no model was downloaded from the internet. The 2,019,377,440-byte Q4_K_M file and the runner were removed from the Mac mini after the check.

The runner listened on literal loopback with a 2,048-token context, one parallel slot, and Metal acceleration. After model load, its resident set was about 2.22 GiB and the PR 8 Mach free-plus-inactive estimate was about 12.94 GiB. The temporary worker used a 4 GiB additional-memory threshold for this test. Thermal state was nominal and Low Power Mode was off. This observed headroom and threshold are not general model-sizing guidance.

| Check                        | Observed result                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single LAN request           | The coordinator selected the temporary Mac mini worker, the expected synthetic marker was returned, and durable metadata recorded `completed` with outcome `succeeded`. The controller observed 662 ms end to end; the durable job interval was 642 ms.                                                                     |
| Two-worker placement         | Two short requests were submitted together while exactly two eligible workers were registered. The coordinator placed them on distinct physical Macs, both durable records completed successfully, and their coordinator lifecycle intervals overlapped. Controller time was 299 ms; durable intervals were 231 and 288 ms. |
| Inference cancellation       | A longer request was observed in durable state `running`, then cancellation was requested after a 150 ms delay. It reached `cancelled` with outcome `cancelled_by_caller` in 1,041 ms; the worker reported zero active jobs and the runner's only slot was idle.                                                            |
| Desktop service preservation | A new transient identity advertised compute only. The existing Mac mini desktop node stayed online with all four desktop capabilities throughout.                                                                                                                                                                           |

The placement check proves concurrent coordinator scheduling on distinct physical workers with overlapping job lifecycles. It does not establish simultaneous GPU utilization or compare parallel throughput. The cancellation check observed the coordinator, worker, and runner return to idle, but did not measure when runner-side GPU work stopped.

Cleanup stopped both temporary workers and runners, revoked the transient identity, and removed the copied model, runner, worktrees, LaunchAgents, plists, and logs. The MacBook runner was restored to stopped with zero loaded models. Existing Ellie configuration, Keychain credentials, the installed native helper, and privacy grants were unchanged; the original Mac mini desktop node remained healthy with all four capabilities.

## Limits

- The LAN result covers one short request, one pair of short simultaneously submitted requests, and one cancellation on two physical Macs. It is not a sustained-load, throughput, tail-latency, or long-context measurement.
- Physical network interruption, coordinator or runner crashes during inference, and sleep/wake were not exercised.
- The model and runner were temporary test assets on the Mac mini; no permanent runner or model installation was validated.
- Optional distributed MLX remains untested.
