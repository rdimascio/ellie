import { decisionRoutingConfig } from "@ellie/config";
import type { DecisionRoutingConfig, SecretStore } from "@ellie/config";
import {
  GatewayDecisionProvider,
  LocalDecisionProvider,
  TypeSafeDecisionProvider,
} from "@ellie/decisions";
import type { DecisionRoutingOptions } from "../../server/src/index.ts";

export const decisionKeyAccount = "decision.typesafe";
export const gatewayKeyAccount = "decision.gateway";
const usage =
  "Use: routing status|off|mode shadow|mode execute|typesafe --allow-cloud [--model ID]|gateway --allow-cloud|local MODEL --endpoint URL";

export function routingCommand(
  args: string[],
  current?: DecisionRoutingConfig,
): { kind: "status" } | { kind: "save"; config?: DecisionRoutingConfig; needsKey?: boolean } {
  if (args.length === 1 && args[0] === "status") return { kind: "status" };
  if (args.length === 1 && args[0] === "off") return { kind: "save" };
  if (args.length === 2 && args[0] === "mode" && ["shadow", "execute"].includes(args[1]!)) {
    if (!current) throw new Error("Configure a decision provider before selecting its mode.");
    return { kind: "save", config: decisionRoutingConfig({ ...current, mode: args[1] }) };
  }
  if (args[0] === "typesafe") {
    if (
      args[1] !== "--allow-cloud" ||
      !(args.length === 2 || (args.length === 4 && args[2] === "--model"))
    )
      throw new Error(usage);
    return {
      kind: "save",
      needsKey: true,
      config: decisionRoutingConfig({
        provider: "typesafe",
        mode: "shadow",
        cloudDisclosure: true,
        model: args[3] ?? "jev-latest",
      }),
    };
  }
  if (args[0] === "gateway") {
    if (args.length !== 2 || args[1] !== "--allow-cloud") throw new Error(usage);
    return {
      kind: "save",
      needsKey: true,
      config: decisionRoutingConfig({
        provider: "gateway",
        mode: "shadow",
        cloudDisclosure: true,
      }),
    };
  }
  if (args[0] === "local" && args.length === 4 && args[2] === "--endpoint")
    return {
      kind: "save",
      config: decisionRoutingConfig({
        provider: "local",
        mode: "shadow",
        model: args[1],
        endpoint: args[3],
      }),
    };
  throw new Error(usage);
}

export async function createDecisionRouting(
  config: DecisionRoutingConfig | undefined,
  secrets: SecretStore,
): Promise<DecisionRoutingOptions | undefined> {
  if (!config) return undefined;
  const provider =
    config.provider === "typesafe"
      ? new TypeSafeDecisionProvider({
          apiKey: await secrets.get(decisionKeyAccount),
          model: config.model,
          timeoutMs: config.timeoutMs,
        })
      : config.provider === "gateway"
        ? new GatewayDecisionProvider({
            apiKey: await secrets.get(gatewayKeyAccount),
            timeoutMs: config.timeoutMs,
          })
        : new LocalDecisionProvider({
            endpoint: config.endpoint,
            model: config.model,
            timeoutMs: config.timeoutMs,
          });
  return {
    provider,
    mode: config.mode,
    timeoutMs: config.timeoutMs,
    minProbability: config.minProbability,
    minMargin: config.minMargin,
  };
}
