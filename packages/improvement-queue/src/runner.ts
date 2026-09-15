import type {
  ImprovementClaim,
  ImprovementItem,
  ImprovementWorker,
  WorkAssignment,
} from "./types.ts";
import type { ImprovementQueue } from "./queue.ts";

export async function runClaimedWork(
  queue: ImprovementQueue,
  claim: ImprovementClaim,
  worker: ImprovementWorker,
): Promise<ImprovementItem> {
  if (worker.ownerId !== claim.ownerId)
    throw new Error("Worker identity does not match the claimed owner.");
  const current = queue.get(claim.item.id);
  if (
    !current ||
    current.state !== "leased" ||
    current.ownerId !== claim.ownerId ||
    current.leaseId !== claim.leaseId ||
    current.leaseExpiresAt !== claim.leaseExpiresAt ||
    claim.leaseExpiresAt <= Date.now()
  )
    throw new Error("Worker dispatch requires the current unexpired owner lease.");
  const assignment: WorkAssignment = Object.freeze({
    itemId: current.id,
    lane: current.lane,
    scope: current.scope,
    scenario: current.evidence.scenario,
    sourceRevision: current.evidence.sourceRevision,
    originEvidenceReference: current.evidence.reference,
    originEvidenceSha256: current.evidence.sha256,
    attempt: current.attemptsUsed,
    attemptBudget: current.attemptBudget,
    maxRuntimeMs: current.maxRuntimeMs,
    ownerId: claim.ownerId,
    leaseId: claim.leaseId,
    leaseExpiresAt: claim.leaseExpiresAt,
  });
  const controller = new AbortController();
  const remaining = Math.min(current.maxRuntimeMs, claim.leaseExpiresAt - Date.now());
  type Settlement =
    | { kind: "result"; result: Awaited<ReturnType<ImprovementWorker["run"]>> }
    | { kind: "error"; error: unknown }
    | { kind: "deadline" };
  const settled: Promise<Settlement> = Promise.resolve()
    .then(() => worker.run(assignment, controller.signal))
    .then(
      (result) => ({ kind: "result", result }),
      (error: unknown) => ({ kind: "error", error }),
    );
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<Settlement>((resolveDeadline) => {
    timeout = setTimeout(() => resolveDeadline({ kind: "deadline" }), remaining);
  });
  const first = await Promise.race([settled, deadline]);
  if (timeout) clearTimeout(timeout);
  if (first.kind === "deadline") {
    controller.abort();
    queue.quarantineLease(claim.item.id, claim.ownerId, claim.leaseId);
    throw new Error("Worker deadline expired; its owner lease remains uncertain.");
  }
  if (first.kind === "error") {
    queue.quarantineLease(claim.item.id, claim.ownerId, claim.leaseId);
    throw first.error;
  }
  if (controller.signal.aborted || claim.leaseExpiresAt <= Date.now()) {
    queue.quarantineLease(claim.item.id, claim.ownerId, claim.leaseId);
    throw new Error("Worker result arrived after its owner lease became uncertain.");
  }
  try {
    return queue.recordResult(claim.item.id, claim.ownerId, claim.leaseId, first.result);
  } catch (error) {
    queue.quarantineLease(claim.item.id, claim.ownerId, claim.leaseId);
    throw error;
  }
}
