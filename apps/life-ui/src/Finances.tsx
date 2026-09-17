import { useEffect, useRef, useState } from "react";
import { api, type ConnectorConnection } from "./api";
import type { Bootstrap, LifeRecord } from "./types";
import { financialInsights } from "./financial-insights";
import { InterfaceIcon } from "./InterfaceIcon";

export function Finances({
  data,
  openIntegrations,
  ask,
  openPersonal,
}: {
  data: Bootstrap;
  openIntegrations: () => void;
  ask: (draft: string) => void;
  openPersonal: () => void;
}) {
  const [connections, setConnections] = useState<ConnectorConnection[]>([]);
  const [verifiedRecords, setVerifiedRecords] = useState<LifeRecord[]>([]);
  const [insightError, setInsightError] = useState("");
  const recordsRef = useRef(data.records);
  recordsRef.current = data.records;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const personal = data.scope === `user:${data.profile.id}`;
  useEffect(() => {
    if (!personal) return;
    let current = true;
    let pending = false;
    setLoading(true);
    setConnections([]);
    setVerifiedRecords([]);
    setInsightError("");
    setError("");
    const refresh = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const result = await api.connections.list();
        if (!current) return;
        const financial = result.connections.filter(
          (item) => item.provider === "plaid" && item.state !== "revoked",
        );
        setConnections(financial);
        // Bootstrap summaries omit connected metadata and provenance. Only full,
        // authenticated record details may establish an account-derived insight.
        const candidates = financial.some((item) => item.state === "connected")
          ? recordsRef.current.filter(
              (record) =>
                record.kind === "memory" &&
                record.data.type === "connected-insight-v1" &&
                record.scope.type === "user" &&
                record.scope.id === data.profile.id &&
                record.provenanceStatus !== "needs-review",
            )
          : [];
        const details: LifeRecord[] = [];
        let incomplete = false;
        for (let offset = 0; offset < candidates.length && current; offset += 8) {
          const results = await Promise.allSettled(
            candidates.slice(offset, offset + 8).map((record) => api.record(record.id)),
          );
          for (const detail of results) {
            if (detail.status === "fulfilled") details.push(detail.value);
            else incomplete = true;
          }
        }
        if (current) {
          setVerifiedRecords(details);
          setInsightError(
            incomplete
              ? "Some insights couldn’t be verified and are hidden. They’ll refresh automatically."
              : "",
          );
          setError("");
        }
      } catch (caught) {
        if (current) {
          setConnections([]);
          setVerifiedRecords([]);
          setError(caught instanceof Error ? caught.message : "Accounts couldn’t be loaded.");
        }
      } finally {
        pending = false;
        if (current) setLoading(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [personal, data.profile.id, revision]);
  const insights =
    personal && !loading && !error
      ? financialInsights(verifiedRecords, connections, data.profile.id)
      : [];
  const connected = connections.filter((item) => item.state === "connected");
  return (
    <section className="page finance-page">
      <div className="page-title">
        <h1>Finances</h1>
        <p>A clearer view of your money, with a little help from Ellie.</p>
      </div>
      {!personal ? (
        <div className="finance-empty">
          <InterfaceIcon name="finances" />
          <h2>A space just for you</h2>
          <p>Financial accounts and insights belong in your personal space.</p>
          <button className="primary" onClick={openPersonal}>
            Open personal finances
          </button>
        </div>
      ) : (
        <>
          <section className="finance-overview" aria-label="Financial overview">
            <div className="finance-overview-top">
              <span className="finance-symbol">
                <InterfaceIcon name="finances" />
              </span>
              <span className="finance-read-only">Read-only</span>
            </div>
            <h2>
              Your money.
              <br />A little more clarity.
            </h2>
            <p>Keep your financial accounts and the patterns worth noticing in one place.</p>
            <button onClick={openIntegrations}>
              {connected.length ? "Manage accounts" : "Explore integrations"}
              <InterfaceIcon name="arrow" />
            </button>
            <span className="finance-orbit" aria-hidden="true" />
          </section>
          <div className="finance-section-title">
            <h2>Your accounts</h2>
            <span>Via Plaid</span>
          </div>
          {loading ? (
            <p className="finance-notice" role="status">
              Loading financial accounts…
            </p>
          ) : error ? (
            <div className="finance-notice" role="alert">
              <p>{error}</p>
              <button onClick={() => setRevision((value) => value + 1)}>Try again</button>
            </div>
          ) : connections.length ? (
            <div className="finance-accounts">
              {connections.map((connection) => (
                <article key={connection.id}>
                  <span className="finance-account-icon">
                    <InterfaceIcon name="finances" />
                  </span>
                  <div>
                    <h3>{connection.label}</h3>
                    <p>
                      {connection.lastSyncAt
                        ? `Updated ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: data.profile.timeZone }).format(connection.lastSyncAt)}`
                        : "Waiting for the first sync"}
                    </p>
                    {connection.error && (
                      <p className="finance-account-error">{connection.error}</p>
                    )}
                  </div>
                  <span className={`finance-account-state state-${connection.state}`}>
                    {connection.state === "connected"
                      ? "Connected"
                      : connection.state === "error"
                        ? "Needs attention"
                        : connection.state === "paused"
                          ? "Paused"
                          : "Connecting"}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <div className="finance-empty">
              <h3>No financial accounts yet</h3>
              <p>Visit Integrations to see financial connection availability.</p>
              <button onClick={openIntegrations}>
                View integrations <InterfaceIcon name="arrow" />
              </button>
            </div>
          )}
          <div className="finance-section-title">
            <h2>Worth a look</h2>
            <span>From your accounts</span>
          </div>
          {insightError && (
            <p className="finance-notice" role="status">
              {insightError}
            </p>
          )}
          {insights.length ? (
            <div className="finance-insights">
              {insights.map((insight) => (
                <article key={insight.id}>
                  <span className="finance-insight-label">
                    <InterfaceIcon name="chat" /> Ellie noticed
                  </span>
                  <h3>{insight.title}</h3>
                  <details>
                    <summary>About this insight</summary>
                    <p>
                      {insight.body ||
                        "Inferred from connected account activity. Review the source account before making a decision."}
                    </p>
                  </details>
                  <button
                    onClick={() =>
                      ask(`Help me understand this financial insight: ${insight.title}`)
                    }
                  >
                    Ask Ellie <InterfaceIcon name="arrow" />
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <div className="finance-empty">
              <InterfaceIcon name="chat" />
              <h3>{loading ? "Checking for insights" : "Room for a clearer picture"}</h3>
              <p>
                {error
                  ? "Reconnect to see current financial insights."
                  : "Current patterns from your connected accounts will appear here when available."}
              </p>
            </div>
          )}
          <p className="finance-footnote">
            Account balances and a full transaction history aren’t available here yet.
          </p>
        </>
      )}
    </section>
  );
}
