import { createHash } from "node:crypto";
import { access, lstat, readdir } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, isAbsolute, join, resolve } from "node:path";
import { load, nodeConfig, save, serverConfig, stateDir } from "@ellie/config";
import { identifier, string } from "@ellie/protocol";
import type { DistributedMlxGroup, DistributedMlxPlan } from "@ellie/protocol";

const GiB = 1024 ** 3;

export interface DistributedSetupMember {
  id: string;
  address: string;
}

export interface DistributedSetupInput {
  modelPath: string;
  members: DistributedSetupMember[];
  groupId?: string;
  modelId?: string;
  requiredFreeMemoryBytes?: number;
  directory?: string;
}

async function directoryBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("The model folder cannot contain symbolic links.");
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) throw new Error("The model folder contains an unsupported entry.");
  let total = 0;
  for (const name of await readdir(path)) total += await directoryBytes(join(path, name));
  return total;
}

export function parseDistributedMembers(value: string): DistributedSetupMember[] {
  const members = value.split(",").map((entry) => {
    const separator = entry.indexOf("@");
    if (separator < 1) throw new Error("Use NODE_ID@IP:PORT for each Mac.");
    const id = identifier(entry.slice(0, separator).trim());
    const address = entry.slice(separator + 1).trim();
    const match = /^(\d+\.\d+\.\d+\.\d+):(\d+)$/.exec(address);
    if (!match || !isIP(match[1]!) || Number(match[2]) < 1024 || Number(match[2]) > 65535)
      throw new Error("Each Mac needs a literal IPv4 address and an unprivileged port.");
    return { id, address };
  });
  if (members.length < 2 || members.length > 8)
    throw new Error("Choose between two and eight Macs.");
  if (new Set(members.map(({ id }) => id)).size !== members.length)
    throw new Error("Each Mac must appear once.");
  return members;
}

export function distributedSetupOptions(args: string[]): Partial<DistributedSetupInput> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      throw new Error("Distributed setup options need a value.");
    if (!["--model", "--members", "--group", "--model-id", "--memory-gib"].includes(key))
      throw new Error(`Unknown distributed setup option: ${key}`);
    values[key] = value;
  }
  const memoryGiB =
    values["--memory-gib"] === undefined ? undefined : Number(values["--memory-gib"]);
  if (memoryGiB !== undefined && (!Number.isFinite(memoryGiB) || memoryGiB <= 0))
    throw new Error("Memory must be a positive number of GiB.");
  return {
    ...(values["--model"] ? { modelPath: values["--model"] } : {}),
    ...(values["--members"] ? { members: parseDistributedMembers(values["--members"]) } : {}),
    ...(values["--group"] ? { groupId: identifier(values["--group"]) } : {}),
    ...(values["--model-id"] ? { modelId: string(values["--model-id"], 200) } : {}),
    ...(memoryGiB === undefined ? {} : { requiredFreeMemoryBytes: Math.ceil(memoryGiB * GiB) }),
  };
}

export async function configureDistributedMlx(input: DistributedSetupInput): Promise<{
  group: DistributedMlxGroup;
  coordinatorUpdated: boolean;
  communicationFile: string;
  requiredFreeMemoryBytes: number;
}> {
  const directory = input.directory ?? stateDir;
  const modelPath = resolve(input.modelPath);
  if (!isAbsolute(modelPath) || !(await lstat(modelPath)).isDirectory())
    throw new Error("Choose a local MLX model folder.");
  await access(join(modelPath, "config.json"));
  await access(join(modelPath, "model.safetensors.index.json"));
  if (!(await readdir(modelPath)).some((name) => name.endsWith(".safetensors")))
    throw new Error("The model folder does not contain MLX safetensor weights.");
  const modelSize = await directoryBytes(modelPath);
  const members = input.members.map(({ id, address }) => ({ id: identifier(id), address }));
  parseDistributedMembers(members.map(({ id, address }) => `${id}@${address}`).join(","));
  const node = nodeConfig(await load("node.json", directory));
  if (!members.some(({ id }) => id === node.id))
    throw new Error(`This Mac's node ID (${node.id}) is missing from --members.`);
  const groupId = identifier(input.groupId ?? "mlx-group");
  const inferredModelId = basename(modelPath)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 100);
  const model = string(input.modelId ?? inferredModelId, 200);
  const nodeIds = members.map(({ id }) => id);
  const planId = `mlx-${createHash("sha256")
    .update(JSON.stringify({ groupId, model, nodeIds }))
    .digest("hex")
    .slice(0, 20)}`;
  const plan: DistributedMlxPlan = {
    mode: "distributed-mlx",
    id: groupId,
    planId,
    nodeIds,
    model,
    backend: "ring",
    strategy: "pipeline",
    explicitlyEnabled: true,
  };
  const communicationName = `${planId}-ring.json`;
  const communicationFile = join(directory, communicationName);
  const requiredFreeMemoryBytes =
    input.requiredFreeMemoryBytes ?? Math.ceil(modelSize / members.length + 2 * GiB);
  await save(
    communicationName,
    members.map(({ address }) => [address]),
    directory,
  );
  const existingGroups = node.distributedWorker?.groups ?? [];
  await save(
    "node.json",
    {
      ...node,
      distributedWorker: {
        ...node.distributedWorker,
        groups: [
          ...existingGroups.filter(({ plan: existing }) => existing.id !== groupId),
          { plan, modelPath, communicationFile, requiredFreeMemoryBytes },
        ],
      },
    },
    directory,
  );
  const group: DistributedMlxGroup = { ...plan, timeoutMs: 120_000 };
  let coordinatorUpdated = false;
  try {
    const server = serverConfig(await load("server.json", directory));
    await save(
      "server.json",
      {
        ...server,
        distributedGroups: [
          ...(server.distributedGroups ?? []).filter(({ id }) => id !== groupId),
          group,
        ],
      },
      directory,
    );
    coordinatorUpdated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { group, coordinatorUpdated, communicationFile, requiredFreeMemoryBytes };
}
