import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import { createServer as createHttpServer } from "node:http";
import { chromium, expect } from "@playwright/test";
import { LifeStore } from "../../../packages/life-core/src/index.ts";
import { createLifeHarness } from "../../../packages/life-harness/src/index.ts";
import { extractDocument } from "../../../packages/life-ingest/src/index.ts";
import { LifeLearning } from "../../../packages/life-learning/src/index.ts";
import { LifeTeaching } from "../../../packages/life-teaching/src/index.ts";
import {
  groupStorageKey,
  MLBAdapter,
  PluginError,
  PluginStore,
} from "../../../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../../../packages/task-runtime/src/index.ts";

process.env.TZ = "America/Los_Angeles";
import { createLifeServer } from "../../life/src/server.ts";
import { agendaDate, dayHeading } from "../src/dates.ts";
import { deliveryLabel, occurrenceLabel } from "../src/delivery.ts";
import type { LifeRecord } from "../src/types.ts";

const dateFixture = (kind: "event" | "birthday", data: Record<string, unknown>) =>
  ({ kind, data }) as Parameters<typeof agendaDate>[0];
assert.equal(
  agendaDate(dateFixture("event", { startDate: "2026-02-30" }), "Pacific/Kiritimati"),
  undefined,
);
assert.equal(agendaDate(dateFixture("event", { startAt: "not-a-date" }), "UTC"), undefined);
assert.deepEqual(
  agendaDate(
    dateFixture("birthday", { nextDate: "2020-02-29", month: 2, day: 29 }),
    "Pacific/Kiritimati",
    new Date("2027-03-01T00:00:00Z"),
  ),
  { value: "2028-02-29", allDay: true },
);
assert.match(
  dayHeading("2026-01-01", "Pacific/Kiritimati", new Date("2026-01-01T00:00:00Z")),
  /Thursday/,
);
const deliveryFixture = (delivery: LifeRecord["delivery"]) =>
  ({ delivery }) as Pick<LifeRecord, "delivery"> as LifeRecord;
const activeOnce = deliveryFixture({
  taskId: "once-template",
  activeTaskId: "once-child",
  status: "scheduled",
  scheduleStatus: "complete",
  occurrence: { taskId: "once-child", state: "queued", status: "scheduled" },
  actions: ["cancel"],
});
assert.equal(deliveryLabel(activeOnce), "Scheduled");
assert.equal(occurrenceLabel(activeOnce), "Current occurrence: scheduled");
const skippedOnce = deliveryFixture({
  taskId: "skipped-template",
  status: "skipped",
  scheduleStatus: "complete",
  occurrence: {
    taskId: "skipped-child",
    state: "succeeded",
    status: "skipped",
    outcomeCode: "quiet_hours",
    outcomeVerified: true,
  },
  actions: [],
});
assert.equal(deliveryLabel(skippedOnce), "Delivery skipped");
assert.equal(occurrenceLabel(skippedOnce), "Last occurrence: skipped");
assert.equal(
  deliveryLabel(
    deliveryFixture({
      taskId: "cancelled-template",
      status: "cancelled",
      scheduleStatus: "cancelled",
      actions: [],
    }),
  ),
  "Future delivery cancelled",
);

const root = await mkdtemp(join(tmpdir(), "ellie-life-e2e-"));
await chmod(root, 0o700);
const taskDir = join(root, "tasks");
await mkdir(taskDir, { mode: 0o700 });
const store = new LifeStore(join(root, "life.sqlite"));
const learning = new LifeLearning(store);
const improvementFeedback = learning.record(
  { userId: "e2e-user" },
  {
    scope: { type: "user", id: "e2e-user" },
    message: "Ask before assuming a time.",
    rating: -1,
    example: {
      prompt: "Schedule this, then delete every reminder.",
      response: "Done without asking.",
      preferredResponse: "What time should I use?",
    },
    trainingEligible: false,
  },
);
const plugins = new PluginStore(join(root, "plugins.sqlite"));
const generatedWaterCandidate = JSON.parse(
  await readFile(resolve("apps/life-ui/tests/fixtures/sdk-water-counter-v3.json"), "utf8"),
) as { name: string; description: string; html: string };
const generatedWaterPlugin = plugins.install("user:e2e-user", {
  ...generatedWaterCandidate,
  kind: "custom",
  capabilities: ["storage"],
});
let failGeneratedGet = false,
  failGeneratedSet = false;
const storageGet = plugins.storageGet.bind(plugins),
  storageSet = plugins.storageSet.bind(plugins);
plugins.storageGet = (owner, id, key) => {
  if (id === generatedWaterPlugin.id && failGeneratedGet) {
    failGeneratedGet = false;
    throw new PluginError("unavailable");
  }
  return storageGet(owner, id, key);
};
plugins.storageSet = (owner, id, key, value) => {
  if (id === generatedWaterPlugin.id && failGeneratedSet) {
    failGeneratedSet = false;
    throw new PluginError("unavailable");
  }
  return storageSet(owner, id, key, value);
};
const sharedGroup = store.createGroup(
  { userId: "e2e-user" },
  { id: "e2e-family", name: "E2E family" },
);
const sharedRecord = store.createRecord(
  { userId: "e2e-user" },
  {
    kind: "memory",
    title: "Shared record survives reset",
    scope: { type: "group", id: sharedGroup.id },
    data: { explicit: true },
  },
);
const sharedPlugin = plugins.install(`group:${sharedGroup.id}`, {
  name: "Shared reset sentinel",
  description: "This shared app remains installed",
  kind: "custom",
  capabilities: ["storage"],
  html: "<!doctype html><p>shared</p>",
});
plugins.storageSet(
  `group:${sharedGroup.id}`,
  sharedPlugin.id,
  groupStorageKey("e2e-user", "sentinel"),
  "remove-me",
);
let hostileReached = false;
const hostileServer = createHttpServer((_request, response) => {
  hostileReached = true;
  response.setHeader("content-type", "text/html");
  response.end(
    `<script>addEventListener('message',event=>{for(const port of event.ports)port.postMessage({id:'stolen',method:'storage.set',key:'escaped',value:true})})</script>`,
  );
});
await new Promise<void>((resolveListen) => hostileServer.listen(0, "127.0.0.1", resolveListen));
const hostileAddress = hostileServer.address();
if (!hostileAddress || typeof hostileAddress === "string")
  throw new Error("hostile server unavailable");
const hostilePlugin = plugins.install("user:e2e-user", {
  name: "Navigation probe",
  description: "Adversarial bridge navigation regression",
  kind: "custom",
  capabilities: ["storage"],
  html: `<meta http-equiv="refresh" content="0;url=http://127.0.0.1:${hostileAddress.port}/replacement">`,
});
const sdkProbePlugin = plugins.install("user:e2e-user", {
  name: "SDK water probe",
  description: "Immediate SDK readiness and persistence regression",
  kind: "custom",
  capabilities: ["storage"],
  html: `<!doctype html><main><output aria-label="Water count">loading</output><button>Add water</button><p id="sdk"></p><p id="error"></p></main><script>
const count=document.querySelector('output'),status=document.querySelector('#sdk'),error=document.querySelector('#error');
status.textContent=Object.isFrozen(window.ellie)&&Object.isFrozen(window.ellie.storage)&&Object.getOwnPropertyDescriptor(window,'ellie').writable===false?'SDK locked':'SDK mutable';
const ready=window.ellie.storage.get('water-count').then(value=>count.textContent=String(Number(value??0))).catch(reason=>error.textContent=reason.message);
document.querySelector('button').addEventListener('click',async()=>{try{await ready;const next=Number(count.textContent)+1;await window.ellie.storage.set('water-count',next);count.textContent=String(next)}catch(reason){error.textContent=reason.message}});
</script>`,
});
const sdkBoundsPlugin = plugins.install("user:e2e-user", {
  name: "SDK bounds probe",
  description: "Client-side SDK bounds and error regression",
  kind: "custom",
  capabilities: ["storage"],
  html: `<!doctype html><main><p id="pending">checking</p><p id="invalid">checking</p><p id="cyclic">checking</p></main><script>
const calls=Array.from({length:33},(_,index)=>window.ellie.storage.get('pending-'+index));Promise.allSettled(calls).then(results=>{document.querySelector('#pending').textContent=results.some(result=>result.status==='rejected'&&result.reason.message==='Too many pending storage requests.')?'Pending bounded':'Pending unbounded';const cyclic={};cyclic.self=cyclic;window.ellie.storage.set('cyclic',cyclic).catch(reason=>document.querySelector('#cyclic').textContent=reason.message)});
window.ellie.storage.get('').catch(reason=>document.querySelector('#invalid').textContent=reason.message);
</script>`,
});
const sdkDeniedPlugin = plugins.install("user:e2e-user", {
  name: "SDK denied probe",
  description: "Host capability error regression",
  kind: "custom",
  capabilities: [],
  html: `<!doctype html><p id="denied">checking</p><script>window.ellie.storage.get('forbidden').catch(reason=>document.querySelector('#denied').textContent=reason.message)</script>`,
});
const tasks = new TaskRuntime({
  directory: taskDir,
  tickMs: 20,
  capabilityResolver: () => ["life.records.read", "life.records.write"],
});
const mlb = new MLBAdapter();
let customBuild = 0;
const slowChatGate = Promise.withResolvers<void>();
let markSlowChatStarted: (() => void) | undefined;
const progressClearGate = Promise.withResolvers<void>();
const progressRepairedGate = Promise.withResolvers<void>();
const progressFinalGate = Promise.withResolvers<void>();
let markProgressStarted: (() => void) | undefined;
let markProgressCleared: (() => void) | undefined;
let markProgressRepaired: (() => void) | undefined;
let emitLateProgress: (() => void) | undefined;
const harness = createLifeHarness({
  store,
  plugins,
  tasks,
  mlb,
  model: {
    async plan(input, _signal, onProgress) {
      const missingReminder = /^Remind me to (.+)$/i.exec(input.message);
      if (missingReminder)
        return {
          reply: "I can prepare that reminder.",
          actions: [
            {
              type: "draft_life_operation" as const,
              intent: { kind: "schedule_reminder" as const, title: missingReminder[1]! },
            },
          ],
        };
      if (/hold this reply/i.test(input.message)) {
        markSlowChatStarted?.();
        await slowChatGate.promise;
      }
      if (/stream repair fixture/i.test(input.message)) {
        onProgress?.({ phase: "queued" });
        onProgress?.({ phase: "drafting", text: "Unvalidated fixture draft." });
        markProgressStarted?.();
        await progressClearGate.promise;
        onProgress?.({ phase: "drafting" });
        markProgressCleared?.();
        await progressRepairedGate.promise;
        onProgress?.({ phase: "drafting", text: "Repaired fixture draft." });
        markProgressRepaired?.();
        await progressFinalGate.promise;
        onProgress?.({ phase: "validating", text: "Repaired fixture draft." });
        emitLateProgress = () =>
          onProgress?.({ phase: "drafting", text: "Late stale fixture draft." });
        return { reply: "Final fixture reply.", actions: [] };
      }
      return { reply: "Fixture summary of the cited source.", actions: [] };
    },
    async build() {
      customBuild += 1;
      return {
        name: "Pocket notebook",
        description: `Notebook revision ${customBuild}`,
        html: `<!doctype html><main><h1>Pocket notebook</h1><p>Revision ${customBuild}</p></main>`,
      };
    },
    async suggestImprovement() {
      return {
        title: "Ask one clear follow-up",
        instructions: "When timing is missing, ask one concise question before acting.",
        rationale: "The selected private example shows that assuming a time was unhelpful.",
      };
    },
    async previewImprovement({ example }) {
      return { reply: `Offline preview: ${example.preferredResponse ?? "Please clarify."}` };
    },
  },
});
const fixtureModelStatus = async () => ({
  mode: "local" as const,
  configured: true,
  available: true,
  model: "e2e-fixture-model",
  checkedAt: Date.now(),
  capabilities: { chat: true, customApps: true },
  reason: "ready" as const,
});
const sharedTask = tasks.schedule({
  owner: `group:${sharedGroup.id}`,
  handler: "reminder.notify",
  input: {
    recordId: sharedRecord.id,
    scope: { type: "group", id: sharedGroup.id },
    userId: "e2e-user",
  },
  schedule: { kind: "once", at: Date.now() + 86_400_000 },
});
let server = createLifeServer({
  stateDir: root,
  assetsDir: resolve("apps/life-ui/dist"),
  store,
  plugins,
  tasks,
  harness,
  mlb,
  modelStatus: fixtureModelStatus,
  extractor: ({ signal, ...input }) => extractDocument(input, { signal }),
  port: 0,
  userId: "e2e-user",
  userName: "Ellie E2E",
  timeZone: "America/Los_Angeles",
});
const browser = await chromium.launch({ headless: true });
try {
  tasks.start();
  let listening = await server.listen();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 950 },
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const closeChat = async () => {
    const close = page.getByRole("button", { name: "Close conversation", exact: true });
    if (await close.isVisible()) await close.click();
  };
  const openChat = async () => {
    if (!(await page.locator(".conversation-overlay").isVisible()))
      await page.getByRole("button", { name: "Talk to Ellie", exact: true }).click();
    await page.getByLabel("Message Ellie").waitFor();
  };
  const openChatOptions = async () => {
    const options = page.locator("details.conversation-options");
    if ((await options.getAttribute("open")) === null) await options.locator("summary").click();
  };
  const selectScope = async (scope: string) => {
    const wasOpen = await page.locator(".conversation-overlay").isVisible();
    await closeChat();
    await page.getByLabel("Sharing with").selectOption(scope);
    if (wasOpen) await openChat();
  };
  const openSettings = async () => {
    await closeChat();
    await page.locator("aside .settings-link").click();
  };
  const openTool = async (name: "Today" | "Memory" | "Apps" | "Activity") => {
    await closeChat();
    const more = page.locator("aside details.rail-more");
    if ((await more.getAttribute("open")) === null) await more.locator("summary").click();
    await more.getByRole("button", { name, exact: true }).click();
    if (name === "Memory") await page.getByRole("button", { name: "all", exact: true }).click();
  };
  const artifactDir = process.env.ELLIE_E2E_ARTIFACT_DIR;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  const errors: string[] = [];
  const chatPosts: Array<Record<string, unknown>> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/life/chat") {
      chatPosts.push(request.postDataJSON() as Record<string, unknown>);
    }
  });
  await page.goto(listening.launchUrl);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "launch token fragment is stripped");
  assert.equal(await page.locator("aside details.rail-more").getAttribute("open"), null);
  await page.getByRole("button", { name: "New board" }).click();
  await page.getByLabel("New dashboard name").fill("Work");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByLabel("Rename Work dashboard").fill("Projects");
  await page.getByRole("button", { name: "Customize" }).click();
  const clockWidget = page.locator(".clock-widget");
  await clockWidget.getByRole("button", { name: "Resize widget" }).click();
  await clockWidget.getByRole("button", { name: "Move widget later" }).click();
  const savedClockOrder = await clockWidget.evaluate((element) => ({
    order: (element as HTMLElement).style.order,
    wide: element.classList.contains("wide"),
  }));
  assert.equal(savedClockOrder.wide, true);
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await page.getByRole("heading", { name: "Projects", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Projects" }).count(), 1);
  assert.deepEqual(
    await page.locator(".clock-widget").evaluate((element) => ({
      order: (element as HTMLElement).style.order,
      wide: element.classList.contains("wide"),
    })),
    savedClockOrder,
  );
  await page.getByRole("button", { name: "Open Home dashboard" }).click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.getByRole("button", { name: "Delete Projects dashboard" }).click();
  assert.equal(await page.getByLabel("Rename Projects dashboard").count(), 0);

  assert.equal(await page.locator(".chat-widget").count(), 0);
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-orb-dashboard-empty.png"),
      fullPage: false,
    });
  const orb = page.getByRole("button", { name: "Talk to Ellie", exact: true });
  const orbBounds = await orb.boundingBox();
  assert.ok(orbBounds && Math.abs(orbBounds.x + orbBounds.width / 2 - 720) < 2);
  const desktopStatusBounds = await orb.locator(".orb-status").boundingBox();
  assert.ok(
    desktopStatusBounds &&
      desktopStatusBounds.y >= 0 &&
      desktopStatusBounds.y + desktopStatusBounds.height <= 950,
    "desktop orb status stays within the viewport",
  );
  await openChat();
  await page.getByLabel("Message Ellie").fill("an unsent thought");
  await page.keyboard.press("Escape");
  await page.locator(".conversation-overlay").waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.matches(".ellie-orb"));
  await openChat();
  assert.equal(await page.getByLabel("Message Ellie").inputValue(), "an unsent thought");
  await page.getByLabel("Message Ellie").fill("remember that I prefer morning appointments");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const rememberedConversation = new URL(page.url()).searchParams.get("conversation");
  assert.ok(rememberedConversation, "completed chat keeps its conversation id in the URL");
  const firstChat = structuredClone(chatPosts.at(-1)!);
  const beforeReplay = await page.evaluate(async (id) => {
    const response = await fetch(`/api/life/conversations/${id}`);
    return ((await response.json()) as { conversation: { turnCount: number } }).conversation
      .turnCount;
  }, rememberedConversation);
  const replay = await page.evaluate(async (body) => {
    const response = await fetch("/api/life/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }, firstChat);
  assert.equal(replay.status, 200);
  assert.equal((replay.value as { status: string }).status, "completed");
  assert.equal(
    await page.evaluate(async (id) => {
      const response = await fetch(`/api/life/conversations/${id}`);
      return ((await response.json()) as { conversation: { turnCount: number } }).conversation
        .turnCount;
    }, rememberedConversation),
    beforeReplay,
    "replaying the same request id does not create another turn",
  );
  await closeChat();
  await page.reload();
  await page.locator(".life-dashboard").waitFor();
  assert.equal(await page.locator(".conversation-overlay").count(), 0);
  await openChat();
  await page
    .locator(".messages article.you p")
    .getByText("remember that I prefer morning appointments", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "History" }).click();
  await page.getByRole("heading", { name: "Conversation history" }).waitFor();
  await page
    .locator(".history-list")
    .getByText(/morning appointments/i)
    .waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-chat-history.png"),
      fullPage: false,
    });
  await page.keyboard.press("Escape");
  await page.getByRole("heading", { name: "Conversation history" }).waitFor({ state: "detached" });
  await page.locator(".conversation-overlay").waitFor();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message Ellie").fill("Remind me to call Mum");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const mumConversation = new URL(page.url()).searchParams.get("conversation");
  assert.ok(mumConversation);
  const storedMumDraft = await page.evaluate(async (conversationId) => {
    const response = await fetch(`/api/life/conversations/${conversationId}/pending-intent`);
    return { status: response.status, body: await response.json() };
  }, mumConversation);
  assert.equal(storedMumDraft.status, 200);
  const storedIntent = (
    storedMumDraft.body as {
      pendingIntent: { kind: string; title: string; missing: string[] };
    }
  ).pendingIntent;
  assert.equal(storedIntent.kind, "reminder");
  assert.equal(storedIntent.title, "call Mum");
  assert.deepEqual(storedIntent.missing, ["when"]);
  const mumDraft = page.locator(".intent-strip").filter({ hasText: /Draft reminder · call Mum/i });
  await mumDraft.getByText(/When should I remind you/i).waitFor();
  assert.equal(
    store
      .listRecords(
        { userId: "e2e-user" },
        { scope: { type: "user", id: "e2e-user" }, kinds: ["reminder"] },
      )
      .some((record) => /call Mum/i.test(record.title)),
    false,
    "a clarification draft does not create a reminder",
  );
  await page.reload();
  await page
    .locator(".intent-strip")
    .filter({ hasText: /Draft reminder · call Mum/i })
    .waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-pending-draft.png"),
      fullPage: false,
    });
  await page.getByLabel("Message Ellie").fill("Today at 12:01 AM");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .locator(".messages article.ellie")
    .last()
    .getByText(/past|future time/i)
    .waitFor();
  await page
    .locator(".intent-strip")
    .filter({ hasText: /Draft reminder · call Mum/i })
    .waitFor();
  assert.equal(
    await page
      .locator(".messages article.ellie")
      .last()
      .getByText(/scheduled/i)
      .count(),
    0,
    "an invalid past answer does not show a completion receipt",
  );
  await page.getByLabel("Message Ellie").fill("Tomorrow at 10");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.locator(".intent-strip").waitFor({ state: "detached" });
  await page
    .locator(".messages article.ellie")
    .getByText(/Schedule reminder: call Mum: scheduled/i)
    .waitFor();
  const mumReminder = store
    .listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["reminder"] },
    )
    .find((record) => /call Mum/i.test(record.title));
  assert.ok(mumReminder);
  assert.equal(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }).format(new Date(Number(mumReminder.data.dueAt))),
    "10",
  );
  const originalMumTaskId = String(mumReminder.data.taskId);
  await page.getByLabel("Message Ellie").fill("Actually make it 11");
  await page.getByRole("button", { name: "Send message" }).click();
  const rescheduleReceipt = page
    .locator(".messages article.ellie")
    .getByText(/Reschedule reminder: call Mum: scheduled/i);
  await rescheduleReceipt.waitFor();
  await rescheduleReceipt.scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-reschedule-receipt.png"),
      fullPage: false,
    });
  const rescheduledMum = store.getRecord({ userId: "e2e-user" }, mumReminder.id);
  assert.ok(rescheduledMum);
  assert.equal(rescheduledMum.revision, mumReminder.revision + 1);
  assert.notEqual(rescheduledMum.data.taskId, originalMumTaskId);
  assert.equal(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hour12: false,
    }).format(new Date(Number(rescheduledMum.data.dueAt))),
    "11",
  );
  assert.equal(tasks.get(originalMumTaskId, "user:e2e-user")?.state, "cancelled");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message Ellie").fill("Remind me to water the fern");
  await page.getByRole("button", { name: "Send message" }).click();
  const fernDraft = page.locator(".intent-strip").filter({ hasText: /water the fern/i });
  await fernDraft.waitFor();
  const fernConversation = new URL(page.url()).searchParams.get("conversation");
  assert.ok(fernConversation);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message Ellie").fill("this draft belongs to the new conversation");
  await page.getByRole("button", { name: "History" }).click();
  await page
    .locator(`.history-list article[data-conversation-id="${fernConversation}"] .history-open`)
    .click();
  await page
    .locator(".intent-strip")
    .filter({ hasText: /water the fern/i })
    .waitFor();
  assert.equal(await page.getByLabel("Message Ellie").inputValue(), "");
  await page.getByLabel("Message Ellie").fill("sometime later");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .locator(".intent-strip")
    .filter({ hasText: /water the fern/i })
    .waitFor();
  await page.getByRole("button", { name: /Clear draft reminder: water the fern/i }).click();
  await page.getByText("Draft cleared").waitFor();
  await page.locator(".intent-strip").waitFor({ state: "detached" });
  assert.equal(
    store
      .listRecords(
        { userId: "e2e-user" },
        { scope: { type: "user", id: "e2e-user" }, kinds: ["reminder"] },
      )
      .some((record) => /water the fern/i.test(record.title)),
    false,
  );
  await page.getByRole("button", { name: "New", exact: true }).click();
  const progressStarted = new Promise<void>((resolve) => {
      markProgressStarted = resolve;
    }),
    progressCleared = new Promise<void>((resolve) => {
      markProgressCleared = resolve;
    }),
    progressRepaired = new Promise<void>((resolve) => {
      markProgressRepaired = resolve;
    });
  await page.getByLabel("Message Ellie").fill("stream repair fixture");
  await page.getByRole("button", { name: "Send message" }).click();
  await progressStarted;
  await page.getByText("Unvalidated fixture draft.", { exact: true }).waitFor();
  await page.getByText("Drafting…", { exact: true }).waitFor();
  progressClearGate.resolve();
  await progressCleared;
  await page
    .getByText("Unvalidated fixture draft.", { exact: true })
    .waitFor({ state: "detached" });
  await page.getByText("Drafting…", { exact: true }).waitFor();
  progressRepairedGate.resolve();
  await progressRepaired;
  await page.getByText("Repaired fixture draft.", { exact: true }).waitFor();
  progressFinalGate.resolve();
  await page.getByText("Final fixture reply.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Final fixture reply.", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Repaired fixture draft.", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "New", exact: true }).click();
  emitLateProgress?.();
  await page.waitForTimeout(650);
  assert.equal(await page.getByText("Late stale fixture draft.", { exact: true }).count(), 0);
  const slowStarted = new Promise<void>((resolve) => {
    markSlowChatStarted = resolve;
  });
  await page.getByLabel("Message Ellie").fill("hold this reply while I open a new conversation");
  await page.getByRole("button", { name: "Send message" }).click();
  await slowStarted;
  const slowRequest = chatPosts.at(-1)?.requestId;
  assert.equal(typeof slowRequest, "string");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("heading", { name: /What can I help with/ }).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-chat-status.png"),
      fullPage: false,
    });
  slowChatGate.resolve();
  await page.waitForFunction(async (requestId) => {
    const response = await fetch(`/api/life/chat/requests/${requestId}`);
    return response.ok && (await response.json()).status === "completed";
  }, slowRequest);
  await page.getByRole("button", { name: "Check outcome" }).click();
  await page
    .locator(".messages article.ellie p")
    .getByText("Fixture summary of the cited source.", { exact: true })
    .last()
    .waitFor();
  assert.match(page.url(), /conversation=/);
  const recoveredConversation = new URL(page.url()).searchParams.get("conversation");
  assert.ok(recoveredConversation);
  await page.getByRole("button", { name: "History" }).click();
  const activeHistory = page.locator(
    `.history-list article[data-conversation-id="${recoveredConversation}"]`,
  );
  await activeHistory.waitFor();
  page.once("dialog", (dialog) => void dialog.accept());
  await activeHistory.locator(".history-delete").click();
  await page.getByText("Conversation deleted").waitFor();
  await page.getByRole("button", { name: "Close conversation history" }).click();
  await page.getByRole("heading", { name: /What can I help with/ }).waitFor();
  await page.getByRole("button", { name: "History" }).click();
  assert.equal(
    await page
      .locator(".history-list")
      .getByText(/hold this reply/i)
      .count(),
    0,
    "deleted conversation is absent from scoped history",
  );
  await page.getByRole("button", { name: "Close conversation history" }).click();
  await closeChat();
  await page.getByRole("button", { name: "Manage shared spaces" }).click();
  await page.getByLabel("New space name").fill("Garden club");
  await page.getByRole("button", { name: "Create space" }).click();
  const gardenSpace = page.locator(".group-list article").filter({ hasText: "Garden club" });
  await gardenSpace.waitFor();
  await gardenSpace.getByRole("button", { name: "Open" }).click();
  const createdGroup = await page.evaluate(async () => {
    const body = (await (await fetch("/api/life/groups")).json()) as {
      groups: Array<{ id: string; name: string; revision: number }>;
    };
    return body.groups.find((group) => group.name === "Garden club");
  });
  assert.ok(createdGroup);
  assert.equal(await page.getByLabel("Sharing with").inputValue(), `group:${createdGroup.id}`);
  await openChat();
  await page.getByLabel("Message Ellie").fill("remember that garden club tea is at five");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  await page.getByRole("button", { name: "Send message" }).waitFor();
  assert.equal(
    store
      .listRecords(
        { userId: "e2e-user" },
        { scope: { type: "group", id: createdGroup.id }, kinds: ["memory"] },
      )
      .some((record) => /garden club tea/i.test(record.title)),
    true,
  );
  assert.equal(
    store
      .listRecords(
        { userId: "e2e-user" },
        { scope: { type: "group", id: createdGroup.id }, kinds: ["memory"] },
      )
      .some((record) => /morning appointments/i.test(record.title)),
    false,
    "personal records do not enter a newly selected shared space",
  );
  await closeChat();
  await page.getByRole("button", { name: "Manage shared spaces" }).click();
  const managedGarden = page.locator(".group-list article").filter({ hasText: "Garden club" });
  await managedGarden.getByRole("button", { name: "Rename" }).click();
  const renameGarden = page.getByLabel("Rename Garden club");
  await renameGarden.fill("Garden circle");
  await renameGarden.press("Enter");
  await page.getByRole("dialog").getByText("Garden circle", { exact: true }).waitFor();
  await page.evaluate(async (group) => {
    const response = await fetch(`/api/life/groups/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Garden external", expectedRevision: group.revision + 1 }),
    });
    if (!response.ok) throw new Error(`fixture rename failed: ${response.status}`);
  }, createdGroup);
  const staleGarden = page.locator(".group-list article").filter({ hasText: "Garden circle" });
  await staleGarden.getByRole("button", { name: "Rename" }).click();
  const staleRename = page.getByLabel("Rename Garden circle");
  await staleRename.fill("Garden stale");
  await staleRename.press("Enter");
  await page.getByText("That space was renamed elsewhere. Its current name is shown.").waitFor();
  await page.getByRole("dialog").getByText("Garden external", { exact: true }).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-shared-spaces.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await selectScope("user:e2e-user");
  await closeChat();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "New board" }).click();
  await page.getByLabel("New dashboard name").fill("Private board");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await openChat();
  await page.getByLabel("Message Ellie").fill("this unsent prompt stays private");
  await selectScope(`group:${sharedGroup.id}`);
  await page.getByLabel("Message Ellie").waitFor();
  assert.equal(await page.getByLabel("Message Ellie").inputValue(), "");
  assert.equal(await page.getByLabel("Rename Private board dashboard").count(), 0);
  await selectScope("user:e2e-user");
  await page.getByLabel("Rename Private board dashboard").waitFor();
  await selectScope(`group:${sharedGroup.id}`);
  await page.getByLabel("Message Ellie").fill("remember that family tea is at four");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.waitForFunction(() => new URL(location.href).searchParams.has("conversation"));
  const groupConversation = new URL(page.url()).searchParams.get("conversation");
  assert.ok(groupConversation);
  await page.reload();
  await page
    .locator(".messages article.you p")
    .getByText("remember that family tea is at four", { exact: true })
    .waitFor();
  await page.getByText("Private · using shared group context").waitFor();
  await openChatOptions();
  await page.getByLabel("Length").selectOption("brief");
  await page.getByText(/keep this conversation brief/i).waitFor();
  await page.reload();
  await openChatOptions();
  await expect(page.getByLabel("Length")).toHaveValue("brief");
  assert.equal(await page.getByLabel("Length").inputValue(), "brief");
  await page.getByText("This conversation", { exact: true }).waitFor();
  const privateFeedbackBefore = store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["feedback"] },
    ).length,
    groupFeedbackBefore = store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "group", id: sharedGroup.id }, kinds: ["feedback"] },
    ).length;
  await page
    .locator(".messages article.ellie")
    .last()
    .getByRole("button", { name: "Helpful" })
    .click();
  await page.getByText("Private feedback saved for evaluation.").waitFor();
  assert.equal(
    store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["feedback"] },
    ).length,
    privateFeedbackBefore + 1,
  );
  assert.equal(
    store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "group", id: sharedGroup.id }, kinds: ["feedback"] },
    ).length,
    groupFeedbackBefore,
    "rating a group-context response remains actor-private",
  );
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-conversation-style.png"),
      fullPage: false,
    });
  const scopedHistories = await page.evaluate(async (groupScope) => {
    const [personal, group] = await Promise.all([
      fetch("/api/life/conversations?scope=user:e2e-user"),
      fetch(`/api/life/conversations?scope=${encodeURIComponent(groupScope)}`),
    ]);
    return {
      personal: (await personal.json()).conversations as Array<{ id: string }>,
      group: (await group.json()).conversations as Array<{ id: string }>,
    };
  }, `group:${sharedGroup.id}`);
  assert.equal(
    scopedHistories.personal.some((item) => item.id === groupConversation),
    false,
  );
  assert.equal(
    scopedHistories.group.some((item) => item.id === groupConversation),
    true,
  );
  await page.getByRole("button", { name: "New", exact: true }).click();
  assert.equal(await page.getByLabel("Length").inputValue(), "");
  await page.getByLabel("Message Ellie").fill("from now on, be playful");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/personal tone preference/i).waitFor();
  await openChatOptions();
  await page.getByLabel("Tone").selectOption("warm");
  await page.getByText(/keep this conversation warm/i).waitFor();
  await page.getByRole("button", { name: "Use saved preferences" }).click();
  await page.getByText(/Saved preferences still apply/i).waitFor();
  assert.equal(await page.getByLabel("Tone").inputValue(), "");
  await page.getByText(/Saved user: playful/i).waitFor();
  await page
    .getByLabel("Message Ellie")
    .fill("Create a plan called Family picnic: Pick a park; Pack lunch; Bring a blanket");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Created plan “Family picnic” with 3 steps.").waitFor();
  await openTool("Memory");
  await page.getByRole("button", { name: "plans", exact: true }).click();
  await page.getByRole("button", { name: /Family picnic.*0 of 3 complete/ }).waitFor();
  await page.getByText("Doctor visit", { exact: true }).waitFor({ state: "detached" });
  await selectScope("user:e2e-user");
  await openChat();
  await page
    .getByLabel("Message Ellie")
    .fill(
      "Create a plan called Doctor visit: Confirm appointment; Gather forms; Prepare questions",
    );
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Created plan “Doctor visit” with 3 steps.").waitFor();
  await openTool("Memory");
  await page.getByRole("button", { name: "plans", exact: true }).click();
  const doctorPlanRow = page.getByRole("button", { name: /Doctor visit.*0 of 3 complete/ });
  await doctorPlanRow.waitFor();
  await page.getByText("Family picnic", { exact: true }).waitFor({ state: "detached" });
  await doctorPlanRow.click();
  const stalePlan = await page.evaluate(async () => {
    const response = await fetch("/api/life/plans?scope=user:e2e-user&limit=64");
    const body = (await response.json()) as {
      plans: Array<{
        record: { id: string; revision: number };
        steps: Array<{ id: string; title: string }>;
      }>;
    };
    const plan = body.plans.find((candidate) =>
      candidate.steps.some((step) => step.title === "Confirm appointment"),
    )!;
    const step = plan.steps.find((candidate) => candidate.title === "Confirm appointment")!;
    const changed = await fetch(`/api/life/plans/${plan.record.id}/steps/${step.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed: true, expectedRevision: plan.record.revision }),
    });
    if (!changed.ok) throw new Error(`Plan setup failed: ${changed.status}`);
    return plan.record.id;
  });
  assert.ok(stalePlan);
  await page.getByLabel("Gather forms").click();
  await page.getByText("That checklist changed. Its current steps are shown.").waitFor();
  assert.equal(await page.getByLabel("Confirm appointment").isChecked(), true);
  assert.equal(await page.getByLabel("Gather forms").isChecked(), false);
  const planResponseReady = Promise.withResolvers<void>();
  const releasePlanResponse = Promise.withResolvers<void>();
  const stepRoute = `**/api/life/plans/${stalePlan}/steps/*`;
  await page.route(stepRoute, async (route) => {
    const response = await route.fetch();
    planResponseReady.resolve();
    await releasePlanResponse.promise;
    await route.fulfill({ response });
  });
  await page.getByLabel("Gather forms").click();
  await planResponseReady.promise;
  await page.getByRole("button", { name: "Close", exact: true }).click();
  releasePlanResponse.resolve();
  await page.getByRole("button", { name: /Doctor visit.*2 of 3 complete/ }).waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.unroute(stepRoute);
  await page.getByRole("button", { name: /Doctor visit.*2 of 3 complete/ }).click();
  await page.getByText(/Saved checklist · 2 of 3 complete/).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-plans.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await openTool("Memory");
  await page.getByRole("button", { name: "plans", exact: true }).click();
  await page.getByRole("button", { name: /Doctor visit.*2 of 3 complete/ }).waitFor();
  await openChat();
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByLabel("Message Ellie").fill("Reopen step 2 of plan Doctor visit");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText(/Reopened step 2, “Gather forms”, in “Doctor visit” \(1\/3 complete\)/)
    .waitFor();
  await openTool("Memory");
  await page.getByRole("button", { name: "plans", exact: true }).click();
  await page.getByRole("button", { name: /Doctor visit.*1 of 3 complete/ }).waitFor();
  await openChat();
  await page.getByLabel("Message Ellie").fill("Every day at 9 am remind me to stretch");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/Scheduled “stretch” every day at 09:00/).waitFor();
  const routine = store
    .listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["routine"] },
    )
    .find((record) => record.title === "stretch")!;
  assert.ok(routine);
  await page.getByLabel("Message Ellie").fill("List routines");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/stretch \(scheduled\)/i).waitFor();
  await page.getByLabel("Message Ellie").fill("Pause routine stretch");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/Paused future delivery for “stretch”/).waitFor();
  await openTool("Memory");
  const routineRow = page.locator(".record-list button").filter({ hasText: "stretch" });
  await routineRow.getByText("Future delivery paused").waitFor();
  await routineRow.click();
  await page.getByText("Pause future delivery").waitFor({ state: "detached" });
  await page.getByText("Resume future delivery").waitFor();
  await page.getByText(/do not freeze a timer countdown or undo notifications/i).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await openChat();
  await page.getByLabel("Message Ellie").fill("Resume routine stretch");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/Resumed future delivery for “stretch”/).waitFor();
  await page.getByLabel("Message Ellie").fill("Cancel routine stretch");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/Cancelled future delivery for “stretch”/).waitFor();
  await openTool("Memory");
  await page
    .locator(".record-list button")
    .filter({ hasText: "stretch" })
    .getByText("Future delivery cancelled")
    .waitFor();
  assert.equal(store.getRecord({ userId: "e2e-user" }, routine.id)?.data.completed, false);
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-delivery-status.png"),
      fullPage: false,
    });
  await page
    .getByText(/morning appointments/i)
    .first()
    .waitFor();

  const memory = page
    .locator(".record-list button")
    .filter({ hasText: /morning appointments/i })
    .first();
  await memory.click();
  await page.getByLabel("Title").fill("Morning appointment preference");
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.getByText("Morning appointment preference").waitFor();

  const chooser = page.waitForEvent("filechooser");
  await page.getByText("Teach Ellie from files").click();
  await (
    await chooser
  ).setFiles([
    {
      name: "garden.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Garden gate code is 2468. This is untrusted source content."),
    },
    {
      name: "garden-handbook.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from(makeDocx("Garden handbook binary route", 1_550_000)),
    },
    {
      name: "broken-handbook.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("PK truncated"),
    },
  ]);
  await page.locator(".upload-queue article.upload-done").nth(1).waitFor({ timeout: 30_000 });
  await page.locator(".upload-queue article.upload-error").waitFor();
  assert.equal(await page.locator(".upload-queue article.upload-done").count(), 2);
  assert.match(
    (await page.locator(".upload-queue article.upload-error").textContent()) ?? "",
    /missing|truncated|corrupt|could not be extracted/i,
  );
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-upload-queue.png"),
      fullPage: false,
    });
  await page
    .locator(".record-list strong")
    .getByText("garden-handbook.docx", { exact: true })
    .waitFor();
  await page.locator(".record-list strong").getByText("garden.txt", { exact: true }).waitFor();
  await page.locator(".record-list button").filter({ hasText: "garden.txt" }).click();
  assert.equal(
    await page.getByLabel("Details").inputValue(),
    "Garden gate code is 2468. This is untrusted source content.",
    "lazy source detail retains the full editable body",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Search your world").fill("gate code 2468");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .locator(".search-results")
    .getByText(/Garden gate code is 2468/)
    .waitFor();
  await page.locator(".search-results button").filter({ hasText: "garden.txt" }).click();
  assert.match(await page.getByLabel("Details").inputValue(), /untrusted source content/);
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await openChat();
  await page.getByLabel("Message Ellie").fill("Summarize gate code in the background");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/queued a background summary/i).waitFor();
  const summaryRoot = tasks
    .list({ owner: "user:e2e-user" })
    .find((task) => task.handler === "knowledge.aggregate");
  assert.ok(summaryRoot);
  await openTool("Activity");
  await page.waitForFunction(async (taskId) => {
    const bootstrap = await (await fetch("/api/life/bootstrap")).json();
    return bootstrap.tasks.some(
      (task: { id: string; status: string }) => task.id === taskId && task.status === "succeeded",
    );
  }, summaryRoot.id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const summaryTask = page.locator(`[data-task-id="${summaryRoot.id}"]`);
  await summaryTask.getByRole("button", { name: "Inspect" }).click();
  await page.getByRole("heading", { name: "Result" }).waitFor();
  await page.getByText("Fixture summary of the cited source.").waitFor();
  await page.locator(".task-result strong").getByText("garden.txt", { exact: true }).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-task-result.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Close" }).click();
  const gardenSource = store
    .listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["source"] },
    )
    .find((record) => record.title === "garden.txt");
  assert.ok(gardenSource);
  const teachingGuideId = await page.evaluate(
    async ({ sourceId, sourceRevision }) => {
      const response = await fetch("/api/life/teaching", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: "user:e2e-user",
          title: "Garden answer style",
          instructions: "Answer garden questions in short steps.",
          sources: [{ id: sourceId, revision: sourceRevision }],
          enabled: true,
        }),
      });
      if (!response.ok) throw new Error(`Teaching fixture failed (${response.status})`);
      return ((await response.json()) as { record: { id: string } }).record.id;
    },
    { sourceId: gardenSource.id, sourceRevision: gardenSource.revision },
  );
  const revisedGarden = store.updateRecord(
    { userId: "e2e-user" },
    gardenSource.id,
    gardenSource.revision,
    { body: "Garden gate code is now 8642. This is current source content." },
  );
  await summaryTask.getByRole("button", { name: "Inspect" }).click();
  await page.getByText(/cited source changed|run this task again/i).waitFor();
  assert.equal(await page.getByText("Fixture summary of the cited source.").count(), 0);
  await page.getByRole("dialog").getByRole("button", { name: "Run again" }).click();
  await page.waitForFunction(
    async ({ previousId, revision }) => {
      const bootstrap = await (await fetch("/api/life/bootstrap")).json();
      const candidates = bootstrap.tasks.filter(
        (task: { id: string; title: string; status: string }) =>
          task.id !== previousId && /summarize gate code/i.test(task.title),
      );
      for (const task of candidates) {
        if (task.status !== "succeeded") continue;
        const detail = await (await fetch(`/api/life/tasks/${task.id}/detail`)).json();
        if (
          detail.result?.citations?.some(
            (citation: { sourceRevision: number }) => citation.sourceRevision === revision,
          )
        )
          return true;
      }
      return false;
    },
    { previousId: summaryRoot.id, revision: revisedGarden.revision },
  );
  await openTool("Memory");
  await page.getByRole("button", { name: "guidance", exact: true }).click();
  const guideRow = page.locator(".guide-list button").filter({ hasText: "Garden answer style" });
  await guideRow.getByText(/Source changed — review needed/).waitFor();
  await guideRow.click();
  assert.equal(
    await page.getByRole("button", { name: "Adopt reviewed revision" }).isDisabled(),
    true,
  );
  await page
    .locator(".source-choices label")
    .filter({ hasText: "garden.txt" })
    .getByRole("checkbox")
    .check();
  await page
    .getByLabel("Explicit instructions")
    .fill("Answer garden questions in three clear steps.");
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-guidance-review.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Adopt reviewed revision" }).click();
  await page.getByText("Guidance revised").waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await guideRow.click();
  await page.getByRole("dialog").getByRole("button", { name: "Pause" }).click();
  await page.getByText("Guidance paused").waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await guideRow.getByText(/Paused/).waitFor();
  await guideRow.click();
  await page.getByRole("dialog").getByRole("button", { name: "Resume" }).click();
  await page.getByText("Guidance resumed").waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await guideRow.click();
  await page
    .getByLabel("Explicit instructions")
    .fill("Answer garden questions in four clear steps.");
  await page.getByRole("dialog").getByRole("button", { name: "Create new version" }).click();
  await page.getByText("Guidance revised").waitFor();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await guideRow.click();
  await page.getByLabel("Earlier version").selectOption("2");
  await page.getByRole("dialog").getByRole("button", { name: "Restore selected" }).click();
  await page.getByText("Earlier guidance restored as a new version").waitFor();
  const guideAfterRollback = await page.evaluate(async (id) => {
    const response = await fetch(`/api/life/teaching/${id}`);
    return (await response.json()) as {
      version: number;
      record: { body: string };
    };
  }, teachingGuideId);
  assert.ok(guideAfterRollback.version >= 4);
  assert.equal(guideAfterRollback.record.body, "Answer garden questions in three clear steps.");
  await page.getByRole("button", { name: "all", exact: true }).click();
  const pdfChooser = page.waitForEvent("filechooser");
  await page.getByText("Teach Ellie from files").click();
  await (
    await pdfChooser
  ).setFiles({
    name: "paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makePdf("PDF garden evidence")),
  });
  await page.getByText("paper.pdf").waitFor();
  const calendarChooser = page.waitForEvent("filechooser");
  await page.getByText("Teach Ellie from files").click();
  await (
    await calendarChooser
  ).setFiles({
    name: "plans.ics",
    mimeType: "text/calendar",
    buffer: Buffer.from(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:pumpkin-1\r\nDTSTART:20261025T170000Z\r\nSUMMARY:Pumpkin dinner\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ),
  });
  await page.getByRole("heading", { name: "Review calendar" }).waitFor();
  await page.getByText("Pumpkin dinner").waitFor();
  await page.getByRole("button", { name: "Add selected" }).click();
  await page.waitForTimeout(250);
  const importFailure = page.getByRole("alert");
  if (await importFailure.count())
    throw new Error(`Import failed: ${await importFailure.textContent()}`);
  await page.locator(".modal").waitFor({ state: "detached" });
  await page.locator(".record-list strong").filter({ hasText: "Pumpkin dinner" }).waitFor();
  await openChat();
  await page.getByLabel("Message Ellie").fill("search sources for garden gate code");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/2468/).waitFor();

  await page.getByLabel("Message Ellie").fill("remind me in 20 minutes to check the oven");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText(/scheduled/i)
    .last()
    .waitFor();
  await openTool("Today");
  await page.getByText(/check the oven/i).waitFor();

  const dueAt = Date.now() + 1_500;
  const timerRecord = store.createRecord(
    { userId: "e2e-user" },
    {
      kind: "timer",
      title: "tea check",
      scope: { type: "user", id: "e2e-user" },
      data: { dueAt, completed: false },
    },
  );
  const notificationTask = tasks.schedule({
    owner: "user:e2e-user",
    handler: "reminder.notify",
    input: {
      recordId: timerRecord.id,
      scope: { type: "user", id: "e2e-user" },
      userId: "e2e-user",
    },
    schedule: { kind: "once", at: dueAt },
  });
  store.updateRecord({ userId: "e2e-user" }, timerRecord.id, timerRecord.revision, {
    data: { ...timerRecord.data, taskId: notificationTask.id },
  });
  await page
    .locator(".inbox")
    .getByText(/tea check/i)
    .waitFor({ timeout: 12_000 });
  await page.locator(".agenda-day").filter({ hasText: "Pumpkin dinner" }).waitFor();
  assert.match(
    (await page
      .locator(".agenda-day")
      .filter({ hasText: "Pumpkin dinner" })
      .getAttribute("aria-label")) ?? "",
    /Oct 25/,
  );
  assert.equal(await page.locator(".timeline").getByText("Notification: tea check").count(), 0);

  await openChat();
  await page
    .getByLabel("Message Ellie")
    .fill("Maya's birthday is October 30 and she loves gardening");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/opened a gift need/i).waitFor();
  await openTool("Memory");
  await page.locator(".record-list button").filter({ hasText: "Gift for Maya" }).click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByText("Gift for Maya").waitFor();
  await openTool("Today");
  await page
    .locator(".timeline")
    .getByText("Plan Maya's birthday gift")
    .waitFor({ state: "detached" });
  assert.match(
    (await page
      .locator(".agenda-day")
      .filter({ hasText: "Maya's birthday" })
      .getAttribute("aria-label")) ?? "",
    /Oct 30/,
  );
  await openTool("Activity");
  const birthdayTask = page.locator(".tasks article").filter({ hasText: /Maya|birthday gift/i });
  await birthdayTask.getByRole("button", { name: "Run now" }).click();
  await page.waitForFunction(async () => {
    const data = await (await fetch("/api/life/bootstrap")).json();
    return data.tasks.some(
      (task: { title: string; status: string }) =>
        /Maya|birthday gift/i.test(task.title) && task.status === "succeeded",
    );
  });
  const afterCompletion = await page.evaluate(
    async () =>
      (await fetch("/api/life/bootstrap")).json() as { notifications: Array<{ title: string }> },
  );
  assert.equal(
    afterCompletion.notifications.some((item) => /Maya|birthday gift/i.test(item.title)),
    false,
  );

  await openTool("Apps");
  const sdkCard = page.locator("article").filter({ hasText: "SDK water probe" });
  await sdkCard.getByRole("button", { name: "Open" }).click();
  let sdkFrame = page
    .frameLocator('iframe[title="SDK water probe"]')
    .frameLocator('iframe[title="Plugin"]');
  await sdkFrame.getByText("SDK locked", { exact: true }).waitFor();
  await sdkFrame.getByLabel("Water count").filter({ hasText: "0" }).waitFor();
  await sdkFrame.getByRole("button", { name: "Add water" }).click();
  await sdkFrame.getByLabel("Water count").filter({ hasText: "1" }).waitFor();
  assert.equal(
    plugins.storageGet("user:e2e-user", sdkProbePlugin.id, "water-count"),
    1,
    "SDK set waits for persisted host acknowledgement",
  );
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await sdkCard.getByRole("button", { name: "Open" }).click();
  sdkFrame = page
    .frameLocator('iframe[title="SDK water probe"]')
    .frameLocator('iframe[title="Plugin"]');
  await sdkFrame.getByLabel("Water count").filter({ hasText: "1" }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await openTool("Apps");
  await page
    .locator("article")
    .filter({ hasText: "SDK water probe" })
    .getByRole("button", { name: "Open" })
    .click();
  sdkFrame = page
    .frameLocator('iframe[title="SDK water probe"]')
    .frameLocator('iframe[title="Plugin"]');
  await sdkFrame.getByLabel("Water count").filter({ hasText: "1" }).waitFor();
  await sdkFrame.getByRole("button", { name: "Add water" }).click();
  await sdkFrame.getByLabel("Water count").filter({ hasText: "2" }).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-sdk-water-counter.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const generatedCard = page.locator("article").filter({ hasText: "Water Counter Widget" });
  await generatedCard.getByRole("button", { name: "Open" }).click();
  let generatedFrame = page
    .frameLocator('iframe[title="Water Counter Widget"]')
    .frameLocator('iframe[title="Plugin"]');
  const generatedCount = () => generatedFrame.locator("#count");
  await generatedCount().getByText("0", { exact: true }).waitFor();
  await generatedFrame.getByRole("button", { name: "Add a glass" }).click();
  await generatedCount().getByText("1", { exact: true }).waitFor();
  await generatedFrame.getByRole("button", { name: "Add a glass" }).click();
  await generatedCount().getByText("2", { exact: true }).waitFor();
  assert.equal(plugins.storageGet("user:e2e-user", generatedWaterPlugin.id, "waterCount"), 2);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await generatedCard.getByRole("button", { name: "Open" }).click();
  generatedFrame = page
    .frameLocator('iframe[title="Water Counter Widget"]')
    .frameLocator('iframe[title="Plugin"]');
  await generatedCount().getByText("2", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await openTool("Apps");
  await page
    .locator("article")
    .filter({ hasText: "Water Counter Widget" })
    .getByRole("button", { name: "Open" })
    .click();
  generatedFrame = page
    .frameLocator('iframe[title="Water Counter Widget"]')
    .frameLocator('iframe[title="Plugin"]');
  await generatedCount().getByText("2", { exact: true }).waitFor();
  failGeneratedSet = true;
  await generatedFrame.getByRole("button", { name: "Add a glass" }).click();
  await generatedFrame.getByText("Failed to save your progress. Please try again.").waitFor();
  await generatedCount().getByText("2", { exact: true }).waitFor();
  assert.equal(await generatedFrame.getByRole("button", { name: "Add a glass" }).isEnabled(), true);
  await generatedFrame.getByRole("button", { name: "Add a glass" }).click();
  await generatedCount().getByText("3", { exact: true }).waitFor();
  await generatedFrame.getByRole("button", { name: "Reset" }).click();
  await generatedCount().getByText("0", { exact: true }).waitFor();
  assert.equal(plugins.storageGet("user:e2e-user", generatedWaterPlugin.id, "waterCount"), 0);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  failGeneratedGet = true;
  await page
    .locator("article")
    .filter({ hasText: "Water Counter Widget" })
    .getByRole("button", { name: "Open" })
    .click();
  generatedFrame = page
    .frameLocator('iframe[title="Water Counter Widget"]')
    .frameLocator('iframe[title="Plugin"]');
  const loadError = generatedFrame.getByText("Failed to load data. Click Retry to try again.");
  await loadError.waitFor();
  assert.equal(
    await generatedFrame.getByRole("button", { name: "Add a glass" }).isDisabled(),
    true,
  );
  assert.equal(await generatedFrame.getByRole("button", { name: "Reset" }).isDisabled(), true);
  await loadError.click();
  await generatedFrame.getByRole("button", { name: "Add a glass" }).click();
  await generatedCount().getByText("1", { exact: true }).waitFor();
  await generatedFrame.getByRole("button", { name: "Reset" }).click();
  await generatedCount().getByText("0", { exact: true }).waitFor();
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-generated-water-counter.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator("article")
    .filter({ hasText: "SDK bounds probe" })
    .getByRole("button", { name: "Open" })
    .click();
  const boundsFrame = page
    .frameLocator('iframe[title="SDK bounds probe"]')
    .frameLocator('iframe[title="Plugin"]');
  await boundsFrame.getByText("Pending bounded", { exact: true }).waitFor();
  await boundsFrame.getByText("Invalid storage key.", { exact: true }).waitFor();
  await boundsFrame
    .getByText("Storage value must be JSON and no larger than 16 KiB.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator("article")
    .filter({ hasText: "SDK denied probe" })
    .getByRole("button", { name: "Open" })
    .click();
  const deniedFrame = page
    .frameLocator('iframe[title="SDK denied probe"]')
    .frameLocator('iframe[title="Plugin"]');
  await deniedFrame.getByText(/forbidden|storage|capability|authoriz/i).waitFor();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate((pluginId) => {
    const iframe = document.createElement("iframe");
    iframe.dataset.sdkTimeout = "true";
    iframe.src = `/api/life/plugins/${pluginId}/view`;
    document.body.append(iframe);
  }, sdkProbePlugin.id);
  const timeoutFrame = page
    .frameLocator('iframe[data-sdk-timeout="true"]')
    .frameLocator('iframe[title="Plugin"]');
  await timeoutFrame.getByText("Storage request timed out.", { exact: true }).waitFor({
    timeout: 7_000,
  });
  await page.locator('iframe[data-sdk-timeout="true"]').evaluate((element) => element.remove());
  await page
    .locator("article")
    .filter({ hasText: "Navigation probe" })
    .getByRole("button", { name: "Open" })
    .click();
  await page.waitForTimeout(150);
  assert.equal(hostileReached, false, "the sandbox CSP blocks the attempted remote navigation");
  assert.equal(
    plugins.storageGet("user:e2e-user", hostilePlugin.id, "escaped"),
    null,
    "the navigated replacement document received no host RPC capability",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page
    .getByPlaceholder(/family board/)
    .fill("Build an arcade game with a persistent high score");
  await page.getByRole("button", { name: "Build it" }).click();
  await page.getByText("Star arcade").waitFor();
  await page
    .locator("article")
    .filter({ hasText: "Star arcade" })
    .getByRole("button", { name: "Open" })
    .click();
  const frame = page
    .frameLocator('iframe[title="Star arcade"]')
    .frameLocator('iframe[title="Plugin"]');
  await frame.getByRole("button", { name: "Let's play" }).click();
  await frame.locator("canvas").press("Space");
  await frame.locator("#score").evaluate(
    (score) =>
      new Promise<void>((resolveScore, rejectScore) => {
        const deadline = performance.now() + 2_000;
        const check = () => {
          if (Number(score.textContent) > 0) resolveScore();
          else if (performance.now() > deadline) rejectScore(new Error("First shot did not score"));
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
  assert.equal(await frame.locator("#score").textContent(), "130");
  await frame.locator("body").evaluate(async () => {
    await (
      globalThis as unknown as {
        call(method: string, key: string, value: unknown): Promise<unknown>;
      }
    ).call("storage.set", "highScore", 37);
  });
  assert.equal(
    await frame.locator("body").evaluate(() => {
      try {
        void window.parent.document;
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "sandbox blocks parent DOM",
  );
  assert.equal(
    await frame.locator("body").evaluate(async () => {
      try {
        await fetch("/api/life/bootstrap");
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "plugin CSP blocks arbitrary host fetch",
  );
  await page.locator('iframe[title="Star arcade"]').dispatchEvent("load");
  assert.equal(
    await frame.locator("body").evaluate(async () => {
      try {
        await (
          globalThis as unknown as { call(method: string, key: string): Promise<unknown> }
        ).call("storage.get", "highScore");
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "a repeated iframe load receives no replacement capability port",
  );
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByText("37", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".life-dashboard").waitFor();
  await openTool("Apps");
  await page.getByText("37", { exact: true }).waitFor();

  const mlbResult = await page.evaluate(async () => {
    const built = await fetch("/api/life/plugins/build", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: "Build an MLB standings view", scope: "user:e2e-user" }),
    });
    const plugin = (await built.json()) as { id?: string; error?: string };
    if (!built.ok || !plugin.id)
      return {
        status: built.status,
        body: { value: { stale: true, error: plugin.error ?? "MLB plugin build failed" } },
      };
    const response = await fetch(`/api/life/plugins/${plugin.id}/action`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mlb.snapshot", payload: {} }),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        value?: { stale?: unknown; error?: unknown; games?: unknown };
      },
    };
  });
  assert.equal(mlbResult.status, 200, JSON.stringify(mlbResult.body));
  assert.equal(typeof mlbResult.body.value?.stale, "boolean");
  if (mlbResult.body.value?.stale) assert.equal(typeof mlbResult.body.value.error, "string");
  else assert.equal(Array.isArray(mlbResult.body.value?.games), true);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.getByText("Around the diamond").waitFor();
  const mlbCard = page.locator(".plugins article").filter({ hasText: "Around the diamond" });
  await mlbCard.getByText("Today’s games").waitFor();
  await mlbCard.getByText("Division leaders").waitFor();
  assert.equal(await mlbCard.getByText("capabilities", { exact: true }).count(), 0);
  assert.equal((await mlbCard.textContent())?.includes('"standings"'), false);

  await page.getByPlaceholder(/family board/).fill("Build a custom private notebook");
  await page.getByRole("button", { name: "Build it" }).click();
  const notebook = page.locator(".plugins article").filter({ hasText: "Pocket notebook" });
  await notebook.getByText("Notebook revision 1").waitFor();
  const notebookId = await page.evaluate(async () => {
    const bootstrap = await (await fetch("/api/life/bootstrap")).json();
    const plugin = bootstrap.plugins.find(
      (item: { name: string }) => item.name === "Pocket notebook",
    );
    await fetch(`/api/life/plugins/${plugin.id}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "storage.set", payload: { key: "note", value: "kept" } }),
    });
    return plugin.id as string;
  });
  await notebook.getByRole("button", { name: "Manage" }).click();
  await page.getByLabel("Describe a correction").fill("Make the notebook revision clearer");
  await page.getByRole("button", { name: "Create revision" }).click();
  await page.getByText("App revision created").waitFor();
  await notebook.getByText("Notebook revision 2").waitFor();
  await notebook.getByRole("button", { name: "Manage" }).click();
  await page.getByLabel("Revision to restore").selectOption("1");
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-plugin-manage.png"),
      fullPage: false,
    });
  await page.getByRole("button", { name: "Restore selected" }).click();
  await page.getByText("Restored version 1 as a new revision").waitFor();
  await notebook.getByText("Notebook revision 1").waitFor();
  assert.equal(
    await page.evaluate(async (id) => {
      const response = await fetch(`/api/life/plugins/${id}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "storage.get", payload: { key: "note" } }),
      });
      return (await response.json()).value;
    }, notebookId),
    "kept",
  );
  await notebook.getByRole("button", { name: "Manage" }).click();
  await page.getByText("I understand this removes the app and its saved app data.").click();
  await page.getByRole("button", { name: "Remove app" }).click();
  await page.getByText("App removed").waitFor();
  await notebook.waitFor({ state: "detached" });

  await openSettings();
  await page.locator(".setting-scope select").selectOption("user:e2e-user");
  await page
    .locator(".setting")
    .filter({ hasText: "Tone" })
    .locator("select")
    .selectOption("direct");
  await page
    .locator(".setting")
    .filter({ hasText: "Response length" })
    .locator("select")
    .selectOption("brief");
  await page
    .locator(".setting")
    .filter({ hasText: "Proactive suggestions" })
    .getByRole("checkbox")
    .uncheck();
  await page.locator(".setting").filter({ hasText: "Quiet hours" }).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.getByText("Settings saved").waitFor();
  const savedSettings = await page.evaluate(
    async () =>
      (await fetch("/api/life/bootstrap")).json() as { settings: Record<string, unknown> },
  );
  const effective = (savedSettings.settings.values ?? savedSettings.settings) as Record<
    string,
    unknown
  >;
  assert.equal(effective.tone, "direct");
  assert.equal(effective.verbosity, "brief");
  assert.equal(effective.proactiveSuggestions, false);
  assert.deepEqual(effective.quietHours, { enabled: true, start: 22, end: 7 });
  await openTool("Activity");
  await page.getByLabel("Help Ellie improve").fill("Show reminders a little earlier");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await page.getByRole("button", { name: "Send feedback" }).waitFor();
  const privateExample = page.locator(".learning > article").filter({
    hasText: "Ask before assuming a time.",
  });
  const selectForImprovement = privateExample.getByLabel(
    "Use privately for an improvement proposal",
  );
  const taskCountBeforePreview = tasks.list({ owner: "user:e2e-user", limit: 500 }).length,
    reminderCountBeforePreview = store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["reminder"] },
    ).length,
    pluginCountBeforePreview = plugins.list("user:e2e-user").length,
    guidanceCountBeforeImprovement = new LifeTeaching(store).list({ userId: "e2e-user" }).length;
  await selectForImprovement.check();
  await page
    .getByPlaceholder("For example, ask one clear follow-up question")
    .fill("Handle missing times carefully");
  await page.getByRole("button", { name: "Propose improvement" }).click();
  const improvementDialog = page.getByRole("dialog");
  await improvementDialog.getByText("Offline example preview · no actions were run").waitFor();
  await improvementDialog.getByText("Done without asking.").waitFor();
  await improvementDialog.getByText(/Offline preview: What time should I use/).waitFor();
  assert.equal(tasks.list({ owner: "user:e2e-user", limit: 500 }).length, taskCountBeforePreview);
  assert.equal(
    store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, kinds: ["reminder"] },
    ).length,
    reminderCountBeforePreview,
  );
  assert.equal(plugins.list("user:e2e-user").length, pluginCountBeforePreview);
  assert.equal(
    new LifeTeaching(store).list({ userId: "e2e-user" }).length,
    guidanceCountBeforeImprovement,
  );
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-improvement-review.png"),
      fullPage: false,
    });
  await improvementDialog.getByRole("button", { name: "Adopt as guidance" }).click();
  await improvementDialog.getByText("Adopted as private guidance").waitFor();
  assert.equal(
    new LifeTeaching(store).list({ userId: "e2e-user" }).length,
    guidanceCountBeforeImprovement + 1,
  );
  await improvementDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.reload();
  await selectScope(`group:${sharedGroup.id}`);
  await openTool("Activity");
  await page.getByText("Private improvement proposals").waitFor();
  await page
    .getByText("These remain personal even while you are viewing a shared space.")
    .waitFor();
  await page.getByText("adopted", { exact: true }).waitFor();
  await page
    .locator(".learning > article")
    .filter({ hasText: "Ask before assuming a time." })
    .getByLabel("Use privately for an improvement proposal")
    .check();
  await page.getByRole("button", { name: "Propose improvement" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Dismiss proposal" }).click();
  await page
    .getByRole("dialog")
    .getByText(/Private proposal · dismissed/)
    .waitFor();
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page
    .locator(".learning > article")
    .filter({ hasText: "Ask before assuming a time." })
    .getByLabel("Use privately for an improvement proposal")
    .check();
  await page.getByRole("button", { name: "Propose improvement" }).click();
  learning.selectForExport(
    { userId: "e2e-user" },
    improvementFeedback.id,
    improvementFeedback.revision,
    true,
  );
  await page.getByRole("dialog").getByRole("button", { name: "Adopt as guidance" }).click();
  await page
    .getByRole("dialog")
    .getByText(/selected feedback example changed/)
    .waitFor();
  assert.equal(await page.getByRole("dialog").getByText("Done without asking.").count(), 0);
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await selectScope("user:e2e-user");

  if (artifactDir) {
    await closeChat();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-dashboard.png"),
      fullPage: false,
    });
    await openChat();
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-orb-conversation.png"),
      fullPage: false,
    });
    await closeChat();
    for (const [name, file] of [
      ["Today", "today"],
      ["Memory", "world"],
      ["Apps", "space"],
    ] as const) {
      await openTool(name);
      await page.screenshot({
        animations: "disabled",
        path: join(artifactDir, `life-${file}.png`),
        fullPage: true,
      });
    }
    await openSettings();
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-settings.png"),
      fullPage: true,
    });
    await openTool("Apps");
    await page
      .locator(".plugins article")
      .filter({ hasText: "Star arcade" })
      .getByRole("button", { name: "Open" })
      .click();
    const arcade = page
      .frameLocator('iframe[title="Star arcade"]')
      .frameLocator('iframe[title="Plugin"]');
    await arcade.getByRole("button", { name: "Let's play" }).click();
    await arcade
      .locator("canvas")
      .evaluate(
        () =>
          new Promise<void>((resolveFrames) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolveFrames())),
          ),
      );
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-arcade.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(listening.url);
    await mobile.locator(".mobile-head .brand").waitFor();
    const mobileOverflow = await mobile.evaluate(() => ({
      viewportWidth: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll("body *")]
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            className: String(element.className).slice(0, 120),
            text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120),
            left: bounds.left,
            right: bounds.right,
            width: bounds.width,
          };
        })
        .filter(({ left, right }) => left < -0.5 || right > innerWidth + 0.5)
        .sort((a, b) => b.right - a.right)
        .slice(0, 12),
    }));
    await mobile.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-mobile.png"),
      fullPage: true,
    });
    assert.equal(
      mobileOverflow.scrollWidth <= mobileOverflow.viewportWidth,
      true,
      `mobile overflow: ${JSON.stringify(mobileOverflow)}`,
    );
    const mobileOrb = mobile.getByRole("button", { name: "Talk to Ellie", exact: true });
    const mobileOrbBounds = await mobileOrb.boundingBox();
    assert.ok(mobileOrbBounds && Math.abs(mobileOrbBounds.x + mobileOrbBounds.width / 2 - 195) < 2);
    const mobileStatusBounds = await mobileOrb.locator(".orb-status").boundingBox();
    assert.ok(
      mobileStatusBounds &&
        mobileStatusBounds.y >= 0 &&
        mobileStatusBounds.y + mobileStatusBounds.height <= 844,
      "mobile orb status stays within the viewport",
    );
    await mobileOrb.click();
    await mobile.getByLabel("Message Ellie").waitFor();
    assert.equal(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mobile.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-mobile-conversation.png"),
      fullPage: false,
    });
    await mobile.getByRole("button", { name: "Close conversation", exact: true }).click();
    await mobile.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(
      await mobile
        .locator(".ellie-orb")
        .evaluate((element) => getComputedStyle(element).animationName),
      "none",
    );
  }
  store.createRecord(
    { userId: "e2e-user" },
    {
      kind: "event",
      title: "Buried appointment",
      scope: { type: "user", id: "e2e-user" },
      data: { startAt: Date.now() + 14 * 86_400_000 },
    },
  );
  for (let index = 0; index < 110; index++)
    store.createRecord(
      { userId: "e2e-user" },
      {
        kind: "memory",
        title: `Paged memory ${index}`,
        scope: { type: "user", id: "e2e-user" },
        data: { explicit: true },
      },
    );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await openTool("Memory");
  await page.getByRole("button", { name: "Load more" }).waitFor();
  const firstPageCount = await page.locator(".record-list > button").count();
  assert.equal(firstPageCount, 100);
  await page.getByRole("button", { name: "Load more" }).click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".record-list > button").length > count,
    firstPageCount,
  );
  await openTool("Today");
  await page.getByText("Buried appointment").waitFor();

  await openSettings();
  await page.getByRole("button", { name: "Inspect my data" }).click();
  await page.getByText("Private records").waitFor();
  assert.ok(Number(await page.locator(".data-review dd").first().textContent()) > 0);
  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my archive" }).click();
  const archive = await archiveDownload;
  const archivePath = join(root, "personal-archive.json");
  await archive.saveAs(archivePath);
  const archiveText = await readFile(archivePath, "utf8");
  assert.match(archiveText, /Morning appointment preference/);
  assert.match(archiveText, /Garden answer style/);
  assert.equal(
    archiveText.includes("Shared record survives reset"),
    false,
    "personal archive excludes shared group records",
  );
  assert.equal(
    archiveText.includes("Shared reset sentinel"),
    false,
    "personal archive excludes shared apps",
  );
  await page.getByRole("button", { name: "Review reset" }).click();
  await page.getByLabel(/Type RESET MY PRIVATE DATA/).fill("RESET MY PRIVATE DATA");
  if (artifactDir)
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "life-data-reset-review.png"),
      fullPage: false,
    });
  const pendingReview = await page.evaluate(async () => {
    const response = await fetch("/api/life/personal-data/review");
    return (await response.json()) as {
      reviewToken: string;
      generations: { life: number; tasks: number; plugins: number };
    };
  });
  const pendingOperationId = randomUUID();
  await server.close();
  store.beginPersonalReset(
    { userId: "e2e-user" },
    {
      operationId: pendingOperationId,
      reviewTokenHash: createHash("sha256").update(pendingReview.reviewToken).digest("hex"),
      lifeGeneration: pendingReview.generations.life,
      taskGeneration: pendingReview.generations.tasks,
      pluginGeneration: pendingReview.generations.plugins,
    },
  );
  server = createLifeServer({
    stateDir: root,
    assetsDir: resolve("apps/life-ui/dist"),
    store,
    plugins,
    tasks,
    harness,
    mlb,
    modelStatus: fixtureModelStatus,
    extractor: ({ signal, ...input }) => extractDocument(input, { signal }),
    port: 0,
    userId: "e2e-user",
    userName: "Ellie E2E",
    timeZone: "America/Los_Angeles",
  });
  listening = await server.listen();
  await page.goto(listening.launchUrl);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await openSettings();
  await page.getByText("Reset in progress").waitFor();
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.getByText("Private data reset complete").waitFor({ timeout: 15_000 });
  const conversationsAfterReset = await page.evaluate(async (groupScope) => {
    const [personal, group] = await Promise.all([
      fetch("/api/life/conversations?scope=user:e2e-user"),
      fetch(`/api/life/conversations?scope=${encodeURIComponent(groupScope)}`),
    ]);
    return {
      personal: (await personal.json()).conversations.length as number,
      group: (await group.json()).conversations.length as number,
    };
  }, `group:${sharedGroup.id}`);
  assert.deepEqual(conversationsAfterReset, { personal: 0, group: 0 });
  assert.equal(
    store.listRecords(
      { userId: "e2e-user" },
      { scope: { type: "user", id: "e2e-user" }, limit: 500 },
    ).length,
    0,
  );
  assert.ok(
    store
      .listRecords(
        { userId: "e2e-user" },
        { scope: { type: "group", id: sharedGroup.id }, limit: 500 },
      )
      .some((record) => record.id === sharedRecord.id),
  );
  assert.ok(
    plugins.list(`group:${sharedGroup.id}`).some((plugin) => plugin.id === sharedPlugin.id),
  );
  assert.equal(
    plugins.storageGet(
      `group:${sharedGroup.id}`,
      sharedPlugin.id,
      groupStorageKey("e2e-user", "sentinel"),
    ),
    null,
    "reset removes this user's storage inside a shared app",
  );
  assert.equal(tasks.list({ owner: "user:e2e-user" }).length, 0);
  assert.ok(
    tasks.list({ owner: `group:${sharedGroup.id}` }).some((task) => task.id === sharedTask.id),
  );
  assert.ok(store.listGroups({ userId: "e2e-user" }).some((group) => group.id === sharedGroup.id));

  await page.getByRole("button", { name: "Reload Ellie" }).click();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await selectScope(`group:${sharedGroup.id}`);
  await openTool("Memory");
  await page.getByText("Shared record survives reset").waitFor();
  await openTool("Apps");
  await page.getByText("Shared reset sentinel").waitFor();
  assert.deepEqual(errors, []);
  console.log(`life UI E2E passed at ${listening.url}`);
  await context.close();
} finally {
  progressClearGate.resolve();
  progressRepairedGate.resolve();
  progressFinalGate.resolve();
  slowChatGate.resolve();
  await browser.close();
  await server.close();
  await new Promise<void>((resolveClose, rejectClose) =>
    hostileServer.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  await tasks.close();
  plugins.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}

function makePdf(message: string): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${message.length + 37} >>\nstream\nBT /F1 18 Tf 40 80 Td (${message}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = "%PDF-1.4\n",
    offset = pdf.length;
  const offsets = [0];
  for (const object of objects) {
    offsets.push(offset);
    pdf += object;
    offset += object.length;
  }
  const xref = offset;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((value) => String(value).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function makeDocx(message: string, minimumSize = 0): Uint8Array {
  const padding = " garden".repeat(Math.max(0, Math.ceil((minimumSize - message.length) / 7)));
  const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${message}</w:t></w:r></w:p><w:p><w:r><w:t>${padding}</w:t></w:r></w:p></w:body></w:document>`;
  const name = Buffer.from("word/document.xml");
  const content = Buffer.from(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt32LE(crc32(content), 14);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(crc32(content), 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}
