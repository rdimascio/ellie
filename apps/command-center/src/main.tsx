import { StrictMode, useEffect, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DemoDevice, DemoState } from "./model.ts";
import {
  AGENDA,
  DEMO_ACTIONS,
  SCENARIOS,
  STATUS_COPY,
  canSubmit,
  reduceDemo,
  scenarioState,
} from "./model.ts";
import type { Scenario } from "./model.ts";
import ellieIcon from "../../../packages/macos/assets/Ellie.png";
import { DashboardEditor } from "./dashboard-editor.tsx";
import "./style.css";

function DeviceIcon({ laptop = false }: { laptop?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="22" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      {laptop ? (
        <path d="M3 25h26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M16 22v5m-5 0h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

function Availability({ device, loading = false }: { device: DemoDevice; loading?: boolean }) {
  return (
    <span className={`availability ${device.available ? "available" : "unavailable"}`}>
      <span aria-hidden="true" />
      {loading ? "Checking" : device.available ? "Available" : "Offline"}
    </span>
  );
}

function WindowPreview({
  illustration,
  offline,
}: {
  illustration: DemoState["illustration"];
  offline: boolean;
}) {
  return (
    <div
      className={`window-preview ${illustration} ${offline ? "screen-offline" : ""}`}
      aria-hidden="true"
    >
      <div className="desktop-scene">
        <div className="scene-orbit" />
        <div className="scene-hill" />
        {offline ? (
          <span className="screen-message">Away for now</span>
        ) : illustration === "welcome" ? (
          <div className="screen-greeting">
            <span>Make yourself</span>
            <strong>at home.</strong>
          </div>
        ) : (
          <>
            <div className="sample-window">
              <div className="sample-toolbar">
                <i />
                <i />
                <i />
                <span>{illustration === "site" ? "Movie night" : "Arc"}</span>
              </div>
              <div className="sample-content">
                <span>{illustration === "site" ? "N" : "A"}</span>
                <div />
                <div />
              </div>
            </div>
            {illustration === "adjacent" && (
              <div className="sample-window second-window">
                <div className="sample-toolbar">
                  <i />
                  <i />
                  <i />
                  <span>Safari</span>
                </div>
                <div className="sample-content">
                  <span>S</span>
                  <div />
                  <div />
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="display-chin" />
      <div className="display-foot" />
    </div>
  );
}

function Activity({
  state,
  cancel,
  compact = false,
}: {
  state: DemoState;
  cancel?: (id: number) => void;
  compact?: boolean;
}) {
  return (
    <section
      className={`activity ${compact ? "compact" : ""}`}
      aria-labelledby={compact ? "tv-activity-heading" : "activity-heading"}
    >
      <div className="section-heading">
        <h2 id={compact ? "tv-activity-heading" : "activity-heading"}>Recent activity</h2>
        <span>Demo history</span>
      </div>
      {state.jobs.length === 0 ? (
        <p className="empty-activity">
          Your requests will appear here, with a clear result for each one.
        </p>
      ) : (
        <ol className="activity-list">
          {state.jobs.slice(0, compact ? 2 : 5).map((job) => {
            const copy = STATUS_COPY[job.state];
            return (
              <li key={job.id}>
                <div className={`job-marker ${copy.tone}`} aria-hidden="true">
                  {job.state === "completed" ? "✓" : job.state === "unknown" ? "?" : "–"}
                </div>
                <div className="job-content">
                  <div className="job-title">
                    <strong>{job.title}</strong>
                    <span className={`job-status ${copy.tone}`}>{copy.label}</span>
                  </div>
                  <span className="job-target">{job.target}</span>
                  {!compact && <p>{copy.detail}</p>}
                  {cancel && ["queued", "running", "delivered"].includes(job.state) && (
                    <button className="text-button" onClick={() => cancel(job.id)}>
                      Cancel request
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function App() {
  const requestedView = new URLSearchParams(window.location.search).get("view");
  const initialView =
    requestedView === "tv" || requestedView === "dashboards" ? requestedView : "remote";
  const [view, setView] = useState<"remote" | "tv" | "dashboards">(initialView);
  const [state, dispatch] = useReducer(reduceDemo, "ready", scenarioState);
  const device = state.devices.find((item) => item.id === state.selected);
  const waiting = state.jobs.find((job) => job.state === "queued");
  const announcement = state.jobs[0]
    ? `${state.jobs[0].title}: ${STATUS_COPY[state.jobs[0].state].label}.`
    : "No requests yet.";

  useEffect(() => {
    if (!waiting) return;
    const command = DEMO_ACTIONS.find((item) => item.title === waiting.title);
    const timer = window.setTimeout(
      () => dispatch({ type: "complete", id: waiting.id, illustration: command?.kind ?? "app" }),
      1800,
    );
    return () => window.clearTimeout(timer);
  }, [waiting]);

  useEffect(() => {
    if (view !== "tv") return;
    const navigate = (event: KeyboardEvent) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (document.activeElement?.tagName === "SELECT") return;
      const controls = [
        ...document.querySelectorAll<HTMLElement>("button:not(:disabled), select, a[href]"),
      ].filter((item) => item.getClientRects().length);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
      controls[(index + direction + controls.length) % controls.length]?.focus();
      event.preventDefault();
    };
    document.addEventListener("keydown", navigate);
    return () => document.removeEventListener("keydown", navigate);
  }, [view]);

  return (
    <div
      className={`app-shell ${view === "tv" ? "tv-mode" : view === "dashboards" ? "dashboard-mode" : "remote-mode"}`}
    >
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <div className="brand">
          <img src={ellieIcon} alt="" width="44" height="44" />
          <span>ellie</span>
        </div>
        <span className="home-name">A little closer to home.</span>
        <nav className="view-switch" aria-label="Preview view">
          <button aria-pressed={view === "remote"} onClick={() => setView("remote")}>
            Remote
          </button>
          <button aria-pressed={view === "tv"} onClick={() => setView("tv")}>
            TV view
          </button>
          <button aria-pressed={view === "dashboards"} onClick={() => setView("dashboards")}>
            Dashboards
          </button>
        </nav>
      </header>
      {view !== "dashboards" && (
        <div className="demo-bar">
          <div>
            <strong>Interactive demo</strong>
            <span>Sample home. Commands stay in this browser.</span>
          </div>
          <label>
            Demo scenario
            <select
              value={state.scenario}
              onChange={(event) =>
                dispatch({ type: "scenario", scenario: event.target.value as Scenario })
              }
            >
              {Object.entries(SCENARIOS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {view === "dashboards" ? (
        <DashboardEditor />
      ) : view === "remote" ? (
        <main id="main" tabIndex={-1} className="remote-layout">
          <aside className="device-sidebar" aria-label="Household devices">
            <h2>Your Macs</h2>
            <p>Choose where it happens.</p>
            <div className="device-list">
              {state.devices.map((item) => (
                <button
                  key={item.id}
                  className={`device-button ${item.id === state.selected ? "selected" : ""}`}
                  aria-pressed={item.id === state.selected}
                  onClick={() => dispatch({ type: "select", id: item.id })}
                >
                  <DeviceIcon laptop={item.id === "demo-laptop"} />
                  <span>
                    <strong>{item.name}</strong>
                    <Availability device={item} loading={state.scenario === "loading"} />
                  </span>
                </button>
              ))}
            </div>
            <div className="sidebar-note">
              <span className="small-spark" aria-hidden="true">
                ✳
              </span>
              <p>
                A home that listens.
                <br />
                One small request at a time.
              </p>
            </div>
          </aside>
          <div className="remote-main">
            <label className="mobile-picker">
              Control a Mac
              <select
                aria-label="Control a Mac"
                value={state.selected}
                disabled={!state.devices.length}
                onChange={(event) => dispatch({ type: "select", id: event.target.value })}
              >
                {state.devices.length ? (
                  state.devices.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.available ? "" : " (offline)"}
                    </option>
                  ))
                ) : (
                  <option value="">No devices</option>
                )}
              </select>
            </label>
            {device ? (
              <>
                <section className="remote-stage" aria-labelledby="device-heading">
                  <div className="stage-heading">
                    <div>
                      <span className="room-label">{device.room}</span>
                      <h1 id="device-heading">{device.name}</h1>
                    </div>
                    <Availability device={device} loading={state.scenario === "loading"} />
                  </div>
                  <WindowPreview illustration={state.illustration} offline={!device.available} />
                  <p className="preview-caption">Illustration only. This is not a live screen.</p>
                  {state.scenario === "loading" ? (
                    <div className="device-notice" role="status">
                      <strong>Finding your Macs…</strong>
                      <p>Availability is being checked in this demo scenario.</p>
                    </div>
                  ) : !device.available ? (
                    <div className="device-notice">
                      <strong>This Mac is offline.</strong>
                      <p>
                        Wake it and check its Ellie service before sending a request. Nothing will
                        be queued while it is unavailable.
                      </p>
                    </div>
                  ) : null}
                </section>
                <section className="actions-section" aria-labelledby="actions-heading">
                  <div className="section-heading">
                    <h2 id="actions-heading">What would you like?</h2>
                    <span>On {device.name}</span>
                  </div>
                  <div className="action-grid">
                    {DEMO_ACTIONS.map((command, index) => (
                      <button
                        key={command.action.tool}
                        className="action-button"
                        disabled={!canSubmit(state, command.action.tool)}
                        onClick={() => dispatch({ type: "submit", index })}
                      >
                        <span className={`action-symbol symbol-${command.kind}`} aria-hidden="true">
                          {command.symbol === "left" || command.symbol === "adjacent" ? (
                            <span className={`tile-glyph ${command.symbol}`}>
                              <i />
                              <i />
                            </span>
                          ) : (
                            command.symbol
                          )}
                        </span>
                        <span>
                          <strong>{command.title}</strong>
                          <small>{command.description}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {device.available && device.capabilities.length < DEMO_ACTIONS.length && (
                    <p className="capability-note">
                      Window controls are unavailable on this Mac. Check its Accessibility
                      permission to enable them.
                    </p>
                  )}
                </section>
              </>
            ) : (
              <section className="empty-state">
                <DeviceIcon />
                <h1>No Macs here yet.</h1>
                <p>
                  Paired Macs will appear here when they connect. Choose the Ready demo scenario to
                  explore the remote.
                </p>
              </section>
            )}
            <Activity state={state} cancel={(id) => dispatch({ type: "cancel", id })} />
          </div>
          <aside className="today-sidebar">
            <Agenda small />
            <div className="home-note">
              <span aria-hidden="true">☀</span>
              <h2>
                Leave a little room
                <br />
                for doing nothing.
              </h2>
              <p>The rest of the evening is yours.</p>
            </div>
          </aside>
        </main>
      ) : (
        <main id="main" tabIndex={-1} className="tv-layout">
          <div>
            <div className="tv-greeting">
              <span>Tuesday, June 18</span>
              <h1>Good to be home.</h1>
              <p>A little shape to the rest of your day.</p>
            </div>
            <Agenda />
          </div>
          <aside className="tv-sidebar">
            <section aria-labelledby="tv-device-heading">
              <div className="section-heading">
                <h2 id="tv-device-heading">Around the house</h2>
                <span>Sample devices</span>
              </div>
              {state.devices.length ? (
                <ul className="tv-device-list">
                  {state.devices.map((item) => (
                    <li key={item.id}>
                      <DeviceIcon laptop={item.id === "demo-laptop"} />
                      <div>
                        <strong>{item.name}</strong>
                        <Availability device={item} loading={state.scenario === "loading"} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No connected Macs in this scenario.</p>
              )}
            </section>
            <Activity state={state} compact />
            <p className="tv-readonly">
              A shared view for the room. Use the remote to send a request.
            </p>
          </aside>
        </main>
      )}
      <footer className="app-footer">
        <span>Made for the place you call home.</span>
        <span>
          {view === "dashboards"
            ? "Saved locally · No connected services"
            : "Prototype · No real household data"}
        </span>
      </footer>
    </div>
  );
}

function Agenda({ small = false }: { small?: boolean }) {
  return (
    <section
      className={`agenda ${small ? "small-agenda" : ""}`}
      aria-labelledby={small ? "small-agenda-title" : "agenda-title"}
    >
      <div className="section-heading">
        <h2 id={small ? "small-agenda-title" : "agenda-title"}>
          {small ? "Later today" : "The rest of today"}
        </h2>
        <span>Sample agenda</span>
      </div>
      <ol>
        {AGENDA.map((item) => (
          <li key={item.time}>
            <div className="agenda-time">
              {item.time}
              <span>{item.period}</span>
            </div>
            <div>
              <h3>{small ? item.kind : item.title}</h3>
              <p>{item.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
