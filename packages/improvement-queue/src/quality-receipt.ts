import {
  IMPROVEMENT_LANE,
  IMPROVEMENT_SCENARIO,
  IMPROVEMENT_SCOPE,
  type EnqueueImprovement,
} from "./types.ts";
import { improvementDeduplicationKey } from "./policy.ts";
import { readPrivateEvidenceFile } from "./evidence-file.ts";

const sha256Pattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Quality receipt ${name} must be an object.`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512)
    throw new Error(`Quality receipt ${name} is invalid.`);
  if (pattern && !pattern.test(value)) throw new Error(`Quality receipt ${name} is invalid.`);
  return value;
}

export function qualityReceiptWork(
  receiptPath: string,
  options: { priority?: number; attemptBudget?: number; maxRuntimeMs?: number } = {},
): EnqueueImprovement {
  const file = readPrivateEvidenceFile(receiptPath);
  const bytes = file.bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("Quality receipt is not valid JSON.", { cause: error });
  }
  const report = object(parsed, "root");
  if (report.version !== 1)
    throw new Error(
      "Unsupported quality receipt format; expected browser quality report version 1.",
    );
  const source = object(report.source, "source");
  const sourceRevision = string(source.commit, "source.commit", revisionPattern);
  const runnerSha256 = string(source.runnerSha256, "source.runnerSha256", sha256Pattern);
  const evaluatorSha256 = string(source.fixtureSha256, "source.fixtureSha256", sha256Pattern);
  const artifactSha256 = string(source.builtUiSha256, "source.builtUiSha256", sha256Pattern);
  if (!Array.isArray(report.scenarios) || report.scenarios.length > 32)
    throw new Error("Quality receipt scenarios are invalid.");
  const matches = report.scenarios.filter(
    (entry) => object(entry, "scenario").name === IMPROVEMENT_SCENARIO,
  );
  if (matches.length !== 1)
    throw new Error(`Quality receipt must contain exactly one ${IMPROVEMENT_SCENARIO} scenario.`);
  const scenario = object(matches[0], "scenario");
  const observedStatus = string(scenario.status, "scenario.status");
  if (observedStatus !== "fail" && observedStatus !== "error")
    throw new Error(
      "Only a failing or errored quality scenario can enter the improvement queue; a mechanical pass is not semantic acceptance.",
    );
  const priority = options.priority ?? 50;
  const attemptBudget = options.attemptBudget ?? 1;
  const maxRuntimeMs = options.maxRuntimeMs ?? 20 * 60 * 1000;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100)
    throw new Error("Improvement priority must be an integer from 0 through 100.");
  if (!Number.isSafeInteger(attemptBudget) || attemptBudget < 1 || attemptBudget > 10)
    throw new Error("Improvement attempt budget must be an integer from 1 through 10.");
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 1000 || maxRuntimeMs > 30 * 60 * 1000)
    throw new Error("Improvement runtime budget must be from 1,000 through 1,800,000 ms.");
  const deduplicationKey = improvementDeduplicationKey({
    scenario: IMPROVEMENT_SCENARIO,
    sourceRevision,
    runnerSha256,
    evaluatorSha256,
    artifactSha256,
  });
  return {
    lane: IMPROVEMENT_LANE,
    scope: IMPROVEMENT_SCOPE,
    deduplicationKey,
    priority,
    attemptBudget,
    maxRuntimeMs,
    evidence: {
      format: "life-quality-report-v1",
      reference: file.reference,
      sha256: file.sha256,
      sourceRevision,
      runnerSha256,
      evaluatorSha256,
      artifactSha256,
      scenario: IMPROVEMENT_SCENARIO,
      observedStatus,
    },
  };
}
