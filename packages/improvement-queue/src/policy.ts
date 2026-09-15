import { createHash } from "node:crypto";
import { IMPROVEMENT_LANE, IMPROVEMENT_SCOPE, type ImprovementEvidence } from "./types.ts";

export function improvementDeduplicationKey(
  evidence: Pick<
    ImprovementEvidence,
    "scenario" | "sourceRevision" | "runnerSha256" | "evaluatorSha256" | "artifactSha256"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lane: IMPROVEMENT_LANE,
        scope: IMPROVEMENT_SCOPE,
        scenario: evidence.scenario,
        sourceRevision: evidence.sourceRevision,
        runnerSha256: evidence.runnerSha256,
        evaluatorSha256: evidence.evaluatorSha256,
        artifactSha256: evidence.artifactSha256,
      }),
    )
    .digest("hex");
}
