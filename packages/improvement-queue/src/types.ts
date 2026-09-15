export const IMPROVEMENT_LANE = "life-quality" as const;
export const IMPROVEMENT_SCOPE = "repository:ellie" as const;
export const IMPROVEMENT_SCENARIO = "memory" as const;

export type ImprovementLane = typeof IMPROVEMENT_LANE;
export type ImprovementScope = typeof IMPROVEMENT_SCOPE;
export type ImprovementScenario = typeof IMPROVEMENT_SCENARIO;

export type ImprovementState =
  | "queued"
  | "leased"
  | "reconciliation_required"
  | "candidate_recorded"
  | "succeeded"
  | "failed"
  | "blocked";

export type ImprovementOutcome = "candidate" | "no_change" | "failed" | "blocked";
export type PromotionState = "not_applicable" | "awaiting_release_owner";

export interface ImprovementEvidence {
  format: "life-quality-report-v1";
  reference: string;
  sha256: string;
  sourceRevision: string;
  runnerSha256: string;
  evaluatorSha256: string;
  artifactSha256: string;
  scenario: ImprovementScenario;
  observedStatus: "fail" | "error";
}

export interface EnqueueImprovement {
  lane: ImprovementLane;
  scope: ImprovementScope;
  deduplicationKey: string;
  priority: number;
  attemptBudget: number;
  maxRuntimeMs: number;
  evidence: ImprovementEvidence;
}

export interface ImprovementItem {
  id: string;
  lane: ImprovementLane;
  scope: ImprovementScope;
  deduplicationKey: string;
  state: ImprovementState;
  priority: number;
  createdAt: number;
  updatedAt: number;
  evidence: ImprovementEvidence;
  attemptsUsed: number;
  attemptBudget: number;
  maxRuntimeMs: number;
  ownerId?: string;
  leaseId?: string;
  leaseStartedAt?: number;
  leaseExpiresAt?: number;
  outcome?: ImprovementOutcome;
  outcomeEvidenceReference?: string;
  outcomeEvidenceSha256?: string;
  candidateCommit?: string;
  candidateReference?: string;
  promotionState: PromotionState;
  resultKey?: string;
}

export interface ImprovementClaim {
  item: ImprovementItem;
  ownerId: string;
  leaseId: string;
  leaseExpiresAt: number;
}

export interface ImprovementResult {
  resultKey: string;
  outcome: ImprovementOutcome;
  originEvidenceSha256: string;
  evidenceReference: string;
  evidenceSha256: string;
  candidateCommit?: string;
  candidateReference?: string;
}

export interface ReconciliationAttribution {
  role: "local-operator";
  id: string;
}

export interface ReconciliationRecord {
  id: string;
  itemId: string;
  staleLeaseId: string;
  operator: ReconciliationAttribution;
  decision: "blocked";
  evidenceReference: string;
  evidenceSha256: string;
  createdAt: number;
}

export interface WorkAssignment {
  itemId: string;
  lane: ImprovementLane;
  scope: ImprovementScope;
  scenario: ImprovementScenario;
  sourceRevision: string;
  originEvidenceReference: string;
  originEvidenceSha256: string;
  attempt: number;
  attemptBudget: number;
  maxRuntimeMs: number;
  ownerId: string;
  leaseId: string;
  leaseExpiresAt: number;
}

export interface ImprovementWorker {
  readonly ownerId: string;
  run(assignment: Readonly<WorkAssignment>, signal: AbortSignal): Promise<ImprovementResult>;
}
