export const DASHBOARD_SCHEMA_VERSION = 1 as const;
export const DASHBOARD_STORAGE_KEY = "ellie.command-center.dashboards.v1";

export const WIDGET_TYPES = ["clock", "note", "weather", "calendar", "chores", "playlist"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type WidgetSize = "small" | "wide";
export type WidgetConfig = Readonly<Record<string, string>>;

export interface DashboardWidget {
  readonly id: string;
  readonly type: WidgetType;
  readonly title: string;
  readonly size: WidgetSize;
  readonly config: WidgetConfig;
}
export type Widget = DashboardWidget;

export interface Dashboard {
  readonly id: string;
  readonly name: string;
  readonly widgets: readonly DashboardWidget[];
}

export interface DashboardState {
  readonly version: typeof DASHBOARD_SCHEMA_VERSION;
  readonly dashboards: readonly Dashboard[];
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class DashboardModelError extends Error {
  override readonly name = "DashboardModelError";
}

export const MAX_DASHBOARDS = 12;
export const MAX_WIDGETS_PER_DASHBOARD = 24;
const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 80;
const MAX_TITLE_LENGTH = 80;
export const MAX_NOTE_LENGTH = 2_000;
export const MAX_SERIALIZED_LENGTH = 128 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FORBIDDEN_CONFIG_KEY =
  /(?:secret|token|password|passphrase|cookie|authorization|api[_-]?key)/iu;

export const DEFAULT_DASHBOARD_STATE: DashboardState = Object.freeze({
  version: DASHBOARD_SCHEMA_VERSION,
  dashboards: Object.freeze([
    Object.freeze({
      id: "home",
      name: "Home",
      widgets: Object.freeze([
        Object.freeze({
          id: "clock",
          type: "clock" as const,
          title: "Right now",
          size: "small" as const,
          config: Object.freeze({}),
        }),
        Object.freeze({
          id: "note",
          type: "note" as const,
          title: "A little note",
          size: "wide" as const,
          config: Object.freeze({ text: "Leave something kind for the household." }),
        }),
      ]),
    }),
  ]),
});

export function createDefaultDashboardState(): DashboardState {
  return cloneState(DEFAULT_DASHBOARD_STATE);
}

export function createDashboard(
  state: DashboardState,
  dashboard: Pick<Dashboard, "id" | "name">,
): DashboardState {
  const current = validatedClone(state);
  if (current.dashboards.length >= MAX_DASHBOARDS) fail("Too many dashboards");
  validateId(dashboard.id, "dashboard id");
  validateText(dashboard.name, "dashboard name", MAX_NAME_LENGTH);
  if (current.dashboards.some(({ id }) => id === dashboard.id)) fail("Duplicate dashboard id");
  return { ...current, dashboards: [...current.dashboards, { ...dashboard, widgets: [] }] };
}

export function renameDashboard(
  state: DashboardState,
  dashboardId: string,
  name: string,
): DashboardState {
  validateText(name, "dashboard name", MAX_NAME_LENGTH);
  return updateDashboard(validatedClone(state), dashboardId, (dashboard) => ({
    ...dashboard,
    name,
  }));
}

export function deleteDashboard(state: DashboardState, dashboardId: string): DashboardState {
  const current = validatedClone(state);
  requireDashboard(current, dashboardId);
  return { ...current, dashboards: current.dashboards.filter(({ id }) => id !== dashboardId) };
}

export function addWidget(
  state: DashboardState,
  dashboardId: string,
  widget: DashboardWidget,
): DashboardState {
  const current = validatedClone(state);
  const cleanWidget = validateWidget(widget, "widget");
  return updateDashboard(current, dashboardId, (dashboard) => {
    if (dashboard.widgets.length >= MAX_WIDGETS_PER_DASHBOARD) fail("Too many widgets");
    if (dashboard.widgets.some(({ id }) => id === cleanWidget.id)) fail("Duplicate widget id");
    return { ...dashboard, widgets: [...dashboard.widgets, cleanWidget] };
  });
}

export function updateWidget(
  state: DashboardState,
  dashboardId: string,
  widgetId: string,
  patch: Partial<Pick<DashboardWidget, "title" | "size" | "config">>,
): DashboardState {
  if (!isPlainObject(patch) || !hasOnlyKeys(patch, ["title", "size", "config"]))
    fail("Invalid widget update");
  const current = validatedClone(state);
  return updateDashboard(current, dashboardId, (dashboard) => {
    const index = dashboard.widgets.findIndex(({ id }) => id === widgetId);
    if (index < 0) fail("Unknown widget id");
    const existing = dashboard.widgets[index]!;
    const updated = validateWidget({ ...existing, ...patch }, "widget");
    const widgets = [...dashboard.widgets];
    widgets[index] = updated;
    return { ...dashboard, widgets };
  });
}

export function removeWidget(
  state: DashboardState,
  dashboardId: string,
  widgetId: string,
): DashboardState {
  const current = validatedClone(state);
  return updateDashboard(current, dashboardId, (dashboard) => {
    if (!dashboard.widgets.some(({ id }) => id === widgetId)) fail("Unknown widget id");
    return { ...dashboard, widgets: dashboard.widgets.filter(({ id }) => id !== widgetId) };
  });
}

export function moveWidget(
  state: DashboardState,
  dashboardId: string,
  widgetId: string,
  toIndex: number,
): DashboardState {
  const current = validatedClone(state);
  return updateDashboard(current, dashboardId, (dashboard) => {
    if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= dashboard.widgets.length)
      fail("Widget position is out of bounds");
    const fromIndex = dashboard.widgets.findIndex(({ id }) => id === widgetId);
    if (fromIndex < 0) fail("Unknown widget id");
    const widgets = [...dashboard.widgets];
    const [widget] = widgets.splice(fromIndex, 1);
    widgets.splice(toIndex, 0, widget!);
    return { ...dashboard, widgets };
  });
}

export function parseDashboardState(value: string | unknown): DashboardState {
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.length > MAX_SERIALIZED_LENGTH) fail("Dashboard data is too large");
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      fail("Dashboard data is not valid JSON");
    }
  }
  return validateState(parsed);
}

export function serializeDashboardState(state: DashboardState): string {
  const serialized = JSON.stringify(validateState(state));
  if (serialized.length > MAX_SERIALIZED_LENGTH) fail("Dashboard data is too large");
  return serialized;
}

export function loadDashboardState(
  storage: StorageLike,
  key = DASHBOARD_STORAGE_KEY,
): DashboardState {
  const stored = storage.getItem(key);
  if (stored === null) return createDefaultDashboardState();
  try {
    return parseDashboardState(stored);
  } catch (error) {
    if (error instanceof DashboardModelError) return createDefaultDashboardState();
    throw error;
  }
}

export function saveDashboardState(
  storage: StorageLike,
  state: DashboardState,
  key = DASHBOARD_STORAGE_KEY,
): void {
  storage.setItem(key, serializeDashboardState(state));
}

function validateState(value: unknown): DashboardState {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["version", "dashboards"]))
    fail("Invalid dashboard state");
  if (value.version !== DASHBOARD_SCHEMA_VERSION) fail("Unsupported dashboard version");
  if (!Array.isArray(value.dashboards) || value.dashboards.length > MAX_DASHBOARDS)
    fail("Invalid dashboards");
  const ids = new Set<string>();
  const dashboards = value.dashboards.map((item, index) => {
    const dashboard = validateDashboard(item, `dashboard ${index}`);
    if (ids.has(dashboard.id)) fail("Duplicate dashboard id");
    ids.add(dashboard.id);
    return dashboard;
  });
  return { version: DASHBOARD_SCHEMA_VERSION, dashboards };
}

function validateDashboard(value: unknown, label: string): Dashboard {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "name", "widgets"]))
    fail(`Invalid ${label}`);
  validateId(value.id, `${label} id`);
  validateText(value.name, `${label} name`, MAX_NAME_LENGTH);
  if (!Array.isArray(value.widgets) || value.widgets.length > MAX_WIDGETS_PER_DASHBOARD)
    fail(`Invalid ${label} widgets`);
  const ids = new Set<string>();
  const widgets = value.widgets.map((item, index) => {
    const widget = validateWidget(item, `${label} widget ${index}`);
    if (ids.has(widget.id)) fail("Duplicate widget id");
    ids.add(widget.id);
    return widget;
  });
  return { id: value.id, name: value.name, widgets };
}

function validateWidget(value: unknown, label: string): DashboardWidget {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ["id", "type", "title", "size", "config"]))
    fail(`Invalid ${label}`);
  validateId(value.id, `${label} id`);
  if (typeof value.type !== "string" || !(WIDGET_TYPES as readonly string[]).includes(value.type))
    fail(`Invalid ${label} type`);
  validateText(value.title, `${label} title`, MAX_TITLE_LENGTH);
  if (value.size !== "small" && value.size !== "wide") fail(`Invalid ${label} size`);
  const config = validateConfig(value.type as WidgetType, value.config, label);
  return {
    id: value.id,
    type: value.type as WidgetType,
    title: value.title,
    size: value.size,
    config,
  };
}

function validateConfig(type: WidgetType, value: unknown, label: string): Record<string, string> {
  if (!isPlainObject(value)) fail(`Invalid ${label} config`);
  const allowed =
    type === "clock"
      ? ["timeZone"]
      : type === "note"
        ? ["text"]
        : type === "playlist"
          ? ["youtubePlaylistID"]
          : [];
  if (!hasOnlyKeys(value, allowed)) fail(`Invalid ${label} config`);
  const config: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_CONFIG_KEY.test(key)) fail(`Invalid ${label} config key`);
    if (typeof item !== "string") fail(`Invalid ${label} config value`);
    const maximum = key === "text" ? MAX_NOTE_LENGTH : 100;
    if (item.length > maximum) fail(`Invalid ${label} config value`);
    if (key === "timeZone") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: item });
      } catch {
        fail(`Invalid ${label} time zone`);
      }
    }
    if (key === "youtubePlaylistID" && !/^PL[A-Za-z0-9_-]{11,78}$/.test(item))
      fail(`Invalid ${label} YouTube playlist id`);
    config[key] = item;
  }
  return config;
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !IDENTIFIER.test(value))
    fail(`Invalid ${label}`);
}

function validateText(value: unknown, label: string, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  )
    fail(`Invalid ${label}`);
}

function updateDashboard(
  state: DashboardState,
  dashboardId: string,
  update: (dashboard: Dashboard) => Dashboard,
): DashboardState {
  const index = state.dashboards.findIndex(({ id }) => id === dashboardId);
  if (index < 0) fail("Unknown dashboard id");
  const dashboards = [...state.dashboards];
  dashboards[index] = update(dashboards[index]!);
  return { ...state, dashboards };
}

function requireDashboard(state: DashboardState, dashboardId: string): Dashboard {
  const dashboard = state.dashboards.find(({ id }) => id === dashboardId);
  if (!dashboard) fail("Unknown dashboard id");
  return dashboard;
}

function validatedClone(state: DashboardState): DashboardState {
  return validateState(state);
}

function cloneState(state: DashboardState): DashboardState {
  return {
    version: DASHBOARD_SCHEMA_VERSION,
    dashboards: state.dashboards.map((dashboard) => ({
      ...dashboard,
      widgets: dashboard.widgets.map((widget) => ({ ...widget, config: { ...widget.config } })),
    })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function fail(message: string): never {
  throw new DashboardModelError(message);
}
