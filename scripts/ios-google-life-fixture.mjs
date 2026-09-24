import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { ConnectorBroker } from "../packages/life-connectors/src/broker.ts";
import { ConnectorStore } from "../packages/life-connectors/src/store.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { createLifeHarness } from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { createLifeServer } from "../apps/life/src/server.ts";
import { NativeLifeAuthority } from "../apps/server/src/native-life.ts";
import { createIOSQuietLifeFixture } from "./ios-quiet-life-fixture.mjs";

const actorId = "ios-google-fixture-owner";
const calendarScope = "https://www.googleapis.com/auth/calendar.readonly";
const gmailScope = "https://www.googleapis.com/auth/gmail.readonly";

class MemoryVault {
  values = new Map();
  put(id, value) {
    this.values.set(id, structuredClone(value));
  }
  get(id) {
    const value = this.values.get(id);
    return value ? structuredClone(value) : undefined;
  }
  delete(id) {
    this.values.delete(id);
  }
  deleteMatching(predicate) {
    const selected = [...this.values].filter(([id, value]) => predicate(id, value));
    for (const [id] of selected) this.values.delete(id);
    return selected.length;
  }
}

/** Synthetic providers behind the real embedded Life routes; no Google network or OAuth. */
export async function createIOSGoogleLifeFixture({
  directory,
  nativeAuth,
  grantedClientIds,
  quiet = false,
}) {
  const now = Date.now();
  const vault = new MemoryVault();
  const reads = new Map();
  let heldRead;
  let heldReadStarted = 0;
  let heldReadCompleted = 0;
  let heldHandled = 0;
  let changeCalendarAfterNextList = false;
  let calendarChanges = 0;
  let calendarChange;
  let restoreCalendarAfterNextAgenda = false;
  let chatPlans = 0;
  const event = (sourceKey, title, startAt) => ({
    sourceKey,
    sourceRevision: "fixture-v1",
    observedAt: now - 60_000,
    title,
    kind: "event",
    data: {
      startAt,
      endAt: startAt + 3_600_000,
      status: "confirmed",
      organizerIsSelf: true,
      timeZone: "America/Los_Angeles",
    },
  });
  const messages = [
    ["unicode_message", "Family 👩‍👩‍👧‍👦", "Preview 👩‍👩‍👧‍👦"],
    ["truncated_message", "Truncated body", "Partial preview"],
    ["unavailable_message", "HTML-only message", "Snippet only"],
    ["held_message", "Delayed body", "Pending preview"],
  ].map(([sourceKey, title, snippet], index) => ({
    sourceKey,
    sourceRevision: "fixture-v1",
    observedAt: now - index * 1_000,
    title,
    kind: "message",
    data: {
      sentAt: now - index * 1_000,
      from: "sender@example.test",
      to: ["owner@example.test"],
      subject: title,
      snippet,
      direction: "incoming",
    },
  }));
  const calendar = {
    id: "google-calendar",
    async identity() {
      return { accountId: "calendar-fixture-account", label: "Family 👩‍👩‍👧‍👦 calendar" };
    },
    async calendars() {
      return [
        { id: "primary", label: "Primary", primary: true },
        { id: "selected@example.test", label: "Selected", primary: false },
      ];
    },
    async pull(input) {
      return {
        accountId: "calendar-fixture-account",
        items:
          input.resourceId === "selected@example.test"
            ? [event("selected-event", "Selected family visit 👩‍👩‍👧‍👦", now + 4 * 86_400_000)]
            : [event("primary-event", "Wrong primary event", now + 3 * 86_400_000)],
        cursor: "fixture-cursor",
        complete: true,
      };
    },
  };
  const gmail = {
    id: "gmail",
    async identity() {
      return { accountId: "gmail-fixture-account", label: "Family 👩‍👩‍👧‍👦 inbox" };
    },
    async pull() {
      return {
        accountId: "gmail-fixture-account",
        items: messages,
        cursor: "fixture-cursor",
        complete: true,
      };
    },
    async readMessageText(messageId) {
      reads.set(messageId, (reads.get(messageId) ?? 0) + 1);
      if (messageId === "unicode_message")
        return { status: "plain", text: "Line one\r\nLine two 👩‍👩‍👧‍👦\n" };
      if (messageId === "truncated_message")
        return { status: "truncated", text: "Partial text", additionalPartsOmitted: true };
      if (messageId === "unavailable_message") return { status: "unavailable" };
      if (messageId !== "held_message" || heldRead)
        throw new Error("Unexpected synthetic Gmail body request.");
      heldReadStarted += 1;
      await new Promise((resolve) => {
        heldRead = resolve;
      });
      heldRead = undefined;
      heldReadCompleted += 1;
      return { status: "plain", text: "Late private fixture body" };
    },
  };
  let life,
    plugins,
    tasks,
    connectorStore,
    connectors,
    nativeLife,
    server,
    connectionIds,
    quietFixture;
  let failServerCloseOnce = false;
  async function closeOwned() {
    heldRead?.();
    quietFixture?.releaseAll();
    for (const close of [
      () => {
        if (failServerCloseOnce) {
          failServerCloseOnce = false;
          throw new Error("Synthetic server close failure.");
        }
        return server?.close();
      },
      () => nativeLife?.close(),
      () => connectors?.close(),
      () => tasks?.close(),
      () => connectorStore?.close(),
      () => plugins?.close(),
      () => life?.close(),
    ]) {
      try {
        await close();
      } catch {
        const failure = new Error("Synthetic Google fixture cleanup is uncertain.");
        failure.fixtureCleanupUncertain = true;
        throw failure;
      }
    }
  }
  try {
    await mkdir(join(directory, "tasks"), { mode: 0o700 });
    life = new LifeStore(join(directory, "life.sqlite"));
    plugins = new PluginStore(join(directory, "plugins.sqlite"));
    tasks = new TaskRuntime({
      directory: join(directory, "tasks"),
      capabilityResolver: () => [
        "life.records.read",
        "life.records.write",
        "life.connections.read",
        "life.connections.write",
      ],
    });
    connectorStore = new ConnectorStore(join(directory, "connectors.sqlite"));
    connectors = new ConnectorBroker({
      store: connectorStore,
      life,
      vault,
      providers: [calendar, gmail],
      tasks,
    });
    nativeLife = NativeLifeAuthority.memory(nativeAuth, [actorId]);
    const calendarConnection = await connectors.connect(
      actorId,
      "google-calendar",
      { accessToken: "synthetic-calendar" },
      "observe",
      [calendarScope],
    );
    await connectors.selectCalendar(actorId, calendarConnection.id, "selected@example.test");
    await connectors.sync(actorId, calendarConnection.id);
    const gmailConnection = await connectors.connect(
      actorId,
      "gmail",
      { accessToken: "synthetic-gmail" },
      "observe",
      [gmailScope],
    );
    await connectors.sync(actorId, gmailConnection.id);
    connectionIds = { calendar: calendarConnection.id, gmail: gmailConnection.id };
    for (const clientId of grantedClientIds)
      await nativeLife.grant({ clientId, actorId, capability: "life.account" });
    const harness = createLifeHarness({
      store: life,
      tasks,
      plugins,
      mlb: new MLBAdapter(),
      model: {
        async plan() {
          chatPlans += 1;
          return { reply: "Family 👩‍👩‍👧‍👧\r\n日本語 read-only answer.", actions: [] };
        },
      },
    });
    server = createLifeServer({
      stateDir: directory,
      store: life,
      tasks,
      plugins,
      harness,
      connectors,
      userId: actorId,
    });
    await server.prepareEmbedded();
    if (quiet) quietFixture = await createIOSQuietLifeFixture({ life, tasks, actorId });
  } catch (error) {
    try {
      await closeOwned();
    } catch {
      const failure = new Error("Synthetic Google fixture setup cleanup is uncertain.");
      failure.fixtureCleanupUncertain = true;
      throw failure;
    }
    throw error;
  }
  return {
    nativeLife,
    lifeApplication: {
      async handle(request, response, context) {
        const path = request.url?.split("?", 1)[0] ?? "";
        const held = /^\/api\/connections\/[^/]+\/messages\/held_message$/.test(path);
        const changeCalendar =
          request.method === "GET" && path === "/api/connections" && changeCalendarAfterNextList;
        const agenda = request.method === "GET" && /^\/api\/connections\/[^/]+\/agenda$/.test(path);
        let finishCalendarChange;
        if (changeCalendar) changeCalendarAfterNextList = false;
        if (changeCalendar)
          calendarChange = new Promise((resolve) => {
            finishCalendarChange = resolve;
          });
        try {
          if (agenda && calendarChange) await calendarChange;
          const restoreCalendar = agenda && restoreCalendarAfterNextAgenda;
          if (restoreCalendar) restoreCalendarAfterNextAgenda = false;
          const perform = () => server.handleEmbedded(request, response, context);
          const result = quietFixture
            ? await quietFixture.handle(request, response, perform)
            : await perform();
          if (changeCalendar) {
            try {
              const current = connectorStore.require(actorId, connectionIds.calendar);
              // Change only the owned fixture connection. Broker selection also schedules
              // research, which is unrelated to this list/agenda consistency race.
              connectorStore.selectCalendar(
                actorId,
                connectionIds.calendar,
                current.generation,
                "primary",
              );
              restoreCalendarAfterNextAgenda = true;
            } finally {
              finishCalendarChange();
              calendarChange = undefined;
            }
          } else if (restoreCalendar) {
            const current = connectorStore.require(actorId, connectionIds.calendar);
            connectorStore.selectCalendar(
              actorId,
              connectionIds.calendar,
              current.generation,
              "selected@example.test",
            );
            await connectors.sync(actorId, connectionIds.calendar);
            calendarChanges += 1;
          }
          return result;
        } finally {
          if (held) heldHandled += 1;
        }
      },
    },
    connectionIds,
    quiet: quietFixture,
    control: {
      chatEvidence: () => ({
        plans: chatPlans,
        conversations: life.listConversations(
          { userId: actorId },
          {
            scope: { type: "user", id: actorId },
          },
        ).items.length,
        records: life.listRecords({ userId: actorId }, { scope: { type: "user", id: actorId } })
          .length,
        tasks: tasks.list({ owner: `user:${actorId}` }).length,
      }),
      bodyReads: () => Object.fromEntries(reads),
      heldReadStarted: () => heldReadStarted,
      heldReadCompleted: () => heldReadCompleted,
      heldHandled: () => heldHandled,
      armCalendarChangeAfterNextList: () => {
        changeCalendarAfterNextList = true;
      },
      calendarChanges: () => calendarChanges,
      releaseHeld: () => {
        const release = heldRead;
        heldRead = undefined;
        release?.();
      },
      failNextServerCloseForTest: () => {
        failServerCloseOnce = true;
      },
    },
    close: closeOwned,
  };
}
