import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defaults } from "@ellie/config/defaults";
import { route } from "@ellie/router";
import { decideDesktop } from "../packages/router/src/decision.ts";
import {
  parseRoutingCases,
  scoreRoutingCase,
  summarizeRoutingEvaluation,
} from "../packages/router/src/evaluation.ts";
import type { RoutingPrediction } from "../packages/router/src/evaluation.ts";
import {
  GatewayDecisionProvider,
  LocalDecisionProvider,
  TypeSafeDecisionProvider,
} from "@ellie/decisions";
import type { DecisionProvider } from "@ellie/decisions";

interface Flags {
  provider: "baseline" | "typesafe" | "gateway" | "local";
  split: "all" | "development" | "heldout";
  limit?: number;
  model?: string;
  endpoint?: string;
  output?: string;
  allowCloud: boolean;
  priceInput?: number;
  priceOutput?: number;
  minProbability?: number;
  minMargin?: number;
  timeoutMs?: number;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { provider: "baseline", split: "all", allowCloud: false };
  const values = new Set([
    "--provider",
    "--split",
    "--limit",
    "--model",
    "--endpoint",
    "--output",
    "--price-input",
    "--price-output",
    "--min-probability",
    "--min-margin",
    "--timeout-ms",
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--allow-cloud") {
      flags.allowCloud = true;
      continue;
    }
    if (!values.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    switch (flag) {
      case "--provider":
        if (!["baseline", "typesafe", "gateway", "local"].includes(value))
          throw new Error("Provider must be baseline, typesafe, gateway, or local.");
        flags.provider = value as Flags["provider"];
        break;
      case "--split":
        if (!["all", "development", "heldout"].includes(value))
          throw new Error("Split must be all, development, or heldout.");
        flags.split = value as Flags["split"];
        break;
      case "--limit":
        flags.limit = Number(value);
        if (!Number.isSafeInteger(flags.limit) || flags.limit < 1)
          throw new Error("Limit must be a positive integer.");
        break;
      case "--model":
        flags.model = value;
        break;
      case "--endpoint":
        flags.endpoint = value;
        break;
      case "--output":
        flags.output = value;
        break;
      case "--price-input":
        flags.priceInput = Number(value);
        break;
      case "--price-output":
        flags.priceOutput = Number(value);
        break;
      case "--min-probability":
        flags.minProbability = Number(value);
        break;
      case "--min-margin":
        flags.minMargin = Number(value);
        break;
      case "--timeout-ms":
        flags.timeoutMs = Number(value);
        break;
    }
  }
  if ((flags.provider === "typesafe" || flags.provider === "gateway") && !flags.allowCloud)
    throw new Error("Cloud evaluation requires --allow-cloud.");
  if (flags.provider === "local" && (!flags.endpoint || !flags.model))
    throw new Error("Local evaluation requires --endpoint and --model.");
  if (flags.provider !== "local" && flags.endpoint)
    throw new Error("--endpoint is only valid with --provider local.");
  if (flags.provider === "baseline" && flags.model)
    throw new Error("--model is only valid with a semantic provider.");
  if (flags.provider === "gateway" && flags.model)
    throw new Error("Gateway evaluation uses the fixed typesafe-ai/jev alias.");
  if (
    flags.provider === "baseline" &&
    (flags.minProbability !== undefined ||
      flags.minMargin !== undefined ||
      flags.timeoutMs !== undefined)
  )
    throw new Error("Decision policy options require a semantic provider.");
  if (
    (flags.minProbability !== undefined &&
      (!Number.isFinite(flags.minProbability) ||
        flags.minProbability < 0 ||
        flags.minProbability > 1)) ||
    (flags.minMargin !== undefined &&
      (!Number.isFinite(flags.minMargin) || flags.minMargin < 0 || flags.minMargin > 1))
  )
    throw new Error("Decision thresholds must be finite numbers from 0 to 1.");
  if ((flags.priceInput === undefined) !== (flags.priceOutput === undefined))
    throw new Error("Provide both --price-input and --price-output per million tokens.");
  if (
    (flags.priceInput !== undefined &&
      (!Number.isFinite(flags.priceInput) || flags.priceInput < 0)) ||
    (flags.priceOutput !== undefined &&
      (!Number.isFinite(flags.priceOutput) || flags.priceOutput < 0))
  )
    throw new Error("Token prices must be nonnegative finite numbers.");
  if (
    flags.timeoutMs !== undefined &&
    (!Number.isSafeInteger(flags.timeoutMs) || flags.timeoutMs < 100 || flags.timeoutMs > 10_000)
  )
    throw new Error("--timeout-ms must be an integer from 100 to 10000.");
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const timeoutMs = flags.timeoutMs ?? 3000;
  let provider: DecisionProvider | undefined;
  if (flags.provider === "typesafe") {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error("TYPESAFE_API_KEY is required for cloud evaluation.");
    provider = new TypeSafeDecisionProvider({
      apiKey,
      ...(flags.model ? { model: flags.model } : {}),
      timeoutMs,
    });
  } else if (flags.provider === "gateway") {
    const apiKey = process.env.AI_GATEWAY_API_KEY;
    if (!apiKey) throw new Error("AI_GATEWAY_API_KEY is required for Gateway evaluation.");
    provider = new GatewayDecisionProvider({ apiKey, timeoutMs });
  } else if (flags.provider === "local") {
    provider = new LocalDecisionProvider({
      endpoint: flags.endpoint!,
      model: flags.model!,
      timeoutMs,
    });
  }
  const datasetPath = fileURLToPath(
    new URL("../examples/decision-routing-cases.json", import.meta.url),
  );
  const source = await readFile(datasetPath, "utf8");
  const dataset = `decision-routing-cases.json@sha256:${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
  const rows = parseRoutingCases(JSON.parse(source))
    .filter((row) => flags.split === "all" || row.split === flags.split)
    .slice(0, flags.limit);
  const scores = [];
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    for (const row of rows) {
      if (controller.signal.aborted) throw new Error("Evaluation cancelled.");
      const start = performance.now();
      let prediction: RoutingPrediction;
      const grammar = route(row.input, row.context ?? {}, defaults);
      if (grammar) {
        prediction = { kind: "plan", actions: grammar.actions, grammarHit: true, model: "grammar" };
      } else if (!provider) {
        prediction = { kind: "abstain", model: "grammar" };
      } else {
        try {
          const decision = await decideDesktop(row.input, row.context ?? {}, defaults, provider, {
            signal: controller.signal,
            minProbability: flags.minProbability ?? 0.98,
            minMargin: flags.minMargin ?? 0.2,
          });
          if (controller.signal.aborted) throw new Error("Evaluation cancelled.");
          prediction =
            decision.kind === "plan"
              ? {
                  kind: "plan",
                  actions: decision.plan.actions,
                  model: decision.response.model,
                  usage: decision.response.usage,
                  usageKnown: decision.response.usage !== undefined,
                  semanticAttempt: true,
                }
              : {
                  kind: "abstain",
                  ...(decision.response ? { model: decision.response.model } : {}),
                  usage: decision.response?.usage,
                  usageKnown:
                    decision.response === undefined || decision.response.usage !== undefined,
                  semanticAttempt: true,
                };
        } catch {
          if (controller.signal.aborted) throw new Error("Evaluation cancelled.");
          prediction = {
            kind: "abstain",
            fallback: true,
            semanticAttempt: true,
            usageKnown: false,
          };
        }
      }
      prediction.latencyMs = performance.now() - start;
      scores.push(scoreRoutingCase(row, prediction));
    }
    if (controller.signal.aborted) throw new Error("Evaluation cancelled.");
    const summary = summarizeRoutingEvaluation(scores, {
      dataset,
      split: flags.split,
      model:
        flags.model ??
        (flags.provider === "typesafe"
          ? "jev-latest"
          : flags.provider === "gateway"
            ? "typesafe-ai/jev"
            : flags.provider),
      ...(provider
        ? {
            thresholds: {
              minProbability: flags.minProbability ?? 0.98,
              minMargin: flags.minMargin ?? 0.2,
            },
            timeoutMs,
          }
        : {}),
      ...(flags.priceInput === undefined
        ? {}
        : {
            pricePerMillionInputTokensUsd: flags.priceInput,
            pricePerMillionOutputTokensUsd: flags.priceOutput,
          }),
    });
    const report =
      flags.provider === "gateway"
        ? {
            ...summary,
            modelProvenance: {
              kind: "gateway-alias",
              requestedModel: "typesafe-ai/jev",
              resolvedVersion: null,
            },
          }
        : summary;
    const output = JSON.stringify(report, null, 2) + "\n";
    if (controller.signal.aborted) throw new Error("Evaluation cancelled.");
    if (flags.output) await writeFile(flags.output, output, { flag: "w" });
    else process.stdout.write(output);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error: unknown) => {
  // Configuration errors are shown; provider errors are converted to per-case abstentions.
  process.stderr.write(`${error instanceof Error ? error.message : "Evaluation failed."}\n`);
  process.exitCode = 1;
});
