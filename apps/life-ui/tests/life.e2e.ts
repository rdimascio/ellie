import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { chromium } from "@playwright/test";
import { LifeStore } from "../../../packages/life-core/src/index.ts";
import { createLifeHarness } from "../../../packages/life-harness/src/index.ts";
import { extractDocument } from "../../../packages/life-ingest/src/index.ts";
import {
  groupStorageKey,
  MLBAdapter,
  PluginStore,
} from "../../../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../../../packages/task-runtime/src/index.ts";
import { createLifeServer } from "../../life/src/server.ts";
import { agendaDate, dayHeading } from "../src/dates.ts";

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

const root = await mkdtemp(join(tmpdir(), "ellie-life-e2e-"));
await chmod(root, 0o700);
const taskDir = join(root, "tasks");
await mkdir(taskDir, { mode: 0o700 });
const store = new LifeStore(join(root, "life.sqlite"));
const plugins = new PluginStore(join(root, "plugins.sqlite"));
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
const tasks = new TaskRuntime({
  directory: taskDir,
  tickMs: 20,
  capabilityResolver: () => ["life.records.read", "life.records.write"],
});
const mlb = new MLBAdapter();
let customBuild = 0;
const harness = createLifeHarness({
  store,
  plugins,
  tasks,
  mlb,
  model: {
    async plan() {
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
  },
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const artifactDir = process.env.ELLIE_E2E_ARTIFACT_DIR;
  if (artifactDir) await mkdir(artifactDir, { recursive: true });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(listening.launchUrl);
  await page.getByRole("heading", { name: /Hi Ellie E2E/ }).waitFor();
  assert.equal(new URL(page.url()).hash, "", "launch token fragment is stripped");

  await page.getByRole("button", { name: "Remember a preference" }).click();
  await page.getByLabel("Message Ellie").fill("remember that I prefer morning appointments");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText(/remember/i)
    .last()
    .waitFor();
  await page.getByRole("button", { name: /Your world/ }).click();
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
  await page.getByText("Teach Ellie from a file").click();
  await (
    await chooser
  ).setFiles({
    name: "garden.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Garden gate code is 2468. This is untrusted source content."),
  });
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
  await page.getByRole("button", { name: "Clear" }).click();
  await page.locator("aside nav button").filter({ hasText: "Ellie" }).click();
  await page.getByLabel("Message Ellie").fill("Summarize gate code in the background");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/queued a background summary/i).waitFor();
  const summaryRoot = tasks
    .list({ owner: "user:e2e-user" })
    .find((task) => task.handler === "knowledge.aggregate");
  assert.ok(summaryRoot);
  await page.getByRole("button", { name: /Activity/ }).click();
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
    await page.screenshot({ path: join(artifactDir, "life-task-result.png"), fullPage: false });
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
  await page.getByRole("button", { name: /Your world/ }).click();
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
    await page.screenshot({ path: join(artifactDir, "life-guidance-review.png"), fullPage: false });
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
  await page.getByText("Teach Ellie from a file").click();
  await (
    await pdfChooser
  ).setFiles({
    name: "paper.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(makePdf("PDF garden evidence")),
  });
  await page.getByText("paper.pdf").waitFor();
  const calendarChooser = page.waitForEvent("filechooser");
  await page.getByText("Teach Ellie from a file").click();
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
  await page.locator("aside nav button").filter({ hasText: "Ellie" }).click();
  await page.getByLabel("Message Ellie").fill("search sources for garden gate code");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/2468/).waitFor();

  await page.getByLabel("Message Ellie").fill("remind me in 20 minutes to check the oven");
  await page.getByRole("button", { name: "Send message" }).click();
  await page
    .getByText(/scheduled/i)
    .last()
    .waitFor();
  await page.getByRole("button", { name: "Today" }).click();
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

  await page.locator("aside nav button").filter({ hasText: "Ellie" }).click();
  await page
    .getByLabel("Message Ellie")
    .fill("Maya's birthday is October 30 and she loves gardening");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText(/opened a gift need/i).waitFor();
  await page.getByRole("button", { name: /Your world/ }).click();
  await page.locator(".record-list button").filter({ hasText: "Gift for Maya" }).click();
  await page.getByRole("button", { name: "Mark complete" }).click();
  await page.getByText("Gift for Maya").waitFor();
  await page.getByRole("button", { name: "Today" }).click();
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
  await page.getByRole("button", { name: /Activity/ }).click();
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

  await page.getByRole("button", { name: /Your space/ }).click();
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
  await page.getByRole("heading", { name: /Hi Ellie E2E/ }).waitFor();
  await page.getByRole("button", { name: /Your space/ }).click();
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
    await page.screenshot({ path: join(artifactDir, "life-plugin-manage.png"), fullPage: false });
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

  await page.getByRole("button", { name: /Settings/ }).click();
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
  assert.equal(effective.proactive, false);
  assert.deepEqual(effective.quietHours, { start: 22, end: 7 });
  await page.getByRole("button", { name: /Activity/ }).click();
  await page.getByLabel("Help Ellie improve").fill("Show reminders a little earlier");
  await page.getByRole("button", { name: "Send feedback" }).click();
  await page.getByRole("button", { name: "Send feedback" }).waitFor();

  if (artifactDir) {
    await page.screenshot({ path: join(artifactDir, "life-desktop.png"), fullPage: true });
    for (const [name, file] of [
      ["Today", "today"],
      ["Your world", "world"],
      ["Your space", "space"],
      ["Settings", "settings"],
    ]) {
      await page.getByRole("button", { name: name! }).click();
      await page.screenshot({ path: join(artifactDir, `life-${file}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Your space" }).click();
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
    await page.screenshot({ path: join(artifactDir, "life-arcade.png"), fullPage: true });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const mobile = await context.newPage();
    await mobile.setViewportSize({ width: 390, height: 844 });
    await mobile.goto(listening.url);
    await mobile.locator(".mobile-head .brand").waitFor();
    assert.equal(
      await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await mobile.screenshot({ path: join(artifactDir, "life-mobile.png"), fullPage: true });
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
  await page.getByRole("button", { name: "Your world" }).click();
  await page.getByRole("button", { name: "Load more" }).waitFor();
  const firstPageCount = await page.locator(".record-list > button").count();
  assert.equal(firstPageCount, 100);
  await page.getByRole("button", { name: "Load more" }).click();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".record-list > button").length > count,
    firstPageCount,
  );
  await page.getByRole("button", { name: "Today" }).click();
  await page.getByText("Buried appointment").waitFor();

  await page.getByRole("button", { name: "Settings" }).click();
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
    extractor: ({ signal, ...input }) => extractDocument(input, { signal }),
    port: 0,
    userId: "e2e-user",
    userName: "Ellie E2E",
    timeZone: "America/Los_Angeles",
  });
  listening = await server.listen();
  await page.goto(listening.launchUrl);
  await page.getByRole("heading", { name: /Hi Ellie E2E/ }).waitFor();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByText("Reset in progress").waitFor();
  await page.getByRole("button", { name: "Retry now" }).click();
  await page.getByText("Private data reset complete").waitFor({ timeout: 15_000 });
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
  await page.getByRole("heading", { name: /Hi Ellie E2E/ }).waitFor();
  await page.getByLabel("Sharing with").selectOption(`group:${sharedGroup.id}`);
  await page.locator("aside nav button").filter({ hasText: "Your world" }).click();
  await page.getByText("Shared record survives reset").waitFor();
  await page.getByRole("button", { name: "Your space" }).click();
  await page.getByText("Shared reset sentinel").waitFor();
  assert.deepEqual(errors, []);
  console.log(`life UI E2E passed at ${listening.url}`);
  await context.close();
} finally {
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
