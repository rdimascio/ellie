export const VERSION = 1 as const;
export const CAPABILITIES = ['app.open', 'url.open', 'window.place', 'window.adjacent'] as const;
export type Capability = typeof CAPABILITIES[number];
export const LAYOUTS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'left', 'right', 'maximize', 'fullscreen'] as const;
export type Layout = typeof LAYOUTS[number];
export type Monitor = 'current' | 'largest' | 'primary';
export type Action =
  | { tool: 'app.open'; app: string }
  | { tool: 'url.open'; app: string; url: string }
  | { tool: 'window.place'; app: string; layout: Layout; monitor: Monitor }
  | { tool: 'window.adjacent'; app: string; anchor: string };
export interface Job { version: typeof VERSION; id: string; expiresAt: number; actions: Action[] }
export interface Result { ok: boolean; message: string }
export interface Context { lastApp?: string }
export interface Plan { actions: Action[]; nextContext: Context }
export interface NodeInfo { id: string; capabilities: Capability[]; lastSeen: number }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function string(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid string.');
  return value;
}
export function identifier(value: unknown): string {
  const result = string(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result)) throw new Error('Invalid identifier.');
  return result;
}
export function capabilities(value: unknown): Capability[] {
  if (!Array.isArray(value) || value.length > CAPABILITIES.length || value.some(x => !CAPABILITIES.includes(x))) throw new Error('Invalid capabilities.');
  return [...new Set(value)] as Capability[];
}
export function action(value: unknown): Action {
  const v = record(value); const app = identifier(v.app);
  switch (v.tool) {
    case 'app.open': return { tool: v.tool, app };
    case 'url.open': {
      const url = new URL(string(v.url));
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS links without credentials are supported.');
      return { tool: v.tool, app, url: url.href };
    }
    case 'window.place':
      if (!LAYOUTS.includes(v.layout as Layout) || !['current','largest','primary'].includes(String(v.monitor))) throw new Error('Invalid window placement.');
      return { tool: v.tool, app, layout: v.layout as Layout, monitor: v.monitor as Monitor };
    case 'window.adjacent': return { tool: v.tool, app, anchor: identifier(v.anchor) };
    default: throw new Error('Unsupported tool.');
  }
}
export function job(value: unknown): Job {
  const v = record(value);
  if (v.version !== VERSION || !Number.isFinite(v.expiresAt) || !Array.isArray(v.actions) || v.actions.length < 1 || v.actions.length > 4) throw new Error('Invalid job.');
  return { version: VERSION, id: identifier(v.id), expiresAt: v.expiresAt as number, actions: v.actions.map(action) };
}
export function result(value: unknown): Result {
  const v = record(value);
  if (typeof v.ok !== 'boolean') throw new Error('Invalid result.');
  return { ok: v.ok, message: string(v.message, 1000) };
}
