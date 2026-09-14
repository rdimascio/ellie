import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardState, DashboardWidget, WidgetSize, WidgetType } from "./dashboard-model.ts";
import {
  DASHBOARD_STORAGE_KEY,
  MAX_NOTE_LENGTH,
  MAX_SERIALIZED_LENGTH,
  DashboardModelError,
  addWidget,
  createDashboard,
  deleteDashboard,
  moveWidget,
  parseDashboardState,
  removeWidget,
  renameDashboard,
  saveDashboardState,
  serializeDashboardState,
  updateWidget,
} from "./dashboard-model.ts";
import "./dashboard-editor.css";

const WIDGETS: ReadonlyArray<{ type: WidgetType; label: string; description: string }> = [
  { type: "clock", label: "Clock", description: "Live time from this device" },
  { type: "note", label: "Note", description: "A message saved in this browser" },
  { type: "weather", label: "Weather", description: "Connection placeholder" },
  { type: "calendar", label: "Calendar", description: "Connection placeholder" },
  { type: "chores", label: "Chores", description: "Connection placeholder" },
  { type: "playlist", label: "Playlist", description: "Connection placeholder" },
];

const INITIAL_STATE: DashboardState = {
  version: 1,
  dashboards: [
    {
      id: "home",
      name: "Home board",
      widgets: [
        { id: "clock", type: "clock", title: "Right now", size: "wide", config: {} },
        {
          id: "welcome-note",
          type: "note",
          title: "For everyone",
          size: "small",
          config: { text: "Dinner is at 6:30. Make yourself at home." },
        },
        { id: "weather", type: "weather", title: "Weather", size: "small", config: {} },
      ],
    },
  ],
};

function restore(): { state: DashboardState; notice: string } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DASHBOARD_STORAGE_KEY);
  } catch {
    return {
      state: INITIAL_STATE,
      notice: "Browser storage is unavailable. Changes will last only while this page stays open.",
    };
  }
  if (!raw) return { state: INITIAL_STATE, notice: "" };
  try {
    return { state: parseDashboardState(raw), notice: "" };
  } catch {
    return {
      state: INITIAL_STATE,
      notice: "Saved dashboard data was invalid, so the starter board was restored.",
    };
  }
}

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function ClockWidget({ timeZone }: { timeZone?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <time className="widget-clock" dateTime={now.toISOString()}>
      {now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone })}
      <span>
        {now.toLocaleDateString([], {
          weekday: "long",
          month: "long",
          day: "numeric",
          timeZone,
        })}
      </span>
    </time>
  );
}

type WidgetPatch = Partial<Pick<DashboardWidget, "title" | "size" | "config">>;

function WidgetBody({
  widget,
  update,
}: {
  widget: DashboardWidget;
  update: (patch: WidgetPatch) => void;
}) {
  if (widget.type === "clock") return <ClockWidget timeZone={widget.config.timeZone} />;
  if (widget.type === "note")
    return (
      <textarea
        className="note-input"
        aria-label={`${widget.title} note`}
        value={widget.config.text ?? ""}
        maxLength={MAX_NOTE_LENGTH}
        placeholder="Write a note for the household…"
        onChange={(event) => update({ config: { ...widget.config, text: event.target.value } })}
      />
    );
  const definition = WIDGETS.find((item) => item.type === widget.type)!;
  return (
    <div className="widget-placeholder">
      <span aria-hidden="true">
        {widget.type === "weather"
          ? "☁"
          : widget.type === "calendar"
            ? "▦"
            : widget.type === "chores"
              ? "✓"
              : "♫"}
      </span>
      <p>{definition.label} isn’t connected.</p>
      <small>This preview makes no outside requests.</small>
    </div>
  );
}

export function DashboardEditor() {
  const initial = useMemo(restore, []);
  const [state, setState] = useState(initial.state);
  const [selectedId, setSelectedId] = useState(initial.state.dashboards[0]?.id ?? "");
  const [notice, setNotice] = useState(initial.notice);
  const [newName, setNewName] = useState("");
  const [widgetType, setWidgetType] = useState<WidgetType>("note");
  const importRef = useRef<HTMLInputElement>(null);
  const dashboard = state.dashboards.find((item) => item.id === selectedId) ?? state.dashboards[0];

  useEffect(() => {
    try {
      saveDashboardState(localStorage, state, DASHBOARD_STORAGE_KEY);
    } catch {
      setNotice("This change could not be saved. Export a copy before leaving this page.");
    }
  }, [state]);

  const mutate = (next: DashboardState, message: string) => {
    setState(next);
    setNotice(message);
  };

  const guardedMutation = (change: () => DashboardState, message: string) => {
    try {
      mutate(change(), message);
      return true;
    } catch (error) {
      if (!(error instanceof DashboardModelError)) throw error;
      setNotice(error.message);
      return false;
    }
  };

  const addDashboard = (event: React.FormEvent) => {
    event.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const id = uniqueId("dashboard");
    if (!guardedMutation(() => createDashboard(state, { id, name }), `${name} created.`)) return;
    setSelectedId(id);
    setNewName("");
  };

  const addSelectedWidget = () => {
    if (!dashboard) return;
    const definition = WIDGETS.find((item) => item.type === widgetType)!;
    const widget: DashboardWidget = {
      id: uniqueId(widgetType),
      type: widgetType,
      title: definition.label,
      size: widgetType === "clock" ? "wide" : "small",
      config: widgetType === "note" ? { text: "" } : {},
    };
    guardedMutation(() => addWidget(state, dashboard.id, widget), `${definition.label} added.`);
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      if (file.size > MAX_SERIALIZED_LENGTH) throw new Error("Dashboard import is too large");
      const next = parseDashboardState(await file.text());
      setState(next);
      setSelectedId(next.dashboards[0]?.id ?? "");
      setNotice("Dashboards imported.");
    } catch {
      setNotice("That file is not a valid Ellie dashboard export. Nothing was changed.");
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const exportData = () => {
    const blob = new Blob([serializeDashboardState(state)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "ellie-dashboards.json";
    link.click();
    URL.revokeObjectURL(link.href);
    setNotice("Dashboard export downloaded.");
  };

  return (
    <main id="main" tabIndex={-1} className="dashboard-workspace">
      <p className="visually-hidden" role="status" aria-live="polite">
        {notice}
      </p>
      <aside className="dashboard-rail" aria-label="Dashboard manager">
        <div>
          <h1>Dashboards</h1>
          <p>Boards live in this browser.</p>
        </div>
        <div className="dashboard-list" role="list" aria-label="Your dashboards">
          {state.dashboards.map((item) => (
            <button
              key={item.id}
              role="listitem"
              aria-pressed={item.id === dashboard?.id}
              onClick={() => setSelectedId(item.id)}
            >
              <span>{item.name}</span>
              <small>
                {item.widgets.length} {item.widgets.length === 1 ? "widget" : "widgets"}
              </small>
            </button>
          ))}
        </div>
        <form className="new-dashboard" onSubmit={addDashboard}>
          <label htmlFor="new-dashboard-name">New dashboard</label>
          <div>
            <input
              id="new-dashboard-name"
              value={newName}
              maxLength={60}
              placeholder="Kitchen board"
              onChange={(event) => setNewName(event.target.value)}
            />
            <button disabled={!newName.trim()}>Create</button>
          </div>
        </form>
        <div className="data-actions">
          <button onClick={exportData}>Export</button>
          <button onClick={() => importRef.current?.click()}>Import</button>
          <input
            ref={importRef}
            hidden
            type="file"
            accept="application/json,.json"
            aria-label="Import dashboards file"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <button
            onClick={() => {
              let storageAvailable = true;
              try {
                localStorage.removeItem(DASHBOARD_STORAGE_KEY);
              } catch {
                storageAvailable = false;
              }
              setState(INITIAL_STATE);
              setSelectedId("home");
              setNotice(
                storageAvailable
                  ? "Starter board restored."
                  : "Starter board restored for this page, but browser storage is unavailable.",
              );
            }}
          >
            Reset
          </button>
        </div>
      </aside>
      <section className="dashboard-stage" aria-label="Dashboard editor">
        {dashboard ? (
          <>
            <header className="dashboard-stage-header">
              <label>
                Dashboard name
                <input
                  aria-label="Dashboard name"
                  value={dashboard.name}
                  maxLength={60}
                  onChange={(event) =>
                    event.target.value.trim() &&
                    mutate(
                      renameDashboard(state, dashboard.id, event.target.value),
                      "Dashboard renamed.",
                    )
                  }
                />
              </label>
              <button
                className="danger-button"
                disabled={state.dashboards.length === 1}
                onClick={() => {
                  const next = deleteDashboard(state, dashboard.id);
                  setState(next);
                  setSelectedId(next.dashboards[0]?.id ?? "");
                  setNotice(`${dashboard.name} deleted.`);
                }}
              >
                Delete dashboard
              </button>
            </header>
            <div className="add-widget-bar">
              <div>
                <strong>Add a widget</strong>
                <span>Clock and notes work now. Other widgets show their connection state.</span>
              </div>
              <label>
                <span className="visually-hidden">Widget type</span>
                <select
                  aria-label="Widget type"
                  value={widgetType}
                  onChange={(event) => setWidgetType(event.target.value as WidgetType)}
                >
                  {WIDGETS.map((item) => (
                    <option key={item.type} value={item.type}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={addSelectedWidget}>Add widget</button>
            </div>
            {dashboard.widgets.length ? (
              <div className="widget-grid">
                {dashboard.widgets.map((widget, index) => {
                  const update = (patch: WidgetPatch) =>
                    mutate(
                      updateWidget(state, dashboard.id, widget.id, patch),
                      `${widget.title} updated.`,
                    );
                  return (
                    <article key={widget.id} className={`dashboard-widget ${widget.size}`}>
                      <div className="widget-heading">
                        <input
                          aria-label={`${widget.title} title`}
                          value={widget.title}
                          maxLength={60}
                          onChange={(event) =>
                            event.target.value.trim() && update({ title: event.target.value })
                          }
                        />
                        <div className="widget-controls">
                          <button
                            aria-label={`Move ${widget.title} earlier`}
                            disabled={index === 0}
                            onClick={() =>
                              mutate(
                                moveWidget(state, dashboard.id, widget.id, index - 1),
                                `${widget.title} moved.`,
                              )
                            }
                          >
                            ←
                          </button>
                          <button
                            aria-label={`Move ${widget.title} later`}
                            disabled={index === dashboard.widgets.length - 1}
                            onClick={() =>
                              mutate(
                                moveWidget(state, dashboard.id, widget.id, index + 1),
                                `${widget.title} moved.`,
                              )
                            }
                          >
                            →
                          </button>
                          <label>
                            <span className="visually-hidden">{widget.title} size</span>
                            <select
                              aria-label={`${widget.title} size`}
                              value={widget.size}
                              onChange={(event) =>
                                update({ size: event.target.value as WidgetSize })
                              }
                            >
                              <option value="small">Small</option>
                              <option value="wide">Wide</option>
                            </select>
                          </label>
                          <button
                            aria-label={`Remove ${widget.title}`}
                            onClick={() =>
                              mutate(
                                removeWidget(state, dashboard.id, widget.id),
                                `${widget.title} removed.`,
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      </div>
                      <WidgetBody widget={widget} update={update} />
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-dashboard">
                <h2>This board is ready.</h2>
                <p>Add a clock, note, or connection placeholder to shape it for your room.</p>
              </div>
            )}
          </>
        ) : (
          <div className="empty-dashboard">
            <h1>Create a dashboard</h1>
            <p>Give your first board a name to begin.</p>
          </div>
        )}
      </section>
    </main>
  );
}
