export type TaskState =
  | "queued"
  | "running"
  | "waiting"
  | "scheduled"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "unknown";

export type OwnerScope = `user:${string}` | `group:${string}`;

export interface TaskBudget {
  maxTasks?: number;
  maxConcurrency?: number;
  maxRuntimeMs?: number;
}

export type RetryPolicy = { maxAttempts: number; delayMs?: number };

export type TaskSchedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; everyMs: number; anchor?: number }
  | { kind: "daily"; time: string; timeZone: string }
  | { kind: "weekly"; weekday: number; time: string; timeZone: string };

export type MissedRunPolicy =
  | { kind: "skip" }
  | { kind: "latest" }
  | { kind: "catch-up"; limit: number };

export interface TaskRecord<Input = unknown, Result = unknown> {
  id: string;
  owner: OwnerScope;
  handler: string;
  input: Input;
  state: TaskState;
  requiredCapabilities: string[];
  allowedCapabilities: string[];
  parentId?: string;
  rootId: string;
  dependsOn: string[];
  budget: TaskBudget;
  deadlineAt?: number;
  expiresAt?: number;
  scheduledFor?: number;
  schedule?: TaskSchedule;
  missedRunPolicy?: MissedRunPolicy;
  attempt: number;
  retry?: RetryPolicy;
  idempotencyKey: string;
  result?: Result;
  outcomeCode?: string;
  outcomeVerified?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProgressRecord {
  id: number;
  taskId: string;
  at: number;
  message: string;
  current?: number;
  total?: number;
}

export interface HandlerContext {
  task: TaskRecord;
  signal: AbortSignal;
  idempotencyKey: string;
  progress(update: { message: string; current?: number; total?: number }): void;
  enqueueChild(input: Omit<EnqueueTask, "owner" | "parentId">): TaskRecord;
}

export interface TaskHandler<Input = unknown, Result = unknown> {
  name: string;
  requiredCapabilities?: readonly string[];
  resumable?: boolean;
  run(context: HandlerContext, input: Input): Promise<Result>;
  checkOutcome?(context: HandlerContext, result: Result): Promise<boolean> | boolean;
}

export interface EnqueueTask {
  id?: string;
  owner: OwnerScope;
  handler: string;
  input?: unknown;
  capabilities?: readonly string[];
  allowedCapabilities?: readonly string[];
  parentId?: string;
  dependsOn?: readonly string[];
  budget?: TaskBudget;
  deadlineAt?: number;
  expiresAt?: number;
  retry?: RetryPolicy;
}

export interface EnqueueWorkflow {
  root: EnqueueTask;
  children: Array<Omit<EnqueueTask, "owner" | "parentId" | "dependsOn">>;
}

export interface WorkflowRecord {
  root: TaskRecord;
  children: TaskRecord[];
}

export interface DeliveryOccurrences {
  active?: TaskRecord;
  latest?: TaskRecord;
}

export interface ScheduleTask extends EnqueueTask {
  schedule: TaskSchedule;
  missedRunPolicy?: MissedRunPolicy;
}

export interface PrepareTaskReplacement {
  operationId: string;
  owner: OwnerScope;
  replacesTaskId: string;
  task: ScheduleTask;
}

export interface PreparedTaskReplacement {
  operationId: string;
  owner: OwnerScope;
  replacesTaskId: string;
  replacementTaskId: string;
  state: "prepared" | "activated" | "discarded";
  createdAt: number;
  updatedAt: number;
  task?: TaskRecord;
}

export interface WatchTask extends EnqueueTask {
  topic: string;
}

export interface WatchEvent {
  owner: OwnerScope;
  topic: string;
  dedupeKey: string;
  payload?: unknown;
}
export interface WatchRecord {
  id: string;
  owner: OwnerScope;
  topic: string;
  handler: string;
  paused: boolean;
  createdAt: number;
}

export type PersonalExportItem =
  | { type: "task"; task: TaskRecord }
  | {
      type: "watch";
      watch: WatchRecord & {
        input: unknown;
        capabilities: string[];
        budget: TaskBudget;
        deadlineAt?: number;
        expiresAt?: number;
        retry?: RetryPolicy;
      };
    }
  | {
      type: "watchEvent";
      event: WatchEvent & { createdAt: number };
    }
  | { type: "progress"; progress: ProgressRecord };
export interface PersonalTaskExportPage {
  format: "ellie-task-runtime-v1";
  owner: `user:${string}`;
  generation: number;
  items: PersonalExportItem[];
  nextCursor?: string;
}
export interface PersonalTaskSummary {
  generation: number;
  tasks: number;
  watches: number;
  watchEvents: number;
  progress: number;
  bytes: number;
}
export interface PersonalDeletion {
  owner: `user:${string}`;
  operationId: string;
  state: "draining" | "ready" | "completed";
  generation: number;
  requestedAt: number;
  readyAt?: number;
  completedAt?: number;
  unknownTaskIds: string[];
}

export interface RuntimeOptions {
  directory: string;
  now?: () => number;
  capabilityResolver?: (owner: OwnerScope) => Promise<readonly string[]> | readonly string[];
  concurrency?: number;
  leaseMs?: number;
  tickMs?: number;
}
