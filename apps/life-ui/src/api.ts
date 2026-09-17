import type {
  Bootstrap,
  LifeKind,
  LifeRecord,
  PluginRevision,
  PluginSummary,
  Scope,
  TaskDetail,
  TeachingGuide,
  TeachingSource,
  PersonalDataReview,
  PersonalResetStatus,
  ConversationSummary,
  ConversationPreferenceState,
  ConversationTurn,
  ModelStatus,
  PendingIntent,
  Group,
  ImprovementProposal,
  LifePlan,
} from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export type ChatResponse = {
  reply?: string;
  conversationId: string;
  turnId: string;
  status: "completed" | "pending" | "interrupted";
  actions?: { label: string; status: string }[];
  pendingIntent: PendingIntent | null;
  conversationPreferences: ConversationPreferenceState;
  progress?: {
    phase: "queued" | "drafting" | "validating";
    text?: string;
    revision: number;
  };
};
export type ConnectorProviderId = "google-calendar" | "gmail" | "plaid";
export type ConnectorMode = "observe" | "prepare";
export type ConnectorState = "connecting" | "connected" | "paused" | "error" | "revoked";
export interface ConnectorConnection {
  id: string;
  provider: ConnectorProviderId;
  label: string;
  state: ConnectorState;
  lastSyncAt?: number;
  mode: ConnectorMode;
  error?: string;
  selectedCalendarId?: string;
}
export interface ConnectionPreview {
  state: ConnectorState;
  lastSyncAt?: number;
  error?: string;
  items: (
    | { kind: "event"; title: string; startAt?: number; startDate?: string }
    | { kind: "message"; subject: string; from: string; snippet?: string; sentAt: number }
  )[];
}
export interface ConnectorProvider {
  id: ConnectorProviderId;
  label: string;
  configured: boolean;
  setupMessage?: string;
}
export const isNewerChatProgress = (currentRevision: number, nextRevision: number) =>
  Number.isInteger(nextRevision) && nextRevision > currentRevision;
export type PluginBridgeRequest = {
  id: string;
  method: "storage.get" | "storage.set" | "mlb.snapshot";
  key?: string;
  value?: unknown;
};
export function parsePluginBridgeRequest(value: unknown): PluginBridgeRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.length > 120 ||
    typeof candidate.method !== "string" ||
    !["storage.get", "storage.set", "mlb.snapshot"].includes(candidate.method) ||
    (candidate.key !== undefined && typeof candidate.key !== "string") ||
    (typeof candidate.key === "string" && candidate.key.length > 512)
  )
    return null;
  try {
    if (JSON.stringify(value).length > 65_536) return null;
  } catch {
    return null;
  }
  return candidate as PluginBridgeRequest;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const value = (await response.json()) as {
        error?: string;
        message?: string;
      };
      message = value.message ?? value.error ?? message;
    } catch {}
    throw new ApiError(message, response.status);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}
export async function establishSessionFromFragment() {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (!token) return false;
  history.replaceState(null, "", location.pathname + location.search);
  await request("/api/life/session", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return true;
}
export const api = {
  connections: {
    list: () =>
      request<{ connections: ConnectorConnection[]; providers: ConnectorProvider[] }>(
        "/api/connections",
      ),
    start: (provider: ConnectorProviderId, mode: ConnectorMode) =>
      request<{ authorizationUrl: string; connectionId: string; openedExternally?: boolean }>(
        "/api/connections/start",
        {
          method: "POST",
          body: JSON.stringify({ provider, mode }),
        },
      ),
    refresh: (id: string) =>
      request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}/refresh`, {
        method: "POST",
        body: "{}",
      }),
    revoke: (id: string) =>
      request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        body: "{}",
      }),
    mode: (id: string, mode: ConnectorMode) =>
      request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}/mode`, {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
    calendars: (id: string) =>
      request<{
        selectedCalendarId: string;
        calendars: { id: string; label: string; primary: boolean }[];
      }>(`/api/connections/${encodeURIComponent(id)}/calendars`),
    selectCalendar: (id: string, calendarId: string) =>
      request<{ ok: true }>(`/api/connections/${encodeURIComponent(id)}/calendar`, {
        method: "POST",
        body: JSON.stringify({ calendarId }),
      }),
    preview: (id: string) =>
      request<ConnectionPreview>(`/api/connections/${encodeURIComponent(id)}/preview`),
  },
  groups: {
    list: () => request<{ groups: Group[] }>("/api/life/groups"),
    create: (name: string) =>
      request<Group>("/api/life/groups", { method: "POST", body: JSON.stringify({ name }) }),
    rename: (id: string, name: string, expectedRevision: number) =>
      request<Group>(`/api/life/groups/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, expectedRevision }),
      }),
  },
  bootstrap: (scope?: string) =>
    request<Bootstrap>(`/api/life/bootstrap${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  memory: (scope: string, signal?: AbortSignal) =>
    request<{ summary: string; entries: number; partial: boolean; revision: string }>(
      `/api/life/memory?scope=${encodeURIComponent(scope)}`,
      { signal },
    ),
  chat: (
    message: string,
    scope: string,
    requestId: string,
    chatEpoch: number,
    conversationId?: string,
    signal?: AbortSignal,
  ) =>
    request<ChatResponse>("/api/life/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        scope,
        requestId,
        chatEpoch,
        conversationId,
      }),
      signal,
    }),
  chatRequest: (requestId: string, signal?: AbortSignal) =>
    request<ChatResponse>(`/api/life/chat/requests/${encodeURIComponent(requestId)}`, { signal }),
  conversations: {
    list: (scope: string, cursor?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams({ scope, limit: "50" });
      if (cursor) query.set("cursor", cursor);
      return request<{
        conversations: ConversationSummary[];
        chatEpoch: number;
        page: { hasMore: boolean; nextCursor?: string };
      }>(`/api/life/conversations?${query}`, { signal });
    },
    detail: (id: string, cursor?: string, signal?: AbortSignal) => {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      return request<{
        conversation: ConversationSummary;
        conversationPreferences: ConversationPreferenceState;
        turns: ConversationTurn[];
        page: { hasMore: boolean; nextCursor?: string };
      }>(`/api/life/conversations/${encodeURIComponent(id)}?${query}`, {
        signal,
      });
    },
    delete: (id: string, revision: number) =>
      request<void>(`/api/life/conversations/${encodeURIComponent(id)}?revision=${revision}`, {
        method: "DELETE",
      }),
    pendingIntent: (id: string, signal?: AbortSignal) =>
      request<{ pendingIntent: PendingIntent | null }>(
        `/api/life/conversations/${encodeURIComponent(id)}/pending-intent`,
        { signal },
      ),
    clearPendingIntent: (id: string, revision: number, signal?: AbortSignal) =>
      request<void>(
        `/api/life/conversations/${encodeURIComponent(id)}/pending-intent?revision=${revision}`,
        { method: "DELETE", signal },
      ),
  },
  modelStatus: (signal?: AbortSignal) => request<ModelStatus>("/api/life/model/status", { signal }),
  createRecord: (value: {
    kind: LifeKind;
    title: string;
    body?: string;
    scope: Scope;
    data: Record<string, unknown>;
  }) =>
    request<LifeRecord>("/api/life/records", {
      method: "POST",
      body: JSON.stringify(value),
    }),
  patchRecord: (id: string, value: Record<string, unknown>) =>
    request<LifeRecord>(`/api/life/records/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(value),
    }),
  deleteRecord: (id: string, revision: number) =>
    request<void>(`/api/life/records/${encodeURIComponent(id)}?revision=${revision}`, {
      method: "DELETE",
    }),
  record: (id: string) => request<LifeRecord>(`/api/life/records/${encodeURIComponent(id)}`),
  records: (scope: string, options: { cursor?: string; q?: string; kinds?: string[] } = {}) => {
    const query = new URLSearchParams({ scope });
    if (options.cursor) query.set("cursor", options.cursor);
    if (options.q) query.set("q", options.q);
    if (options.kinds?.length) query.set("kinds", options.kinds.join(","));
    return request<{
      records: LifeRecord[];
      page: { hasMore: boolean; nextCursor?: string };
    }>(`/api/life/records?${query}`);
  },
  search: (scope: string, q: string) =>
    request<{
      results: Array<{
        sourceId: string;
        sourceTitle: string;
        text: string;
        reference?: string;
        score: number;
      }>;
    }>(`/api/life/search?scope=${encodeURIComponent(scope)}&q=${encodeURIComponent(q)}`),
  source: (
    value: {
      filename: string;
      content: string;
      mimeType: string;
      scope: string;
      encoding?: "base64";
    },
    signal?: AbortSignal,
  ) =>
    request("/api/life/sources", {
      method: "POST",
      body: JSON.stringify(value),
      signal,
    }),
  sourceBinary: (
    file: File,
    scope: string,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ) =>
    new Promise<LifeRecord>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Upload cancelled", "AbortError"));
        return;
      }
      const extensionMime = /\.docx$/i.test(file.name)
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : /\.pdf$/i.test(file.name)
          ? "application/pdf"
          : /\.png$/i.test(file.name)
            ? "image/png"
            : /\.jpe?g$/i.test(file.name)
              ? "image/jpeg"
              : "application/octet-stream";
      const query = new URLSearchParams({
        scope,
        filename: file.name,
        mimeType:
          extensionMime !== "application/octet-stream"
            ? extensionMime
            : file.type || "application/octet-stream",
      });
      const xhr = new XMLHttpRequest();
      const cancelled = () => xhr.abort();
      signal.addEventListener("abort", cancelled, { once: true });
      xhr.open("POST", `/api/life/sources/binary?${query}`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) progress(event.loaded / event.total);
      };
      xhr.onerror = () => {
        signal.removeEventListener("abort", cancelled);
        reject(new ApiError("The file upload failed.", 0));
      };
      xhr.onabort = () => {
        signal.removeEventListener("abort", cancelled);
        reject(new DOMException("Upload cancelled", "AbortError"));
      };
      xhr.onload = () => {
        signal.removeEventListener("abort", cancelled);
        let value: (Partial<LifeRecord> & { error?: string; message?: string }) | undefined;
        try {
          value = JSON.parse(xhr.responseText);
        } catch {}
        if (xhr.status < 200 || xhr.status >= 300)
          reject(
            new ApiError(
              value?.message ?? value?.error ?? `Request failed (${xhr.status})`,
              xhr.status,
            ),
          );
        else if (value?.id) resolve(value as LifeRecord);
        else reject(new ApiError("The upload response was invalid.", xhr.status));
      };
      xhr.send(file);
    }),
  settings: (scope: string, values: Record<string, unknown>) =>
    request("/api/life/settings", {
      method: "POST",
      body: JSON.stringify({ scope, values }),
    }),
  feedback: (text: string, scope: string, runId?: string) =>
    request("/api/life/feedback", {
      method: "POST",
      body: JSON.stringify({ text, scope, runId }),
    }),
  task: (id: string, action: "pause" | "resume" | "cancel" | "run") =>
    request(`/api/life/tasks/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: "{}",
    }),
  taskDetail: (id: string) =>
    request<TaskDetail>(`/api/life/tasks/${encodeURIComponent(id)}/detail`),
  buildPlugin: (requestText: string, scope: string, signal?: AbortSignal) =>
    request("/api/life/plugins/build", {
      method: "POST",
      body: JSON.stringify({ request: requestText, scope }),
      signal,
    }),
  pluginHistory: (id: string) =>
    request<{ revisions: PluginRevision[] }>(`/api/life/plugins/${encodeURIComponent(id)}/history`),
  revisePlugin: (id: string, requestText: string, expectedVersion: number, signal?: AbortSignal) =>
    request<PluginSummary>(`/api/life/plugins/${encodeURIComponent(id)}/revise`, {
      method: "POST",
      body: JSON.stringify({ request: requestText, expectedVersion }),
      signal,
    }),
  rollbackPlugin: (id: string, expectedVersion: number, targetVersion: number) =>
    request<PluginSummary>(`/api/life/plugins/${encodeURIComponent(id)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ expectedVersion, targetVersion }),
    }),
  deletePlugin: (id: string) =>
    request<void>(`/api/life/plugins/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  learning: {
    record: (value: {
      conversationId: string;
      turnId: string;
      message: string;
      rating: -1 | 1;
      example: { preferredResponse?: string };
      trainingEligible: false;
    }) =>
      request<LifeRecord>("/api/life/learning", {
        method: "POST",
        body: JSON.stringify(value),
      }),
    list: (scope: string) =>
      request<{ records: LifeRecord[]; windowLimit: number; hasMore: boolean }>(
        `/api/life/learning?scope=${encodeURIComponent(scope)}`,
      ),
    select: (id: string, expectedRevision: number, selected: boolean) =>
      request<LifeRecord>(`/api/life/learning/${encodeURIComponent(id)}/selection`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision, selected }),
      }),
    export: (ids: string[]) =>
      request<{ format: string; count: number; jsonl: string }>("/api/life/learning/export", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
  },
  improvements: {
    list: () =>
      request<{ proposals: ImprovementProposal[]; modelAvailable: boolean }>(
        "/api/life/improvements",
      ),
    detail: (id: string, signal?: AbortSignal) =>
      request<ImprovementProposal>(`/api/life/improvements/${encodeURIComponent(id)}`, { signal }),
    propose: (
      feedback: Array<{ id: string; revision: number }>,
      goal: string,
      signal?: AbortSignal,
    ) =>
      request<ImprovementProposal>("/api/life/improvements", {
        method: "POST",
        body: JSON.stringify({ feedback, ...(goal.trim() ? { goal: goal.trim() } : {}) }),
        signal,
      }),
    adopt: (id: string, expectedRevision: number) =>
      request<ImprovementProposal>(`/api/life/improvements/${encodeURIComponent(id)}/adopt`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      }),
    dismiss: (id: string, expectedRevision: number) =>
      request<ImprovementProposal>(`/api/life/improvements/${encodeURIComponent(id)}/dismiss`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision }),
      }),
  },
  plans: {
    list: (scope: string, signal?: AbortSignal) =>
      request<{ plans: LifePlan[]; hasMore: boolean; unavailableCount: number }>(
        `/api/life/plans?scope=${encodeURIComponent(scope)}&limit=64`,
        { signal },
      ),
    detail: (id: string, signal?: AbortSignal) =>
      request<LifePlan>(`/api/life/plans/${encodeURIComponent(id)}`, { signal }),
    create: (value: { scope: string; title: string; steps: string[] }) =>
      request<LifePlan>("/api/life/plans", { method: "POST", body: JSON.stringify(value) }),
    step: (id: string, stepId: string, completed: boolean, expectedRevision: number) =>
      request<LifePlan>(
        `/api/life/plans/${encodeURIComponent(id)}/steps/${encodeURIComponent(stepId)}`,
        { method: "POST", body: JSON.stringify({ completed, expectedRevision }) },
      ),
  },
  import: {
    preview: (
      value: {
        scope: string;
        format: "ics" | "vcard";
        content: string;
        fileName?: string;
        defaultTimeZone?: string;
      },
      signal?: AbortSignal,
    ) =>
      request<{
        format: "ics" | "vcard";
        source: { title: string; contentHash: string };
        items: Array<{
          key: string;
          kind: string;
          title: string;
          body?: string;
          data: Record<string, unknown>;
          warnings: string[];
        }>;
        warnings: string[];
      }>("/api/life/import/preview", {
        method: "POST",
        body: JSON.stringify(value),
        signal,
      }),
    commit: (
      value: {
        scope: string;
        format: "ics" | "vcard";
        content: string;
        fileName?: string;
        defaultTimeZone?: string;
        selectedKeys?: string[];
        sourceId?: string;
      },
      signal?: AbortSignal,
    ) =>
      request("/api/life/import/commit", {
        method: "POST",
        body: JSON.stringify(value),
        signal,
      }),
  },
  notification: (id: string, action: "dismiss" | "complete", expectedRevision: number) =>
    request(`/api/life/notifications/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }),
  pluginAction: async (id: string, action: string, payload: unknown) => {
    const response = await request<{ value: unknown }>(
      `/api/life/plugins/${encodeURIComponent(id)}/action`,
      { method: "POST", body: JSON.stringify({ action, payload }) },
    );
    return response.value;
  },
  teaching: {
    list: (scope: string) =>
      request<{ guides: TeachingGuide[] }>(`/api/life/teaching?scope=${encodeURIComponent(scope)}`),
    detail: (id: string) => request<TeachingGuide>(`/api/life/teaching/${encodeURIComponent(id)}`),
    create: (value: {
      scope: string;
      title: string;
      instructions: string;
      sources?: TeachingSource[];
      enabled?: boolean;
    }) =>
      request<TeachingGuide>("/api/life/teaching", {
        method: "POST",
        body: JSON.stringify(value),
      }),
    revise: (
      id: string,
      expectedRevision: number,
      instructions: string,
      sources?: TeachingSource[],
    ) =>
      request<TeachingGuide>(`/api/life/teaching/${encodeURIComponent(id)}/revise`, {
        method: "POST",
        body: JSON.stringify({
          expectedRevision,
          instructions,
          ...(sources ? { sources } : {}),
        }),
      }),
    enabled: (id: string, expectedRevision: number, enabled: boolean) =>
      request<TeachingGuide>(`/api/life/teaching/${encodeURIComponent(id)}/enabled`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision, enabled }),
      }),
    rollback: (id: string, expectedRevision: number, targetVersion: number) =>
      request<TeachingGuide>(`/api/life/teaching/${encodeURIComponent(id)}/rollback`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision, targetVersion }),
      }),
  },
  personalData: {
    review: () => request<PersonalDataReview>("/api/life/personal-data/review"),
    exportPage: (
      reviewToken: string,
      store: "life" | "tasks" | "plugins" | "connectors",
      cursor?: string,
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams({ reviewToken, store, limit: "100" });
      if (cursor) query.set("cursor", cursor);
      return request<{
        format: string;
        generation: number;
        items: unknown[];
        nextCursor?: string;
      }>(`/api/life/personal-data/export?${query}`, { signal });
    },
    reset: (reviewToken: string) =>
      request<PersonalResetStatus>("/api/life/personal-data/reset", {
        method: "POST",
        body: JSON.stringify({ reviewToken }),
      }),
    currentReset: () =>
      request<{ reset: PersonalResetStatus | null }>("/api/life/personal-data/reset"),
    resetStatus: (operationId: string) =>
      request<PersonalResetStatus>(
        `/api/life/personal-data/reset/${encodeURIComponent(operationId)}`,
      ),
    retryReset: (operationId: string) =>
      request<PersonalResetStatus>(
        `/api/life/personal-data/reset/${encodeURIComponent(operationId)}/retry`,
        {
          method: "POST",
          body: "{}",
        },
      ),
  },
};
