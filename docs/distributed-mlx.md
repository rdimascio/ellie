# Use two Macs for one model

Ellie's Apple silicon release includes the MLX runner. You do not install Python, install MLX, edit JSON, create topology files, or measure the network yourself.

For the first setup, use two Macs on the same trusted network and put the same MLX-converted model folder on both. The folder must contain `config.json`, `.safetensors` weights, and `model.safetensors.index.json`.

1. Pair both Macs with Ellie, then run this on the coordinator Mac to see their node IDs:

   ```sh
   ellie nodes
   ```

2. On each Mac, run setup. It asks for the model folder and one line containing the two node IDs and addresses:

   ```sh
   ellie distributed setup
   ```

   The line looks like this:

   ```text
   mac-a@192.168.10.10:5100,mac-b@192.168.10.11:5100
   ```

   Use the same order on both Macs. The command writes the private node settings and network topology. When it runs on the coordinator Mac, it also adds the group to the coordinator settings. Memory requirements are estimated from the model size.

   Setup can also run without prompts:

   ```sh
   ellie distributed setup --model /Users/me/Models/model-name \
     --members mac-a@192.168.10.10:5100,mac-b@192.168.10.11:5100
   ```

3. Restart the Ellie node service on both Macs and the coordinator service. Check readiness and send a short request:

   ```sh
   ellie groups
   ellie infer --group mlx-group model-name "Reply with one short sentence."
   ```

Ellie starts both MLX ranks together and performs a synchronized connection check before loading the model. Both Macs must be awake, plugged into power, and able to reach the listed addresses. The model remains a separate local asset because model folders can be tens or hundreds of gigabytes.

For Thunderbolt RDMA, JACCL, tensor parallelism, and advanced network thresholds, see the [technical reference](distributed-mlx-reference.md).
