import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, establishSessionFromFragment, parsePluginBridgeRequest } from "./api";
import type { Bootstrap, LifeRecord, PluginSummary, TeachingGuide, TeachingSource } from "./types";
import { agendaDate, compareAgenda, dateValue, dayHeading, dayKey, friendlyDay } from "./dates";

type View = "chat" | "today" | "world" | "space" | "activity" | "settings";
type Message = {
  role: "you" | "ellie";
  text: string;
  prompt?: string;
  actions?: { label: string; status: string }[];
};
const icons: Record<View, string> = {
  chat: "✦",
  today: "◷",
  world: "⌾",
  space: "◇",
  activity: "↻",
  settings: "⚙",
};
const labels: Record<View, string> = {
  chat: "Ellie",
  today: "Today",
  world: "Your world",
  space: "Your space",
  activity: "Activity",
  settings: "Settings",
};
const timedKinds = new Set(["reminder", "timer", "event", "birthday", "holiday"]);
const needsSourceReview = (record: LifeRecord) =>
  record.provenanceStatus === "needs-review" ||
  record.provenance?.some((item) => item.invalidatedAt !== undefined) === true;
const taskTitle = (task: { title: string }) =>
  task.title === "knowledge.aggregate"
    ? "Background source summary"
    : task.title === "knowledge.summarize-source"
      ? "Summarize source"
      : task.title;
const friendly = (value: string, zone?: string) => {
  const date = /^\d{10,}$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: zone,
      }).format(date);
};

export function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [view, setView] = useState<View>("chat"),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [busy, setBusy] = useState(""),
    [messages, setMessages] = useState<Message[]>([]),
    [conversation, setConversation] = useState<string>(),
    [expanded, setExpanded] = useState<PluginSummary | null>(null);
  const [notice, setNotice] = useState("");
  const scopeGeneration = useRef(0);
  const desiredScope = useRef("");
  const requestEpoch = useRef(0);
  const refreshRunning = useRef(false);
  const loadRef = useRef<(scope?: string, quiet?: boolean) => Promise<void>>(async () => {});
  const load = async (scope?: string, quiet = false) => {
    const epoch = ++requestEpoch.current;
    if (!quiet) setError("");
    try {
      const next = await api.bootstrap(scope);
      if (!desiredScope.current) desiredScope.current = next.scope;
      if (epoch === requestEpoch.current && next.scope === desiredScope.current) setData(next);
    } catch (e) {
      if (epoch !== requestEpoch.current) return;
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setAuth(true);
      else if (!quiet) setError(e instanceof Error ? e.message : "Ellie could not load your day.");
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  };
  loadRef.current = load;
  useEffect(() => {
    void (async () => {
      try {
        await establishSessionFromFragment();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That sign-in link did not work.");
      }
      await load();
    })();
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 3500);
    return () => clearTimeout(id);
  }, [notice]);
  const scope = data?.scope ?? "";
  useEffect(() => {
    if (!scope) return;
    const refresh = async () => {
      if (document.visibilityState !== "visible" || refreshRunning.current) return;
      refreshRunning.current = true;
      try {
        await loadRef.current(desiredScope.current, true);
      } finally {
        refreshRunning.current = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [scope]);
  const scopeOptions = useMemo(
    () =>
      data
        ? [
            { id: `user:${data.profile.id}`, name: "Just me" },
            ...data.groups.map((g) => ({ id: `group:${g.id}`, name: g.name })),
          ]
        : [],
    [data],
  );
  async function send(message: string) {
    if (!message.trim() || !data) return;
    const generation = scopeGeneration.current;
    setMessages((m) => [...m, { role: "you", text: message.trim() }]);
    setBusy("chat");
    try {
      const r = await api.chat(message.trim(), scope, conversation);
      if (generation !== scopeGeneration.current) return;
      setConversation(r.conversationId);
      setMessages((m) => [
        ...m,
        { role: "ellie", text: r.reply, prompt: message.trim(), actions: r.actions },
      ]);
      await load(scope);
    } catch (e) {
      if (generation === scopeGeneration.current)
        setError(e instanceof Error ? e.message : "Ellie could not send that message.");
    } finally {
      if (generation === scopeGeneration.current) setBusy("");
    }
  }
  async function taskAction(id: string, action: "pause" | "resume" | "cancel" | "run") {
    const generation = scopeGeneration.current;
    setBusy(id);
    try {
      await api.task(id, action);
      setNotice(action === "run" ? "Started" : "Activity updated");
      if (generation === scopeGeneration.current) await load(desiredScope.current);
    } catch (e) {
      if (generation === scopeGeneration.current)
        setError(e instanceof Error ? e.message : "Activity could not be updated.");
    } finally {
      if (generation === scopeGeneration.current) setBusy("");
    }
  }
  if (loading)
    return <State title="Opening your day" body="Ellie is gathering what matters now." pulse />;
  if (auth)
    return (
      <State
        title="This link isn’t signed in"
        body="Reopen the private link printed by the Ellie CLI. It contains a short-lived sign-in token."
      />
    );
  if (!data)
    return (
      <State
        title="Ellie couldn’t open"
        body={error || "The life service did not return a profile."}
        action={
          <button
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Try again
          </button>
        }
      />
    );
  return (
    <div className="shell">
      <aside>
        <Brand />
        <nav aria-label="Main navigation">
          {(["chat", "today", "world", "space", "activity"] as View[]).map((v) => (
            <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
              <span>{icons[v]}</span>
              {labels[v]}
              {v === "activity" && data.tasks.length > 0 ? <b>{data.tasks.length}</b> : null}
            </button>
          ))}
        </nav>
        <div className="scope">
          <label htmlFor="scope">Sharing with</label>
          <select
            id="scope"
            value={scope}
            onChange={(e) => {
              scopeGeneration.current += 1;
              desiredScope.current = e.target.value;
              setMessages([]);
              setConversation(undefined);
              setLoading(true);
              void load(e.target.value);
            }}
          >
            {scopeOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button className="settings-link" onClick={() => setView("settings")}>
          {icons.settings} Settings
        </button>
      </aside>
      <main>
        <header className="mobile-head">
          <Brand />
          <button onClick={() => setView("settings")} aria-label="Settings">
            ⚙
          </button>
        </header>
        {error && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            {notice}
          </div>
        )}
        {view === "chat" && (
          <Chat
            name={data.profile.name}
            messages={messages}
            records={data.agendaRecords ?? data.records}
            timeZone={data.profile.timeZone}
            scope={scope}
            busy={busy === "chat"}
            send={send}
          />
        )}{" "}
        {view === "today" && <Today data={data} refresh={() => load(scope)} notify={setNotice} />}{" "}
        {view === "world" && <World data={data} refresh={() => load(scope)} notify={setNotice} />}{" "}
        {view === "space" && (
          <Space
            plugins={data.plugins}
            open={setExpanded}
            changed={async (message) => {
              setNotice(message);
              await load(desiredScope.current);
            }}
            build={async (r) => {
              const generation = scopeGeneration.current;
              setBusy("build");
              try {
                await api.buildPlugin(r, scope);
                if (generation !== scopeGeneration.current) return;
                setNotice("Ellie started building it");
                await load(desiredScope.current);
              } catch (error) {
                if (generation === scopeGeneration.current)
                  setError(
                    error instanceof Error ? error.message : "Ellie could not start that build.",
                  );
              } finally {
                if (generation === scopeGeneration.current) setBusy("");
              }
            }}
            busy={busy === "build"}
          />
        )}{" "}
        {view === "activity" && <Activity data={data} busy={busy} act={taskAction} />}{" "}
        {view === "settings" && (
          <Settings
            data={data}
            save={async (settingsScope, values) => {
              const generation = scopeGeneration.current;
              setBusy("settings");
              try {
                await api.settings(settingsScope, values);
                if (generation !== scopeGeneration.current) return;
                setNotice("Settings saved");
                await load(desiredScope.current);
              } catch (error) {
                if (generation === scopeGeneration.current)
                  setError(error instanceof Error ? error.message : "Settings could not be saved.");
              } finally {
                if (generation === scopeGeneration.current) setBusy("");
              }
            }}
            busy={busy === "settings"}
          />
        )}{" "}
      </main>
      <nav className="bottom" aria-label="Main navigation">
        {(["chat", "today", "world", "space", "activity"] as View[]).map((v) => (
          <button key={v} className={view === v ? "active" : ""} onClick={() => setView(v)}>
            <span>{icons[v]}</span>
            {labels[v].replace("Your ", "")}
          </button>
        ))}
      </nav>
      {expanded && (
        <PluginModal
          plugin={expanded}
          close={() => {
            setExpanded(null);
            void load(scope, true);
          }}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span aria-hidden>e</span>
      <strong>Ellie</strong>
    </div>
  );
}
function State(p: { title: string; body: string; pulse?: boolean; action?: React.ReactNode }) {
  return (
    <div className="state">
      <Brand />
      <div className={p.pulse ? "orb pulse" : "orb"}>e</div>
      <h1>{p.title}</h1>
      <p>{p.body}</p>
      {p.action}
    </div>
  );
}
function Page({
  title,
  lede,
  children,
}: {
  title: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <section className="page">
      <div className="page-title">
        <h1>{title}</h1>
        <p>{lede}</p>
      </div>
      {children}
    </section>
  );
}
function Composer({
  onSend,
  busy,
  placeholder = "Tell Ellie what’s on your mind",
}: {
  onSend: (s: string) => void;
  busy: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onSend(text);
      setText("");
    }
  };
  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        aria-label="Message Ellie"
        rows={1}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <button disabled={busy || !text.trim()} aria-label="Send message">
        {busy ? "…" : "↑"}
      </button>
    </form>
  );
}
function Chat({
  name,
  messages,
  records,
  timeZone,
  scope,
  busy,
  send,
}: {
  name: string;
  messages: Message[];
  records: LifeRecord[];
  timeZone: string;
  scope: string;
  busy: boolean;
  send: (s: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);
  const upcoming = records
    .map((record) => ({
      record,
      when: agendaDate(record, timeZone),
    }))
    .filter(
      (item): item is { record: LifeRecord; when: { value: string | number; allDay: boolean } } =>
        Boolean(item.when),
    )
    .sort((a, b) => compareAgenda(a, b, timeZone))
    .slice(0, 2);
  return (
    <section className="conversation">
      <div className="hello">
        <span className="ellie-mark">e</span>
        <h1>{messages.length ? "I’m here." : `Hi ${name}. What shall we carry forward?`}</h1>
        {messages.length === 0 && (
          <>
            <p>Teach me something, make a plan, or ask what needs your attention.</p>
            <div className="suggestions">
              {["What should I know today?", "Remember a preference", "Help me plan something"].map(
                (x) => (
                  <button key={x} onClick={() => send(x)}>
                    {x}
                  </button>
                ),
              )}
            </div>
            {upcoming.length > 0 && (
              <div className="glance">
                <span>On the horizon</span>
                {upcoming.map(({ record, when }) => (
                  <div key={record.id}>
                    <strong>{record.title}</strong>
                    <small>
                      {when.allDay ? friendlyDay(when.value) : friendly(String(when.value))}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="messages" aria-live="polite">
        {messages.map((m, i) => (
          <article key={i} className={m.role}>
            <span>{m.role === "ellie" ? "e" : "You"}</span>
            <div>
              <p>{m.text}</p>
              {m.actions?.map((a, j) => (
                <small key={j}>
                  {a.label}: {a.status}
                </small>
              ))}
              {m.role === "ellie" && m.prompt && (
                <ResponseFeedback scope={scope} prompt={m.prompt} response={m.text} />
              )}
            </div>
          </article>
        ))}
        {busy && (
          <article className="ellie">
            <span>e</span>
            <div className="typing">● ● ●</div>
          </article>
        )}
        <div ref={end} />
      </div>
      <Composer onSend={send} busy={busy} />
    </section>
  );
}
function ResponseFeedback({
  scope,
  prompt,
  response,
}: {
  scope: string;
  prompt: string;
  response: string;
}) {
  const [mode, setMode] = useState<"idle" | "correct" | "sent">("idle"),
    [correction, setCorrection] = useState("");
  const record = async (rating: -1 | 1) => {
    await api.learning.record({
      scope,
      message:
        rating === 1
          ? "This response was helpful."
          : correction.trim() || "This response needs work.",
      rating,
      example: {
        prompt,
        response,
        ...(correction.trim() ? { preferredResponse: correction.trim() } : {}),
      },
      trainingEligible: false,
    });
    setMode("sent");
  };
  if (mode === "sent") return <span className="feedback-sent">Feedback saved for evaluation.</span>;
  return (
    <div className="response-feedback">
      <button onClick={() => void record(1)}>Helpful</button>
      <button onClick={() => setMode("correct")}>Needs work</button>
      {mode === "correct" && (
        <div>
          <textarea
            aria-label="How should Ellie respond instead?"
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="Optional: what would have been better?"
          />
          <button onClick={() => void record(-1)}>Save feedback</button>
        </div>
      )}
    </div>
  );
}
function Today({
  data,
  refresh,
  notify,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (value: string) => void;
}) {
  const baseAgenda = data.agendaRecords ?? data.records;
  const [agendaExtras, setAgendaExtras] = useState<LifeRecord[]>([]),
    [agendaPage, setAgendaPage] = useState(data.agendaPage),
    [loadingAgenda, setLoadingAgenda] = useState(false),
    [agendaError, setAgendaError] = useState("");
  const agendaScope = useRef(data.scope);
  agendaScope.current = data.scope;
  useEffect(() => {
    setAgendaExtras([]);
    setAgendaPage(data.agendaPage);
    setAgendaError("");
  }, [data.scope]);
  const allAgenda = [...baseAgenda, ...agendaExtras];
  const byId = new Map(data.records.map((record) => [record.id, record]));
  const entries = allAgenda
    .filter((record) => {
      if (!timedKinds.has(record.kind)) return false;
      if (record.data.completed === true || record.data.cancelled === true) return false;
      if (record.kind === "event" && record.data.type === "notification") return false;
      if (record.relatedCompleted) return false;
      return !record.relationships?.some((relation) => {
        if (relation.type !== "need") return false;
        const need = byId.get(relation.targetId);
        return need?.data.completed === true || need?.data.cancelled === true;
      });
    })
    .map((record) => ({ record, when: agendaDate(record, data.profile.timeZone) }))
    .filter(
      (
        item,
      ): item is {
        record: LifeRecord;
        when: { value: string | number; allDay: boolean };
      } => Boolean(item.when),
    )
    .sort((a, b) => compareAgenda(a, b, data.profile.timeZone));
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const key = dayKey(entry.when.value, data.profile.timeZone);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const notificationAction = async (
    id: string,
    action: "dismiss" | "complete",
    revision: number,
  ) => {
    try {
      await api.notification(id, action, revision);
      notify(action === "complete" ? "Marked complete" : "Dismissed");
      await refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "Notification could not be updated.");
    }
  };
  return (
    <Page title="Today" lede="Commitments, preparation, and the few things worth seeing now.">
      {data.notifications.length > 0 && (
        <div className="inbox" aria-label="Notifications">
          {data.notifications.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.title}</strong>
                {item.body && <p>{item.body}</p>}
              </div>
              <button onClick={() => void notificationAction(item.id, "complete", item.revision)}>
                Complete
              </button>
              <button onClick={() => void notificationAction(item.id, "dismiss", item.revision)}>
                Dismiss
              </button>
            </article>
          ))}
        </div>
      )}
      {entries.length ? (
        [...groups.entries()].map(([key, items], groupIndex) => (
          <section
            className="agenda-day"
            key={key}
            aria-label={friendlyDay(items[0]!.when.value, data.profile.timeZone)}
          >
            <div className="date-rule">
              <span>{dayHeading(items[0]!.when.value, data.profile.timeZone)}</span>
              <strong>{Number(key.slice(-2))}</strong>
            </div>
            <div className="timeline">
              {items.map(({ record, when }, itemIndex) => (
                <article key={record.id}>
                  <time>
                    {when.allDay ? "All day" : friendly(String(when.value), data.profile.timeZone)}
                  </time>
                  <i />
                  <div>
                    <span>{record.kind}</span>
                    <h2>{record.title}</h2>
                    {(record.bodyPreview || record.body) && (
                      <p>{record.bodyPreview || record.body}</p>
                    )}
                    {needsSourceReview(record) && (
                      <strong className="source-warning">Source changed — review needed</strong>
                    )}
                  </div>
                  {groupIndex === 0 && itemIndex === 0 && <em>next</em>}
                </article>
              ))}
            </div>
          </section>
        ))
      ) : (
        <Empty
          title="A clear day"
          body="Tell Ellie about a commitment or reminder and it will appear here."
        />
      )}
      {agendaError && (
        <p className="settings-error" role="alert">
          {agendaError}
        </p>
      )}
      {agendaPage?.hasMore && (
        <button
          className="load-more"
          disabled={loadingAgenda}
          onClick={async () => {
            if (!agendaPage.nextCursor) return;
            const requestedScope = data.scope;
            setLoadingAgenda(true);
            setAgendaError("");
            try {
              const next = await api.records(requestedScope, {
                cursor: agendaPage.nextCursor,
                kinds: ["reminder", "timer", "event", "birthday", "holiday"],
              });
              if (agendaScope.current !== requestedScope) return;
              setAgendaExtras((current) => [
                ...current,
                ...next.records.filter(
                  (record) =>
                    !baseAgenda.some((existing) => existing.id === record.id) &&
                    !current.some((existing) => existing.id === record.id),
                ),
              ]);
              setAgendaPage(next.page);
            } catch (error) {
              if (agendaScope.current === requestedScope)
                setAgendaError(
                  error instanceof Error ? error.message : "More commitments could not be loaded.",
                );
            } finally {
              if (agendaScope.current === requestedScope) setLoadingAgenda(false);
            }
          }}
        >
          {loadingAgenda ? "Loading…" : "Load more commitments"}
        </button>
      )}
    </Page>
  );
}
function World({
  data,
  refresh,
  notify,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
}) {
  const [tab, setTab] = useState("all"),
    [editing, setEditing] = useState<LifeRecord | null>(null),
    [extras, setExtras] = useState<LifeRecord[]>([]),
    [page, setPage] = useState(data.recordsPage),
    [query, setQuery] = useState(""),
    [searchResults, setSearchResults] = useState<
      Awaited<ReturnType<typeof api.search>>["results"] | null
    >(null),
    [loadingRecords, setLoadingRecords] = useState(false),
    [recordError, setRecordError] = useState("");
  const worldScope = useRef(data.scope);
  worldScope.current = data.scope;
  useEffect(() => {
    setExtras([]);
    setPage(data.recordsPage);
    setQuery("");
    setSearchResults(null);
    setEditing(null);
  }, [data.scope]);
  const groups = ["all", "memory", "contact", "need", "source", "guidance"];
  const records = [...data.records, ...extras].filter(
    (r) =>
      !(r.kind === "routine" && r.data.type === "teaching-guide-v1") &&
      (tab === "all" || r.kind === tab),
  );
  const openRecord = async (id: string) => {
    const requestedScope = data.scope;
    setLoadingRecords(true);
    setRecordError("");
    try {
      const detail = await api.record(id);
      if (worldScope.current === requestedScope) setEditing(detail);
    } catch (error) {
      if (worldScope.current === requestedScope)
        setRecordError(error instanceof Error ? error.message : "That detail could not be loaded.");
    } finally {
      if (worldScope.current === requestedScope) setLoadingRecords(false);
    }
  };
  return (
    <Page title="Your world" lede="What Ellie knows, where it came from, and who can see it.">
      <div className="tabs">
        {groups.map((g) => (
          <button key={g} className={tab === g ? "active" : ""} onClick={() => setTab(g)}>
            {g}
          </button>
        ))}
      </div>
      <form
        className="record-search"
        onSubmit={async (event) => {
          event.preventDefault();
          const requestedScope = data.scope;
          setLoadingRecords(true);
          setRecordError("");
          try {
            if (!query.trim()) setSearchResults(null);
            else {
              const results = (await api.search(requestedScope, query.trim())).results;
              if (worldScope.current === requestedScope) setSearchResults(results);
            }
          } catch (error) {
            if (worldScope.current === requestedScope)
              setRecordError(
                error instanceof Error ? error.message : "Search could not be completed.",
              );
          } finally {
            if (worldScope.current === requestedScope) setLoadingRecords(false);
          }
        }}
      >
        <input
          aria-label="Search your world"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memories, people, and sources"
        />
        <button disabled={loadingRecords}>{loadingRecords ? "Looking…" : "Search"}</button>
        {searchResults && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSearchResults(null);
            }}
          >
            Clear
          </button>
        )}
      </form>
      {recordError && (
        <p className="settings-error" role="alert">
          {recordError}
        </p>
      )}
      {tab === "guidance" ? (
        <Guidance data={data} refresh={refresh} notify={notify} />
      ) : searchResults ? (
        searchResults.length ? (
          <div className="record-list search-results">
            {searchResults.map((result, index) => (
              <button
                key={`${result.sourceId}:${result.reference ?? index}`}
                onClick={() => void openRecord(result.sourceId)}
              >
                <span className="kind">s</span>
                <span>
                  <strong>{result.sourceTitle}</strong>
                  <small>{result.text}</small>
                  {result.reference && <em>{result.reference}</em>}
                </span>
                <em>Source</em>
              </button>
            ))}
          </div>
        ) : (
          <Empty title="Nothing matched" body="Try a name or a distinctive phrase from a source." />
        )
      ) : records.length ? (
        <div className="record-list">
          {records.map((r) => (
            <button key={r.id} onClick={() => void openRecord(r.id)}>
              <span className="kind">{r.kind.slice(0, 1)}</span>
              <span>
                <strong>{r.title}</strong>
                <small>
                  {needsSourceReview(r)
                    ? "Source changed — review needed"
                    : r.bodyPreview || r.body || `Updated ${friendly(r.updatedAt)}`}
                </small>
              </span>
              <em>{r.scope.type === "user" ? "Private" : "Shared"}</em>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title={`No ${tab === "all" ? "saved details" : `${tab} records`} yet`}
          body="You can teach Ellie in chat or add a source below."
        />
      )}
      {tab !== "guidance" && !searchResults && page?.hasMore && (
        <button
          className="load-more"
          disabled={loadingRecords}
          onClick={async () => {
            if (!page.nextCursor) return;
            const requestedScope = data.scope;
            setLoadingRecords(true);
            try {
              const next = await api.records(requestedScope, { cursor: page.nextCursor });
              if (worldScope.current !== requestedScope) return;
              setExtras((current) => [
                ...current,
                ...next.records.filter(
                  (record) =>
                    !data.records.some((existing) => existing.id === record.id) &&
                    !current.some((existing) => existing.id === record.id),
                ),
              ]);
              setPage(next.page);
            } catch (error) {
              if (worldScope.current === requestedScope)
                setRecordError(
                  error instanceof Error ? error.message : "More records could not be loaded.",
                );
            } finally {
              if (worldScope.current === requestedScope) setLoadingRecords(false);
            }
          }}
        >
          {loadingRecords ? "Loading…" : "Load more"}
        </button>
      )}
      {tab !== "guidance" && (
        <SourceUpload
          scope={data.scope}
          done={async () => {
            notify("Source added");
            await refresh();
          }}
        />
      )}
      {editing && (
        <RecordModal
          record={editing}
          close={() => setEditing(null)}
          saved={async () => {
            setEditing(null);
            notify("Record updated");
            await refresh();
          }}
        />
      )}
    </Page>
  );
}
function Guidance({
  data,
  refresh,
  notify,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [guides, setGuides] = useState<TeachingGuide[]>([]);
  const [selected, setSelected] = useState<TeachingGuide | null>(null);
  const [selectedSources, setSelectedSources] = useState<LifeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const scopeRef = useRef(data.scope);
  scopeRef.current = data.scope;
  const load = async () => {
    const scope = data.scope;
    setLoading(true);
    setError("");
    try {
      const result = await api.teaching.list(scope);
      if (scopeRef.current === scope) setGuides(result.guides);
    } catch (caught) {
      if (scopeRef.current === scope)
        setError(caught instanceof Error ? caught.message : "Guidance could not be loaded.");
    } finally {
      if (scopeRef.current === scope) setLoading(false);
    }
  };
  useEffect(() => {
    setSelected(null);
    setSelectedSources([]);
    void load();
  }, [data.scope]);
  const open = async (id: string) => {
    const scope = data.scope;
    setLoading(true);
    try {
      const detail = await api.teaching.detail(id);
      const sourceIds = [
        ...new Set(
          detail.versions.flatMap((version) => version.sources.map((source) => source.id)),
        ),
      ];
      const sourceDetails = (
        await Promise.allSettled(sourceIds.map((sourceId) => api.record(sourceId)))
      ).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (scopeRef.current === scope) {
        setSelected(detail);
        setSelectedSources(sourceDetails);
      }
    } catch (caught) {
      if (scopeRef.current === scope)
        setError(caught instanceof Error ? caught.message : "That guide could not be opened.");
    } finally {
      if (scopeRef.current === scope) setLoading(false);
    }
  };
  return (
    <section className="guidance">
      <header>
        <div>
          <h2>Guidance Ellie follows</h2>
          <p>
            Versioned instructions you deliberately adopted. A changed source pauses trust until you
            review it.
          </p>
        </div>
      </header>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {loading && !guides.length ? (
        <p className="muted">Loading guidance…</p>
      ) : guides.length ? (
        <div className="guide-list">
          {guides.map((guide) => (
            <button key={guide.record.id} onClick={() => void open(guide.record.id)}>
              <span className={`guide-status ${guide.status}`} aria-hidden="true" />
              <span>
                <strong>{guide.record.title}</strong>
                <small>
                  Version {guide.version} ·{" "}
                  {guide.status === "source-changed"
                    ? "Source changed — review needed"
                    : guide.enabled
                      ? "Active"
                      : "Paused"}
                </small>
              </span>
              <em>Inspect</em>
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="No adopted guidance"
          body="Ask Ellie to follow a source or instruction and it will appear here for review."
        />
      )}
      {selected && (
        <GuidanceModal
          guide={selected}
          currentSources={[
            ...selectedSources,
            ...data.records.filter(
              (record) =>
                record.kind === "source" &&
                !selectedSources.some((source) => source.id === record.id),
            ),
          ]}
          close={() => setSelected(null)}
          changed={async (message) => {
            setSelected(null);
            notify(message);
            await Promise.all([load(), refresh()]);
          }}
        />
      )}
    </section>
  );
}

function GuidanceModal({
  guide,
  currentSources,
  close,
  changed,
}: {
  guide: TeachingGuide;
  currentSources: LifeRecord[];
  close: () => void;
  changed: (message: string) => Promise<void>;
}) {
  const [instructions, setInstructions] = useState(guide.record.body ?? "");
  const [sources, setSources] = useState<Set<string>>(
    new Set(
      guide.status === "source-changed"
        ? []
        : (guide.versions.find((version) => version.version === guide.version)?.sources ?? []).map(
            (source) => source.id,
          ),
    ),
  );
  const [targetVersion, setTargetVersion] = useState(guide.version);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const mutate = async (label: string, operation: () => Promise<unknown>, notice: string) => {
    setBusy(label);
    setError("");
    try {
      await operation();
      await changed(notice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Guidance could not be updated.");
    } finally {
      setBusy("");
    }
  };
  const chosenSources: TeachingSource[] = currentSources
    .filter((source) => sources.has(source.id))
    .map((source) => ({ id: source.id, revision: source.revision }));
  return (
    <Modal title="Review guidance" close={close}>
      <p className="guide-state">
        <strong>{guide.record.title}</strong>
        <span>
          Version {guide.version} · {guide.status}
        </span>
      </p>
      {guide.status === "source-changed" && (
        <p className="impact">
          A linked source changed. Read the current source and select it below before adopting
          revised instructions.
        </p>
      )}
      <label>
        Explicit instructions
        <textarea
          rows={7}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <fieldset className="source-choices">
        <legend>
          {guide.status === "source-changed"
            ? "Choose current source revisions to review"
            : "Link current sources (optional)"}
        </legend>
        {currentSources.map((source) => (
          <label className="inline-check" key={source.id}>
            <input
              type="checkbox"
              checked={sources.has(source.id)}
              onChange={(event) =>
                setSources((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(source.id);
                  else next.delete(source.id);
                  return next;
                })
              }
            />
            <span>
              {source.title} <small>revision {source.revision}</small>
              {(source.body || source.bodyPreview) && (
                <small className="source-review-copy">
                  {String(source.body || source.bodyPreview).slice(0, 500)}
                  {String(source.body || source.bodyPreview).length > 500 ? "…" : ""}
                </small>
              )}
            </span>
          </label>
        ))}
        {!currentSources.length && (
          <p className="muted">No current sources are visible in this page.</p>
        )}
      </fieldset>
      <div className="modal-actions guide-actions">
        <button
          disabled={!!busy}
          onClick={() =>
            void mutate(
              "enabled",
              () => api.teaching.enabled(guide.record.id, guide.record.revision, !guide.enabled),
              guide.enabled ? "Guidance paused" : "Guidance resumed",
            )
          }
        >
          {guide.enabled ? "Pause" : "Resume"}
        </button>
        <button
          className="primary"
          disabled={
            !!busy ||
            !instructions.trim() ||
            (guide.status === "source-changed" && chosenSources.length === 0)
          }
          onClick={() =>
            void mutate(
              "revise",
              () =>
                api.teaching.revise(
                  guide.record.id,
                  guide.record.revision,
                  instructions.trim(),
                  chosenSources,
                ),
              "Guidance revised",
            )
          }
        >
          {busy === "revise"
            ? "Saving…"
            : guide.status === "source-changed"
              ? "Adopt reviewed revision"
              : "Create new version"}
        </button>
      </div>
      {guide.versions.length > 1 && (
        <div className="guide-history">
          <label>
            Earlier version
            <select
              value={targetVersion}
              onChange={(event) => setTargetVersion(Number(event.target.value))}
            >
              {guide.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  Version {version.version} · {new Date(version.adoptedAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={!!busy || targetVersion === guide.version}
            onClick={() =>
              void mutate(
                "rollback",
                () => api.teaching.rollback(guide.record.id, guide.record.revision, targetVersion),
                "Earlier guidance restored as a new version",
              )
            }
          >
            Restore selected
          </button>
        </div>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
function SourceUpload({ scope, done }: { scope: string; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState<{
    format: "ics" | "vcard";
    content: string;
    fileName: string;
    preview: Awaited<ReturnType<typeof api.import.preview>>;
    selected: Set<string>;
  } | null>(null);
  return (
    <>
      <label className="drop">
        <input
          type="file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            try {
              const importFormat = /\.ics$/i.test(file.name)
                ? "ics"
                : /\.(vcf|vcard)$/i.test(file.name)
                  ? "vcard"
                  : undefined;
              if (importFormat) {
                const content = await file.text(),
                  preview = await api.import.preview({
                    scope,
                    format: importFormat,
                    content,
                    fileName: file.name,
                  });
                setImporting({
                  format: importFormat,
                  content,
                  fileName: file.name,
                  preview,
                  selected: new Set(preview.items.map((item) => item.key)),
                });
                return;
              }
              const binary =
                file.type === "application/pdf" ||
                file.type === "image/png" ||
                file.type === "image/jpeg";
              let content: string;
              if (binary) {
                const source = new Uint8Array(await file.arrayBuffer());
                let encoded = "";
                for (let offset = 0; offset < source.length; offset += 0x8000)
                  encoded += String.fromCharCode(...source.subarray(offset, offset + 0x8000));
                content = btoa(encoded);
              } else content = await file.text();
              await api.source({
                filename: file.name,
                content,
                mimeType: file.type || "text/plain",
                scope,
                ...(binary ? { encoding: "base64" as const } : {}),
              });
              await done();
            } catch (error) {
              setImportError(
                error instanceof Error ? error.message : "The file could not be added.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
        <strong>{busy ? "Teaching Ellie…" : "Teach Ellie from a file"}</strong>
        <span>Choose notes, PDF, image, calendar, or contact files</span>
      </label>
      {importing && (
        <Modal
          title={`Review ${importing.format === "ics" ? "calendar" : "contacts"}`}
          close={() => setImporting(null)}
        >
          <p className="impact">
            Choose what to add. File content is treated as data; warnings show details Ellie could
            not safely infer.
          </p>
          {importing.preview.warnings.map((w) => (
            <p className="import-warning" key={w}>
              {w}
            </p>
          ))}
          <div className="import-items">
            {importing.preview.items.map((item) => (
              <label key={item.key}>
                <input
                  type="checkbox"
                  checked={importing.selected.has(item.key)}
                  onChange={(event) =>
                    setImporting((current) => {
                      if (!current) return current;
                      const selected = new Set(current.selected);
                      if (event.target.checked) selected.add(item.key);
                      else selected.delete(item.key);
                      return { ...current, selected };
                    })
                  }
                />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.kind}</small>
                  {item.warnings.map((w) => (
                    <em key={w}>{w}</em>
                  ))}
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button onClick={() => setImporting(null)}>Cancel</button>
            <button
              className="primary"
              disabled={busy || importing.selected.size === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.import.commit({
                    scope,
                    format: importing.format,
                    content: importing.content,
                    fileName: importing.fileName,
                    selectedKeys: [...importing.selected],
                  });
                  setImporting(null);
                  await done();
                } catch (error) {
                  setImportError(
                    error instanceof Error
                      ? error.message
                      : "The selected items could not be added.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add selected
            </button>
          </div>
          {importError && (
            <p className="settings-error" role="alert">
              {importError}
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
function RecordModal({
  record,
  close,
  saved,
}: {
  record: LifeRecord;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const isGuide = record.kind === "routine" && record.data.type === "teaching-guide-v1";
  const [title, setTitle] = useState(record.title),
    [body, setBody] = useState(record.body ?? ""),
    [busy, setBusy] = useState(false),
    [mutationError, setMutationError] = useState("");
  const mutate = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setMutationError("");
    try {
      await operation();
      await saved();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "The record could not be updated.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        isGuide
          ? "Versioned guidance"
          : record.kind === "source"
            ? "Review source"
            : "Edit what Ellie knows"
      }
      close={close}
    >
      {isGuide ? (
        <>
          <p className="impact">
            Guidance changes create a reviewable version. Open Guidance in Your world to revise,
            pause, or restore it safely.
          </p>
          <div className="modal-actions">
            <button className="primary" onClick={close}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Details
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          {record.kind === "source" && (
            <p className="impact">
              Deleting this source removes its text from search. Memories that cite it remain
              visible but their source is marked unavailable.
            </p>
          )}
          {(["need", "goal", "reminder", "routine"] as string[]).includes(record.kind) &&
            record.data.completed !== true && (
              <button
                className="record-action"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    api.patchRecord(record.id, {
                      expectedRevision: record.revision,
                      data: { ...record.data, completed: true, completedAt: Date.now() },
                    }),
                  )
                }
              >
                Mark complete
              </button>
            )}
          {(["reminder", "timer", "event"] as string[]).includes(record.kind) &&
            record.data.cancelled !== true &&
            record.data.completed !== true && (
              <button
                className="record-action"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    api.patchRecord(record.id, {
                      expectedRevision: record.revision,
                      data: { ...record.data, cancelled: true, cancelledAt: Date.now() },
                    }),
                  )
                }
              >
                Cancel {record.kind}
              </button>
            )}
          <div className="modal-actions">
            <button
              className="danger"
              onClick={() => void mutate(() => api.deleteRecord(record.id, record.revision))}
            >
              {record.kind === "source" ? "Delete source" : "Forget this"}
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void mutate(() =>
                  api.patchRecord(record.id, { title, body, expectedRevision: record.revision }),
                )
              }
            >
              Save changes
            </button>
          </div>
          {mutationError && (
            <p className="settings-error" role="alert">
              {mutationError}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
function Space({
  plugins,
  open,
  changed,
  build,
  busy,
}: {
  plugins: PluginSummary[];
  open: (p: PluginSummary) => void;
  changed: (message: string) => Promise<void>;
  build: (s: string) => Promise<void>;
  busy: boolean;
}) {
  const [idea, setIdea] = useState(""),
    [managed, setManaged] = useState<PluginSummary | null>(null);
  return (
    <Page title="Your space" lede="Useful things Ellie has made for your life.">
      <form
        className="build-strip"
        onSubmit={(e) => {
          e.preventDefault();
          if (idea.trim()) {
            void build(idea);
            setIdea("");
          }
        }}
      >
        <span>◇</span>
        <label>
          What should Ellie build?
          <input
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="A family board, a tiny game, a standings view…"
          />
        </label>
        <button disabled={busy || !idea.trim()}>{busy ? "Starting…" : "Build it"}</button>
      </form>
      {plugins.length ? (
        <div className="plugins">
          {plugins.map((p, i) => (
            <article key={p.id} className={i === 0 ? "featured" : ""}>
              <div>
                <span>{p.kind}</span>
                <small>
                  {p.status} · v{p.version}
                </small>
              </div>
              <h2>{p.name}</h2>
              <p>{p.description}</p>
              <WidgetData plugin={p} />
              <div className="plugin-actions">
                <button onClick={() => open(p)}>Open</button>
                <button onClick={() => setManaged(p)}>Manage</button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="Room to make something"
          body="Describe a small tool or view above. Ellie will show progress in Activity."
        />
      )}
      {managed && (
        <PluginManager
          plugin={managed}
          close={() => setManaged(null)}
          changed={async (message) => {
            setManaged(null);
            await changed(message);
          }}
        />
      )}
    </Page>
  );
}
function WidgetData({ plugin }: { plugin: PluginSummary }) {
  if (plugin.kind === "arcade")
    return (
      <dl className="widget-facts">
        <div>
          <dt>Personal best</dt>
          <dd>{typeof plugin.data.highScore === "number" ? plugin.data.highScore : 0}</dd>
        </div>
      </dl>
    );
  if (plugin.kind !== "mlb") return null;
  const snapshot =
    plugin.data.snapshot && typeof plugin.data.snapshot === "object"
      ? (plugin.data.snapshot as Record<string, unknown>)
      : undefined;
  const games = Array.isArray(snapshot?.games)
    ? (snapshot.games as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  const divisions = Array.isArray(snapshot?.standings)
    ? (snapshot.standings as Array<Record<string, unknown>>).slice(0, 3)
    : [];
  return (
    <div className="ballpark-summary">
      {typeof snapshot?.error === "string" && (
        <p className="widget-note">Live baseball is temporarily unavailable.</p>
      )}
      <div>
        <h3>Today’s games</h3>
        {games.length ? (
          games.map((game, index) => (
            <p key={String(game.id ?? index)}>
              <strong>{String(game.away ?? "Away")}</strong> at{" "}
              <strong>{String(game.home ?? "Home")}</strong>
              <span>{String(game.status ?? "Scheduled")}</span>
            </p>
          ))
        ) : (
          <p className="widget-note">No games listed today.</p>
        )}
      </div>
      <div>
        <h3>Division leaders</h3>
        {divisions.length ? (
          divisions.map((division, index) => {
            const teams = Array.isArray(division.teams)
              ? (division.teams as Array<Record<string, unknown>>)
              : [];
            const leader = teams[0];
            return leader ? (
              <p key={String(division.division ?? index)}>
                <strong>{String(leader.name ?? "Leader")}</strong>
                <span>
                  {String(leader.wins ?? 0)}–{String(leader.losses ?? 0)}
                </span>
              </p>
            ) : null;
          })
        ) : (
          <p className="widget-note">Standings are not available.</p>
        )}
      </div>
    </div>
  );
}
function PluginManager({
  plugin,
  close,
  changed,
}: {
  plugin: PluginSummary;
  close: () => void;
  changed: (message: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<
      Awaited<ReturnType<typeof api.pluginHistory>>["revisions"]
    >([]),
    [request, setRequest] = useState(""),
    [targetVersion, setTargetVersion] = useState(""),
    [confirmRemove, setConfirmRemove] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api
      .pluginHistory(plugin.id)
      .then((result) => {
        if (active) {
          setHistory(result.revisions);
          const previous = result.revisions.find((revision) => !revision.active);
          setTargetVersion(previous ? String(previous.version) : "");
        }
      })
      .catch(
        (cause) =>
          active &&
          setError(cause instanceof Error ? cause.message : "Revision history could not load."),
      );
    return () => {
      active = false;
    };
  }, [plugin.id]);
  const mutate = async (name: string, operation: () => Promise<unknown>, message: string) => {
    setBusy(name);
    setError("");
    try {
      await operation();
      await changed(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The app could not be updated.");
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal title={`Manage ${plugin.name}`} close={close}>
      <p className="impact">
        Version {plugin.version} is active. Ellie retains recent revisions so you can review or
        restore them.
      </p>
      <label>
        Describe a correction
        <textarea
          rows={4}
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder="Make the score easier to read and keep saved data working."
        />
      </label>
      <button
        className="primary"
        disabled={Boolean(busy) || !request.trim()}
        onClick={() =>
          void mutate(
            "revise",
            () => api.revisePlugin(plugin.id, request.trim(), plugin.version),
            "App revision created",
          )
        }
      >
        {busy === "revise" ? "Revising…" : "Create revision"}
      </button>
      <section className="revision-history">
        <h3>Revision history</h3>
        {history.map((revision) => (
          <p key={revision.version}>
            <strong>
              Version {revision.version}
              {revision.active ? " · active" : ""}
            </strong>
            <span>{revision.description}</span>
          </p>
        ))}
        <div className="rollback-row">
          <select
            aria-label="Revision to restore"
            value={targetVersion}
            onChange={(event) => setTargetVersion(event.target.value)}
          >
            {history
              .filter((revision) => !revision.active)
              .map((revision) => (
                <option key={revision.version} value={revision.version}>
                  Version {revision.version}
                </option>
              ))}
          </select>
          <button
            disabled={Boolean(busy) || !targetVersion}
            onClick={() =>
              void mutate(
                "rollback",
                () => api.rollbackPlugin(plugin.id, plugin.version, Number(targetVersion)),
                `Restored version ${targetVersion} as a new revision`,
              )
            }
          >
            {busy === "rollback" ? "Restoring…" : "Restore selected"}
          </button>
        </div>
      </section>
      <div className="remove-plugin">
        <label className="inline-check">
          <input
            type="checkbox"
            checked={confirmRemove}
            onChange={(event) => setConfirmRemove(event.target.checked)}
          />
          I understand this removes the app and its saved app data.
        </label>
        <button
          className="danger"
          disabled={Boolean(busy) || !confirmRemove}
          onClick={() => void mutate("remove", () => api.deletePlugin(plugin.id), "App removed")}
        >
          {busy === "remove" ? "Removing…" : "Remove app"}
        </button>
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
function PluginModal({ plugin, close }: { plugin: PluginSummary; close: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null),
    channel = useRef<MessageChannel | undefined>(undefined),
    connected = useRef(false);
  useEffect(() => () => channel.current?.port1.close(), []);
  const connect = () => {
    if (connected.current) {
      channel.current?.port1.close();
      channel.current = undefined;
      return;
    }
    connected.current = true;
    channel.current?.port1.close();
    const next = new MessageChannel();
    channel.current = next;
    next.port1.onmessage = async (e) => {
      const value = parsePluginBridgeRequest(e.data);
      if (!value) {
        next.port1.postMessage({
          id: typeof e.data?.id === "string" ? e.data.id : "invalid",
          ok: false,
          error: "Invalid plugin request",
        });
        return;
      }
      try {
        const result = await api.pluginAction(plugin.id, value.method, {
          key: typeof value.key === "string" ? value.key : undefined,
          value: value.value,
        });
        next.port1.postMessage({ id: value.id, ok: true, result });
      } catch (error) {
        next.port1.postMessage({
          id: value.id,
          ok: false,
          error: error instanceof Error ? error.message : "Plugin action failed",
        });
      }
    };
    next.port1.start();
    frame.current?.contentWindow?.postMessage({ type: "ellie:connect", pluginId: plugin.id }, "*", [
      next.port2,
    ]);
  };
  return (
    <Modal title={plugin.name} close={close} wide>
      <iframe
        ref={frame}
        onLoad={connect}
        title={plugin.name}
        src={`/api/life/plugins/${encodeURIComponent(plugin.id)}/view`}
        sandbox="allow-scripts"
      />
    </Modal>
  );
}
function Activity({
  data,
  busy,
  act,
}: {
  data: Bootstrap;
  busy: string;
  act: (id: string, a: "pause" | "resume" | "cancel" | "run") => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof api.taskDetail>> | null>(null);
  const [detailError, setDetailError] = useState("");
  return (
    <Page title="Activity" lede="Work in motion, waiting points, and recent outcomes.">
      {data.tasks.length ? (
        <div className="tasks">
          {data.tasks.map((t) => {
            const permits = (action: "pause" | "resume" | "cancel" | "run") =>
              t.actions
                ? t.actions.includes(action)
                : action === "pause"
                  ? t.status === "running"
                  : action === "resume"
                    ? t.status === "paused"
                    : action === "run"
                      ? t.status === "scheduled"
                      : ["running", "paused", "queued", "scheduled"].includes(t.status);
            return (
              <article key={t.id} data-task-id={t.id}>
                <i className={`status ${t.status}`} />
                <div>
                  <span>{t.status}</span>
                  <h2>{taskTitle(t)}</h2>
                  {t.detail && <p>{t.detail}</p>}
                </div>
                <div>
                  <button
                    onClick={() => {
                      setDetailError("");
                      void api
                        .taskDetail(t.id)
                        .then(setDetail)
                        .catch((cause) =>
                          setDetailError(
                            cause instanceof Error ? cause.message : "Task detail could not load.",
                          ),
                        );
                    }}
                  >
                    Inspect
                  </button>
                  {permits("pause") && (
                    <button disabled={busy === t.id} onClick={() => act(t.id, "pause")}>
                      Pause
                    </button>
                  )}
                  {permits("resume") && (
                    <button disabled={busy === t.id} onClick={() => act(t.id, "resume")}>
                      Resume
                    </button>
                  )}
                  {permits("run") && (
                    <button disabled={busy === t.id} onClick={() => act(t.id, "run")}>
                      Run now
                    </button>
                  )}
                  {t.actions?.includes("rerun") && (
                    <button disabled={busy === t.id} onClick={() => act(t.id, "run")}>
                      Run again
                    </button>
                  )}
                  {permits("cancel") && (
                    <button disabled={busy === t.id} onClick={() => act(t.id, "cancel")}>
                      Cancel
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Empty
          title="Nothing is running"
          body="When Ellie works in the background, you can follow, pause, or stop it here."
        />
      )}
      <form
        className="feedback"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!feedback.trim()) return;
          setSending(true);
          try {
            await api.feedback(feedback.trim(), data.scope);
            setFeedback("");
          } finally {
            setSending(false);
          }
        }}
      >
        <label htmlFor="feedback">Help Ellie improve</label>
        <div>
          <input
            id="feedback"
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="What should work differently next time?"
          />
          <button disabled={sending || !feedback.trim()}>
            {sending ? "Sending…" : "Send feedback"}
          </button>
        </div>
      </form>
      <LearningPanel scope={data.scope} />
      {detailError && (
        <p className="settings-error" role="alert">
          {detailError}
        </p>
      )}
      {detail && (
        <Modal title={taskTitle(detail.task)} close={() => setDetail(null)}>
          <p className="impact">Status: {detail.task.status}</p>
          {detail.stale ? (
            <div className="stale-result">
              <p className="settings-error">
                {detail.staleReason ??
                  "The sources changed, so this stored result needs to be run again."}
              </p>
              <button
                className="primary"
                onClick={() => {
                  act(detail.task.id, "run");
                  setDetail(null);
                }}
              >
                Run again
              </button>
            </div>
          ) : detail.result ? (
            <section className="task-result">
              <h3>Result</h3>
              <p>{detail.result.summary}</p>
              {detail.result.citations.map((citation) => (
                <p key={`${citation.sourceId}:${citation.sourceRevision}`}>
                  <strong>{citation.title}</strong>
                  {citation.references.length > 0 && <span>{citation.references.join(", ")}</span>}
                </p>
              ))}
              {detail.result.omitted ? (
                <small>{detail.result.omitted} additional results omitted.</small>
              ) : null}
            </section>
          ) : null}
          {detail.children.length > 0 && (
            <section className="task-children">
              <h3>Steps</h3>
              {detail.children.map((child) => (
                <p key={child.id}>
                  <i className={`status ${child.status}`} />
                  <span>
                    <strong>{taskTitle(child)}</strong>
                    {child.detail && <small>{child.detail}</small>}
                  </span>
                  <em>{child.status}</em>
                </p>
              ))}
            </section>
          )}
          {detail.progress.length > 0 && (
            <section className="task-progress">
              <h3>Progress</h3>
              {detail.progress.slice(-8).map((item, index) => (
                <p key={`${item.at ?? "progress"}:${index}`}>
                  {item.message ?? `${item.current ?? 0} of ${item.total ?? "?"}`}
                </p>
              ))}
            </section>
          )}
        </Modal>
      )}
    </Page>
  );
}
function LearningPanel({ scope }: { scope: string }) {
  const [records, setRecords] = useState<LifeRecord[]>([]),
    [error, setError] = useState("");
  const load = async () => {
    try {
      setRecords((await api.learning.list(scope)).records);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feedback could not load.");
    }
  };
  useEffect(() => {
    void load();
  }, [scope]);
  if (error)
    return (
      <div className="learning">
        <h2>Response feedback</h2>
        <p>{error}</p>
      </div>
    );
  if (!records.length) return null;
  const selected = records.filter((record) => record.data.trainingEligible === true);
  return (
    <section className="learning">
      <header>
        <div>
          <h2>Response feedback</h2>
          <p>Examples you chose to keep for evaluation. This does not train or change a model.</p>
        </div>
        <button
          disabled={!selected.length}
          onClick={async () => {
            const result = await api.learning.export(selected.map((record) => record.id));
            const url = URL.createObjectURL(
              new Blob([result.jsonl], { type: "application/x-ndjson" }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "ellie-feedback.jsonl";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
          }}
        >
          Download selected JSONL
        </button>
      </header>
      {records.map((record) => {
        const example = record.data.example as
          | { prompt?: string; response?: string; preferredResponse?: string }
          | undefined;
        return (
          <article key={record.id}>
            <div>
              <strong>{record.title}</strong>
              <p>{record.body}</p>
              {example && (
                <details>
                  <summary>Inspect exchange</summary>
                  <blockquote>
                    <b>You</b>
                    {example.prompt}
                  </blockquote>
                  <blockquote>
                    <b>Ellie</b>
                    {example.response}
                  </blockquote>
                  {example.preferredResponse && (
                    <blockquote>
                      <b>Preferred</b>
                      {example.preferredResponse}
                    </blockquote>
                  )}
                </details>
              )}
            </div>
            <label>
              <input
                type="checkbox"
                checked={record.data.trainingEligible === true}
                onChange={async (event) => {
                  await api.learning.select(record.id, record.revision, event.target.checked);
                  await load();
                }}
              />{" "}
              Include in evaluation export
            </label>
          </article>
        );
      })}
    </section>
  );
}
function Settings({
  data,
  save,
  busy,
}: {
  data: Bootstrap;
  save: (scope: string, v: Record<string, unknown>) => Promise<void>;
  busy: boolean;
}) {
  const wrapped = data.settings.values;
  const initial =
    wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
      ? (wrapped as Record<string, unknown>)
      : data.settings;
  const origins =
    data.settings.origins && typeof data.settings.origins === "object"
      ? (data.settings.origins as Record<string, string>)
      : {};
  const [values, setValues] = useState<Record<string, unknown>>({ ...initial });
  const [json, setJson] = useState(JSON.stringify(initial, null, 2));
  const [invalid, setInvalid] = useState("");
  const settingsScopes = [
    { id: "default", name: "Default" },
    ...data.groups.map((group) => ({ id: `group:${group.id}`, name: group.name })),
    { id: `user:${data.profile.id}`, name: "Personal" },
  ];
  const [settingsScope, setSettingsScope] = useState(
    settingsScopes.some((item) => item.id === data.scope) ? data.scope : "default",
  );
  const update = (key: string, value: unknown) =>
    setValues((current) => {
      const next = { ...current, [key]: value };
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  const origin = (key: string) => origins[key] ?? "effective";
  const changed = () =>
    Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => JSON.stringify(initial[key]) !== JSON.stringify(value),
      ),
    );
  return (
    <Page title="Settings" lede="Preferences for this scope. More specific choices take priority.">
      <div className="setting-scope">
        <div>
          <span>Preference layer</span>
          <select value={settingsScope} onChange={(event) => setSettingsScope(event.target.value)}>
            {settingsScopes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <p>
          These choices apply only to the selected scope. Ellie keeps default, group, and personal
          preferences separate.
        </p>
      </div>
      <div className="friendly-settings">
        <Setting label="Tone" origin={origin("tone")}>
          <select
            value={String(values.tone ?? "")}
            onChange={(event) => update("tone", event.target.value)}
          >
            <option value="">Use inherited tone</option>
            <option value="calm">Calm</option>
            <option value="warm">Warm</option>
            <option value="playful">Playful</option>
            <option value="direct">Direct</option>
          </select>
        </Setting>
        <Setting label="Response length" origin={origin("verbosity")}>
          <select
            value={String(values.verbosity ?? "")}
            onChange={(event) => update("verbosity", event.target.value)}
          >
            <option value="">Use inherited length</option>
            <option value="brief">Brief</option>
            <option value="balanced">Balanced</option>
            <option value="detailed">Detailed</option>
          </select>
        </Setting>
        <Setting label="Time zone" origin={origin("timeZone")}>
          <input
            value={String(values.timeZone ?? data.profile.timeZone)}
            onChange={(event) => update("timeZone", event.target.value)}
            placeholder="America/Los_Angeles"
          />
        </Setting>
        <Setting label="Proactive suggestions" origin={origin("proactive")}>
          <label className="switch">
            <input
              type="checkbox"
              checked={values.proactive !== false}
              onChange={(event) => update("proactive", event.target.checked)}
            />
            <span>Let Ellie surface timely, useful suggestions</span>
          </label>
        </Setting>
        <Setting label="Quiet hours" origin={origin("quietHours")}>
          <label className="switch">
            <input
              type="checkbox"
              checked={values.quietHours != null}
              onChange={(event) =>
                update("quietHours", event.target.checked ? { start: 22, end: 7 } : null)
              }
            />
            <span>Hold proactive notifications overnight</span>
          </label>
          {values.quietHours != null && typeof values.quietHours === "object" && (
            <div className="hours">
              <label>
                From{" "}
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={Number((values.quietHours as { start?: number }).start ?? 22)}
                  onChange={(event) =>
                    update("quietHours", {
                      ...(values.quietHours as object),
                      start: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Until{" "}
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={Number((values.quietHours as { end?: number }).end ?? 7)}
                  onChange={(event) =>
                    update("quietHours", {
                      ...(values.quietHours as object),
                      end: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          )}
        </Setting>
      </div>
      <details className="advanced">
        <summary>Advanced settings</summary>
        <p>
          Edit the effective settings as JSON. Only values that changed will be saved to this layer.
        </p>
        <textarea
          rows={12}
          value={json}
          onChange={(event) => setJson(event.target.value)}
          spellCheck={false}
        />
        <button
          onClick={() => {
            try {
              const parsed = JSON.parse(json);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
              setValues(parsed);
              setInvalid("");
            } catch {
              setInvalid("Settings must be a JSON object.");
            }
          }}
        >
          Apply JSON changes
        </button>
      </details>
      {invalid && (
        <span className="settings-error" role="alert">
          {invalid}
        </span>
      )}
      <button
        className="primary"
        disabled={busy || Object.keys(changed()).length === 0}
        onClick={() => {
          setInvalid("");
          void save(settingsScope, changed());
        }}
      >
        {busy ? "Saving…" : "Save settings"}
      </button>
      <PersonalDataControls profileId={data.profile.id} />
    </Page>
  );
}
function PersonalDataControls({ profileId }: { profileId: string }) {
  const [review, setReview] = useState<Awaited<ReturnType<typeof api.personalData.review>> | null>(
    null,
  );
  const [reset, setReset] = useState<Awaited<ReturnType<typeof api.personalData.reset>> | null>(
    null,
  );
  const [confirmReset, setConfirmReset] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const profileRef = useRef(profileId);
  const exportController = useRef<AbortController | null>(null);
  const pollRunning = useRef(false);
  profileRef.current = profileId;
  useEffect(
    () => () => {
      exportController.current?.abort();
    },
    [profileId],
  );
  useEffect(() => {
    let cancelled = false;
    void api.personalData
      .currentReset()
      .then(({ reset: pending }) => {
        if (!cancelled && pending && profileRef.current === profileId) setReset(pending);
      })
      .catch((caught) => {
        if (!cancelled)
          setError(
            caught instanceof Error ? caught.message : "Reset recovery could not be checked.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);
  const inspect = async () => {
    const requestedProfile = profileId;
    setBusy("review");
    setError("");
    try {
      const value = await api.personalData.review();
      if (profileRef.current === requestedProfile) {
        setReview(value);
        setReset(null);
        setConfirmReset(false);
        setAcknowledgement("");
      }
    } catch (caught) {
      if (profileRef.current === requestedProfile)
        setError(
          caught instanceof Error ? caught.message : "Your data summary could not be loaded.",
        );
    } finally {
      if (profileRef.current === requestedProfile) setBusy("");
    }
  };
  useEffect(() => {
    if (!reset || reset.state === "completed") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (pollRunning.current) return;
      pollRunning.current = true;
      void api.personalData
        .resetStatus(reset.operationId)
        .then((value) => {
          if (!cancelled && profileRef.current === profileId) setReset(value);
        })
        .catch((caught) => {
          if (!cancelled)
            setError(
              caught instanceof Error ? caught.message : "Reset status could not be checked.",
            );
        })
        .finally(() => {
          pollRunning.current = false;
        });
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [reset?.operationId, reset?.state, profileId]);
  const download = async () => {
    if (!review) return;
    setBusy("export");
    setError("");
    const controller = new AbortController();
    exportController.current?.abort();
    exportController.current = controller;
    try {
      const archive: Record<string, { format: string; generation: number; items: unknown[] }> = {};
      let pages = 0;
      let bytes = 0;
      let itemCount = 0;
      for (const store of ["life", "tasks", "plugins"] as const) {
        const items: unknown[] = [];
        let cursor: string | undefined;
        let format = "";
        let generation = 0;
        do {
          if (++pages > 3_000)
            throw new Error("This archive exceeds the current browser download limit.");
          const page = await api.personalData.exportPage(
            review.reviewToken,
            store,
            cursor,
            controller.signal,
          );
          bytes += new TextEncoder().encode(JSON.stringify(page.items)).byteLength;
          itemCount += page.items.length;
          if (itemCount > 10_000 || bytes > 25 * 1024 * 1024)
            throw new Error(
              "This archive exceeds the current browser download limit of 10,000 items or 25 MB.",
            );
          format = page.format;
          generation = page.generation;
          items.push(...page.items);
          cursor = page.nextCursor;
        } while (cursor);
        archive[store] = { format, generation, items };
      }
      if (profileRef.current !== profileId) return;
      const blob = new Blob(
        [
          JSON.stringify(
            {
              format: "ellie-personal-data-v1",
              exportedAt: new Date().toISOString(),
              data: archive,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `ellie-personal-data-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (caught) {
      if (!controller.signal.aborted)
        setError(caught instanceof Error ? caught.message : "Your archive could not be exported.");
    } finally {
      if (exportController.current === controller) exportController.current = null;
      if (profileRef.current === profileId) setBusy("");
    }
  };
  const beginReset = async () => {
    if (!review || acknowledgement !== "RESET MY PRIVATE DATA") return;
    setBusy("reset");
    setError("");
    try {
      const status = await api.personalData.reset(review.reviewToken);
      if (profileRef.current === profileId) {
        setConfirmReset(false);
        setReset(status);
      }
    } catch (caught) {
      if (profileRef.current === profileId)
        setError(caught instanceof Error ? caught.message : "The reset could not be started.");
    } finally {
      if (profileRef.current === profileId) setBusy("");
    }
  };
  return (
    <section className="personal-data">
      <header>
        <div>
          <span>Your data</span>
          <h2>Export or reset your private Ellie data</h2>
        </div>
        <button disabled={!!busy || !!reset} onClick={() => void inspect()}>
          {busy === "review" ? "Inspecting…" : review ? "Refresh summary" : "Inspect my data"}
        </button>
      </header>
      <p>
        These controls cover your private records, settings, work, guidance, apps, and app storage.
        Shared group records, apps, tasks, and memberships stay in place. Your own storage inside a
        shared app is removed by reset.
      </p>
      {review && (
        <div className="data-review">
          <dl>
            <div>
              <dt>Private records</dt>
              <dd>{review.counts.privateRecords}</dd>
            </div>
            <div>
              <dt>Sources</dt>
              <dd>{review.counts.sources}</dd>
            </div>
            <div>
              <dt>Guides</dt>
              <dd>{review.counts.guidance}</dd>
            </div>
            <div>
              <dt>Tasks & watches</dt>
              <dd>{review.counts.tasks + review.counts.watches}</dd>
            </div>
            <div>
              <dt>Personal apps</dt>
              <dd>{review.counts.plugins}</dd>
            </div>
            <div>
              <dt>App storage keys</dt>
              <dd>{review.counts.pluginStorageKeys + review.counts.sharedPluginStorageKeys}</dd>
            </div>
          </dl>
          <small>
            Fresh review valid until {new Date(review.expiresAt).toLocaleTimeString()} · about{" "}
            {Math.max(1, Math.ceil(review.bytes / 1024))} KB
          </small>
          <div className="data-actions">
            <button disabled={!!busy} onClick={() => void download()}>
              {busy === "export" ? "Preparing archive…" : "Download my archive"}
            </button>
            <button className="danger" disabled={!!busy} onClick={() => setConfirmReset(true)}>
              Review reset
            </button>
          </div>
        </div>
      )}
      {confirmReset && (
        <Modal title="Reset your private Ellie data" close={() => setConfirmReset(false)}>
          <p className="impact">
            This permanently removes the private data counted in this fresh review. Shared group
            content and memberships remain. Type the phrase below to acknowledge the impact.
          </p>
          <label>
            Type <strong>RESET MY PRIVATE DATA</strong>
            <input
              autoComplete="off"
              value={acknowledgement}
              onChange={(event) => setAcknowledgement(event.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setConfirmReset(false)}>Keep my data</button>
            <button
              className="danger danger-solid"
              disabled={busy === "reset" || acknowledgement !== "RESET MY PRIVATE DATA"}
              onClick={() => void beginReset()}
            >
              {busy === "reset" ? "Starting…" : "Reset private data"}
            </button>
          </div>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
      {reset && (
        <div className={`reset-status ${reset.state}`} role="status">
          <strong>
            {reset.state === "completed" ? "Private data reset complete" : "Reset in progress"}
          </strong>
          <span>
            {reset.state === "draining"
              ? "Finishing active private work safely…"
              : reset.state === "completed"
                ? "Ellie is ready to start fresh. Shared spaces were preserved."
                : "Removing the reviewed private data…"}
          </span>
          {reset.state !== "completed" && (
            <button
              onClick={async () => {
                try {
                  setReset(await api.personalData.retryReset(reset.operationId));
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "Retry failed.");
                }
              }}
            >
              Retry now
            </button>
          )}
          {reset.state === "completed" && (
            <button onClick={() => location.reload()}>Reload Ellie</button>
          )}
        </div>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
function Setting({
  label,
  origin,
  children,
}: {
  label: string;
  origin: string;
  children: React.ReactNode;
}) {
  return (
    <section className="setting">
      <header>
        <strong>{label}</strong>
        <span>{origin === "effective" ? "Inherited or default" : `From ${origin}`}</span>
      </header>
      <div>{children}</div>
    </section>
  );
}
function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty">
      <span>e</span>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}
function Modal({
  title,
  close,
  wide,
  children,
}: {
  title: string;
  close: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    addEventListener("keydown", key);
    closeButton.current?.focus();
    return () => {
      removeEventListener("keydown", key);
      previouslyFocused?.focus();
    };
  }, [close]);
  return (
    <div
      className="backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <h1 id="modal-title">{title}</h1>
          <button ref={closeButton} onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
