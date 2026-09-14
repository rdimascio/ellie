import type { Bootstrap, LifeKind, LifeRecord, Scope } from "./types";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
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
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const value = (await response.json()) as { error?: string; message?: string };
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
  await request("/api/life/session", { method: "POST", body: JSON.stringify({ token }) });
  return true;
}
export const api = {
  bootstrap: (scope?: string) =>
    request<Bootstrap>(`/api/life/bootstrap${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`),
  chat: (message: string, scope: string, conversationId?: string) =>
    request<{
      reply: string;
      conversationId: string;
      actions?: { label: string; status: string }[];
    }>("/api/life/chat", {
      method: "POST",
      body: JSON.stringify({ message, scope, conversationId }),
    }),
  createRecord: (value: {
    kind: LifeKind;
    title: string;
    body?: string;
    scope: Scope;
    data: Record<string, unknown>;
  }) => request<LifeRecord>("/api/life/records", { method: "POST", body: JSON.stringify(value) }),
  patchRecord: (id: string, value: Record<string, unknown>) =>
    request<LifeRecord>(`/api/life/records/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(value),
    }),
  deleteRecord: (id: string, revision: number) =>
    request<void>(`/api/life/records/${encodeURIComponent(id)}?revision=${revision}`, {
      method: "DELETE",
    }),
  source: (value: {
    filename: string;
    content: string;
    mimeType: string;
    scope: string;
    encoding?: "base64";
  }) => request("/api/life/sources", { method: "POST", body: JSON.stringify(value) }),
  settings: (scope: string, values: Record<string, unknown>) =>
    request("/api/life/settings", { method: "POST", body: JSON.stringify({ scope, values }) }),
  feedback: (text: string, scope: string, runId?: string) =>
    request("/api/life/feedback", { method: "POST", body: JSON.stringify({ text, scope, runId }) }),
  task: (id: string, action: "pause" | "resume" | "cancel" | "run") =>
    request(`/api/life/tasks/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }),
  buildPlugin: (requestText: string, scope: string) =>
    request("/api/life/plugins/build", {
      method: "POST",
      body: JSON.stringify({ request: requestText, scope }),
    }),
  learning: {
    record: (value: {
      scope: string;
      message: string;
      rating: -1 | 1;
      example: { prompt: string; response: string; preferredResponse?: string };
      trainingEligible: false;
    }) =>
      request<LifeRecord>("/api/life/learning", { method: "POST", body: JSON.stringify(value) }),
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
  import: {
    preview: (value: {
      scope: string;
      format: "ics" | "vcard";
      content: string;
      fileName?: string;
      defaultTimeZone?: string;
    }) =>
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
      }>("/api/life/import/preview", { method: "POST", body: JSON.stringify(value) }),
    commit: (value: {
      scope: string;
      format: "ics" | "vcard";
      content: string;
      fileName?: string;
      defaultTimeZone?: string;
      selectedKeys?: string[];
      sourceId?: string;
    }) => request("/api/life/import/commit", { method: "POST", body: JSON.stringify(value) }),
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
};
