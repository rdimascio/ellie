import { ImprovementQueue } from "./queue.ts";
import { qualityReceiptWork } from "./quality-receipt.ts";
import { validatedImprovementStateDirectory } from "./state-path.ts";
import type { ImprovementOutcome } from "./types.ts";

function usage(): never {
  throw new Error(
    "Use: improvement:queue enqueue|status|claim|record-result|mark-blocked --state-dir /absolute/private/path [options]",
  );
}

function argumentsMap(args: string[]): { command: string; values: Map<string, string> } {
  const command = args.shift();
  if (!command) usage();
  const values = new Map<string, string>();
  while (args.length > 0) {
    const key = args.shift();
    const value = args.shift();
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) usage();
    if (values.has(key)) throw new Error(`Duplicate option: ${key}`);
    values.set(key, value);
  }
  return { command, values };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required option: ${name}`);
  return value;
}

function number(values: Map<string, string>, name: string, fallback?: number): number {
  const raw = values.get(name);
  if (raw === undefined && fallback !== undefined) return fallback;
  if (!raw || !/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer.`);
  return Number(raw);
}

function assertOnly(values: Map<string, string>, allowed: string[]): void {
  for (const key of values.keys())
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
}

function stateDirectory(values: Map<string, string>): string {
  return validatedImprovementStateDirectory(required(values, "--state-dir"));
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, values } = argumentsMap([...argv]);
  const directory = stateDirectory(values);
  if (command === "enqueue") {
    assertOnly(values, [
      "--state-dir",
      "--receipt",
      "--priority",
      "--attempt-budget",
      "--max-runtime-ms",
    ]);
    const receipt = required(values, "--receipt");
    const input = qualityReceiptWork(receipt, {
      priority: number(values, "--priority", 50),
      attemptBudget: number(values, "--attempt-budget", 1),
      maxRuntimeMs: number(values, "--max-runtime-ms", 20 * 60 * 1000),
    });
    const queue = new ImprovementQueue(directory);
    try {
      output(queue.enqueue(input));
    } finally {
      queue.close();
    }
    return;
  }

  const queue = new ImprovementQueue(directory);
  try {
    if (command === "status") {
      assertOnly(values, ["--state-dir", "--item", "--limit"]);
      const item = values.get("--item");
      output(item ? (queue.get(item) ?? null) : queue.list(number(values, "--limit", 100)));
      return;
    }
    if (command === "claim") {
      assertOnly(values, ["--state-dir", "--owner", "--lease-ms"]);
      output(queue.claim(required(values, "--owner"), number(values, "--lease-ms")) ?? null);
      return;
    }
    if (command === "record-result") {
      assertOnly(values, [
        "--state-dir",
        "--item",
        "--owner",
        "--lease",
        "--result-key",
        "--outcome",
        "--origin-evidence-sha256",
        "--evidence-ref",
        "--evidence-sha256",
        "--candidate-commit",
        "--candidate-ref",
      ]);
      const outcome = required(values, "--outcome") as ImprovementOutcome;
      if (!(["candidate", "no_change", "failed", "blocked"] as const).includes(outcome))
        throw new Error("Unsupported result outcome.");
      output(
        queue.recordResult(
          required(values, "--item"),
          required(values, "--owner"),
          required(values, "--lease"),
          {
            resultKey: required(values, "--result-key"),
            outcome,
            originEvidenceSha256: required(values, "--origin-evidence-sha256"),
            evidenceReference: required(values, "--evidence-ref"),
            evidenceSha256: required(values, "--evidence-sha256"),
            ...(values.get("--candidate-commit")
              ? { candidateCommit: values.get("--candidate-commit")! }
              : {}),
            ...(values.get("--candidate-ref")
              ? { candidateReference: values.get("--candidate-ref")! }
              : {}),
          },
        ),
      );
      return;
    }
    if (command === "mark-blocked") {
      assertOnly(values, [
        "--state-dir",
        "--item",
        "--lease",
        "--operator",
        "--evidence-ref",
        "--evidence-sha256",
      ]);
      output(
        queue.markBlocked(
          required(values, "--item"),
          required(values, "--lease"),
          { role: "local-operator", id: required(values, "--operator") },
          {
            evidenceReference: required(values, "--evidence-ref"),
            evidenceSha256: required(values, "--evidence-sha256"),
          },
        ),
      );
      return;
    }
    usage();
  } finally {
    queue.close();
  }
}
