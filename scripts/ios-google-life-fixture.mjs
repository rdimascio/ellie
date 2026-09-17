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
export async function createIOSGoogleLifeFixture({ directory, nativeAuth, grantedClientIds }) {
  const now = Date.now();
  await mkdir(join(directory, "tasks"), { mode: 0o700 });
  const life = new LifeStore(join(directory, "life.sqlite"));
  const plugins = new PluginStore(join(directory, "plugins.sqlite"));
  const tasks = new TaskRuntime({
    directory: join(directory, "tasks"),
    capabilityResolver: () => [
      "life.records.read",
      "life.records.write",
      "life.connections.read",
      "life.connections.write",
    ],
  });
  const connectorStore = new ConnectorStore(join(directory, "connectors.sqlite"));
  const vault = new MemoryVault();
  const reads = new Map();
  let heldRead;
  let heldReadStarted = 0;
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
      return { status: "plain", text: "Late private fixture body" };
    },
  };
  const connectors = new ConnectorBroker({
    store: connectorStore,
    life,
    vault,
    providers: [calendar, gmail],
    tasks,
  });
  const nativeLife = NativeLifeAuthority.memory(nativeAuth, [actorId]);
  let server;
  let connectionIds;
  try {
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
  } catch (error) {
    heldRead?.();
    await server?.close().catch(() => {});
    await nativeLife.close().catch(() => {});
    await connectors.close().catch(() => {});
    await tasks.close().catch(() => {});
    connectorStore.close();
    plugins.close();
    life.close();
    throw error;
  }
  return {
    nativeLife,
    lifeApplication: {
      handle: (request, response, context) => server.handleEmbedded(request, response, context),
    },
    connectionIds,
    control: {
      bodyReads: () => Object.fromEntries(reads),
      heldReadStarted: () => heldReadStarted,
      releaseHeld: () => {
        const release = heldRead;
        heldRead = undefined;
        release?.();
      },
    },
    async close() {
      heldRead?.();
      await server.close();
      await nativeLife.close();
      await connectors.close();
      await tasks.close();
      connectorStore.close();
      plugins.close();
      life.close();
    },
  };
}
