import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, establishSessionFromFragment, parsePluginBridgeRequest } from "./api";
import type { Bootstrap, LifeRecord, PluginSummary } from "./types";

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
const agendaDate = (record: LifeRecord, timeZone: string, now = new Date()) => {
  const direct =
    record.kind === "reminder" || record.kind === "timer"
      ? record.data.dueAt
      : (record.data.startAt ?? record.data.startDate ?? record.data.date);
  if (typeof direct === "number" || (typeof direct === "string" && direct.trim()))
    return {
      value: direct,
      allDay: typeof direct === "string" && /^\d{4}-\d{2}-\d{2}$/.test(direct),
    };
  if (record.kind !== "birthday") return undefined;
  if (typeof record.data.nextDate === "string")
    return { value: record.data.nextDate, allDay: true };
  const month = Number(record.data.month),
    day = Number(record.data.day);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const localYear = Number(
    new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(now),
  );
  let value = `${localYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const today = calendarKey(now, timeZone);
  if (value < today)
    value = `${localYear + 1}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { value, allDay: true };
};
const dateValue = (value: string | number) =>
  typeof value === "number"
    ? new Date(value)
    : new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
const calendarKey = (date: Date, zone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: zone,
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const dayKey = (value: string | number, zone: string) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : calendarKey(dateValue(value), zone);
const friendlyDay = (value: string | number, zone?: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : zone,
  }).format(dateValue(value));
const dayHeading = (value: string | number, zone: string, today = new Date()) => {
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const key = dayKey(value, zone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      ...(key.slice(0, 4) === calendarKey(today, zone).slice(0, 4) ? {} : { year: "numeric" }),
      timeZone: dateOnly ? "UTC" : zone,
    })
      .formatToParts(dateValue(value))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday}, ${parts.month}${parts.year ? ` ${parts.year}` : ""}`;
};
const needsSourceReview = (record: LifeRecord) =>
  record.provenance?.some((item) => item.invalidatedAt !== undefined) === true;
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
            records={data.records}
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
  scope,
  busy,
  send,
}: {
  name: string;
  messages: Message[];
  records: LifeRecord[];
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
      when: agendaDate(record, Intl.DateTimeFormat().resolvedOptions().timeZone),
    }))
    .filter(
      (item): item is { record: LifeRecord; when: { value: string | number; allDay: boolean } } =>
        Boolean(item.when),
    )
    .sort((a, b) => dateValue(a.when.value).valueOf() - dateValue(b.when.value).valueOf())
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
  const byId = new Map(data.records.map((record) => [record.id, record]));
  const entries = data.records
    .filter((record) => {
      if (!timedKinds.has(record.kind)) return false;
      if (record.data.completed === true || record.data.cancelled === true) return false;
      if (record.kind === "event" && record.data.type === "notification") return false;
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
    .sort((a, b) => dateValue(a.when.value).valueOf() - dateValue(b.when.value).valueOf());
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
                    {record.body && <p>{record.body}</p>}
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
    [editing, setEditing] = useState<LifeRecord | null>(null);
  const groups = ["all", "memory", "contact", "need", "source"];
  const records = data.records.filter((r) => tab === "all" || r.kind === tab);
  return (
    <Page title="Your world" lede="What Ellie knows, where it came from, and who can see it.">
      <div className="tabs">
        {groups.map((g) => (
          <button key={g} className={tab === g ? "active" : ""} onClick={() => setTab(g)}>
            {g}
          </button>
        ))}
      </div>
      {records.length ? (
        <div className="record-list">
          {records.map((r) => (
            <button key={r.id} onClick={() => setEditing(r)}>
              <span className="kind">{r.kind.slice(0, 1)}</span>
              <span>
                <strong>{r.title}</strong>
                <small>
                  {needsSourceReview(r)
                    ? "Source changed — review needed"
                    : r.body || `Updated ${friendly(r.updatedAt)}`}
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
      <SourceUpload
        scope={data.scope}
        done={async () => {
          notify("Source added");
          await refresh();
        }}
      />
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
      title={record.kind === "source" ? "Review source" : "Edit what Ellie knows"}
      close={close}
    >
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
          Deleting this source removes its text from search. Memories that cite it remain visible
          but their source is marked unavailable.
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
    </Modal>
  );
}
function Space({
  plugins,
  open,
  build,
  busy,
}: {
  plugins: PluginSummary[];
  open: (p: PluginSummary) => void;
  build: (s: string) => Promise<void>;
  busy: boolean;
}) {
  const [idea, setIdea] = useState("");
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
              <button onClick={() => open(p)}>Open</button>
            </article>
          ))}
        </div>
      ) : (
        <Empty
          title="Room to make something"
          body="Describe a small tool or view above. Ellie will show progress in Activity."
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
  return (
    <Page title="Activity" lede="Work in motion, waiting points, and recent outcomes.">
      {data.tasks.length ? (
        <div className="tasks">
          {data.tasks.map((t) => (
            <article key={t.id}>
              <i className={`status ${t.status}`} />
              <div>
                <span>{t.status}</span>
                <h2>{t.title}</h2>
                {t.detail && <p>{t.detail}</p>}
              </div>
              <div>
                {t.status === "running" ? (
                  <button disabled={busy === t.id} onClick={() => act(t.id, "pause")}>
                    Pause
                  </button>
                ) : (
                  <button
                    disabled={busy === t.id}
                    onClick={() => act(t.id, t.status === "paused" ? "resume" : "run")}
                  >
                    {t.status === "paused" ? "Resume" : "Run"}
                  </button>
                )}
                <button disabled={busy === t.id} onClick={() => act(t.id, "cancel")}>
                  Cancel
                </button>
              </div>
            </article>
          ))}
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
    </Page>
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
