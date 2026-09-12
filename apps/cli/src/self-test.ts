import { capabilities, identifier, record, result, string } from "@ellie/protocol";
import type { Capability, Result } from "@ellie/protocol";

interface TestClient {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
}

export interface ServiceTestOptions {
  nodeId?: string;
  desktopApp?: string;
}

interface ExecutionNode {
  id: string;
  lastSeen: number;
  capabilities: Capability[];
}

export function nodeIdArgument(value: unknown): string {
  if (typeof value === "string" && /^<?(?:your[-_ ]?)?node[-_ ]?id>?$/i.test(value.trim()))
    throw new Error(
      "Replace NODE_ID with the actual ID shown by `bun run ellie nodes`, or omit --node when exactly one execution node is online.",
    );
  return identifier(value);
}

function appAliasArgument(value: unknown): string {
  const alias = string(value, 100);
  if (!/^[a-z0-9 -]+$/i.test(alias))
    throw new Error("App aliases may contain only letters, numbers, spaces, and hyphens.");
  return alias.toLowerCase().trim().replace(/ +/g, " ");
}

export function serviceTestOptions(args: string[]): ServiceTestOptions {
  let nodeId: string | undefined;
  let desktop = false;
  let desktopApp: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--node") {
      if (nodeId !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--"))
        throw new Error("Use --node once followed by a node ID.");
      nodeId = nodeIdArgument(args[++index]);
    } else if (argument === "--desktop") {
      if (desktop) throw new Error("Use --desktop only once.");
      desktop = true;
    } else if (argument === "--app") {
      if (desktopApp !== undefined || !args[index + 1] || args[index + 1]!.startsWith("--"))
        throw new Error("Use --app once followed by an allowed app name.");
      desktopApp = appAliasArgument(args[++index]);
    } else {
      throw new Error("Use: bun run ellie service test [--node ID] [--desktop --app ALLOWED_NAME]");
    }
  }
  if (desktop !== (desktopApp !== undefined))
    throw new Error("Desktop testing requires both --desktop and --app ALLOWED_NAME.");
  return {
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(desktopApp === undefined ? {} : { desktopApp }),
  };
}

function executionNodes(value: unknown): ExecutionNode[] {
  if (!Array.isArray(value)) throw new Error("The coordinator returned invalid node status.");
  const nodes: ExecutionNode[] = [];
  for (const item of value) {
    try {
      const node = record(item);
      if (typeof node.lastSeen !== "number" || !Number.isFinite(node.lastSeen)) continue;
      nodes.push({
        id: identifier(node.id),
        lastSeen: node.lastSeen,
        capabilities: capabilities(node.executionCapabilities ?? node.capabilities ?? []),
      });
    } catch {
      // Ignore malformed entries; they are never eligible for a command.
    }
  }
  return nodes;
}

export function selectExecutionNode(
  value: unknown,
  explicitId?: string,
  now = Date.now(),
): ExecutionNode {
  const nodes = executionNodes(value);
  if (explicitId) {
    const selected = nodes.find((node) => node.id === explicitId);
    if (!selected)
      throw new Error(
        `Node ${explicitId} is unknown or not currently registered. Run \`bun run ellie nodes\` and use the exact ID shown there.`,
      );
    if (now - selected.lastSeen > 60_000)
      throw new Error(
        `Node ${explicitId} is registered but offline or stale. Start its node service.`,
      );
    if (!selected.capabilities.includes("app.open"))
      throw new Error(`Node ${explicitId} does not currently advertise desktop app control.`);
    return selected;
  }
  const eligible = nodes.filter(
    (node) => now - node.lastSeen <= 60_000 && node.capabilities.includes("app.open"),
  );
  if (eligible.length === 1) return eligible[0]!;
  if (eligible.length === 0)
    throw new Error(
      nodes.length
        ? "No online registered node currently advertises desktop app control. Check `bun run ellie doctor node` on the execution Mac."
        : "No node is currently registered. Start the paired node service, then run `bun run ellie nodes`.",
    );
  throw new Error(
    `More than one execution node is online. Re-run with --node and one exact ID: ${eligible.map((node) => node.id).join(", ")}`,
  );
}

export async function runServiceTest(
  client: TestClient,
  options: ServiceTestOptions,
  now = Date.now(),
): Promise<{ nodeId: string; result?: Result; lines: string[] }> {
  const nodes = await client.call("GET", "/v1/nodes");
  const selected = selectExecutionNode(nodes, options.nodeId, now);
  const lines = [
    "PASS The coordinator's pinned authenticated endpoint is reachable.",
    `PASS Node ${selected.id} has a fresh registration and advertises desktop app control.`,
  ];
  if (!options.desktopApp) {
    lines.push("INFO Read-only test complete; no job or desktop action was submitted.");
    return { nodeId: selected.id, lines };
  }
  const outcome = result(
    await client.call("POST", "/v1/commands", {
      nodeId: selected.id,
      text: `open app ${options.desktopApp}`,
    }),
  );
  if (!outcome.ok) throw new Error(`Desktop service test failed: ${outcome.message}`);
  lines.push(`PASS Desktop job completed: ${outcome.message}`);
  return { nodeId: selected.id, result: outcome, lines };
}
