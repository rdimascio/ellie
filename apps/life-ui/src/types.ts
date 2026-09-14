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
  scope: Scope;
  data: Record<string, unknown>;
  relationships?: Array<{ type: string; targetId: string }>;
  provenance?: Array<{
    sourceId: string;
    reference?: string;
    derived?: boolean;
    invalidatedAt?: number;
  }>;
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
}
export interface PluginSummary {
  id: string;
  name: string;
  description: string;
  kind: string;
  status: string;
  version: string;
  data: Record<string, unknown>;
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
  tasks: TaskSummary[];
  plugins: PluginSummary[];
  settings: Record<string, unknown>;
  notifications: NotificationSummary[];
  capabilities: Record<string, unknown>;
}
