import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createHttpServer } from "node:http";
import { chromium } from "@playwright/test";
import { LifeStore } from "../../../packages/life-core/src/index.ts";
import { createLifeHarness } from "../../../packages/life-harness/src/index.ts";
import { extractDocument } from "../../../packages/life-ingest/src/index.ts";
import { MLBAdapter, PluginStore } from "../../../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../../../packages/task-runtime/src/index.ts";
import { createLifeServer } from "../../life/src/server.ts";

const root = await mkdtemp(join(tmpdir(), "ellie-life-e2e-"));
await chmod(root, 0o700);
const taskDir = join(root, "tasks");
await mkdir(taskDir, { mode: 0o700 });
const store = new LifeStore(join(root, "life.sqlite"));
const plugins = new PluginStore(join(root, "plugins.sqlite"));
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
const harness = createLifeHarness({ store, plugins, tasks, mlb });
const server = createLifeServer({
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
  const listening = await server.listen();
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
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
  await page.getByText("garden.txt").waitFor();
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
  assert.equal(await page.locator(".timeline").getByText("Plan Maya's birthday gift").count(), 0);
  assert.match(
    (await page
      .locator(".agenda-day")
      .filter({ hasText: "Maya's birthday" })
      .getAttribute("aria-label")) ?? "",
    /Oct 30/,
  );
  await page.getByRole("button", { name: /Activity/ }).click();
  const birthdayTask = page.locator(".tasks article").filter({ hasText: /Maya|birthday gift/i });
  await birthdayTask.getByRole("button", { name: "Run" }).click();
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

  const artifactDir = process.env.ELLIE_E2E_ARTIFACT_DIR;
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
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
