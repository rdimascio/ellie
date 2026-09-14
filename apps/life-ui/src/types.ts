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
  progress: Array<{ message?: string; current?: number; total?: number; at?: string }>;
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
}
