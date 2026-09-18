import { spawn } from "node:child_process";
import { access, readdir, stat, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { distributedWorkerConfig, stateDir } from "@ellie/config";
import type { DistributedWorkerConfig, LocalMlxGroup } from "@ellie/config";
import { record, result, sameMlxPlan } from "@ellie/protocol";
import type { DistributedMlxCapability, InferenceJob, Result } from "@ellie/protocol";

export interface DistributedWorker {
  advertise(signal: AbortSignal): Promise<DistributedMlxCapability[]>;
  prepare(task: InferenceJob, signal: AbortSignal): Promise<void>;
  execute(task: InferenceJob, signal: AbortSignal): Promise<Result>;
}
const helper = fileURLToPath(new URL("../native/mlx_rank.py", import.meta.url));

/** Local configuration alone selects executables, model paths, and communication endpoints. */
export class LocalDistributedWorker implements DistributedWorker {
  private config: DistributedWorkerConfig;
  private nodeId: string;
  private lockDirectory: string;
  constructor(
    config: DistributedWorkerConfig,
    nodeId: string,
    lockDirectory = join(stateDir, "mlx-locks"),
  ) {
    this.config = distributedWorkerConfig(config, nodeId);
    this.nodeId = nodeId;
    this.lockDirectory = lockDirectory;
  }
  private async installed(group: LocalMlxGroup, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await access(this.config.python, constants.X_OK);
    if (!(await stat(group.modelPath)).isDirectory())
      throw new Error("Model must be installed locally.");
    await access(join(group.modelPath, "config.json"), constants.R_OK);
    if (!(await readdir(group.modelPath)).some((name) => name.endsWith(".safetensors")))
      throw new Error("Local MLX model weights are missing.");
    await access(group.communicationFile, constants.R_OK);
    signal.throwIfAborted();
  }
  async advertise(signal: AbortSignal): Promise<DistributedMlxCapability[]> {
    const caps: DistributedMlxCapability[] = [];
    for (const group of this.config.groups) {
      try {
        await this.installed(group, signal);
        caps.push({
          plan: group.plan,
          rank: group.plan.nodeIds.indexOf(this.nodeId),
          requiredFreeMemoryBytes: group.requiredFreeMemoryBytes,
        });
      } catch {
        signal.throwIfAborted();
      }
    }
    return caps;
  }
  private local(task: InferenceJob): LocalMlxGroup {
    const a = task.assignment;
    const group = a && this.config.groups.find((g) => sameMlxPlan(g.plan, a.plan));
    if (
      !group ||
      !a ||
      a.plan.nodeIds[a.rank] !== this.nodeId ||
      task.request.mode !== "distributed-mlx" ||
      task.request.groupId !== group.plan.id ||
      task.request.model !== group.plan.model
    )
      throw new Error("This Mac has not enabled the assigned shard plan.");
    return group;
  }
  async prepare(task: InferenceJob, signal: AbortSignal): Promise<void> {
    const group = this.local(task);
    await this.installed(group, signal);
    await this.run(group, task, true, signal);
  }
  async execute(task: InferenceJob, signal: AbortSignal): Promise<Result> {
    return result(await this.run(this.local(task), task, false, signal));
  }
  private async run(
    group: LocalMlxGroup,
    task: InferenceJob,
    checkOnly: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const locks = this.lockDirectory;
    await mkdir(locks, { recursive: true, mode: 0o700 });
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.min(120_000, task.expiresAt - Date.now()))),
    ]);
    deadline.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.python, ["-I", helper], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: `${dirname(this.config.python)}:/usr/bin:/bin`,
          HOME: homedir(),
          LANG: "en_US.UTF-8",
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          TOKENIZERS_PARALLELISM: "false",
        },
      });
      let output = "";
      let invalid = false;
      let killTimer: NodeJS.Timeout | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch {}
        }
      };
      const abort = () => {
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
      };
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        if (invalid) return;
        output += data;
        if (Buffer.byteLength(output) > 65_536) {
          invalid = true;
          output = "";
          abort();
        }
      });
      // Libraries can print prompts or paths on errors; never propagate or persist stderr.
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("error", () => {
        invalid = true;
      });
      child.on("close", (code) => {
        deadline.removeEventListener("abort", abort);
        clearTimeout(killTimer);
        if (code !== 0 || invalid || deadline.aborted)
          return reject(new Error("Local distributed MLX process failed or was cancelled."));
        try {
          const response = record(JSON.parse(output));
          if (response.ok !== true) throw new Error("MLX process did not complete.");
          resolve(response);
        } catch {
          reject(new Error("Invalid response from the local MLX process."));
        }
      });
      child.stdin.end(
        JSON.stringify({
          checkOnly,
          modelPath: group.modelPath,
          communicationFile: group.communicationFile,
          coordinator: group.coordinator,
          backend: group.plan.backend,
          strategy: group.plan.strategy,
          rank: task.assignment!.rank,
          size: group.plan.nodeIds.length,
          lockPath: join(locks, `${group.plan.id}.lock`),
          expiresAt: task.expiresAt,
          prompt: checkOnly ? undefined : task.request.prompt,
          maxTokens: task.request.maxTokens,
        }),
      );
    });
  }
}
