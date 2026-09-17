import { useEffect, useRef, useState } from "react";
import {
  api,
  type ConnectionPreview,
  type ConnectorConnection,
  type ConnectorMode,
  type ConnectorProvider,
} from "./api";

export function Connections({ standalone = false }: { standalone?: boolean }) {
  const [connections, setConnections] = useState<ConnectorConnection[]>([]);
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [connectMode, setConnectMode] = useState<ConnectorMode>("prepare");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const listRequest = useRef(0);
  const actionInFlight = useRef(false);
  const detailRequest = useRef(0);
  const [detailId, setDetailId] = useState("");
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [calendarOptions, setCalendarOptions] = useState<
    { id: string; label: string; primary: boolean }[]
  >([]);
  const [calendarChoice, setCalendarChoice] = useState("");
  const [detailError, setDetailError] = useState("");
  const detailSync = connections.find((item) => item.id === detailId)?.lastSyncAt;
  useEffect(() => {
    if (!detailId) return;
    const current = connections.find((item) => item.id === detailId);
    if (!current || current.state === "revoked") {
      detailRequest.current++;
      setDetailId("");
      setPreview(null);
      setCalendarOptions([]);
      setCalendarChoice("");
      setDetailError("");
    }
  }, [connections, detailId]);
  useEffect(() => {
    if (detailId && detailSync && !actionInFlight.current) void openDetails(detailId);
  }, [detailId, detailSync]);
  const [pending, setPending] = useState<{
    provider: ConnectorProvider["id"];
    connectionId: string;
    authorizationUrl?: string;
    openedExternally: boolean;
    seen: boolean;
  } | null>(null);

  const load = async () => {
    const request = ++listRequest.current;
    const value = await api.connections.list();
    if (request !== listRequest.current) return false;
    setConnections(value.connections);
    setProviders(value.providers);
    setLoadError("");
    setLoading(false);
    return true;
  };
  useEffect(() => {
    if (!pending) return;
    const connection = connections.find(
      (item) => item.id === pending.connectionId && item.provider === pending.provider,
    );
    if (connection?.state === "connecting") {
      if (!pending.seen) setPending({ ...pending, seen: true });
      return;
    }
    if (!connection && !pending.seen) return;
    setPending(null);
    setCopyStatus("");
    if (connection?.state === "connected") setNotice("Google connection is ready.");
    else if (connection?.state === "paused" || connection?.state === "error")
      setNotice("Google sign-in finished, but the connection needs attention.");
    else setNotice("Google connection setup did not finish. You can start again.");
  }, [connections, pending]);
  useEffect(() => {
    let current = true;
    let loading = false;
    const refresh = async () => {
      if (loading || actionInFlight.current || document.visibilityState !== "visible") return;
      loading = true;
      const request = ++listRequest.current;
      try {
        const value = await api.connections.list();
        if (!current || request !== listRequest.current) return;
        setConnections(value.connections);
        setProviders(value.providers);
        setLoadError("");
        setLoading(false);
      } catch (caught) {
        if (current && request === listRequest.current)
          setLoadError(
            caught instanceof Error ? caught.message : "Connected accounts are unavailable.",
          );
        if (current && request === listRequest.current) setLoading(false);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      current = false;
      listRequest.current++;
      window.clearInterval(timer);
    };
  }, []);

  const run = async (key: string, operation: () => Promise<unknown>) => {
    actionInFlight.current = true;
    listRequest.current++;
    setBusy(key);
    setError("");
    setNotice("");
    if (detailId) {
      detailRequest.current++;
      setPreview(null);
    }
    try {
      await operation();
      await load();
      if (detailId && !key.startsWith("revoke:") && !key.startsWith("cancel:"))
        await openDetails(detailId);
      else if (key.startsWith("revoke:") || key.startsWith("cancel:")) {
        setDetailId("");
        setCalendarOptions([]);
        setPreview(null);
        setCalendarChoice("");
      }
    } catch (caught) {
      try {
        await load();
        if (detailId) await openDetails(detailId);
      } catch {
        /* Preserve the action failure. */
      }
      setError(
        caught instanceof Error ? caught.message : "The connected account could not be updated.",
      );
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  };
  const openDetails = async (id: string) => {
    const request = ++detailRequest.current;
    setDetailId(id);
    setPreview(null);
    setCalendarOptions([]);
    setCalendarChoice("");
    setDetailError("");
    try {
      const connection = connections.find((item) => item.id === id);
      const [nextPreview, calendars] = await Promise.all([
        api.connections.preview(id),
        connection?.provider === "google-calendar" && connection.state === "connected"
          ? api.connections.calendars(id)
          : Promise.resolve(null),
      ]);
      if (request !== detailRequest.current) return;
      setPreview(nextPreview);
      setCalendarOptions(calendars?.calendars ?? []);
      setCalendarChoice(calendars?.selectedCalendarId ?? "");
    } catch (caught) {
      if (request === detailRequest.current)
        setDetailError(
          caught instanceof Error ? caught.message : "Imported activity is unavailable.",
        );
    }
  };
  const connect = async (provider: ConnectorProvider) => {
    actionInFlight.current = true;
    listRequest.current++;
    setBusy(`connect:${provider.id}`);
    setError("");
    setNotice("");
    setCopyStatus("");
    try {
      const value = await api.connections.start(provider.id, connectMode),
        target = new URL(value.authorizationUrl, location.origin);
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.connectionId)
      )
        throw new Error("The connection response was invalid.");
      const local = target.origin === location.origin,
        google =
          target.protocol === "https:" &&
          target.hostname === "accounts.google.com" &&
          target.port === "" &&
          target.pathname === "/o/oauth2/v2/auth" &&
          target.username === "" &&
          target.password === "" &&
          target.hash === "";
      if (!local && !google) throw new Error("The connection URL was not trusted.");
      setPending({
        provider: provider.id,
        connectionId: value.connectionId,
        ...(value.openedExternally ? {} : { authorizationUrl: target.href }),
        openedExternally: value.openedExternally === true,
        seen: false,
      });
      try {
        if (await load())
          setPending((current) =>
            current?.connectionId === value.connectionId ? { ...current, seen: true } : current,
          );
      } catch {
        setError("Connection started, but its current status could not be loaded.");
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The account connection could not start.",
      );
    } finally {
      actionInFlight.current = false;
      setBusy("");
    }
  };

  return (
    <section
      className={`connections ${standalone ? "connections-page" : ""}`}
      id="connected-accounts"
    >
      {standalone ? (
        <div className="integration-intro">
          <span className="integration-intro-symbol">
            <IntegrationMark provider="all" />
          </span>
          <h2>
            A little more connected.
            <br />A lot more useful.
          </h2>
          <p>Give Ellie the context to help with your day.</p>
        </div>
      ) : (
        <header>
          <div>
            <span>Private connections</span>
            <h2>Connected accounts</h2>
          </div>
        </header>
      )}
      <p>
        Connect once and Ellie can keep read-only context current automatically. Ellie never sends
        messages, moves money, or changes a connected account.
      </p>
      <label className="connection-default">
        <input
          type="checkbox"
          checked={connectMode === "prepare"}
          onChange={(event) => setConnectMode(event.target.checked ? "prepare" : "observe")}
        />
        <span>
          Automatically create private preparation plans
          <small>
            Ellie may infer useful defaults from read-only context. You can edit or dismiss them.
          </small>
        </span>
      </label>
      {pending && (
        <div className="connection-status" role="status">
          <p>
            {pending.openedExternally
              ? "Finish connecting in your browser. Ellie will update here when it’s ready."
              : "Google sign-in must open outside Ellie. Use the external browser link, then return here when you finish."}
          </p>
          {pending.authorizationUrl && (
            <div className="connection-actions">
              <a href={pending.authorizationUrl} target="_blank" rel="noreferrer">
                Open Google sign-in in an external browser
              </a>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(pending.authorizationUrl!);
                    setCopyStatus("Sign-in link copied.");
                  } catch {
                    setError("The sign-in link could not be copied. Open it directly instead.");
                  }
                }}
              >
                Copy sign-in link
              </button>
            </div>
          )}
          {copyStatus && <small>{copyStatus}</small>}
          <button
            type="button"
            disabled={busy !== ""}
            onClick={() =>
              void run(`cancel:${pending.connectionId}`, () =>
                api.connections.revoke(pending.connectionId),
              )
            }
          >
            {busy === `cancel:${pending.connectionId}` ? "Stopping…" : "Stop setup"}
          </button>
        </div>
      )}
      {notice && (
        <p className="connection-status" role="status">
          {notice}
        </p>
      )}
      {connections.length > 0 && (
        <div className="connection-list">
          {connections.map((connection) => (
            <article key={connection.id}>
              <div className="connection-identity">
                <IntegrationMark provider={connection.provider} />
                <div>
                  <strong>{connection.label}</strong>
                  <small>
                    {providerLabel(providers, connection.provider)} · {stateLabel(connection.state)}
                    {connection.lastSyncAt
                      ? ` · Updated ${new Date(connection.lastSyncAt).toLocaleString()}`
                      : ""}
                  </small>
                  {connection.error && <span role="alert">{connection.error}</span>}
                </div>
              </div>
              <label>
                Mode
                <select
                  value={connection.mode}
                  disabled={busy !== "" || connection.state === "revoked"}
                  onChange={(event) =>
                    void run(`mode:${connection.id}`, () =>
                      api.connections.mode(connection.id, event.target.value as ConnectorMode),
                    )
                  }
                >
                  <option value="observe">Observe</option>
                  <option value="prepare">Prepare</option>
                </select>
              </label>
              <div className="connection-actions">
                {connection.state !== "revoked" && (
                  <button
                    type="button"
                    disabled={busy !== ""}
                    onClick={() =>
                      detailId === connection.id
                        ? (detailRequest.current++, setDetailId(""), setPreview(null))
                        : void openDetails(connection.id)
                    }
                  >
                    {detailId === connection.id
                      ? "Hide imported activity"
                      : "View imported activity"}
                  </button>
                )}
                <button
                  disabled={busy !== "" || connection.state === "revoked"}
                  onClick={() =>
                    void run(`refresh:${connection.id}`, () =>
                      api.connections.refresh(connection.id),
                    )
                  }
                >
                  {busy === `refresh:${connection.id}` ? "Refreshing…" : "Refresh"}
                </button>
                <button
                  className="danger"
                  disabled={busy !== ""}
                  onClick={() =>
                    void run(`revoke:${connection.id}`, () => api.connections.revoke(connection.id))
                  }
                >
                  Disconnect
                </button>
              </div>
              {detailId === connection.id && (
                <div className="connection-status">
                  {connection.provider === "google-calendar" && calendarOptions.length > 0 && (
                    <label>
                      Calendar to read
                      <select
                        value={calendarChoice}
                        disabled={busy !== ""}
                        onChange={(event) =>
                          void run(`calendar:${connection.id}`, () =>
                            api.connections.selectCalendar(connection.id, event.target.value),
                          )
                        }
                      >
                        {calendarChoice &&
                          !calendarOptions.some((item) => item.id === calendarChoice) && (
                            <option value={calendarChoice}>
                              Previously selected calendar (unavailable)
                            </option>
                          )}
                        {calendarOptions.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.label}
                            {calendar.primary ? " (primary)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {detailError && <p role="alert">{detailError}</p>}
                  {preview && (
                    <>
                      <p>
                        {preview.lastSyncAt
                          ? `Last imported ${new Date(preview.lastSyncAt).toLocaleString()}`
                          : "No completed import yet."}
                        {preview.error ? ` · Import needs attention: ${preview.error}` : ""}
                      </p>
                      {preview.items.length === 0 ? (
                        <p>No imported activity to preview.</p>
                      ) : (
                        <ul>
                          {preview.items.map((item, index) => (
                            <li key={index}>
                              {item.kind === "event"
                                ? `${item.title}${item.startAt ? ` · ${new Date(item.startAt).toLocaleString()}` : item.startDate ? ` · ${item.startDate}` : ""}`
                                : `${item.subject} · ${item.from}${item.snippet ? ` · ${item.snippet}` : ""}`}
                            </li>
                          ))}
                        </ul>
                      )}
                      <small>
                        Private read-only preview. Gmail shows headers and a bounded snippet, not
                        message bodies.
                      </small>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
      <div className="provider-list">
        {providers
          .filter(
            (provider) =>
              !connections.some(
                (connection) =>
                  connection.provider === provider.id && connection.state !== "revoked",
              ),
          )
          .map((provider) => (
            <article key={provider.id}>
              <div className="connection-identity">
                <IntegrationMark provider={provider.id} />
                <div>
                  <strong>{provider.id === "plaid" ? "Plaid" : provider.label}</strong>
                  <span className="provider-description">
                    {provider.id === "gmail"
                      ? "Email & useful context"
                      : provider.id === "google-calendar"
                        ? "Events & your everyday"
                        : "Financial accounts & transactions"}
                  </span>
                  <small>
                    {provider.configured
                      ? "Ready for a private read-only connection"
                      : (provider.setupMessage ?? "Setup is required on this Ellie host.")}
                  </small>
                </div>
              </div>
              <button
                disabled={!provider.configured || busy !== "" || pending !== null}
                title={
                  !provider.configured
                    ? provider.setupMessage
                    : pending
                      ? "Finish or stop the current connection first."
                      : undefined
                }
                onClick={() => void connect(provider)}
              >
                {busy === `connect:${provider.id}`
                  ? "Opening…"
                  : provider.configured
                    ? "Connect"
                    : "Setup required"}
              </button>
            </article>
          ))}
      </div>
      {loading && (
        <p className="connection-empty" role="status">
          Loading integrations…
        </p>
      )}
      {providers.length === 0 && !error && !loadError && !loading && (
        <p className="connection-empty">No providers are configured.</p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {loadError && (
        <p className="settings-error" role="alert">
          {loadError}
        </p>
      )}
    </section>
  );
}

function providerLabel(providers: ConnectorProvider[], id: ConnectorConnection["provider"]) {
  return providers.find((provider) => provider.id === id)?.label ?? id;
}

function stateLabel(state: ConnectorConnection["state"]) {
  return {
    connecting: "Connecting",
    connected: "Connected",
    paused: "Paused",
    error: "Needs attention",
    revoked: "Disconnected",
  }[state];
}

function IntegrationMark({ provider }: { provider: string }) {
  return (
    <span className={`integration-mark mark-${provider}`} aria-hidden="true">
      <svg
        width="26"
        height="26"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {provider === "gmail" ? (
          <>
            <path d="M3 18V6l9 7 9-7v12" />
            <path d="m3 6 9 7 9-7" />
          </>
        ) : provider === "google-calendar" ? (
          <>
            <rect x="4" y="5" width="16" height="16" rx="3" />
            <path d="M8 3v4m8-4v4M4 11h16m-11 5h6" />
          </>
        ) : provider === "plaid" ? (
          <>
            <path d="m12 2 10 10-10 10L2 12Z" />
            <path d="m7 7 10 10M7 17 17 7M7 2l15 15M2 7l15 15" />
          </>
        ) : (
          <>
            <rect x="3" y="3" width="7" height="7" rx="2" />
            <rect x="14" y="14" width="7" height="7" rx="2" />
            <path d="M14 6h2a2 2 0 0 1 2 2v2M10 18H8a2 2 0 0 1-2-2v-2" />
          </>
        )}
      </svg>
    </span>
  );
}
