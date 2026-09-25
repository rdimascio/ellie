import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  establishSessionFromFragment,
  isNewerChatProgress,
  parsePluginBridgeRequest,
} from "./api";
import type { ChatResponse } from "./api";
import type {
  Bootstrap,
  ConversationSummary,
  ConversationPreferenceState,
  ConversationTurn,
  Group,
  ImprovementProposal,
  LifePlan,
  LifeRecord,
  ModelStatus,
  PendingIntent,
  PluginSummary,
  TeachingGuide,
  TeachingSource,
} from "./types";
import { agendaDate, compareAgenda, dateValue, dayHeading, dayKey, friendlyDay } from "./dates";
import { deliveryLabel, occurrenceLabel } from "./delivery";
import { Connections } from "./Connections";
import { Finances } from "./Finances";
import { InterfaceIcon, ElliePresence } from "./InterfaceIcon";

type View =
  | "dashboard"
  | "chat"
  | "today"
  | "world"
  | "space"
  | "finances"
  | "integrations"
  | "activity"
  | "settings";
type Message = {
  id: string;
  role: "you" | "ellie";
  text: string;
  prompt?: string;
  actions?: { label: string; status: string }[];
  status?: "pending" | "interrupted" | "completed";
  outdated?: boolean;
  turnId?: string;
};
type LifeBoard = {
  id: string;
  name: string;
  layout: Record<string, { order: number; wide: boolean }>;
};
type LifeBoards = { selectedId: string; boards: LifeBoard[] };
const starterBoards = (): LifeBoards => ({
  selectedId: "home",
  boards: [{ id: "home", name: "Home", layout: {} }],
});
const parseBoards = (raw: string | null): LifeBoards => {
  if (!raw || raw.length > 64 * 1024) return starterBoards();
  try {
    const value = JSON.parse(raw) as LifeBoards;
    const plain = (item: unknown): item is Record<string, unknown> =>
      Boolean(item) &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) === Object.prototype;
    if (
      !plain(value) ||
      !Array.isArray(value.boards) ||
      value.boards.length < 1 ||
      value.boards.length > 12
    )
      return starterBoards();
    const ids = new Set<string>();
    const boards: LifeBoard[] = [];
    for (const candidate of value.boards) {
      if (
        !plain(candidate) ||
        typeof candidate.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(candidate.id)
      )
        return starterBoards();
      if (
        ids.has(candidate.id) ||
        typeof candidate.name !== "string" ||
        !candidate.name.trim() ||
        candidate.name.length > 60 ||
        !plain(candidate.layout)
      )
        return starterBoards();
      ids.add(candidate.id);
      const layoutEntries = Object.entries(candidate.layout);
      if (layoutEntries.length > 128) return starterBoards();
      const layout: LifeBoard["layout"] = Object.create(null) as LifeBoard["layout"];
      for (const [key, entry] of layoutEntries) {
        if (
          key.length < 1 ||
          key.length > 160 ||
          !plain(entry) ||
          !Number.isInteger(entry.order) ||
          Math.abs(entry.order as number) > 10_000 ||
          typeof entry.wide !== "boolean"
        )
          return starterBoards();
        layout[key] = { order: entry.order as number, wide: entry.wide };
      }
      boards.push({ id: candidate.id, name: candidate.name.trim(), layout });
    }
    const selectedId =
      typeof value.selectedId === "string" && ids.has(value.selectedId)
        ? value.selectedId
        : boards[0].id;
    return { selectedId, boards };
  } catch {
    return starterBoards();
  }
};
const newRequestId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const conversationScope = (value: ConversationSummary["scope"]) => `${value.type}:${value.id}`;
const setChatUrl = (conversationId?: string, requestId?: string) => {
  const url = new URL(location.href);
  if (conversationId) url.searchParams.set("conversation", conversationId);
  else url.searchParams.delete("conversation");
  if (requestId) url.searchParams.set("request", requestId);
  else url.searchParams.delete("request");
  history.replaceState(null, "", `${url.pathname}${url.search}`);
};
const labels: Record<View, string> = {
  dashboard: "Home",
  chat: "Ellie",
  today: "Today",
  world: "Memory",
  space: "Custom tools",
  finances: "Finances",
  integrations: "Integrations",
  activity: "Activity",
  settings: "Settings",
};
const timedKinds = new Set(["reminder", "timer", "event", "birthday", "holiday"]);
const agendaEntries = (data: Bootstrap, records = data.agendaRecords ?? data.records) => {
  const byId = new Map(data.records.map((record) => [record.id, record]));
  return records
    .filter((record) => {
      if (!timedKinds.has(record.kind)) return false;
      if (record.data.completed === true || record.data.cancelled === true) return false;
      if (record.delivery?.status === "cancelled" || record.delivery?.status === "complete")
        return false;
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
      (item): item is { record: LifeRecord; when: { value: string | number; allDay: boolean } } =>
        Boolean(item.when),
    )
    .sort((a, b) => compareAgenda(a, b, data.profile.timeZone));
};
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
  const ownerConnections = location.search === "?view=settings&section=connections";
  const [data, setData] = useState<Bootstrap | null>(null),
    [view, setView] = useState<View>(ownerConnections ? "settings" : "dashboard"),
    [conversationOpen, setConversationOpen] = useState(
      () => new URLSearchParams(location.search).get("view") === "chat",
    ),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [auth, setAuth] = useState(false),
    [busy, setBusy] = useState(""),
    [composerDraft, setComposerDraft] = useState(""),
    [chatProgress, setChatProgress] = useState<ChatResponse["progress"]>(),
    [messages, setMessages] = useState<Message[]>([]),
    [conversation, setConversation] = useState<string>(),
    [conversationMeta, setConversationMeta] = useState<ConversationSummary>(),
    [conversationPreferences, setConversationPreferences] = useState<ConversationPreferenceState>({
      preferences: {},
      revision: 0,
    }),
    [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null),
    [pendingIntentState, setPendingIntentState] = useState<"idle" | "loading" | "error">("idle"),
    [uncertainRequest, setUncertainRequest] = useState<{
      id: string;
      scope: string;
      status?: "pending" | "interrupted";
    }>(),
    [olderTurns, setOlderTurns] = useState<{
      hasMore: boolean;
      nextCursor?: string;
    }>({ hasMore: false }),
    [expanded, setExpanded] = useState<PluginSummary | null>(null),
    [groupsOpen, setGroupsOpen] = useState(false),
    [boards, setBoards] = useState<LifeBoards>(starterBoards),
    [boardsKey, setBoardsKey] = useState(""),
    [worldTab, setWorldTab] = useState("all");
  const [notice, setNotice] = useState("");
  const scopeGeneration = useRef(0);
  const desiredScope = useRef("");
  const requestEpoch = useRef(0);
  const refreshRunning = useRef(false);
  const chatEpoch = useRef(0);
  const chatRequest = useRef<AbortController | undefined>(undefined);
  const chatProgressRequest = useRef<AbortController | undefined>(undefined);
  const chatProgressRevision = useRef(-1);
  const pendingIntentRequest = useRef<AbortController | undefined>(undefined);
  const pluginBuildRequest = useRef<AbortController | undefined>(undefined);
  const chatInFlight = useRef("");
  const restoredUrl = useRef(false);
  const observedChatEpoch = useRef<number | undefined>(undefined);
  const orbRef = useRef<HTMLButtonElement>(null);
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
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [view]);
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
  useEffect(
    () => () => {
      pluginBuildRequest.current?.abort();
    },
    [],
  );
  const scope = data?.scope ?? "";
  useEffect(() => {
    const url = new URL(location.href);
    if (conversationOpen) url.searchParams.set("view", "chat");
    else url.searchParams.delete("view");
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [conversationOpen]);
  const boardStorageKey = data
    ? `ellie.life.boards.v1:${data.profile.id}:${data.scope}`
    : "ellie.life.boards.v1:loading";
  useEffect(() => {
    if (!data) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(boardStorageKey);
    } catch {
      // Starter board remains usable without browser storage.
    }
    setBoards(parseBoards(raw));
    setBoardsKey(boardStorageKey);
  }, [boardStorageKey]);
  const saveBoards = (next: LifeBoards) => {
    if (boardsKey !== boardStorageKey) return;
    setBoards(next);
    try {
      localStorage.setItem(boardStorageKey, JSON.stringify(next));
    } catch {
      setNotice("This board layout will last only while this page stays open.");
    }
  };
  const showConversation = (open: boolean) => {
    setConversationOpen(open);
  };
  const visibleBoards = boardsKey === boardStorageKey ? boards : starterBoards();
  const orbState =
    busy === "chat" ? "working" : pendingIntent || uncertainRequest ? "attention" : "ready";
  useEffect(() => {
    if (!data) return;
    if (observedChatEpoch.current !== undefined && observedChatEpoch.current !== data.chatEpoch) {
      ++chatEpoch.current;
      chatRequest.current?.abort();
      chatProgressRequest.current?.abort();
      pendingIntentRequest.current?.abort();
      chatInFlight.current = "";
      setMessages([]);
      setComposerDraft("");
      setChatProgress(undefined);
      setConversation(undefined);
      setConversationMeta(undefined);
      setConversationPreferences({ preferences: {}, revision: 0 });
      setPendingIntent(null);
      setPendingIntentState("idle");
      setUncertainRequest(undefined);
      setBusy("");
      setChatUrl();
    }
    observedChatEpoch.current = data.chatEpoch;
  }, [data?.chatEpoch]);
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
  useEffect(() => {
    if (!conversationOpen || !data) return;
    const background = [
      ...document.querySelectorAll<HTMLElement>(
        ".shell > aside, .shell > main > :not(.conversation-overlay), .shell > .bottom, .shell > .ellie-orb",
      ),
    ];
    background.forEach((element) => {
      element.inert = true;
    });
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>('.conversation-overlay [aria-label="Message Ellie"]')
        ?.focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (document.querySelectorAll('[role="dialog"]').length > 1) return;
        showConversation(false);
        requestAnimationFrame(() => orbRef.current?.focus());
        return;
      }
      if (event.key !== "Tab") return;
      if (document.querySelectorAll('[role="dialog"]').length > 1) return;
      const overlay = document.querySelector<HTMLElement>(".conversation-overlay");
      const controls = overlay
        ? [
            ...overlay.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input, textarea, select, summary, [tabindex='0']",
            ),
          ].filter((item) => item.getClientRects().length > 0)
        : [];
      if (!controls.length) return;
      const first = controls[0],
        last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        last.focus();
        event.preventDefault();
      } else if (!event.shiftKey && document.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      background.forEach((element) => {
        element.inert = false;
      });
    };
  }, [conversationOpen, data?.profile.id]);
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
  const switchScope = (nextScope: string) => {
    scopeGeneration.current += 1;
    chatEpoch.current += 1;
    chatRequest.current?.abort();
    chatProgressRequest.current?.abort();
    pendingIntentRequest.current?.abort();
    pluginBuildRequest.current?.abort();
    chatInFlight.current = "";
    desiredScope.current = nextScope;
    setMessages([]);
    setComposerDraft("");
    setChatProgress(undefined);
    setConversation(undefined);
    setConversationMeta(undefined);
    setConversationPreferences({ preferences: {}, revision: 0 });
    setPendingIntent(null);
    setPendingIntentState("idle");
    setBusy("");
    setChatUrl(undefined, uncertainRequest?.id);
    setLoading(true);
    void load(nextScope);
  };
  const mapTurns = (turns: ConversationTurn[]): Message[] =>
    [...turns].reverse().flatMap((turn) => [
      {
        id: `${turn.id}-user`,
        role: "you" as const,
        text: turn.user,
        status: turn.status,
      },
      ...(turn.assistant
        ? [
            {
              id: `${turn.id}-ellie`,
              role: "ellie" as const,
              text: turn.assistant,
              prompt: turn.user,
              status: turn.status,
              outdated: turn.outdated && turn.evidence.length > 0,
              actions: turn.actions,
              turnId: turn.id,
            },
          ]
        : []),
    ]);
  async function openConversation(id: string, preserveRequest?: { id: string; scope: string }) {
    const epoch = ++chatEpoch.current;
    chatRequest.current?.abort();
    chatProgressRequest.current?.abort();
    setChatProgress(undefined);
    pendingIntentRequest.current?.abort();
    const controller = new AbortController();
    chatRequest.current = controller;
    setBusy("conversation");
    try {
      const detail = await api.conversations.detail(id, undefined, controller.signal);
      if (epoch !== chatEpoch.current) return;
      const detailScope = conversationScope(detail.conversation.scope);
      if (detailScope !== desiredScope.current) {
        scopeGeneration.current += 1;
        desiredScope.current = detailScope;
        setLoading(true);
        await load(detailScope);
        if (epoch !== chatEpoch.current) return;
      }
      if (id !== conversation) setComposerDraft("");
      setConversation(id);
      setConversationMeta(detail.conversation);
      setConversationPreferences(detail.conversationPreferences);
      setMessages(mapTurns(detail.turns));
      setOlderTurns(detail.page);
      const pending =
        preserveRequest &&
        detail.turns.some(
          (turn) => turn.requestId === preserveRequest.id && turn.status !== "completed",
        )
          ? { ...preserveRequest, scope: detailScope }
          : undefined;
      setUncertainRequest(pending);
      setChatUrl(id, pending?.id);
      setPendingIntentState("loading");
      try {
        const intent = await api.conversations.pendingIntent(id, controller.signal);
        if (epoch === chatEpoch.current) {
          setPendingIntent(intent.pendingIntent);
          setPendingIntentState("idle");
        }
      } catch (intentError) {
        if (!controller.signal.aborted && epoch === chatEpoch.current) {
          setPendingIntent(null);
          setPendingIntentState("error");
        }
      }
    } catch (e) {
      if (!controller.signal.aborted && epoch === chatEpoch.current)
        setError(e instanceof Error ? e.message : "That conversation could not be opened.");
    } finally {
      if (epoch === chatEpoch.current) setBusy("");
    }
  }
  useEffect(() => {
    if (!data || restoredUrl.current) return;
    restoredUrl.current = true;
    const params = new URLSearchParams(location.search);
    const requestId = params.get("request") ?? undefined;
    const conversationId = params.get("conversation") ?? undefined;
    const recovery = requestId ? { id: requestId, scope: data.scope } : undefined;
    if (recovery) setUncertainRequest(recovery);
    if (conversationId) void openConversation(conversationId, recovery);
  }, [data]);
  useEffect(
    () => () => {
      chatRequest.current?.abort();
      chatProgressRequest.current?.abort();
      pendingIntentRequest.current?.abort();
    },
    [],
  );
  async function send(message: string) {
    if (!message.trim() || !data || chatInFlight.current || busy === "conversation") return;
    const generation = scopeGeneration.current;
    const epoch = ++chatEpoch.current;
    chatRequest.current?.abort();
    pendingIntentRequest.current?.abort();
    const controller = new AbortController();
    chatRequest.current = controller;
    const requestId = newRequestId();
    chatInFlight.current = requestId;
    const originalConversation = conversation;
    setMessages((m) => [
      ...m,
      {
        id: `${requestId}-user`,
        role: "you",
        text: message.trim(),
        status: "pending",
      },
    ]);
    setUncertainRequest({ id: requestId, scope });
    setChatUrl(originalConversation, requestId);
    setBusy("chat");
    setChatProgress(undefined);
    chatProgressRevision.current = -1;
    chatProgressRequest.current?.abort();
    const progressController = new AbortController();
    chatProgressRequest.current = progressController;
    void (async () => {
      while (!progressController.signal.aborted && chatInFlight.current === requestId) {
        await new Promise((resolve) => window.setTimeout(resolve, 350));
        if (progressController.signal.aborted || chatInFlight.current !== requestId) return;
        try {
          const snapshot = await api.chatRequest(requestId, progressController.signal);
          if (
            progressController.signal.aborted ||
            generation !== scopeGeneration.current ||
            epoch !== chatEpoch.current ||
            chatInFlight.current !== requestId
          )
            return;
          if (snapshot.status !== "pending") {
            setChatProgress(undefined);
            return;
          }
          if (!snapshot.progress) {
            setChatProgress(undefined);
          } else if (
            isNewerChatProgress(chatProgressRevision.current, snapshot.progress.revision)
          ) {
            chatProgressRevision.current = snapshot.progress.revision;
            setChatProgress(snapshot.progress);
          }
        } catch {
          if (progressController.signal.aborted) return;
          setChatProgress(undefined);
        }
      }
    })();
    try {
      const r = await api.chat(
        message.trim(),
        scope,
        requestId,
        data.chatEpoch,
        originalConversation,
        controller.signal,
      );
      if (generation !== scopeGeneration.current || epoch !== chatEpoch.current) return;
      progressController.abort();
      if (chatProgressRequest.current === progressController)
        chatProgressRequest.current = undefined;
      setChatProgress(undefined);
      setConversation(r.conversationId);
      setConversationPreferences(r.conversationPreferences);
      setMessages((current) => {
        const next = current.map((item) =>
          item.id === `${requestId}-user` ? { ...item, status: r.status } : item,
        );
        return r.reply
          ? [
              ...next,
              {
                id: `${r.turnId}-ellie`,
                role: "ellie" as const,
                text: r.reply,
                prompt: message.trim(),
                actions: r.actions,
                status: r.status,
                turnId: r.turnId,
              },
            ]
          : next;
      });
      if (r.status === "completed") {
        setUncertainRequest(undefined);
        setChatUrl(r.conversationId);
      } else {
        const pending = { id: requestId, scope };
        setUncertainRequest(pending);
        setChatUrl(r.conversationId, requestId);
      }
      if (generation !== scopeGeneration.current || epoch !== chatEpoch.current) return;
      await load(scope);
      if (generation !== scopeGeneration.current || epoch !== chatEpoch.current) return;
      await openConversation(
        r.conversationId,
        r.status === "completed" ? undefined : { id: requestId, scope },
      );
    } catch (e) {
      if (generation === scopeGeneration.current && epoch === chatEpoch.current) {
        setUncertainRequest({ id: requestId, scope });
        setChatUrl(originalConversation, requestId);
        if (!controller.signal.aborted)
          setNotice("The connection ended before Ellie confirmed the outcome.");
      }
    } finally {
      progressController.abort();
      if (chatProgressRequest.current === progressController)
        chatProgressRequest.current = undefined;
      if (generation === scopeGeneration.current && epoch === chatEpoch.current)
        setChatProgress(undefined);
      if (chatInFlight.current === requestId) chatInFlight.current = "";
      if (generation === scopeGeneration.current && epoch === chatEpoch.current) setBusy("");
    }
  }
  async function checkChatOutcome() {
    if (!uncertainRequest) return;
    const { id: requestId, scope: requestScope } = uncertainRequest;
    const epoch = ++chatEpoch.current;
    const controller = new AbortController();
    chatRequest.current?.abort();
    chatProgressRequest.current?.abort();
    setChatProgress(undefined);
    chatInFlight.current = "";
    chatRequest.current = controller;
    setBusy("chat");
    try {
      const result = await api.chatRequest(requestId, controller.signal);
      if (epoch !== chatEpoch.current) return;
      setConversation(result.conversationId);
      setChatUrl(result.conversationId, result.status === "completed" ? undefined : requestId);
      if (result.status === "completed") {
        setUncertainRequest(undefined);
        await openConversation(result.conversationId);
      } else {
        const recovery = {
          id: requestId,
          scope: requestScope,
          status: result.status,
        } as const;
        setUncertainRequest(recovery);
        await openConversation(result.conversationId, recovery);
        setNotice(
          result.status === "pending"
            ? "Ellie is still working on that request."
            : "The request was interrupted. Check Today and Activity before sending it again.",
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && epoch === chatEpoch.current)
        setNotice(
          e instanceof ApiError && e.status === 404
            ? "The outcome is unknown. Check Today and Activity before sending a new request."
            : e instanceof Error
              ? e.message
              : "The outcome could not be checked.",
        );
    } finally {
      if (epoch === chatEpoch.current) setBusy("");
    }
  }
  function newConversation() {
    ++chatEpoch.current;
    chatRequest.current?.abort();
    chatProgressRequest.current?.abort();
    pendingIntentRequest.current?.abort();
    chatInFlight.current = "";
    setMessages([]);
    setComposerDraft("");
    setChatProgress(undefined);
    setConversation(undefined);
    setConversationMeta(undefined);
    setConversationPreferences({ preferences: {}, revision: 0 });
    setPendingIntent(null);
    setPendingIntentState("idle");
    setBusy("");
    setOlderTurns({ hasMore: false });
    setChatUrl(undefined, uncertainRequest?.id);
  }
  async function loadOlderConversationTurns() {
    if (!conversation || !olderTurns.nextCursor || busy) return;
    const epoch = chatEpoch.current;
    const controller = new AbortController();
    chatRequest.current = controller;
    setBusy("conversation");
    try {
      const detail = await api.conversations.detail(
        conversation,
        olderTurns.nextCursor,
        controller.signal,
      );
      if (epoch !== chatEpoch.current) return;
      setMessages((current) => [...mapTurns(detail.turns), ...current]);
      setConversationMeta(detail.conversation);
      setOlderTurns(detail.page);
    } catch (cause) {
      if (!controller.signal.aborted && epoch === chatEpoch.current)
        setError(cause instanceof Error ? cause.message : "Older turns could not be loaded.");
    } finally {
      if (epoch === chatEpoch.current) setBusy("");
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
  const feedback = (
    <>
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
    </>
  );
  return (
    <div className="shell">
      <aside>
        <Brand />
        <DashboardBoards
          value={visibleBoards}
          change={saveBoards}
          openHome={() => setView("dashboard")}
        />
        <nav aria-label="Main navigation">
          {(["dashboard"] as View[]).map((v) => (
            <button
              key={v}
              className={view === v ? "active" : ""}
              aria-current={view === v ? "page" : undefined}
              onClick={() => setView(v)}
            >
              <InterfaceIcon name={v} />
              {labels[v]}
            </button>
          ))}
          <details className="rail-more">
            <summary>More</summary>
            {(["today", "finances", "integrations", "activity"] as View[]).map((v) => (
              <button
                key={v}
                className={view === v ? "active" : ""}
                aria-current={view === v ? "page" : undefined}
                onClick={() => setView(v)}
              >
                <InterfaceIcon name={v} />
                {labels[v]}
                {v === "activity" && data.tasks.length > 0 ? (
                  <b aria-hidden="true">{data.tasks.length}</b>
                ) : null}
              </button>
            ))}
          </details>
        </nav>
        <div className="scope">
          <label htmlFor="scope">Sharing with</label>
          <select id="scope" value={scope} onChange={(e) => switchScope(e.target.value)}>
            {scopeOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button type="button" className="manage-spaces" onClick={() => setGroupsOpen(true)}>
            Manage shared spaces
          </button>
        </div>
        <button className="settings-link" onClick={() => setView("settings")}>
          <InterfaceIcon name="settings" /> Settings
        </button>
      </aside>
      <main>
        <header className="mobile-head">
          <Brand />
          <div className="mobile-head-actions">
            <button
              onClick={() => setView("activity")}
              aria-label="Activity"
              aria-current={view === "activity" ? "page" : undefined}
            >
              <InterfaceIcon name="activity" />
              {data.tasks.some((task) => task.status === "running") && (
                <span className="activity-indicator" />
              )}
            </button>
            <button
              onClick={() => setView("settings")}
              aria-label="Settings"
              aria-current={view === "settings" ? "page" : undefined}
            >
              <InterfaceIcon name="settings" />
            </button>
          </div>
        </header>
        {!conversationOpen && feedback}
        {view === "dashboard" && (
          <LifeDashboard
            key={`${data.profile.id}:${data.scope}:${data.chatEpoch}`}
            data={data}
            openPlugin={setExpanded}
            openView={setView}
            openConversation={() => showConversation(true)}
            openPlans={() => {
              setWorldTab("plans");
              setView("world");
            }}
            board={
              visibleBoards.boards.find((board) => board.id === visibleBoards.selectedId) ??
              visibleBoards.boards[0]
            }
            boards={visibleBoards.boards}
            selectBoard={(id) => saveBoards({ ...visibleBoards, selectedId: id })}
            changeBoard={(board) =>
              saveBoards({
                ...visibleBoards,
                boards: visibleBoards.boards.map((item) => (item.id === board.id ? board : item)),
              })
            }
          />
        )}{" "}
        {conversationOpen && (
          <div
            className="conversation-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Ellie conversation"
          >
            <button
              className="conversation-close"
              aria-label="Close conversation"
              onClick={() => {
                showConversation(false);
                requestAnimationFrame(() => orbRef.current?.focus());
              }}
            >
              <InterfaceIcon name="close" />
            </button>
            {feedback}
            <Chat
              name={data.profile.name}
              messages={messages}
              records={data.agendaRecords ?? data.records}
              timeZone={data.profile.timeZone}
              scope={scope}
              busy={busy === "chat" || busy === "conversation"}
              send={send}
              draft={composerDraft}
              setDraft={setComposerDraft}
              progress={chatProgress}
              active={conversationMeta}
              preferences={conversationPreferences}
              savedSettings={data.settings}
              openConversation={openConversation}
              newConversation={newConversation}
              uncertainRequest={uncertainRequest}
              checkOutcome={checkChatOutcome}
              pendingIntent={pendingIntent}
              pendingIntentState={pendingIntentState}
              clearPendingIntent={async () => {
                if (
                  !conversation ||
                  !pendingIntent ||
                  pendingIntent.state !== "awaiting-fields" ||
                  chatInFlight.current ||
                  busy
                )
                  return;
                const generation = scopeGeneration.current;
                const epoch = chatEpoch.current;
                const controller = new AbortController();
                pendingIntentRequest.current?.abort();
                pendingIntentRequest.current = controller;
                setPendingIntentState("loading");
                try {
                  await api.conversations.clearPendingIntent(
                    conversation,
                    pendingIntent.revision,
                    controller.signal,
                  );
                  if (generation !== scopeGeneration.current || epoch !== chatEpoch.current) return;
                  setPendingIntent(null);
                  setPendingIntentState("idle");
                  setNotice("Draft cleared");
                } catch (cause) {
                  if (controller.signal.aborted) return;
                  if (generation !== scopeGeneration.current || epoch !== chatEpoch.current) return;
                  if (cause instanceof ApiError && cause.status === 409) {
                    setNotice("That draft changed. Ellie is checking its current status.");
                    await openConversation(conversation);
                    return;
                  }
                  setPendingIntentState("error");
                  setError(
                    cause instanceof Error ? cause.message : "The draft could not be cleared.",
                  );
                } finally {
                  if (pendingIntentRequest.current === controller)
                    pendingIntentRequest.current = undefined;
                }
              }}
              olderTurns={olderTurns}
              loadOlder={loadOlderConversationTurns}
              notify={setNotice}
            />
          </div>
        )}{" "}
        {view === "today" && <Today data={data} refresh={() => load(scope)} notify={setNotice} />}{" "}
        {view === "finances" && (
          <Finances
            data={data}
            openIntegrations={() => setView("integrations")}
            openPersonal={() => switchScope(`user:${data.profile.id}`)}
            ask={(draft) => {
              setComposerDraft(draft);
              showConversation(true);
            }}
          />
        )}
        {view === "integrations" && (
          <Page title="Integrations" lede="Your favorite services, a little more connected.">
            <Connections standalone />
          </Page>
        )}
        {view === "world" && (
          <World
            data={data}
            refresh={() => load(scope)}
            notify={setNotice}
            initialTab={worldTab}
            conversationRevision={`${conversationMeta?.id ?? ""}:${conversationMeta?.revision ?? 0}`}
          />
        )}{" "}
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
              const controller = new AbortController();
              pluginBuildRequest.current?.abort();
              pluginBuildRequest.current = controller;
              setBusy("build");
              try {
                await api.buildPlugin(r, scope, controller.signal);
                if (generation !== scopeGeneration.current) return;
                setNotice("App created");
                await load(desiredScope.current);
              } catch (error) {
                if (generation === scopeGeneration.current) {
                  const stopped =
                    controller.signal.aborted ||
                    (error instanceof ApiError && error.status === 408) ||
                    (error instanceof DOMException && error.name === "AbortError");
                  if (stopped) {
                    setNotice("Build request cancelled");
                    await load(scope, true);
                  } else
                    setError(
                      error instanceof Error ? error.message : "Ellie could not start that build.",
                    );
                }
              } finally {
                if (pluginBuildRequest.current === controller) {
                  pluginBuildRequest.current = undefined;
                  if (generation === scopeGeneration.current) setBusy("");
                }
              }
            }}
            cancelBuild={() => pluginBuildRequest.current?.abort()}
            busy={busy === "build"}
          />
        )}{" "}
        {view === "activity" && (
          <Activity
            data={data}
            busy={busy}
            act={taskAction}
            openGuidance={() => setView("world")}
          />
        )}{" "}
        {view === "settings" && (
          <Settings
            data={data}
            openConnections={ownerConnections}
            openMemory={() => setView("world")}
            openTools={() => setView("space")}
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
      <button
        ref={orbRef}
        className="ellie-orb"
        data-state={orbState}
        aria-label="Talk to Ellie"
        aria-expanded={conversationOpen}
        title={
          orbState === "working"
            ? "Ellie is working"
            : orbState === "attention"
              ? "Ellie needs your attention"
              : "Ellie is ready"
        }
        onClick={() => showConversation(true)}
      >
        <ElliePresence className="orb-core" />
        <span className="orb-status" aria-hidden="true">
          {orbState === "working" ? "Working" : orbState === "attention" ? "Continue" : "Ask Ellie"}
        </span>
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">
        {orbState === "working"
          ? "Ellie is working"
          : orbState === "attention"
            ? "Ellie needs your attention"
            : "Ellie is ready"}
      </span>
      <nav className="bottom" aria-label="Main navigation">
        {(["dashboard", "today", "finances", "integrations"] as View[]).map((v) => (
          <button
            key={v}
            className={view === v ? "active" : ""}
            aria-current={view === v ? "page" : undefined}
            onClick={() => setView(v)}
          >
            <InterfaceIcon name={v} />
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
      {groupsOpen && (
        <GroupManager
          initial={data.groups}
          close={() => setGroupsOpen(false)}
          open={(group) => {
            setGroupsOpen(false);
            switchScope(`group:${group.id}`);
          }}
          changed={() => load(desiredScope.current, true)}
        />
      )}
    </div>
  );
}

function DashboardBoards({
  value,
  change,
  openHome,
}: {
  value: LifeBoards;
  change: (value: LifeBoards) => void;
  openHome: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return (
    <section className="board-manager" aria-label="Your dashboards">
      <div className="board-list">
        {value.boards.map((board) => (
          <div key={board.id} className={board.id === value.selectedId ? "selected" : ""}>
            <button
              aria-label={`Open ${board.name} dashboard`}
              aria-pressed={board.id === value.selectedId}
              onClick={() => {
                change({ ...value, selectedId: board.id });
                openHome();
              }}
            >
              {board.name.slice(0, 1).toUpperCase()}
            </button>
            <input
              aria-label={`Rename ${board.name} dashboard`}
              value={board.name}
              maxLength={60}
              onChange={(event) => {
                const nextName = event.target.value;
                change({
                  ...value,
                  boards: value.boards.map((item) =>
                    item.id === board.id ? { ...item, name: nextName } : item,
                  ),
                });
              }}
              onBlur={() => {
                if (board.name.trim()) return;
                change({
                  ...value,
                  boards: value.boards.map((item) =>
                    item.id === board.id ? { ...item, name: "Untitled board" } : item,
                  ),
                });
              }}
            />
            {value.boards.length > 1 && (
              <button
                className="delete-board"
                aria-label={`Delete ${board.name} dashboard`}
                onClick={() => {
                  const remaining = value.boards.filter((item) => item.id !== board.id);
                  change({
                    boards: remaining,
                    selectedId: value.selectedId === board.id ? remaining[0].id : value.selectedId,
                  });
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {creating ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || value.boards.length >= 12) return;
            const board: LifeBoard = {
              id: `board-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
              name: name.trim(),
              layout: {},
            };
            change({ boards: [...value.boards, board], selectedId: board.id });
            setName("");
            setCreating(false);
            openHome();
          }}
        >
          <input
            autoFocus
            aria-label="New dashboard name"
            maxLength={60}
            value={name}
            placeholder="Kitchen board"
            onChange={(event) => setName(event.target.value)}
          />
          <button disabled={!name.trim()}>Create</button>
        </form>
      ) : (
        <button
          className="new-board"
          disabled={value.boards.length >= 12}
          onClick={() => setCreating(true)}
        >
          ＋ New board
        </button>
      )}
    </section>
  );
}

function LifeDashboard({
  data,
  openPlugin,
  openView,
  openConversation,
  openPlans,
  board,
  boards,
  selectBoard,
  changeBoard,
}: {
  data: Bootstrap;
  openPlugin: (plugin: PluginSummary) => void;
  openView: (view: View) => void;
  openConversation: () => void;
  openPlans: () => void;
  board: LifeBoard;
  boards: LifeBoard[];
  selectBoard: (id: string) => void;
  changeBoard: (board: LifeBoard) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [plans, setPlans] = useState<LifePlan[]>([]);
  const [planError, setPlanError] = useState(false);
  const [planLoading, setPlanLoading] = useState(true);
  const [customizing, setCustomizing] = useState(false);
  const widgetKeys = [
    "clock",
    "agenda",
    "plans",
    ...data.plugins.map((p) => `plugin:${p.id}`),
    "add",
  ];
  const layout = board.layout;
  const layoutFor = (key: string) => layout[key] ?? { order: widgetKeys.indexOf(key), wide: false };
  const changeLayout = (key: string, change: "back" | "forward" | "size") => {
    const ordered = [...widgetKeys].sort((a, b) => layoutFor(a).order - layoutFor(b).order);
    const index = ordered.indexOf(key);
    const next = { ...layout };
    if (change === "size") next[key] = { ...layoutFor(key), wide: !layoutFor(key).wide };
    else {
      const other = ordered[index + (change === "back" ? -1 : 1)];
      if (!other) return;
      next[key] = { ...layoutFor(key), order: layoutFor(other).order };
      next[other] = { ...layoutFor(other), order: layoutFor(key).order };
    }
    changeBoard({ ...board, layout: next });
  };
  const widgetProps = (key: string) => ({
    className: `life-widget ${layoutFor(key).wide ? "wide" : ""}`,
    style: { order: layoutFor(key).order },
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const request = new AbortController();
    setPlanLoading(true);
    void api.plans
      .list(data.scope, request.signal)
      .then((result) => {
        if (!request.signal.aborted) {
          setPlans(result.plans);
          setPlanError(false);
          setPlanLoading(false);
        }
      })
      .catch(() => {
        if (!request.signal.aborted) {
          setPlanError(true);
          setPlanLoading(false);
        }
      });
    return () => request.abort();
  }, [data.scope, data.records]);
  const agenda = agendaEntries(data).slice(0, 3);
  return (
    <div className="life-dashboard">
      <header className="dashboard-title">
        <div>
          <span>
            {now.toLocaleDateString([], {
              weekday: "long",
              month: "short",
              day: "numeric",
              timeZone: data.profile.timeZone,
            })}
          </span>
          <h1>{board.name}</h1>
        </div>
        <div className="dashboard-title-actions">
          <label className="mobile-board-select">
            Board
            <select value={board.id} onChange={(event) => selectBoard(event.target.value)}>
              {boards.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="customize-dashboard"
            aria-pressed={customizing}
            onClick={() => setCustomizing((value) => !value)}
          >
            <InterfaceIcon name="tune" />
            {customizing ? "Done" : "Customize"}
          </button>
        </div>
      </header>
      <section className="assistant-invitation" aria-label="Your personal assistant">
        <div className="invitation-copy">
          <h2>
            What’s on
            <br />
            your mind?
          </h2>
          <p>
            A question. A plan.
            <br />A little help with your day.
          </p>
          <button onClick={openConversation}>
            Ask Ellie <InterfaceIcon name="arrow" />
          </button>
        </div>
        <ElliePresence className="hero-presence" />
      </section>
      <div className="dashboard-section-heading">
        <h2>Your space</h2>
        <span>Made for your everyday</span>
      </div>
      <div className="life-widget-grid">
        <section
          {...widgetProps("clock")}
          className={`${widgetProps("clock").className} clock-widget`}
        >
          {customizing && <DashboardWidgetTools widget="clock" change={changeLayout} />}
          <span className="widget-kicker">Right now</span>
          <time dateTime={now.toISOString()}>
            {now.toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
              timeZone: data.profile.timeZone,
            })}
          </time>
          <p>
            {now.toLocaleDateString([], {
              month: "long",
              day: "numeric",
              timeZone: data.profile.timeZone,
            })}
          </p>
        </section>
        <section
          {...widgetProps("agenda")}
          className={`${widgetProps("agenda").className} agenda-widget`}
        >
          {customizing && <DashboardWidgetTools widget="agenda" change={changeLayout} />}
          <button className="widget-open" onClick={() => openView("today")}>
            <span className="widget-heading">
              <span className="widget-kicker">Coming up</span>
              <InterfaceIcon name="today" />
            </span>
            <h2>{agenda.length ? "On your horizon" : "Room to breathe"}</h2>
            {agenda.map(({ record, when }) => (
              <span className="agenda-preview-row" key={record.id}>
                <span className="agenda-preview-marker" />
                <span>{record.title}</span>
                <time>
                  {when.allDay
                    ? friendlyDay(when.value, data.profile.timeZone)
                    : new Intl.DateTimeFormat(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: data.profile.timeZone,
                      }).format(dateValue(when.value))}
                </time>
              </span>
            ))}
            {!agenda.length && (
              <span className="widget-description">Your next commitments will appear here.</span>
            )}
            <small>
              Open agenda <InterfaceIcon name="arrow" />
            </small>
          </button>
        </section>
        <section
          {...widgetProps("plans")}
          className={`${widgetProps("plans").className} plan-widget`}
        >
          {customizing && <DashboardWidgetTools widget="plans" change={changeLayout} />}
          <button className="widget-open" onClick={openPlans}>
            <span className="widget-heading">
              <span className="widget-kicker">Plans</span>
              <InterfaceIcon name="world" />
            </span>
            <h2>
              {planLoading && !plans.length
                ? "Loading plans…"
                : plans.length
                  ? `${plans.length} saved`
                  : planError
                    ? "Plans unavailable"
                    : "No checklists yet"}
            </h2>
            {planLoading && plans.length > 0 && <span className="widget-state">Updating…</span>}
            {planError && <span>Plans are temporarily unavailable.</span>}
            {plans.slice(0, 2).map((plan) => (
              <span className="plan-preview" key={plan.record.id}>
                <span>{plan.record.title}</span>
                <span className="plan-preview-progress">
                  <span
                    style={{
                      width: `${plan.totalSteps ? Math.min(100, Math.max(0, (plan.completedSteps / plan.totalSteps) * 100)) : 0}%`,
                    }}
                  />
                </span>
                <span className="plan-preview-count">
                  {plan.completedSteps} of {plan.totalSteps} steps
                </span>
              </span>
            ))}
            <small>
              Open plans <InterfaceIcon name="arrow" />
            </small>
          </button>
        </section>
        {data.plugins.map((plugin) => (
          <section
            {...widgetProps(`plugin:${plugin.id}`)}
            className={`${widgetProps(`plugin:${plugin.id}`).className} plugin-widget`}
            key={plugin.id}
          >
            {customizing && (
              <DashboardWidgetTools widget={`plugin:${plugin.id}`} change={changeLayout} />
            )}
            <button className="widget-open" onClick={() => openPlugin(plugin)}>
              <span className="widget-kicker">App</span>
              <h2>{plugin.name}</h2>
              <p>{plugin.description}</p>
              <span className={`widget-state state-${plugin.status}`}>{plugin.status}</span>
              <WidgetData plugin={plugin} />
              <small>Open app</small>
            </button>
          </section>
        ))}
        <section {...widgetProps("add")} className={`${widgetProps("add").className} add-widget`}>
          {customizing && <DashboardWidgetTools widget="add" change={changeLayout} />}
          <button className="widget-open" onClick={() => openView("integrations")}>
            <span className="add-app-icon">
              <InterfaceIcon name="integrations" />
            </span>
            <strong>Connect your world</strong>
            <small>Gmail, Plaid, and more.</small>
          </button>
        </section>
      </div>
    </div>
  );
}

function DashboardWidgetTools({
  widget,
  change,
}: {
  widget: string;
  change: (widget: string, change: "back" | "forward" | "size") => void;
}) {
  return (
    <div className="dashboard-widget-tools" aria-label="Widget layout controls">
      <button aria-label="Move widget earlier" onClick={() => change(widget, "back")}>
        ←
      </button>
      <button aria-label="Move widget later" onClick={() => change(widget, "forward")}>
        →
      </button>
      <button aria-label="Resize widget" onClick={() => change(widget, "size")}>
        ↔
      </button>
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <InterfaceIcon name="chat" className="brand-symbol" />
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
  text,
  setText,
  placeholder = "Tell Ellie what’s on your mind",
}: {
  onSend: (s: string) => void;
  busy: boolean;
  text: string;
  setText: (value: string) => void;
  placeholder?: string;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }, [text]);
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
        ref={inputRef}
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
function ConversationStyle({
  state,
  savedSettings,
  busy,
  send,
}: {
  state: ConversationPreferenceState;
  savedSettings: Record<string, unknown>;
  busy: boolean;
  send: (message: string) => void;
}) {
  const values =
      savedSettings.values && typeof savedSettings.values === "object"
        ? (savedSettings.values as Record<string, unknown>)
        : savedSettings,
    origins =
      savedSettings.origins && typeof savedSettings.origins === "object"
        ? (savedSettings.origins as Record<string, string>)
        : {},
    savedTone = typeof values.tone === "string" ? values.tone : "calm",
    savedVerbosity = typeof values.verbosity === "string" ? values.verbosity : "balanced";
  const label = (key: "tone" | "verbosity", saved: string) =>
    state.preferences[key] ? "This conversation" : `Saved ${origins[key] ?? "default"}: ${saved}`;
  return (
    <div className="conversation-style" aria-label="Conversation style">
      <label>
        Tone
        <select
          value={state.preferences.tone ?? ""}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) send(`In this conversation, be ${event.target.value}`);
          }}
        >
          <option value="">{savedTone}</option>
          {(["calm", "warm", "playful", "direct"] as const).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <small>{label("tone", savedTone)}</small>
      </label>
      <label>
        Length
        <select
          value={state.preferences.verbosity ?? ""}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value) send(`In this conversation, be ${event.target.value}`);
          }}
        >
          <option value="">{savedVerbosity}</option>
          {(["brief", "balanced", "detailed"] as const).map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
        <small>{label("verbosity", savedVerbosity)}</small>
      </label>
      {(state.preferences.tone || state.preferences.verbosity) && (
        <button
          type="button"
          disabled={busy}
          onClick={() => send("Use saved preferences again in this conversation")}
        >
          Use saved preferences
        </button>
      )}
    </div>
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
  draft,
  setDraft,
  progress,
  active,
  preferences,
  savedSettings,
  openConversation,
  newConversation,
  uncertainRequest,
  checkOutcome,
  pendingIntent,
  pendingIntentState,
  clearPendingIntent,
  olderTurns,
  loadOlder,
  notify,
}: {
  name: string;
  messages: Message[];
  records: LifeRecord[];
  timeZone: string;
  scope: string;
  busy: boolean;
  send: (s: string) => void;
  draft: string;
  setDraft: (value: string) => void;
  progress?: ChatResponse["progress"];
  active?: ConversationSummary;
  preferences: ConversationPreferenceState;
  savedSettings: Record<string, unknown>;
  openConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  uncertainRequest?: {
    id: string;
    scope: string;
    status?: "pending" | "interrupted";
  };
  checkOutcome: () => Promise<void>;
  pendingIntent: PendingIntent | null;
  pendingIntentState: "idle" | "loading" | "error";
  clearPendingIntent: () => Promise<void>;
  olderTurns: { hasMore: boolean; nextCursor?: string };
  loadOlder: () => Promise<void>;
  notify: (value: string) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    if (nearBottom.current) end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, progress?.revision]);
  const upcoming = records
    .map((record) => ({
      record,
      when: agendaDate(record, timeZone),
    }))
    .filter(
      (
        item,
      ): item is {
        record: LifeRecord;
        when: { value: string | number; allDay: boolean };
      } => Boolean(item.when),
    )
    .sort((a, b) => compareAgenda(a, b, timeZone))
    .slice(0, 2);
  return (
    <section
      className="conversation"
      onScroll={(event) => {
        const element = event.currentTarget;
        nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
    >
      <div className="conversation-bar">
        <div>
          <strong>{active?.title || "New conversation"}</strong>
          <span>
            Private · using {scope.startsWith("group:") ? "shared group" : "your"} context
          </span>
        </div>
        <details className="conversation-options">
          <summary>Options</summary>
          <div>
            <ConversationStyle
              state={preferences}
              savedSettings={savedSettings}
              busy={busy}
              send={send}
            />
            <ModelReadiness />
          </div>
        </details>
        <button onClick={() => setHistoryOpen(true)}>History</button>
        <button onClick={newConversation} disabled={!messages.length && !active}>
          New
        </button>
      </div>
      {uncertainRequest && !busy && (
        <div className="request-recovery" role="status">
          <div>
            <strong>
              {uncertainRequest.status === "interrupted"
                ? "That request was interrupted"
                : "Let’s check what happened"}
            </strong>
            <p>
              {uncertainRequest.status === "interrupted"
                ? "Its outcome may be incomplete. Inspect Today and Activity before sending a new request."
                : "The last connection ended without a final result. Check its saved status before sending the same request again."}
            </p>
          </div>
          {uncertainRequest.status !== "interrupted" && (
            <button onClick={() => void checkOutcome()} disabled={busy}>
              Check outcome
            </button>
          )}
        </div>
      )}
      {active && (pendingIntent || pendingIntentState !== "idle") && (
        <PendingIntentStrip
          intent={pendingIntent}
          state={pendingIntentState}
          busy={busy}
          clear={clearPendingIntent}
          retry={() => openConversation(active.id)}
        />
      )}
      {messages.length === 0 && (
        <div className="hello">
          <ElliePresence className="conversation-presence" />
          <h1>{name === "You" ? "" : `Hi ${name}. `}What can I help with?</h1>
          {messages.length === 0 && (
            <>
              <p>Ask a question, make a plan, or tell me about your day.</p>
              <div className="suggestions">
                {["What should I know today?", "List reminders", "Help me plan something"].map(
                  (x) => (
                    <button key={x} disabled={busy} onClick={() => send(x)}>
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
      )}
      <div className="messages" aria-live="polite">
        {olderTurns.hasMore && (
          <button className="load-more" disabled={busy} onClick={() => void loadOlder()}>
            Load older turns
          </button>
        )}
        {messages.map((m) => (
          <article key={m.id} className={m.role}>
            <span>{m.role === "ellie" ? "e" : "You"}</span>
            <div>
              <p>{m.text}</p>
              {m.outdated && (
                <small>Some cited source details have changed since this reply.</small>
              )}
              {m.actions?.map((a, j) => (
                <small key={j}>
                  {a.label}: {a.status}
                </small>
              ))}
              {m.role === "ellie" && m.prompt && (
                <ResponseFeedback conversationId={active?.id} turnId={m.turnId} />
              )}
            </div>
          </article>
        ))}
        {busy && (
          <article className="ellie">
            <span>e</span>
            <div className={progress ? "provisional-reply" : "typing"}>
              {progress ? (
                <>
                  <b>
                    {progress.phase === "queued"
                      ? "Getting ready…"
                      : progress.phase === "validating"
                        ? "Checking draft…"
                        : "Drafting…"}
                  </b>
                  {progress.text && <p>{progress.text}</p>}
                </>
              ) : (
                "● ● ●"
              )}
            </div>
          </article>
        )}
        <div ref={end} />
      </div>
      <Composer
        onSend={send}
        text={draft}
        setText={setDraft}
        busy={busy || pendingIntentState === "loading" || pendingIntent?.state === "executing"}
        placeholder={
          pendingIntent?.state === "awaiting-fields"
            ? pendingIntent.question || `Tell Ellie ${pendingIntent.missing.join(" and ")}`
            : undefined
        }
      />
      {historyOpen && (
        <ConversationHistory
          scope={scope}
          activeId={active?.id}
          close={() => setHistoryOpen(false)}
          open={async (id) => {
            await openConversation(id);
            setHistoryOpen(false);
          }}
          deleted={(id) => {
            notify("Conversation deleted");
            if (active?.id === id) newConversation();
          }}
        />
      )}
    </section>
  );
}

function PendingIntentStrip({
  intent,
  state,
  busy,
  clear,
  retry,
}: {
  intent: PendingIntent | null;
  state: "idle" | "loading" | "error";
  busy: boolean;
  clear: () => Promise<void>;
  retry: () => Promise<void>;
}) {
  if (state === "loading")
    return (
      <div className="intent-strip" role="status">
        <span>Checking saved draft…</span>
      </div>
    );
  if (state === "error")
    return (
      <div className="intent-strip intent-error" role="alert">
        <div>
          <strong>Draft status unavailable</strong>
          <span>Ellie could not verify whether this conversation has a saved draft.</span>
        </div>
        <button onClick={() => void retry()} disabled={busy}>
          Try again
        </button>
      </div>
    );
  if (!intent) return null;
  const kind = intent.kind === "need" ? "need" : intent.kind;
  const missing = intent.missing.map((value) => value.replace(/[-_]/g, " ")).join(" and ");
  return (
    <div className={`intent-strip intent-${intent.state}`} role="status">
      <div>
        <strong>
          {intent.state === "expired" ? "Expired" : "Draft"} {kind} · {intent.title}
        </strong>
        <span>
          {intent.state === "awaiting-fields"
            ? intent.question || `Needs ${missing}`
            : intent.state === "executing"
              ? "Ellie is carrying this out. Closing the page will not cancel it."
              : intent.state === "interrupted"
                ? "Execution was interrupted. Check Today and Activity before trying again."
                : "This draft expired before it was completed. Start a new request when you’re ready."}
        </span>
      </div>
      {intent.state === "awaiting-fields" && (
        <button
          onClick={() => void clear()}
          disabled={busy}
          aria-label={`Clear draft ${kind}: ${intent.title}`}
        >
          Clear draft
        </button>
      )}
    </div>
  );
}

function ModelReadiness() {
  const [status, setStatus] = useState<ModelStatus>();
  const [loading, setLoading] = useState(false);
  const activeRequest = useRef<AbortController | undefined>(undefined);
  const load = () => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    void api
      .modelStatus(controller.signal)
      .then(setStatus)
      .catch(() => setStatus(undefined))
      .finally(() => setLoading(false));
    return controller;
  };
  useEffect(() => {
    load();
    return () => activeRequest.current?.abort();
  }, []);
  const text = !status
    ? "Model status unavailable"
    : status.mode === "deterministic"
      ? "Built-in help ready"
      : status.available
        ? `${status.model || "Local model"} ready`
        : status.reason === "probe-unsupported"
          ? "Local model configured · availability unverified"
          : status.reason === "model-not-installed"
            ? "Local model needs installation"
            : status.reason === "runner-unreachable"
              ? "Local model runner unavailable"
              : "Local model not configured";
  return (
    <div className="model-readiness" title={text}>
      <i className={status?.available || status?.mode === "deterministic" ? "ready" : ""} />
      <span>{text}</span>
      <button
        aria-label="Refresh model status"
        disabled={loading}
        onClick={() => {
          load();
        }}
      >
        ↻
      </button>
      {status?.reason === "not-configured" && (
        <details>
          <summary>Setup</summary>
          <code>bun run life:start --model-url LOOPBACK_MODEL_URL --model MODEL_ID</code>
        </details>
      )}
    </div>
  );
}

function ConversationHistory({
  scope,
  activeId,
  close,
  open,
  deleted,
}: {
  scope: string;
  activeId?: string;
  close: () => void;
  open: (id: string) => Promise<void>;
  deleted: (id: string) => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [page, setPage] = useState<{ hasMore: boolean; nextCursor?: string }>({
    hasMore: false,
  });
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const loadEpoch = useRef(0);
  const dialog = useRef<HTMLElement>(null);
  const load = async (cursor?: string, signal?: AbortSignal) => {
    const epoch = ++loadEpoch.current;
    setBusy("list");
    setLoading(true);
    try {
      const result = await api.conversations.list(scope, cursor, signal);
      if (epoch !== loadEpoch.current) return;
      setItems((current) =>
        cursor ? [...current, ...result.conversations] : result.conversations,
      );
      setPage(result.page);
    } catch (cause) {
      if (
        epoch === loadEpoch.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      )
        setError(
          cause instanceof Error ? cause.message : "Conversation history could not be loaded.",
        );
    } finally {
      if (epoch === loadEpoch.current) setBusy("");
      if (epoch === loadEpoch.current) setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => {
      ++loadEpoch.current;
      controller.abort();
    };
  }, [scope]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      if (event.key === "Tab" && dialog.current) {
        const controls = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
        if (!controls.length) return;
        const first = controls[0]!;
        const last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", escape);
    };
  }, []);
  return (
    <div
      className="backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <section
        ref={dialog}
        className="modal conversation-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        tabIndex={-1}
      >
        <header>
          <div>
            <span>Your private daybook</span>
            <h1 id="history-title">Conversation history</h1>
          </div>
          <button onClick={close} aria-label="Close conversation history">
            ×
          </button>
        </header>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="history-list">
          {items.map((item) => (
            <article
              key={item.id}
              data-conversation-id={item.id}
              className={item.id === activeId ? "active" : ""}
            >
              <button className="history-open" onClick={() => void open(item.id)}>
                <strong>{item.title}</strong>
                <span>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                  }).format(new Date(item.updatedAt))}{" "}
                  · {item.turnCount} {item.turnCount === 1 ? "turn" : "turns"}
                  {item.pending ? " · Working" : ""}
                </span>
              </button>
              <button
                className="history-delete"
                aria-label={`Delete ${item.title}`}
                disabled={item.pending || busy === item.id}
                title={
                  item.pending
                    ? "A conversation cannot be deleted while Ellie is working."
                    : "Delete conversation"
                }
                onClick={async () => {
                  if (!confirm(`Delete “${item.title}”? This removes its private transcript.`))
                    return;
                  setBusy(item.id);
                  setError("");
                  try {
                    await api.conversations.delete(item.id, item.revision);
                    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
                    deleted(item.id);
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : "Conversation could not be deleted.",
                    );
                  } finally {
                    setBusy("");
                  }
                }}
              >
                Remove
              </button>
            </article>
          ))}
          {loading && <p className="history-loading">Opening your daybook…</p>}
          {!items.length && !loading && (
            <Empty
              title="No saved conversations yet"
              body="A conversation appears here after you send its first message."
            />
          )}
        </div>
        {page.hasMore && (
          <button
            className="load-more"
            disabled={busy === "list"}
            onClick={() => void load(page.nextCursor)}
          >
            Load older conversations
          </button>
        )}
      </section>
    </div>
  );
}
function ResponseFeedback({
  conversationId,
  turnId,
}: {
  conversationId?: string;
  turnId?: string;
}) {
  const [mode, setMode] = useState<"idle" | "correct" | "sending" | "sent">("idle"),
    [correction, setCorrection] = useState(""),
    [error, setError] = useState("");
  const record = async (rating: -1 | 1) => {
    if (!conversationId || !turnId || mode === "sending") return;
    setMode("sending");
    setError("");
    try {
      await api.learning.record({
        conversationId,
        turnId,
        message:
          rating === 1
            ? "This response was helpful."
            : correction.trim() || "This response needs work.",
        rating,
        example: correction.trim() ? { preferredResponse: correction.trim() } : {},
        trainingEligible: false,
      });
      setMode("sent");
    } catch (cause) {
      setMode(rating === -1 ? "correct" : "idle");
      setError(cause instanceof Error ? cause.message : "Feedback could not be saved.");
    }
  };
  if (mode === "sent")
    return <span className="feedback-sent">Private feedback saved for evaluation.</span>;
  return (
    <div className="response-feedback">
      <span>Private to you</span>
      <button
        disabled={!conversationId || !turnId || mode === "sending"}
        onClick={() => void record(1)}
      >
        Helpful
      </button>
      <button
        disabled={!conversationId || !turnId || mode === "sending"}
        onClick={() => setMode("correct")}
      >
        Needs work
      </button>
      {(mode === "correct" || mode === "sending") && (
        <div>
          <textarea
            aria-label="How should Ellie respond instead?"
            value={correction}
            onChange={(event) => setCorrection(event.target.value)}
            placeholder="Optional: what would have been better?"
          />
          <button disabled={mode === "sending"} onClick={() => void record(-1)}>
            {mode === "sending" ? "Saving…" : "Save private feedback"}
          </button>
        </div>
      )}
      {error && <span role="alert">{error}</span>}
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
  const entries = agendaEntries(data, allAgenda);
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
                    {deliveryLabel(record) && (
                      <strong className={`delivery-state ${record.delivery?.status}`}>
                        {deliveryLabel(record)}
                      </strong>
                    )}
                    {occurrenceLabel(record) && (
                      <small className="occurrence-state">{occurrenceLabel(record)}</small>
                    )}
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
  initialTab = "all",
  conversationRevision,
}: {
  data: Bootstrap;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  initialTab?: string;
  conversationRevision: string;
}) {
  const [tab, setTab] = useState(initialTab),
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
  useEffect(() => setTab(initialTab), [initialTab]);
  const groups = ["all", "memory", "contact", "need", "source", "plans", "guidance"];
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
    <Page
      title="Memory"
      lede="Ellie remembers useful context from your conversations automatically. Open details here when you need them."
    >
      <ConversationMemory scope={data.scope} revision={conversationRevision} />
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
        <Guidance key={conversationRevision} data={data} refresh={refresh} notify={notify} />
      ) : tab === "plans" ? (
        <Plans scope={data.scope} revision={conversationRevision} />
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
                    : deliveryLabel(r) ||
                      r.bodyPreview ||
                      r.body ||
                      `Updated ${friendly(r.updatedAt)}`}
                </small>
                {occurrenceLabel(r) && <small>{occurrenceLabel(r)}</small>}
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
      {tab !== "guidance" && tab !== "plans" && !searchResults && page?.hasMore && (
        <button
          className="load-more"
          disabled={loadingRecords}
          onClick={async () => {
            if (!page.nextCursor) return;
            const requestedScope = data.scope;
            setLoadingRecords(true);
            try {
              const next = await api.records(requestedScope, {
                cursor: page.nextCursor,
              });
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
      {tab !== "guidance" && tab !== "plans" && (
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
function ConversationMemory({ scope, revision }: { scope: string; revision: string }) {
  const [memory, setMemory] = useState<Awaited<ReturnType<typeof api.memory>>>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const request = new AbortController();
    setMemory(undefined);
    setError(false);
    void api
      .memory(scope, request.signal)
      .then((value) => !request.signal.aborted && setMemory(value))
      .catch(() => !request.signal.aborted && setError(true));
    return () => request.abort();
  }, [scope, revision]);
  return (
    <details
      className="conversation-memory"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>From conversations {memory ? `· ${memory.entries} recent notes` : ""}</summary>
      {open &&
        (memory?.summary ? (
          <p>{memory.summary}</p>
        ) : (
          <p>{error ? "Conversation memory is unavailable." : "Checking…"}</p>
        ))}
      {open && memory?.partial && (
        <small>This is a compact selection of your conversation notes.</small>
      )}
    </details>
  );
}
function Plans({ scope, revision }: { scope: string; revision: string }) {
  const [plans, setPlans] = useState<LifePlan[]>([]),
    [selected, setSelected] = useState<LifePlan | null>(null),
    [loading, setLoading] = useState(true),
    [hasMore, setHasMore] = useState(false),
    [unavailableCount, setUnavailableCount] = useState(0),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const scopeRef = useRef(scope);
  const generationRef = useRef(0);
  const selectedRef = useRef<LifePlan | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  scopeRef.current = scope;
  const select = (plan: LifePlan | null) => {
    selectedRef.current = plan;
    setSelected(plan);
  };
  const load = async () => {
    const requestedScope = scope;
    const generation = generationRef.current;
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    setLoading(true);
    try {
      const result = await api.plans.list(requestedScope, request.signal);
      if (
        generationRef.current === generation &&
        scopeRef.current === requestedScope &&
        !request.signal.aborted
      ) {
        setPlans(result.plans);
        setHasMore(result.hasMore);
        setUnavailableCount(result.unavailableCount);
        setError("");
      }
    } catch (cause) {
      if (
        generationRef.current === generation &&
        scopeRef.current === requestedScope &&
        !request.signal.aborted
      )
        setError(cause instanceof Error ? cause.message : "Plans could not load.");
    } finally {
      if (requestRef.current === request) requestRef.current = null;
      if (
        generationRef.current === generation &&
        scopeRef.current === requestedScope &&
        !request.signal.aborted
      )
        setLoading(false);
    }
  };
  useEffect(() => {
    generationRef.current++;
    requestRef.current?.abort();
    select(null);
    setPlans([]);
    setBusy("");
    setUnavailableCount(0);
    setError("");
    void load();
    return () => {
      generationRef.current++;
      requestRef.current?.abort();
    };
  }, [scope, revision]);
  const toggle = async (stepId: string, completed: boolean) => {
    if (!selected || busy) return;
    const requestedScope = scope;
    const generation = generationRef.current;
    const plan = selected;
    const isCurrent = () =>
      generationRef.current === generation && scopeRef.current === requestedScope;
    setBusy(stepId);
    setError("");
    try {
      const next = await api.plans.step(plan.record.id, stepId, completed, plan.record.revision);
      if (!isCurrent()) return;
      if (selectedRef.current?.record.id === plan.record.id) select(next);
      setPlans((current) =>
        current.map((plan) => (plan.record.id === next.record.id ? next : plan)),
      );
    } catch (cause) {
      if (!isCurrent()) return;
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          const current = await api.plans.detail(plan.record.id);
          if (isCurrent()) {
            if (selectedRef.current?.record.id === plan.record.id) select(current);
            setPlans((items) =>
              items.map((plan) => (plan.record.id === current.record.id ? current : plan)),
            );
            setError("That checklist changed. Its current steps are shown.");
          }
        } catch (refreshError) {
          if (isCurrent())
            setError(
              refreshError instanceof Error ? refreshError.message : "Plan could not refresh.",
            );
        }
      } else setError(cause instanceof Error ? cause.message : "That step could not be updated.");
    } finally {
      if (isCurrent()) setBusy("");
    }
  };
  if (loading) return <p className="history-loading">Opening saved plans…</p>;
  return (
    <section className="plans">
      <header>
        <div>
          <h2>Plans</h2>
          <p>
            Ellie prepares private checklists from connected activity. You can adjust them as plans
            change.
          </p>
        </div>
        <button
          disabled={Boolean(busy)}
          onClick={() => {
            select(null);
            void load();
          }}
        >
          Refresh plans
        </button>
      </header>
      {plans.length ? (
        <div className="plan-list">
          {plans.map((plan) => (
            <button key={plan.record.id} onClick={() => select(plan)}>
              <span>
                <strong>{plan.record.title}</strong>
                <small>
                  {plan.completedSteps} of {plan.totalSteps} complete
                </small>
              </span>
              <progress
                aria-label={`${plan.record.title} progress`}
                max={plan.totalSteps}
                value={plan.completedSteps}
              />
            </button>
          ))}
        </div>
      ) : error ? null : (
        <Empty
          title={unavailableCount ? "Saved plans need review" : "No saved plans yet"}
          body={
            "Connect your calendar in Settings and Ellie can prepare for upcoming appointments automatically. You can also describe a plan in chat."
          }
        />
      )}
      {unavailableCount > 0 && (
        <p role="status">
          {unavailableCount} saved {unavailableCount === 1 ? "plan has" : "plans have"} invalid
          data. Find the original records under All to review or remove them.
        </p>
      )}
      {hasMore && (
        <p className="plan-limit" role="status">
          Showing the 64 most recently updated plans in this space.
        </p>
      )}
      <p className="plan-chat-help">
        Tell Ellie when something changes, or update a step here. Steps stay open until completion
        is confirmed.
      </p>
      {error && !selected && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {selected && (
        <Modal title={selected.record.title} close={() => select(null)}>
          <p className="impact">
            Saved checklist · {selected.completedSteps} of {selected.totalSteps} complete. Changing
            a step does not execute it or schedule a reminder.
          </p>
          {selected.record.body && <p className="impact">{selected.record.body}</p>}
          <div className="plan-steps">
            {selected.steps.map((step) => (
              <label key={step.id} className="inline-check">
                <input
                  type="checkbox"
                  checked={step.completed}
                  disabled={Boolean(busy)}
                  onChange={(event) => void toggle(step.id, event.target.checked)}
                />
                <span>{step.title}</span>
              </label>
            ))}
          </div>
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}
    </section>
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
  type UploadItem = {
    id: string;
    file: File;
    status: "queued" | "uploading" | "review" | "done" | "error" | "cancelled";
    progress: number;
    error?: string;
    note?: string;
  };
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [queueNotice, setQueueNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState<{
    queueId: string;
    format: "ics" | "vcard";
    content: string;
    fileName: string;
    preview: Awaited<ReturnType<typeof api.import.preview>>;
    selected: Set<string>;
  } | null>(null);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const updateItem = (id: string, patch: Partial<UploadItem>) =>
    setQueue((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  useEffect(() => {
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    controller.current?.abort();
    controller.current = null;
    running.current = false;
    setQueue([]);
    setImporting(null);
    setImportError("");
    setQueueNotice("");
  }, [scope]);
  useEffect(() => {
    if (running.current || importing) return;
    const item = queue.find((candidate) => candidate.status === "queued");
    if (!item) return;
    const requestedScope = scope;
    const abort = new AbortController();
    controller.current = abort;
    running.current = true;
    updateItem(item.id, { status: "uploading", progress: 0, error: undefined });
    void (async () => {
      try {
        if (item.file.size === 0) throw new Error("This file is empty.");
        if (item.file.size > 50_000_000) throw new Error("This file exceeds the 50 MB limit.");
        const importFormat = /\.ics$/i.test(item.file.name)
          ? "ics"
          : /\.(vcf|vcard)$/i.test(item.file.name)
            ? "vcard"
            : undefined;
        if (importFormat) {
          const content = await item.file.text();
          if (abort.signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
          const preview = await api.import.preview(
            {
              scope: requestedScope,
              format: importFormat,
              content,
              fileName: item.file.name,
            },
            abort.signal,
          );
          if (scopeRef.current !== requestedScope || abort.signal.aborted) return;
          updateItem(item.id, { status: "review", progress: 1 });
          setImporting({
            queueId: item.id,
            format: importFormat,
            content,
            fileName: item.file.name,
            preview,
            selected: new Set(preview.items.map((entry) => entry.key)),
          });
          return;
        }
        const binary =
          item.file.type === "application/pdf" ||
          item.file.type === "image/png" ||
          item.file.type === "image/jpeg" ||
          item.file.type ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          /\.(pdf|png|jpe?g|docx)$/i.test(item.file.name);
        if (binary) {
          await api.sourceBinary(item.file, requestedScope, abort.signal, (progress) =>
            updateItem(item.id, { progress }),
          );
          if (/\.docx$/i.test(item.file.name))
            updateItem(item.id, {
              note: "Document text added. Embedded objects are not OCRed and external resources are not fetched.",
            });
        } else
          await api.source(
            {
              filename: item.file.name,
              content: await item.file.text(),
              mimeType: item.file.type || "text/plain",
              scope: requestedScope,
            },
            abort.signal,
          );
        if (scopeRef.current !== requestedScope || abort.signal.aborted) return;
        updateItem(item.id, { status: "done", progress: 1 });
        await done();
      } catch (error) {
        if (scopeRef.current !== requestedScope) return;
        updateItem(item.id, {
          status:
            error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "error",
          error:
            error instanceof DOMException && error.name === "AbortError"
              ? "Cancelled"
              : error instanceof Error
                ? error.message
                : "The file could not be added.",
        });
      } finally {
        if (controller.current === abort) controller.current = null;
        running.current = false;
        if (scopeRef.current === requestedScope) setQueue((current) => [...current]);
      }
    })();
  }, [queue, importing, scope, done]);
  return (
    <>
      <label className="drop">
        <input
          type="file"
          multiple
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            setQueue((current) => {
              const accepted = files.slice(0, Math.max(0, 20 - current.length));
              const ignored = files.length - accepted.length;
              setQueueNotice(
                ignored
                  ? `${ignored} ${ignored === 1 ? "file was" : "files were"} not queued because the 20-file limit was reached.`
                  : "",
              );
              return [
                ...current,
                ...accepted.map((file, index) => ({
                  id: `${Date.now()}-${index}-${file.name}`,
                  file,
                  status: "queued" as const,
                  progress: 0,
                })),
              ];
            });
            event.target.value = "";
          }}
        />
        <strong>Teach Ellie from files</strong>
        <span>Choose up to 20 notes, DOCX, PDF, images, calendars, or contacts</span>
      </label>
      {queue.length > 0 && (
        <section className="upload-queue" aria-label="File upload queue">
          <header>
            <strong>Selected files</strong>
            <span>
              {queue.filter((item) => item.status === "done").length} of {queue.length} added
            </span>
            {queue.some((item) => ["done", "error", "cancelled"].includes(item.status)) && (
              <button
                onClick={() =>
                  setQueue((current) =>
                    current.filter((item) => !["done", "error", "cancelled"].includes(item.status)),
                  )
                }
              >
                Dismiss results
              </button>
            )}
          </header>
          {queueNotice && (
            <p className="queue-notice" role="alert">
              {queueNotice}
            </p>
          )}
          {queue.map((item) => (
            <article key={item.id} className={`upload-${item.status}`}>
              <div>
                <strong>{item.file.name}</strong>
                <small>
                  {item.status === "uploading"
                    ? `Uploading ${Math.round(item.progress * 100)}%`
                    : item.status === "review"
                      ? "Waiting for your review"
                      : item.status === "done"
                        ? "Added"
                        : item.status === "error"
                          ? "Needs attention"
                          : item.status}
                </small>
                {item.error && <em>{item.error}</em>}
                {item.note && <span className="upload-note">{item.note}</span>}
              </div>
              <progress max={1} value={item.progress} />
              {(item.status === "queued" || item.status === "uploading") && (
                <button
                  aria-label={`Cancel ${item.file.name}`}
                  onClick={() => {
                    if (item.status === "uploading") controller.current?.abort();
                    else
                      updateItem(item.id, {
                        status: "cancelled",
                        error: "Cancelled",
                      });
                  }}
                >
                  Cancel
                </button>
              )}
              {item.status === "error" && (
                <button
                  onClick={() =>
                    updateItem(item.id, {
                      status: "queued",
                      progress: 0,
                      error: undefined,
                    })
                  }
                >
                  Retry
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {importing && (
        <Modal
          title={`Review ${importing.format === "ics" ? "calendar" : "contacts"}`}
          close={() => {
            updateItem(importing.queueId, {
              status: "cancelled",
              error: "Review cancelled",
            });
            setImporting(null);
          }}
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
            <button
              onClick={() => {
                updateItem(importing.queueId, {
                  status: "cancelled",
                  error: "Review cancelled",
                });
                setImporting(null);
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || importing.selected.size === 0}
              onClick={async () => {
                setBusy(true);
                const abort = new AbortController();
                controller.current = abort;
                try {
                  await api.import.commit(
                    {
                      scope,
                      format: importing.format,
                      content: importing.content,
                      fileName: importing.fileName,
                      selectedKeys: [...importing.selected],
                    },
                    abort.signal,
                  );
                  updateItem(importing.queueId, {
                    status: "done",
                    progress: 1,
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
                  if (controller.current === abort) controller.current = null;
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
                      data: {
                        ...record.data,
                        completed: true,
                        completedAt: Date.now(),
                      },
                    }),
                  )
                }
              >
                Mark complete
              </button>
            )}
          {(["reminder", "timer", "event"] as string[]).includes(record.kind) &&
            !record.delivery &&
            record.data.cancelled !== true &&
            record.data.completed !== true && (
              <button
                className="record-action"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    api.patchRecord(record.id, {
                      expectedRevision: record.revision,
                      data: {
                        ...record.data,
                        cancelled: true,
                        cancelledAt: Date.now(),
                      },
                    }),
                  )
                }
              >
                Cancel {record.kind}
              </button>
            )}
          {record.delivery && (
            <section className="delivery-controls">
              <h3>Delivery</h3>
              <strong className={`delivery-state ${record.delivery.status}`}>
                {deliveryLabel(record)}
              </strong>
              {occurrenceLabel(record) && (
                <span className="occurrence-state">{occurrenceLabel(record)}</span>
              )}
              <p>
                These controls manage future delivery or future routine runs. They do not freeze a
                timer countdown or undo notifications that were already delivered. The saved record
                remains in your history.
              </p>
              <div>
                {record.delivery.actions.includes("pause") && (
                  <button
                    disabled={busy}
                    onClick={() => void mutate(() => api.task(record.delivery!.taskId, "pause"))}
                  >
                    Pause future delivery
                  </button>
                )}
                {record.delivery.actions.includes("resume") && (
                  <button
                    disabled={busy}
                    onClick={() => void mutate(() => api.task(record.delivery!.taskId, "resume"))}
                  >
                    Resume future delivery
                  </button>
                )}
                {record.delivery.actions.includes("cancel") && (
                  <button
                    disabled={busy}
                    onClick={() => void mutate(() => api.task(record.delivery!.taskId, "cancel"))}
                  >
                    Cancel future delivery
                  </button>
                )}
              </div>
            </section>
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
                  api.patchRecord(record.id, {
                    title,
                    body,
                    expectedRevision: record.revision,
                  }),
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
  cancelBuild,
  busy,
}: {
  plugins: PluginSummary[];
  open: (p: PluginSummary) => void;
  changed: (message: string) => Promise<void>;
  build: (s: string) => Promise<void>;
  cancelBuild: () => void;
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
        {busy ? (
          <div className="build-progress" role="status">
            <span>Ellie is building your app. This can take up to two minutes.</span>
            <button type="button" onClick={cancelBuild}>
              Cancel
            </button>
          </div>
        ) : (
          <button disabled={!idea.trim()}>Build it</button>
        )}
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
              <span className="game-teams">
                <strong>{String(game.away ?? "Away")}</strong> at{" "}
                <strong>{String(game.home ?? "Home")}</strong>
              </span>
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
  const revisionRequest = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
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
      mounted.current = false;
      revisionRequest.current?.abort();
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
  const revise = async () => {
    const controller = new AbortController();
    revisionRequest.current = controller;
    setBusy("revise");
    setError("");
    try {
      await api.revisePlugin(plugin.id, request.trim(), plugin.version, controller.signal);
      await changed("App revision created");
    } catch (cause) {
      const stopped =
        controller.signal.aborted ||
        (cause instanceof ApiError && cause.status === 408) ||
        (cause instanceof DOMException && cause.name === "AbortError");
      if (!mounted.current) return;
      if (stopped) {
        await changed("Revision request cancelled");
        return;
      }
      setError(cause instanceof Error ? cause.message : "The app could not be updated.");
    } finally {
      if (mounted.current && revisionRequest.current === controller) {
        revisionRequest.current = undefined;
        setBusy("");
      }
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
        onClick={() => void revise()}
      >
        {busy === "revise" ? "Revising…" : "Create revision"}
      </button>
      {busy === "revise" && (
        <div className="revision-progress" role="status">
          <span>Ellie is preparing a new version. The current app stays active.</span>
          <button type="button" onClick={() => revisionRequest.current?.abort()}>
            Cancel revision
          </button>
        </div>
      )}
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
  openGuidance,
}: {
  data: Bootstrap;
  busy: string;
  act: (id: string, a: "pause" | "resume" | "cancel" | "run") => void;
  openGuidance: () => void;
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
      <LearningPanel userId={data.profile.id} openGuidance={openGuidance} />
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
function LearningPanel({ userId, openGuidance }: { userId: string; openGuidance: () => void }) {
  const [records, setRecords] = useState<LifeRecord[]>([]),
    [proposals, setProposals] = useState<ImprovementProposal[]>([]),
    [modelAvailable, setModelAvailable] = useState(true),
    [improvementSelected, setImprovementSelected] = useState<Set<string>>(new Set()),
    [goal, setGoal] = useState(""),
    [review, setReview] = useState<ImprovementProposal | null>(null),
    [working, setWorking] = useState(""),
    [error, setError] = useState("");
  const proposalRequest = useRef<AbortController | undefined>(undefined);
  const learningMounted = useRef(true);
  const load = async () => {
    try {
      const [learning, improvements] = await Promise.all([
        api.learning.list(`user:${userId}`),
        api.improvements.list(),
      ]);
      setRecords(learning.records);
      setProposals(improvements.proposals);
      setModelAvailable(improvements.modelAvailable);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Feedback could not load.");
    }
  };
  useEffect(() => {
    learningMounted.current = true;
    void load();
    return () => {
      learningMounted.current = false;
      proposalRequest.current?.abort();
    };
  }, [userId]);
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
      <section className="improvement-builder">
        <div>
          <h3>Propose a private improvement</h3>
          <p>
            Choose one to three examples. Ellie previews them offline; no actions are run, model
            weights do not change, and the preview does not prove the suggestion is better.
          </p>
        </div>
        <label>
          Optional goal
          <input
            value={goal}
            maxLength={1000}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="For example, ask one clear follow-up question"
          />
        </label>
        <div>
          <button
            className="primary"
            disabled={working === "propose" || improvementSelected.size < 1 || !modelAvailable}
            onClick={() => {
              const controller = new AbortController();
              proposalRequest.current?.abort();
              proposalRequest.current = controller;
              setWorking("propose");
              setError("");
              const feedback = records
                .filter((record) => improvementSelected.has(record.id))
                .slice(0, 3)
                .map((record) => ({ id: record.id, revision: record.revision }));
              void api.improvements
                .propose(feedback, goal, controller.signal)
                .then(async (proposal) => {
                  if (!learningMounted.current || proposalRequest.current !== controller) return;
                  setReview(proposal);
                  setImprovementSelected(new Set());
                  await load();
                })
                .catch((cause) => {
                  if (!learningMounted.current || proposalRequest.current !== controller) return;
                  if (controller.signal.aborted) setError("Improvement request cancelled.");
                  else
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "An improvement could not be proposed.",
                    );
                })
                .finally(() => {
                  if (learningMounted.current && proposalRequest.current === controller) {
                    proposalRequest.current = undefined;
                    setWorking("");
                  }
                });
            }}
          >
            {working === "propose" ? "Preparing offline previews…" : "Propose improvement"}
          </button>
          {working === "propose" && (
            <button type="button" onClick={() => proposalRequest.current?.abort()}>
              Cancel
            </button>
          )}
        </div>
        {!modelAvailable && (
          <p className="settings-error">
            A local model with improvement previews must be configured and available first.
          </p>
        )}
      </section>
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
            <label>
              <input
                type="checkbox"
                checked={improvementSelected.has(record.id)}
                disabled={!improvementSelected.has(record.id) && improvementSelected.size >= 3}
                onChange={(event) =>
                  setImprovementSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(record.id);
                    else next.delete(record.id);
                    return next;
                  })
                }
              />{" "}
              Use privately for an improvement proposal
            </label>
          </article>
        );
      })}
      {proposals.length > 0 && (
        <section className="improvement-list">
          <h3>Private improvement proposals</h3>
          <p>These remain personal even while you are viewing a shared space.</p>
          {proposals.map((proposal) => (
            <article key={proposal.record.id}>
              <div>
                <strong>{proposal.record.title}</strong>
                <span>{proposal.status}</span>
              </div>
              <button onClick={() => setReview(proposal)}>Review</button>
            </article>
          ))}
        </section>
      )}
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <ImprovementReview
          proposal={review}
          close={() => setReview(null)}
          openGuidance={openGuidance}
          changed={async (next) => {
            setReview(next);
            await load();
          }}
        />
      )}
    </section>
  );
}
function ImprovementReview({
  proposal,
  close,
  changed,
  openGuidance,
}: {
  proposal: ImprovementProposal;
  close: () => void;
  changed: (proposal: ImprovementProposal) => Promise<void>;
  openGuidance: () => void;
}) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const mutate = async (action: "adopt" | "dismiss") => {
    setBusy(action);
    setError("");
    try {
      const next = await api.improvements[action](proposal.record.id, proposal.record.revision);
      await changed(next);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        try {
          await changed(await api.improvements.detail(proposal.record.id));
          setError("This proposal changed. Its current review is shown.");
        } catch (refreshError) {
          setError(
            refreshError instanceof Error ? refreshError.message : "Review could not refresh.",
          );
        }
      } else
        setError(cause instanceof Error ? cause.message : "The proposal could not be updated.");
    } finally {
      setBusy("");
    }
  };
  return (
    <Modal title={proposal.record.title} close={close} wide>
      <p className="impact">
        Private proposal · {proposal.status}. Reviewing or previewing runs no actions and does not
        change model weights.
      </p>
      {proposal.status === "stale" ? (
        <p className="settings-error">
          A selected feedback example changed or was removed. Replay text is hidden and this
          proposal cannot be adopted.
        </p>
      ) : (
        <>
          <section className="proposal-copy">
            <h3>Proposed guidance</h3>
            <p>{proposal.instructions}</p>
            <h3>Why Ellie proposed it</h3>
            <p>{proposal.rationale}</p>
          </section>
          <section className="preview-list">
            <h3>Offline example preview · no actions were run</h3>
            <p>Compare the replies yourself. This limited replay is not a quality score.</p>
            {proposal.previews.map((preview) => (
              <article key={preview.feedbackId}>
                <p>
                  <b>Example prompt</b>
                  {preview.prompt}
                </p>
                <div>
                  <blockquote>
                    <b>Before</b>
                    {preview.recordedResponse}
                  </blockquote>
                  <blockquote>
                    <b>With proposed guidance</b>
                    {preview.candidateResponse}
                  </blockquote>
                </div>
                {preview.preferredResponse && (
                  <p>
                    <b>Your correction</b>
                    {preview.preferredResponse}
                  </p>
                )}
              </article>
            ))}
          </section>
        </>
      )}
      {proposal.status === "ready" && (
        <div className="modal-actions">
          <button className="primary" disabled={Boolean(busy)} onClick={() => void mutate("adopt")}>
            {busy === "adopt" ? "Adopting…" : "Adopt as guidance"}
          </button>
          <button disabled={Boolean(busy)} onClick={() => void mutate("dismiss")}>
            {busy === "dismiss" ? "Dismissing…" : "Dismiss proposal"}
          </button>
        </div>
      )}
      {proposal.status === "adopted" && (
        <div className="success-note">
          <p>Adopted as private guidance. It did not change model weights.</p>
          <button onClick={openGuidance}>Open guidance in Your world</button>
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
function Settings({
  data,
  save,
  busy,
  openConnections,
  openMemory,
  openTools,
}: {
  data: Bootstrap;
  save: (scope: string, v: Record<string, unknown>) => Promise<void>;
  busy: boolean;
  openConnections: boolean;
  openMemory: () => void;
  openTools: () => void;
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
    ...data.groups.map((group) => ({
      id: `group:${group.id}`,
      name: group.name,
    })),
    { id: `user:${data.profile.id}`, name: "Personal" },
  ];
  const [settingsScope, setSettingsScope] = useState(
    openConnections
      ? `user:${data.profile.id}`
      : settingsScopes.some((item) => item.id === data.scope)
        ? data.scope
        : "default",
  );
  useEffect(() => {
    if (!openConnections) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById("connected-accounts")?.scrollIntoView({ block: "start" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [openConnections]);
  const update = (key: string, value: unknown) =>
    setValues((current) => {
      const next = { ...current, [key]: value };
      setJson(JSON.stringify(next, null, 2));
      return next;
    });
  const origin = (key: string) => origins[key] ?? "effective";
  const proactive =
    typeof values.proactiveSuggestions === "boolean"
      ? values.proactiveSuggestions
      : typeof values.proactive === "boolean"
        ? values.proactive
        : true;
  const quietHours =
    values.quietHours && typeof values.quietHours === "object"
      ? (values.quietHours as {
          enabled?: boolean;
          start?: number;
          end?: number;
        })
      : undefined;
  const quietHoursEnabled = Boolean(quietHours && quietHours.enabled !== false);
  const changed = () =>
    Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) => JSON.stringify(initial[key]) !== JSON.stringify(value),
      ),
    );
  return (
    <Page title="Settings" lede="Preferences for this scope. More specific choices take priority.">
      <div className="settings-model">
        <span>Conversation model</span>
        <ModelReadiness />
      </div>
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
        <Setting
          label="Proactive suggestions"
          origin={origins.proactiveSuggestions ?? origin("proactive")}
        >
          <label className="switch">
            <input
              type="checkbox"
              checked={proactive}
              onChange={(event) => update("proactiveSuggestions", event.target.checked)}
            />
            <span>Let Ellie surface timely, useful suggestions</span>
          </label>
        </Setting>
        <Setting label="Quiet hours" origin={origin("quietHours")}>
          <label className="switch">
            <input
              type="checkbox"
              checked={quietHoursEnabled}
              onChange={(event) =>
                update(
                  "quietHours",
                  event.target.checked
                    ? {
                        enabled: true,
                        start: quietHours?.start ?? 22,
                        end: quietHours?.end ?? 7,
                      }
                    : {
                        enabled: false,
                        start: quietHours?.start ?? 22,
                        end: quietHours?.end ?? 7,
                      },
                )
              }
            />
            <span>Hold proactive notifications overnight</span>
          </label>
          {quietHoursEnabled && (
            <div className="hours">
              <label>
                From{" "}
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={Number(quietHours?.start ?? 22)}
                  onChange={(event) =>
                    update("quietHours", {
                      ...quietHours,
                      enabled: true,
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
                  value={Number(quietHours?.end ?? 7)}
                  onChange={(event) =>
                    update("quietHours", {
                      ...quietHours,
                      enabled: true,
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
      {settingsScope === `user:${data.profile.id}` && <Connections />}
      <details className="library-settings">
        <summary>Library and tools</summary>
        <p>Review what Ellie remembers or manage tools you’ve already made.</p>
        <button onClick={openMemory}>
          <InterfaceIcon name="world" /> Manage saved memory <InterfaceIcon name="arrow" />
        </button>
        <button onClick={openTools}>
          <InterfaceIcon name="space" /> Open custom tools <InterfaceIcon name="arrow" />
        </button>
      </details>
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
      const stores = [
        "life",
        "tasks",
        "plugins",
        ...(review.generations.connectors === undefined ? [] : (["connectors"] as const)),
      ] as const;
      for (const store of stores) {
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
        These controls cover your private records, settings, work, guidance, connected accounts and
        evidence, apps, and app storage. Shared group records, apps, tasks, and memberships stay in
        place. Your own storage inside a shared app is removed by reset.
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
            {review.counts.connections !== undefined && (
              <div>
                <dt>Connected evidence</dt>
                <dd>
                  {review.counts.connections} account
                  {review.counts.connections === 1 ? "" : "s"} ·{" "}
                  {review.counts.connectedEvidence ?? 0}
                </dd>
              </div>
            )}
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
function GroupManager({
  initial,
  close,
  open,
  changed,
}: {
  initial: Group[];
  close: () => void;
  open: (group: Group) => void;
  changed: () => Promise<void>;
}) {
  const [groups, setGroups] = useState(initial),
    [name, setName] = useState(""),
    [editing, setEditing] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const group = await api.groups.create(name.trim());
      setGroups((current) => [...current, group]);
      setName("");
      await changed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The shared space could not be created.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Shared spaces" close={close}>
      <p className="impact">
        Shared spaces keep selected records and apps together on this device. Your conversations
        remain private.
      </p>
      <form
        className="group-create"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <label>
          New space name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <button className="primary" disabled={busy || !name.trim()}>
          Create space
        </button>
      </form>
      <div className="group-list">
        {groups.map((group) => (
          <article key={group.id}>
            {editing === group.id ? (
              <input
                aria-label={`Rename ${group.name}`}
                defaultValue={group.name}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const next = event.currentTarget.value.trim();
                  if (!next) return;
                  setBusy(true);
                  void api.groups
                    .rename(group.id, next, group.revision)
                    .then(async (updated) => {
                      setGroups((current) =>
                        current.map((item) => (item.id === updated.id ? updated : item)),
                      );
                      setEditing("");
                      await changed();
                    })
                    .catch(async (cause) => {
                      if (cause instanceof ApiError && cause.status === 409) {
                        try {
                          const current = await api.groups.list();
                          setGroups(current.groups);
                          await changed();
                          setEditing("");
                          setError("That space was renamed elsewhere. Its current name is shown.");
                        } catch (refreshError) {
                          setError(
                            refreshError instanceof Error
                              ? refreshError.message
                              : "The current space name could not be loaded.",
                          );
                        }
                      } else setError(cause instanceof Error ? cause.message : "Rename failed.");
                    })
                    .finally(() => setBusy(false));
                }}
              />
            ) : (
              <div>
                <strong>{group.name}</strong>
                <span>{group.role === "owner" ? "You own this space" : "Member"}</span>
              </div>
            )}
            <div>
              {group.role === "owner" && editing !== group.id && (
                <button onClick={() => setEditing(group.id)}>Rename</button>
              )}
              <button className="primary" onClick={() => open(group)}>
                Open
              </button>
            </div>
          </article>
        ))}
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
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
