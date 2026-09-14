import { useEffect, useState } from "react";
import { api, type ConnectorConnection, type ConnectorMode, type ConnectorProvider } from "./api";

export function Connections() {
  const [connections, setConnections] = useState<ConnectorConnection[]>([]);
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [connectMode, setConnectMode] = useState<ConnectorMode>("prepare");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [pending, setPending] = useState<{
    provider: ConnectorProvider["id"];
    authorizationUrl?: string;
    openedExternally: boolean;
  } | null>(null);

  const load = async () => {
    const value = await api.connections.list();
    setConnections(value.connections);
    setProviders(value.providers);
    setPending((current) =>
      current &&
      value.connections.some(
        (connection) =>
          connection.provider === current.provider && connection.state === "connected",
      )
        ? null
        : current,
    );
  };
  useEffect(() => {
    let current = true;
    let loading = false;
    const refresh = async () => {
      if (loading || document.visibilityState !== "visible") return;
      loading = true;
      try {
        const value = await api.connections.list();
        if (!current) return;
        setConnections(value.connections);
        setProviders(value.providers);
        setPending((pendingConnection) =>
          pendingConnection &&
          value.connections.some(
            (connection) =>
              connection.provider === pendingConnection.provider &&
              connection.state === "connected",
          )
            ? null
            : pendingConnection,
        );
      } catch (caught) {
        if (current)
          setError(
            caught instanceof Error ? caught.message : "Connected accounts are unavailable.",
          );
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, []);

  const run = async (key: string, operation: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await operation();
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The connected account could not be updated.",
      );
    } finally {
      setBusy("");
    }
  };
  const connect = async (provider: ConnectorProvider) => {
    setBusy(`connect:${provider.id}`);
    setError("");
    setCopyStatus("");
    try {
      const value = await api.connections.start(provider.id, connectMode),
        target = new URL(value.authorizationUrl, location.origin);
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
        ...(value.openedExternally ? {} : { authorizationUrl: target.href }),
        openedExternally: value.openedExternally === true,
      });
      setBusy("");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The account connection could not start.",
      );
      setBusy("");
    }
  };

  return (
    <section className="connections">
      <header>
        <div>
          <span>Private connections</span>
          <h2>Connected accounts</h2>
        </div>
      </header>
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
        </div>
      )}
      {connections.length > 0 && (
        <div className="connection-list">
          {connections.map((connection) => (
            <article key={connection.id}>
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
              <div>
                <strong>{provider.label}</strong>
                <small>
                  {provider.configured
                    ? "Ready for a private read-only connection"
                    : (provider.setupMessage ?? "Setup is required on this Ellie host.")}
                </small>
              </div>
              <button
                disabled={!provider.configured || busy !== ""}
                title={!provider.configured ? provider.setupMessage : undefined}
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
      {providers.length === 0 && !error && (
        <p className="connection-empty">No providers are configured.</p>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
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
