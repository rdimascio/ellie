import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, load, nodeConfig, serverConfig } from "@ellie/config";
import {
  configureDistributedMlx,
  parseDistributedMembers,
} from "../apps/cli/src/distributed-setup.ts";
import { packagedMlxRunner } from "../apps/node/src/distributed-runtime.ts";

test("distributed setup turns model and Mac choices into node, topology, and coordinator config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-distributed-setup-"));
  try {
    const model = join(directory, "models", "Tiny-MLX");
    await mkdir(model, { recursive: true });
    await writeFile(join(model, "config.json"), "{}\n");
    await writeFile(join(model, "model.safetensors.index.json"), "{}\n");
    await writeFile(join(model, "model-00001-of-00002.safetensors"), "weight bytes\n");
    await writeFile(
      join(directory, "node.json"),
      JSON.stringify({
        version: 1,
        id: "mac-a",
        serverUrl: "https://127.0.0.1:7437",
        preferences: defaults,
      }),
    );
    await writeFile(
      join(directory, "server.json"),
      JSON.stringify({ version: 1, host: "0.0.0.0", port: 7437, preferences: defaults }),
    );
    const members = parseDistributedMembers("mac-a@192.168.10.10:5100,mac-b@192.168.10.11:5100");
    const result = await configureDistributedMlx({
      directory,
      modelPath: model,
      members,
      groupId: "desk-cluster",
    });
    assert.equal(result.coordinatorUpdated, true);
    const node = nodeConfig(await load("node.json", directory));
    assert.equal(node.distributedWorker?.python, undefined);
    assert.equal(node.distributedWorker?.groups[0]?.plan.id, "desk-cluster");
    assert.equal(node.distributedWorker?.groups[0]?.plan.model, "tiny-mlx");
    assert.ok((node.distributedWorker?.groups[0]?.requiredFreeMemoryBytes ?? 0) > 2 * 1024 ** 3);
    assert.deepEqual(JSON.parse(await readFile(result.communicationFile, "utf8")), [
      ["192.168.10.10:5100"],
      ["192.168.10.11:5100"],
    ]);
    const server = serverConfig(await load("server.json", directory));
    assert.equal(server.distributedGroups?.[0]?.id, "desk-cluster");
    assert.equal(server.distributedGroups?.[0]?.qualification, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("installed MLX runner resolves from the release payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ellie-mlx-runtime-"));
  try {
    const runtime = join(directory, "payload", "bin", "node");
    const runner = join(directory, "payload", "mlx-runtime", "bin", "ellie-mlx-rank");
    await mkdir(join(directory, "payload", "bin"), { recursive: true });
    await mkdir(join(directory, "payload", "mlx-runtime", "bin"), { recursive: true });
    await writeFile(runtime, "");
    await writeFile(runner, "#!/bin/sh\n", { mode: 0o700 });
    await chmod(runner, 0o700);
    assert.equal(packagedMlxRunner(runtime), runner);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
