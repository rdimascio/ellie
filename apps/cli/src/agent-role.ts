import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir, save } from "@ellie/config";
import { record } from "@ellie/protocol";
import { serviceRole, type ServiceRole } from "./services.ts";

export const AGENT_ROLE_FILE = "role.json";
export interface AgentRole {
  version: 1;
  role: ServiceRole;
}

export function agentRole(value: unknown): AgentRole {
  const v = record(value);
  if (v.version !== 1 || Object.keys(v).length !== 2) throw new Error("Invalid Ellie role.");
  return { version: 1, role: serviceRole(v.role) };
}

/** The role this Mac was configured to run, or undefined when it has never been chosen. */
export async function loadAgentRole(directory = stateDir): Promise<AgentRole | undefined> {
  let contents: string;
  try {
    contents = await readFile(join(directory, AGENT_ROLE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Ellie role configuration is unavailable.");
  }
  return agentRole(JSON.parse(contents));
}

export async function saveAgentRole(role: ServiceRole): Promise<AgentRole> {
  const value: AgentRole = { version: 1, role };
  await save(AGENT_ROLE_FILE, value);
  return value;
}

export function parseAgentCommand(args: string[]): { setRole?: ServiceRole } {
  if (args.length === 1) return {};
  if (args.length === 3 && args[1] === "--set-role") return { setRole: serviceRole(args[2]) };
  throw new Error("Use: bun run ellie agent [--set-role coordinator|node]");
}
