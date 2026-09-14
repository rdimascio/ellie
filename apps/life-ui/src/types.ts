export type Scope = { type: "user" | "group"; id: string };
export type LifeKind =
  | "memory"
  | "contact"
  | "place"
  | "reminder"
  | "timer"
  | "event"
  | "birthday"
  | "holiday"
  | "need"
  | "goal"
  | "routine"
  | "source"
  | "feedback";
export interface LifeRecord {
  id: string;
  kind: LifeKind;
  title: string;
  body?: string;
  bodyPreview?: string;
  hasMoreBody?: boolean;
  scope: Scope;
  data: Record<string, unknown>;
  relationships?: Array<{ type: string; targetId: string }>;
  provenance?: Array<{
    sourceId: string;
    reference?: string;
    derived?: boolean;
    invalidatedAt?: number;
  }>;
  provenanceStatus?: "valid" | "needs-review";
  relatedCompleted?: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  detail?: string;
  updatedAt?: string;
  rootId?: string;
  parentId?: string;
  progress?: { current?: number; total?: number; message?: string };
  actions?: Array<"pause" | "resume" | "cancel" | "run" | "rerun">;
}
export interface TaskDetail {
  task: TaskSummary;
  children: TaskSummary[];
  progress: Array<{
    message?: string;
    current?: number;
    total?: number;
    at?: string;
  }>;
  result?: {
    status: "complete";
    summary: string;
    citations: Array<{
      sourceId: string;
      sourceRevision: number;
      title: string;
      references: string[];
    }>;
    omitted?: number;
  };
  stale?: boolean;
  staleReason?: string;
}
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  version: number;
  data: Record<string, unknown>;
}
export interface PluginRevision {
  version: number;
  name: string;
  description: string;
  kind: string;
  active: boolean;
}
export interface NotificationSummary {
  id: string;
  title: string;
  body?: string;
  revision: number;
  reminderId?: string;
  needId?: string;
  deliveredAt?: number;
}
export interface Bootstrap {
  profile: { id: string; name: string; timeZone: string };
  groups: { id: string; name: string }[];
  scope: string;
  records: LifeRecord[];
  recordsPage?: { hasMore: boolean; nextCursor?: string };
  agendaRecords?: LifeRecord[];
  agendaPage?: { hasMore: boolean; nextCursor?: string };
  notificationsPage?: { hasMore: boolean; nextCursor?: string };
  tasks: TaskSummary[];
  plugins: PluginSummary[];
  settings: Record<string, unknown>;
  notifications: NotificationSummary[];
  capabilities: Record<string, unknown>;
  chatEpoch: number;
}
export interface TeachingSource {
  id: string;
  revision: number;
}
export interface TeachingVersion {
  version: number;
  instructions: string;
  sources: TeachingSource[];
  adoptedBy: string;
  adoptedAt: string | number;
}
export interface TeachingGuide {
  record: LifeRecord;
  version: number;
  enabled: boolean;
  status: "active" | "paused" | "source-changed";
  versions: TeachingVersion[];
}
export interface PersonalDataReview {
  reviewToken: string;
  expiresAt: string | number;
  generations: { life: number; tasks: number; plugins: number };
  counts: {
    privateRecords: number;
    sources: number;
    feedback: number;
    guidance: number;
    userSettings: number;
    tasks: number;
    watches: number;
    taskProgress?: number;
    plugins: number;
    pluginVersions: number;
    pluginStorageKeys: number;
    sharedPluginStorageKeys: number;
    conversations?: number;
    conversationTurns?: number;
  };
  bytes: number;
  truncated?: boolean;
  preserves?: string[];
}
export interface PersonalResetStatus {
  operationId: string;
  state: "draining" | "tasks-deleted" | "plugins-deleted" | "life-deleted" | "completed";
  runtimeState?: "draining" | "ready" | "completed";
  unknownTaskIds?: string[];
  counts?: Record<string, number>;
  error?: string;
}
export interface ConversationSummary {
  id: string;
  scope: Scope;
  title: string;
  revision: number;
  turnCount: number;
  pending: boolean;
  createdAt: string | number;
  updatedAt: string | number;
}
export interface ConversationTurn {
  id: string;
  requestId: string;
  user: string;
  assistant?: string;
  status: "pending" | "completed" | "interrupted";
  outdated: boolean;
  evidence: Array<{
    sourceId: string;
    sourceRevision: number;
    title: string;
    reference?: string;
  }>;
  actions: Array<{ label: string; status: string }>;
  createdAt: string | number;
  updatedAt: string | number;
}
export interface PendingIntent {
  id: string;
  kind: "reminder" | "event" | "need";
  title: string;
  state: "awaiting-fields" | "executing" | "interrupted" | "expired";
  question?: string;
  missing: string[];
  expiresAt: string;
  revision: number;
}
export interface ModelStatus {
  mode: "deterministic" | "local";
  configured: boolean;
  available: boolean;
  model?: string;
  checkedAt: string | number;
  capabilities: { chat: boolean; customApps: boolean };
  reason:
    | "not-configured"
    | "runner-unreachable"
    | "model-not-installed"
    | "probe-unsupported"
    | "ready";
}
