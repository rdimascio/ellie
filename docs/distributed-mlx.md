# Set up distributed MLX on two Macs

Ellie can run **one model request using two Macs together**. Start with two Macs on the same trusted network and the **ring + pipeline** option. Use the same small local MLX model on both Macs for the first test. This feature is experimental: the coordinator and cancellation flow have been tested with simulated workers, but a real two-Mac model run still needs hardware testing.

There are three places to set up: a network file and `node.json` **on each Mac**, plus `server.json` **on the coordinator Mac**. The coordinator can also be one of the workers. The examples use `mac-a`, `mac-b`, and `local-model`; replace those names with yours.

1. **Pair both Macs.** Follow the existing [pairing steps](../README.md), then run `bun run ellie nodes` on the coordinator Mac. Write down the exact two node IDs. Keep them in the same order in every file below: the first Mac is `mac-a`, and the second is `mac-b` in the example.

2. **Prepare Python and the model on both Macs.** Create a Python environment and install MLX-LM. Apple's [MLX-LM instructions](https://github.com/ml-explore/mlx-lm#mlx-lm) use `pip install mlx-lm`. For example:

   ```sh
   python3 -m venv ~/.ellie/mlx-venv
   ~/.ellie/mlx-venv/bin/python3 -m pip install mlx-lm
   ```

   Put the **same downloaded, MLX-converted model** on both Macs. For this pipeline example, its folder must contain `config.json`, model `.safetensors` files, and `model.safetensors.index.json`. Ellie reads a local model folder; it does not download one. In the configuration, use the full path to this virtual environment's `bin/python3` and to the model folder. The model must support MLX-LM pipelining; an unsupported model will fail when it loads.

3. **Connect the Macs and create the network file on both.** Give each Mac a reachable IP address on the trusted link. Create `~/.ellie/ring.json` on **each Mac** with the same contents, replacing the example IPs with the actual addresses:

   ```json
   [["192.168.10.10:5100"], ["192.168.10.11:5100"]]
   ```

   The first address belongs to the first node ID in your group. Make sure these Macs can reach each other at those addresses and ports. Measure bandwidth and latency on that link; the next step requires the slowest measured bandwidth (in **bytes per second**) and the highest measured latency (in **milliseconds**). Ellie does not measure the link for you.

4. **Add one group to the coordinator's existing `~/.ellie/server.json`.** Add the `distributedGroups` property at the top level. The block below is **part of your existing JSON file**, not a replacement for it. Keep the file's existing `version`, `host`, `port`, `preferences`, and any other settings. Replace the IDs, model name, and measurements:

   ```json
   "distributedGroups": [
     {
       "mode": "distributed-mlx",
       "id": "desk-cluster",
       "planId": "model-topology-v1",
       "nodeIds": ["mac-a", "mac-b"],
       "model": "local-model",
       "backend": "ring",
       "strategy": "pipeline",
       "explicitlyEnabled": true,
       "timeoutMs": 120000,
       "qualification": {
         "measuredAt": 1760000000000,
         "expiresAt": 1760003600000,
         "bandwidthBytesPerSecond": 1000000000,
         "latencyMs": 1,
         "minBandwidthBytesPerSecond": 100000000,
         "maxLatencyMs": 5
       }
     }
   ]
   ```

   The two timestamps and network readings above are **old example values; they will not enable a run**. After measuring, run `node -p 'Date.now()'` to get `measuredAt`, and `node -p 'Date.now() + 3600000'` for an expiry one hour later. Put the actual measurements in `bandwidthBytesPerSecond` and `latencyMs`. The `min...` and `max...` fields are the limits you choose to accept. Refresh the measurements and timestamps before the expiry; Ellie accepts a qualification for at most 24 hours.

5. **Add a worker to each Mac's existing `~/.ellie/node.json`.** Add the `distributedWorker` property at the top level, keeping the Mac's existing pairing ID, server URL, and preferences. Use the **same `plan` block** on both Macs. Set `python`, `modelPath`, and `communicationFile` to full local paths on _that Mac_. Set `requiredFreeMemoryBytes` to that Mac's measured free-memory budget for loading its shard and generating text; 4 GiB below is an example, not a recommendation for every model.

   ```json
   "distributedWorker": {
     "python": "/Users/YOU/.ellie/mlx-venv/bin/python3",
     "groups": [{
       "plan": {
         "mode": "distributed-mlx",
         "id": "desk-cluster",
         "planId": "model-topology-v1",
         "nodeIds": ["mac-a", "mac-b"],
         "model": "local-model",
         "backend": "ring",
         "strategy": "pipeline",
         "explicitlyEnabled": true
       },
       "modelPath": "/Users/YOU/models/local-model",
       "communicationFile": "/Users/YOU/.ellie/ring.json",
       "requiredFreeMemoryBytes": 4294967296
     }]
   }
   ```

6. **Restart Ellie and try a short request.** Restart the coordinator first, then the node service on each Mac. If you installed [LaunchAgent services](services.md), use `bun run ellie service stop coordinator` and `bun run ellie service start coordinator` on the coordinator, and the matching `service stop node` / `service start node` commands on each worker. If you run Ellie in terminals, stop and start those processes instead. Then, on the coordinator:

   ```sh
   bun run ellie groups
   bun run ellie infer --group desk-cluster local-model "Reply with one short sentence."
   ```

   `groups` shows why a group cannot start, such as an expired measurement, an offline Mac, or insufficient free memory. A ready group can still fail when Python checks the model or connects the two Macs; this first run checks those pieces. Each Mac must be awake, on AC power, and have healthy thermal readings.

For Thunderbolt RDMA with JACCL, a different communication file, or a model that uses tensor parallelism, see the [technical reference](distributed-mlx-reference.md). That page also covers cancellation and recovery. MLX's model traffic uses the configured Mac-to-Mac link, which is separate from Ellie's encrypted coordinator connection; use a trusted network.
