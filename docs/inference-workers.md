# Testing independent inference workers

Desktop commands still work without a model. This is an optional, non-streaming local inference probe, with a 30-second job deadline. Start with a small model that already runs comfortably on one Mac.

## Configure each worker Mac

1. Install and run a local OpenAI-compatible model server on loopback, serving a model you have already installed. It must expose `GET /v1/models` and `POST /v1/chat/completions`. Keep it running. Ellie does not install or launch the runner. Use the exact model ID returned by `/v1/models`.
2. Pair the Mac using the existing README steps. The server Mac can also pair as a node and offer compute. Each physical Mac needs a separate pairing invitation and identity.
3. Edit the existing `~/.ellie/node.json` and add the following top-level fields. Keep the generated identity, server URL, and preferences. These values are a schema example; substitute your runner's actual model ID and an appropriate measured memory budget.

```json
{
  "executionEnabled": false,
  "inferenceWorker": {
    "endpoint": "http://127.0.0.1:8080",
    "models": [{ "id": "your-installed-model-id", "requiredFreeMemoryBytes": 4294967296 }]
  }
}
```

`executionEnabled: false` makes this a compute-only node; set it to `true` to retain desktop actions. The sample budget is 4 GiB of additional free memory, not a universal requirement for any particular model. Include generation/cache headroom and verify memory pressure on the worker. Only models both configured here and listed by the runner can run. Removing `inferenceWorker` disables compute.

4. Update and start the coordinator first, then update each node. From the repository root:

```sh
bun install --frozen-lockfile
bun run check
bun run build:macos
bun run ellie node start
```

The updated helper supplies power-mode, thermal, and conservative macOS admission-memory readings without Accessibility permission. The memory reading includes free and inactive VM pages and falls back to free pages alone if native collection fails. Execution-only setups keep their prior behavior. Compute Macs need to stay awake with their local runner and Ellie agent running; they do not need Accessibility unless desktop window control is also enabled.

## Send a request from the server Mac

In another terminal, from the repository root:

```sh
bun run ellie nodes
bun run ellie infer your-installed-model-id "Write one short greeting."
```

`nodes` includes execution and compute capabilities, the model inventory, resource readings, and server receipt timestamps. If no eligible worker exists, check free RAM, model inventory, freshness, battery/low-power mode, thermal state, OS load, and network latency. Ellie will not silently choose a different model.

To verify multi-Mac placement, enable the same small model on two paired Macs and submit two inference requests from separate terminals. Overlapping requests reserve different available Macs. If all eligible workers are busy, the next request is rejected instead of queued. HTTP results include `workerId`; the CLI prints the returned text only.

## Limits to verify on hardware

- macOS LibreSSL certificate generation and Keychain init; native helper compilation and thermal/power readings.
- Real runner inventory/model ID compatibility, memory admission, response latency, and cancellation behavior.
- Unplug a laptop, enable low-power mode, stop its runner, or let it sleep; unsuitable/unavailable workers must stop receiving new jobs. Already running runner work may take time to stop after its HTTP request is cancelled.
- A runner may continue processing after a disconnected HTTP client. Use a dedicated runner that honors cancellation; Ellie does not kill or supervise the runner process.
- Native telemetry and MLX were not physically tested in the Linux development environment. Automated tests use actual HTTPS, a synthetic local HTTP model endpoint, and explicit synthetic resource readings.
- Distributed MLX is an advanced architecture extension only; no sharding implementation is enabled in this release. See [architecture](architecture.md).
