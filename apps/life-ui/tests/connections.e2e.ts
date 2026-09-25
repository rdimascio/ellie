import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import {
  ConnectorBroker,
  type ConnectedOAuth,
  type CredentialVault,
} from "../../../packages/life-connectors/src/broker.ts";
import type {
  LifeProviderAdapter,
  ProviderCredential,
  ProviderId,
  ProviderObservation,
} from "../../../packages/life-connectors/src/provider-types.ts";
import { ConnectorStore } from "../../../packages/life-connectors/src/store.ts";
import { LifeStore } from "../../../packages/life-core/src/index.ts";
import { createLifeHarness } from "../../../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../../../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../../../packages/task-runtime/src/index.ts";
import { createLifeServer } from "../../life/src/server.ts";

process.env.TZ = "America/Los_Angeles";
const actorId = "connected-e2e-user";
const now = Date.now();
const root = await mkdtemp(join(tmpdir(), "ellie-connected-e2e-"));
await chmod(root, 0o700);
await mkdir(join(root, "tasks"), { mode: 0o700 });

class MemoryVault implements CredentialVault {
  readonly values = new Map<string, Record<string, unknown>>();
  put(id: string, value: Record<string, unknown>) {
    this.values.set(id, structuredClone(value));
  }
  get<T extends object>(id: string): T | undefined {
    const value = this.values.get(id);
    return value ? (structuredClone(value) as T) : undefined;
  }
  delete(id: string) {
    this.values.delete(id);
  }
  deleteMatching(predicate: (id: string, value: Record<string, unknown>) => boolean) {
    const selected = [...this.values].filter(([id, value]) => predicate(id, value));
    for (const [id] of selected) this.values.delete(id);
    return selected.length;
  }
}

const event = (
  sourceKey: string,
  title: string,
  startAt: number,
  observedAt = now - 60_000,
): ProviderObservation => ({
  sourceKey,
  sourceRevision: "fixture-v1",
  observedAt,
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

const calendarItems = [
  event("doctor", "Doctor appointment", now + 2 * 86_400_000),
  event("past-1", "Dentist appointment", now - 35 * 86_400_000 + 9 * 3_600_000),
  event("past-2", "Checkup appointment", now - 21 * 86_400_000 + 9 * 3_600_000),
  event("past-3", "Clinic appointment", now - 7 * 86_400_000 + 9 * 3_600_000),
];

const adapter = (id: ProviderId, items: ProviderObservation[]): LifeProviderAdapter => ({
  id,
  async identity() {
    return {
      accountId: `${id}-fixture-account`,
      label:
        id === "google-calendar"
          ? "Private fixture calendar"
          : id === "plaid"
            ? "Private fixture bank"
            : "Private fixture inbox",
    };
  },
  async pull() {
    return { accountId: `${id}-fixture-account`, items, cursor: "fixture-cursor", complete: true };
  },
});

let latestOAuthState = "";
let tokenExchanges = 0;
const oauth: ConnectedOAuth = {
  begin({ actorId: owner, provider, redirectUri }) {
    latestOAuthState = `fixture-${provider}-${owner}`;
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.searchParams.set("client_id", "fixture-client.apps.googleusercontent.com");
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("state", latestOAuthState);
    return { authorizationUrl: target.href, state: latestOAuthState };
  },
  async complete() {
    tokenExchanges++;
    return {
      actorId,
      provider: "gmail" as const,
      credential: { accessToken: "gmail-browser-fixture-secret" },
      grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    };
  },
  async refreshCredential(credential) {
    return credential;
  },
};

const life = new LifeStore(join(root, "life.sqlite"));
const plugins = new PluginStore(join(root, "plugins.sqlite"));
const tasks = new TaskRuntime({
  directory: join(root, "tasks"),
  tickMs: 20,
  capabilityResolver: () => [
    "life.records.read",
    "life.records.write",
    "life.connections.read",
    "life.connections.write",
  ],
});
const connectorStore = new ConnectorStore(join(root, "connectors.sqlite"));
const vault = new MemoryVault();
const selectedItems = [event("selected-only", "Selected calendar visit", now + 4 * 86_400_000)];
const calendar: LifeProviderAdapter = {
  ...adapter("google-calendar", calendarItems),
  async calendars() {
    return [
      { id: "primary", label: "Primary fixture", primary: true },
      { id: "selected@example.test", label: "Selected fixture", primary: false },
    ];
  },
  async pull(input) {
    return {
      accountId: "google-calendar-fixture-account",
      items: input.resourceId === "selected@example.test" ? selectedItems : calendarItems,
      cursor: "fixture-cursor",
      complete: true,
    };
  },
};
let explicitFullReads = 0;
const gmail: LifeProviderAdapter = {
  ...adapter("gmail", [
    {
      sourceKey: "fixture-message",
      sourceRevision: "fixture-v1",
      observedAt: now,
      title: "Private fixture subject",
      kind: "message",
      data: {
        sentAt: now,
        from: "sender@example.test",
        to: ["owner@example.test"],
        subject: "Private fixture subject",
        snippet: "Bounded fixture snippet",
        direction: "incoming",
      },
    },
  ]),
  async readMessageText(messageId) {
    explicitFullReads++;
    assert.equal(messageId, "fixture-message");
    return { status: "plain", text: "Private fixture body, fetched only after selection." };
  },
};
const plaid = adapter(
  "plaid",
  [61, 31, 1].map((days): ProviderObservation => ({
    sourceKey: `charge-${days}`,
    sourceRevision: "settled-v1",
    observedAt: now - 60_000,
    title: "Fixture Streaming",
    kind: "transaction",
    data: {
      postedAt: now - days * 86_400_000,
      amountDecimal: "12.00",
      currency: "USD",
      merchant: "Fixture Streaming",
      pending: false,
    },
  })),
);
const connectors = new ConnectorBroker({
  store: connectorStore,
  life,
  vault,
  providers: [calendar, gmail, plaid],
  tasks,
  oauth,
  now: () => now,
});
const harness = createLifeHarness({
  store: life,
  plugins,
  tasks,
  mlb: new MLBAdapter(),
  model: {
    async plan() {
      return { reply: "Fixture reply.", actions: [] };
    },
    async build() {
      return { name: "Fixture", description: "Fixture", html: "<main>Fixture</main>" };
    },
  },
});
let openExternally = true;
const server = createLifeServer({
  stateDir: root,
  assetsDir: resolve("apps/life-ui/dist"),
  store: life,
  plugins,
  tasks,
  harness,
  connectors,
  port: 0,
  userId: actorId,
  userName: "Connected E2E",
  timeZone: "America/Los_Angeles",
  now: () => now,
  openAuthorizationUrl: async () => openExternally,
});
const browser = await chromium.launch({ headless: true });

try {
  tasks.start();
  const connection = await connectors.connect(
    actorId,
    "google-calendar",
    { accessToken: "browser-fixture-secret" },
    "prepare",
    ["https://www.googleapis.com/auth/calendar.readonly"],
  );
  const workflowDeadline = Date.now() + 10_000;
  while (
    life.listPlanRecords({ userId: actorId }, { scope: { type: "user", id: actorId }, limit: 10 })
      .length === 0
  ) {
    if (Date.now() >= workflowDeadline)
      throw new Error("Connected research did not durably publish a preparation plan.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const bank = await connectors.connect(
    actorId,
    "plaid",
    { accessToken: "bank-fixture-secret" },
    "observe",
    [],
  );
  const financialRecord = () =>
    life
      .listRecords(
        { userId: actorId },
        {
          scope: { type: "user", id: actorId },
          kinds: ["memory"],
        },
      )
      .find(
        (record) =>
          record.data.type === "connected-insight-v1" && record.title.includes("Fixture Streaming"),
      );
  const financialDeadline = Date.now() + 10_000;
  while (!financialRecord()) {
    if (Date.now() >= financialDeadline)
      throw new Error("Plaid broker did not publish its financial insight.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  const financialInsight = financialRecord()!;
  assert.equal(financialInsight.provenance[0]?.sourceId, `connected-source-${bank.id}`);
  assert.equal(financialInsight.provenance[0]?.derived, true);
  const listening = await server.listen();
  const unauthorized = await fetch(`${listening.url}/api/connections`);
  assert.equal(unauthorized.status, 401, "connected metadata requires a local session");

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    timezoneId: "America/Los_Angeles",
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(listening.launchUrl);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.getByRole("button", { name: "Talk to Ellie", exact: true }).waitFor();
  const forgedTitle = "A manual memory is not an account insight";
  const forged = await page.evaluate(
    async ({ actorId, bankId, now, title }) => {
      const response = await fetch("/api/life/records", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "memory",
          title,
          scope: { type: "user", id: actorId },
          data: {
            type: "connected-insight-v1",
            connected: { connectionId: bankId, expiresAt: now + 60_000 },
          },
        }),
      });
      return { status: response.status, record: await response.json() };
    },
    { actorId, bankId: bank.id, now, title: forgedTitle },
  );
  assert.equal(forged.status, 201);
  assert.deepEqual(forged.record.provenance, []);
  await page.reload();
  const bootstrapRecord = await page.evaluate(async (id) => {
    const response = await fetch("/api/life/bootstrap");
    const value = await response.json();
    return value.records.find((record: { id: string }) => record.id === id);
  }, financialInsight.id);
  assert.equal(bootstrapRecord.provenance, undefined);
  assert.equal(bootstrapRecord.data.connected, undefined);
  const detail = page.waitForResponse((response) =>
    response.url().endsWith(`/api/life/records/${financialInsight.id}`),
  );
  await page.locator(".bottom").getByRole("button", { name: "Finances", exact: true }).click();
  assert.equal((await detail).status(), 200);
  await page
    .locator(".finance-insights")
    .getByRole("heading", { name: financialInsight.title, exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".finance-insights").getByText(forgedTitle, { exact: true }).count(),
    0,
  );
  console.log(
    "Finances accepts broker-produced Plaid detail provenance and rejects signed-in user-created lookalikes.",
  );
  await page.goto(`${listening.url}/?section=connections&view=settings`);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.goto(`${listening.url}/?view=settings&section=connections`);
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.equal(await page.locator(".setting-scope select").inputValue(), `user:${actorId}`);
  await page.getByRole("heading", { name: "Connected accounts", exact: true }).waitFor();
  const openSettings = async () => {
    const mobile = page.getByLabel("Settings", { exact: true });
    await expect(mobile).toBeVisible();
    await mobile.click();
  };
  const holdNextConnectionsList = async () => {
    let capture!: () => void;
    let release!: () => void;
    let delivered!: () => void;
    const captured = new Promise<void>((resolve) => (capture = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const finished = new Promise<void>((resolve) => (delivered = resolve));
    let held = false;
    const routePattern = "**/api/connections";
    const handler = async (route: import("@playwright/test").Route) => {
      if (held || route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      held = true;
      const stale = await route.fetch();
      capture();
      await gate;
      await route.fulfill({ response: stale });
      delivered();
    };
    await page.route(routePattern, handler);
    await Promise.race([
      captured,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for the owned status poll.")), 7_000),
      ),
    ]);
    return async () => {
      release();
      await finished;
      await page.unroute(routePattern, handler);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    };
  };
  await page.getByText("Private fixture calendar").waitFor();
  await page.getByText(/Google Calendar · Connected/).waitFor();
  assert.equal(
    await page.getByLabel("Automatically create private preparation plans").isChecked(),
    true,
  );
  assert.match((await page.locator(".connections").textContent()) ?? "", /read-only connection/);
  const mode = page
    .locator(".connection-list article")
    .filter({ hasText: "Private fixture calendar" })
    .locator("select");
  await mode.selectOption("observe");
  await page.waitForFunction(async () => {
    const response = await fetch("/api/connections");
    const value = await response.json();
    return (
      value.connections.find((item: { provider: string }) => item.provider === "google-calendar")
        ?.mode === "observe"
    );
  });
  await mode.selectOption("prepare");
  await page.waitForFunction(async () => {
    const response = await fetch("/api/connections");
    const value = await response.json();
    return (
      value.connections.find((item: { provider: string }) => item.provider === "google-calendar")
        ?.mode === "prepare"
    );
  });
  const calendarArticle = page
    .locator(".connection-list article")
    .filter({ hasText: "Private fixture calendar" });
  const refreshRoute = "**/api/connections/*/refresh";
  await page.route(refreshRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Calendar refresh is unavailable." }),
    }),
  );
  await calendarArticle.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("alert").getByText("Calendar refresh is unavailable.").waitFor();
  await page.getByText(/Google Calendar · Connected/).waitFor();
  await page.unroute(refreshRoute);
  await calendarArticle.getByRole("button", { name: "Refresh" }).click();
  await page.getByText(/Google Calendar · Connected/).waitFor();

  const ellieUrl = page.url();
  const gmailConnect = () =>
    page
      .locator(".provider-list article")
      .filter({ hasText: "Gmail" })
      .getByRole("button", { name: "Connect" });
  await expect(gmailConnect()).toBeEnabled();
  const deliverPreStartList = await holdNextConnectionsList();
  await gmailConnect().click();
  await page
    .getByRole("status")
    .getByText("Finish connecting in your browser. Ellie will update here when it’s ready.")
    .waitFor();
  assert.equal(page.url(), ellieUrl, "host-opened OAuth keeps the Ellie WebView in place");
  assert.equal(await gmailConnect().count(), 0, "pending setup cannot create a duplicate");
  await deliverPreStartList();
  assert.equal(
    await page.getByRole("button", { name: "Stop setup" }).count(),
    1,
    "a delayed pre-start list must not clear the current setup",
  );
  const cancelRoute = "**/api/connections/*/revoke";
  await page.route(cancelRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Connection cancellation is unavailable." }),
    }),
  );
  await page.getByRole("button", { name: "Stop setup" }).click();
  await page.getByRole("alert").getByText("Connection cancellation is unavailable.").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Stop setup" }).count(),
    1,
    "failed cancellation must retain the pending setup and its recovery control",
  );
  await page.unroute(cancelRoute);
  await expect(page.getByRole("button", { name: "Stop setup" })).toBeEnabled();
  const deliverPreStopList = await holdNextConnectionsList();
  await page.getByRole("button", { name: "Stop setup" }).click();
  await page
    .getByRole("status")
    .getByText("Google connection setup did not finish. You can start again.")
    .waitFor();
  await deliverPreStopList();
  assert.equal(await page.getByRole("button", { name: "Stop setup" }).count(), 0);
  await page.getByText(/Gmail · Disconnected/).waitFor();
  const stoppedCallback = await fetch(
    `${listening.url}/api/connections/callback?state=${encodeURIComponent(latestOAuthState)}&code=late-synthetic-code`,
    { redirect: "manual" },
  );
  assert.equal(stoppedCallback.status, 400);
  assert.equal(tokenExchanges, 0, "stopped setup never reaches the token exchange");
  await gmailConnect().waitFor();
  openExternally = false;
  await page.reload();
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await openSettings();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();

  await gmailConnect().click();
  const externalLink = page.getByRole("link", {
    name: "Open Google sign-in in an external browser",
  });
  await externalLink.waitFor();
  await page.getByRole("button", { name: "Copy sign-in link" }).waitFor();
  await context.route("https://accounts.google.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<title>OAuth fixture</title>" }),
  );
  const popupPromise = page.waitForEvent("popup");
  await externalLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const authorization = new URL(popup.url());
  assert.equal(authorization.pathname, "/o/oauth2/v2/auth");
  assert.equal(page.url(), ellieUrl, "explicit sign-in link does not replace the Ellie WebView");
  await popup.close();
  const callback = `${listening.url}/api/connections/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=fixture-code`;
  const completed = await fetch(callback, { redirect: "manual" });
  assert.equal(completed.status, 303, "OAuth callback does not require the browser session cookie");
  assert.equal(tokenExchanges, 1, "only the explicitly completed setup exchanges a token");
  assert.equal(completed.headers.get("location"), "/connections/complete");
  const replay = await fetch(callback, { redirect: "manual" });
  assert.equal(replay.status, 400, "OAuth callback state is one-use");
  await page.reload();
  await openSettings();
  const gmailArticle = page
    .locator(".connection-list article")
    .filter({ hasText: "Private fixture inbox" });
  await gmailArticle.getByRole("button", { name: "View imported activity" }).click();
  await gmailArticle.getByText(/Private fixture subject/).waitFor();
  await gmailArticle.getByText(/Bounded fixture snippet/).waitFor();
  assert.equal(explicitFullReads, 0, "preview must not fetch any message body");
  await gmailArticle
    .getByRole("button", { name: /Private fixture subject.*sender@example.test/ })
    .click();
  await gmailArticle
    .getByRole("region", { name: "Selected Gmail message" })
    .getByText("Private fixture body, fetched only after selection.")
    .waitFor();
  assert.equal(explicitFullReads, 1);
  await calendarArticle.getByRole("button", { name: "View imported activity" }).click();
  assert.equal(
    await gmailArticle.getByText("Private fixture body, fetched only after selection.").count(),
    0,
  );
  const gmailId = connectorStore
    .list(actorId)
    .find((item) => item.provider === "gmail" && item.state === "connected")!.id;
  const otherStateDir = join(root, "other-actor");
  await mkdir(otherStateDir, { mode: 0o700 });
  const otherServer = createLifeServer({
    stateDir: otherStateDir,
    assetsDir: resolve("apps/life-ui/dist"),
    store: life,
    plugins,
    tasks,
    harness,
    connectors,
    port: 0,
    userId: "different-fixture-actor",
    userName: "Other fixture actor",
    timeZone: "America/Los_Angeles",
    now: () => now,
  });
  try {
    const otherListening = await otherServer.listen();
    const otherContext = await browser.newContext();
    try {
      const otherPage = await otherContext.newPage();
      await otherPage.goto(otherListening.launchUrl);
      const deniedMessage = await otherPage.evaluate(
        async ({ id }) =>
          fetch(`/api/connections/${encodeURIComponent(id)}/messages/fixture-message`).then(
            (response) => response.status,
          ),
        { id: gmailId },
      );
      assert.notEqual(deniedMessage, 200, "another actor cannot open imported mail");
      assert.equal(explicitFullReads, 1, "cross-actor denial must precede provider access");
    } finally {
      await otherContext.close();
    }
  } finally {
    await otherServer.close();
  }
  let releaseGmailRead!: () => void;
  let captureGmailRead!: () => void;
  let deliveredGmailRead!: () => void;
  const heldGmail = new Promise<void>((resolve) => {
    captureGmailRead = resolve;
  });
  const gmailGate = new Promise<void>((resolve) => {
    releaseGmailRead = resolve;
  });
  const deliveredGmail = new Promise<void>((resolve) => {
    deliveredGmailRead = resolve;
  });
  const gmailPreviewRoute = async (route: import("@playwright/test").Route) => {
    if (!route.request().url().endsWith(`/api/connections/${gmailId}/preview`)) {
      await route.continue();
      return;
    }
    const stale = await route.fetch();
    captureGmailRead();
    await gmailGate;
    await route.fulfill({ response: stale });
    deliveredGmailRead();
  };
  await page.route("**/api/connections/*/preview", gmailPreviewRoute);
  try {
    await gmailArticle.getByRole("button", { name: "View imported activity" }).click();
    await Promise.race([
      heldGmail,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for held Gmail preview.")), 7_000),
      ),
    ]);
    await calendarArticle.getByRole("button", { name: "View imported activity" }).click();
    assert.equal(
      await calendarArticle.getByText(/Private fixture subject/).count(),
      0,
      "the second account must never display the first account's preview",
    );
    releaseGmailRead();
    await deliveredGmail;
  } finally {
    releaseGmailRead();
    await page.unroute("**/api/connections/*/preview", gmailPreviewRoute);
  }
  await calendarArticle.getByText("Doctor appointment").waitFor();
  assert.equal(
    await calendarArticle.getByText(/Private fixture subject/).count(),
    0,
    "a late first-account response cannot overwrite the selected account",
  );

  await page.goto(listening.url);
  await page.getByRole("heading", { name: "Home", exact: true }).waitFor();
  await page.locator(".plan-widget").getByText(/saved/).waitFor();
  await page.locator(".plan-widget .widget-open").click();
  const doctorPlan = page.getByRole("button", { name: /Prepare for Doctor appointment/ });
  await doctorPlan.waitFor();
  await doctorPlan.click();
  await page.getByText(/confirmed appointment is scheduled/i).waitFor();
  await page.getByLabel("Check whether any pre-visit forms need attention").waitFor();
  const artifactDir = process.env.ELLIE_E2E_ARTIFACT_DIR;
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "connected-plan-mobile.png"),
      fullPage: false,
    });
  }
  await page.getByRole("button", { name: "Close" }).click();

  await openSettings();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await calendarArticle.getByRole("button", { name: "View imported activity" }).click();
  await calendarArticle.getByText("Doctor appointment").waitFor();
  const rejectedCalendar = await page.evaluate(
    async (id) =>
      fetch(`/api/connections/${id}/calendar`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ calendarId: "not-in-the-account" }),
      }).then((response) => response.status),
    connection.id,
  );
  assert.notEqual(rejectedCalendar, 200);
  assert.equal(connectorStore.get(actorId, connection.id)?.selectedCalendarId, undefined);
  assert.equal(
    connectorStore
      .observations(actorId, connection.id)
      .some((item) => item.title === "Doctor appointment"),
    true,
  );
  await calendarArticle.getByLabel("Calendar to read").selectOption("selected@example.test");
  await calendarArticle.getByText("Selected calendar visit").waitFor();
  assert.equal(
    await calendarArticle.getByText("Doctor appointment").count(),
    0,
    "switching calendars replaces only this connection's imported evidence",
  );
  const selectedRead = await page.evaluate(async (id) => {
    const response = await fetch(`/api/connections/${id}/preview`);
    return response.json();
  }, connection.id);
  assert.deepEqual(
    selectedRead.items.map((item: { title: string }) => item.title),
    ["Selected calendar visit"],
  );
  await gmailArticle.getByRole("button", { name: "View imported activity" }).click();
  await gmailArticle.getByText(/Private fixture subject/).waitFor();
  let releaseMessageRead!: () => void;
  let messageReadCaptured!: () => void;
  const heldMessageRead = new Promise<void>((resolve) => {
    messageReadCaptured = resolve;
  });
  const messageReadGate = new Promise<void>((resolve) => {
    releaseMessageRead = resolve;
  });
  let messageRouteSettled!: () => void;
  const routeSettled = new Promise<void>((resolve) => {
    messageRouteSettled = resolve;
  });
  const messageRoute = async (route: import("@playwright/test").Route) => {
    try {
      const response = await route.fetch();
      messageReadCaptured();
      await messageReadGate;
      try {
        await route.fulfill({ response });
      } catch (error) {
        if (!(error instanceof Error) || !/Route is already handled/.test(error.message))
          throw error;
      }
    } finally {
      messageRouteSettled();
    }
  };
  await page.route("**/api/connections/*/messages/*", messageRoute);
  try {
    await gmailArticle
      .getByRole("button", { name: /Private fixture subject.*sender@example.test/ })
      .click();
    await Promise.race([
      heldMessageRead,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for held message read.")), 7_000),
      ),
    ]);
    assert.equal(explicitFullReads, 2);
    assert.equal(
      await page.evaluate(
        (id) =>
          fetch(`/api/connections/${id}/revoke`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }).then((response) => response.status),
        gmailId,
      ),
      200,
    );
    await page
      .locator(".provider-list article")
      .filter({ hasText: "Gmail" })
      .getByRole("button", { name: "Connect" })
      .waitFor({ timeout: 10_000 });
  } finally {
    releaseMessageRead();
    await Promise.race([
      routeSettled,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Held message route did not settle.")), 7_000),
      ),
    ]);
    await page.unroute("**/api/connections/*/messages/*", messageRoute);
  }
  assert.equal(
    await page
      .locator(".connections")
      .getByText(/Bounded fixture snippet/)
      .count(),
    0,
    "a polled revocation clears the previously opened private preview",
  );
  assert.equal(
    await page.getByText("Private fixture body, fetched only after selection.").count(),
    0,
    "a late message response cannot restore private body after revocation",
  );
  if (artifactDir) {
    await page
      .getByRole("heading", { name: "Connected accounts", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: "disabled",
      path: join(artifactDir, "connected-accounts-mobile.png"),
      fullPage: false,
    });
  }

  await page.getByRole("button", { name: "Inspect my data" }).click();
  await page
    .getByText(/account/)
    .last()
    .waitFor();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download my archive" }).click();
  const download = await downloadPromise;
  const archivePath = join(root, "connected-archive.json");
  await download.saveAs(archivePath);
  const archive = await readFile(archivePath, "utf8");
  assert.match(archive, /ellie-connectors-v1/);
  assert.match(archive, /Doctor appointment/);
  assert.doesNotMatch(archive, /browser-fixture-secret/);
  assert.doesNotMatch(archive, /Private fixture body, fetched only after selection/);

  await page.route(cancelRoute, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Calendar disconnect is unavailable." }),
    }),
  );
  await calendarArticle.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("alert").getByText("Calendar disconnect is unavailable.").waitFor();
  await page.getByText(/Google Calendar · Connected/).waitFor();
  await page.unroute(cancelRoute);
  const connectedCalendar = connectorStore.get(actorId, connection.id)!;
  connectorStore.update(
    actorId,
    connection.id,
    connectedCalendar.generation,
    { state: "error", error: "revoked" },
    true,
  );
  await page.getByText(/Google Calendar · Needs attention/).waitFor({ timeout: 10_000 });
  await calendarArticle
    .getByRole("alert")
    .getByText(
      "Account access expired or was revoked. Disconnect, then connect again to review access.",
    )
    .waitFor();
  assert.equal(
    await calendarArticle.getByRole("alert").getByText("revoked", { exact: true }).count(),
    0,
    "revoked credentials must show a recovery action instead of a machine code",
  );
  await calendarArticle.getByRole("button", { name: "Disconnect" }).click();
  await page
    .locator(".provider-list article")
    .filter({ hasText: "Google Calendar" })
    .getByRole("button", { name: "Connect" })
    .waitFor();
  assert.equal(
    await page.evaluate(
      (id) => fetch(`/api/connections/${id}/preview`).then((response) => response.status),
      connection.id,
    ),
    404,
  );
  assert.equal(
    [...vault.values.values()].some((value) => value.accessToken === "browser-fixture-secret"),
    false,
  );
  await page
    .locator(".provider-list article")
    .filter({ hasText: "Google Calendar" })
    .getByRole("button", { name: "Connect" })
    .click();
  const cancelledLink = await page
    .getByRole("link", {
      name: "Open Google sign-in in an external browser",
    })
    .getAttribute("href");
  assert.ok(cancelledLink);
  const cancelledState = new URL(cancelledLink).searchParams.get("state");
  assert.ok(cancelledState);
  const denied = await fetch(
    `${listening.url}/api/connections/callback?state=${encodeURIComponent(cancelledState)}&error=access_denied`,
    { redirect: "manual" },
  );
  assert.equal(denied.status, 303);
  await page
    .getByRole("status")
    .getByText("Google connection setup did not finish. You can start again.")
    .waitFor({ timeout: 10_000 });
  assert.equal(
    await page
      .getByRole("link", {
        name: "Open Google sign-in in an external browser",
      })
      .count(),
    0,
    "a denied OAuth link must no longer be offered",
  );
  await page.getByRole("button", { name: "Refresh summary" }).click();
  await page.getByRole("button", { name: "Review reset" }).waitFor();
  await page.getByRole("button", { name: "Review reset" }).click();
  await page.getByLabel(/Type RESET MY PRIVATE DATA/).fill("RESET MY PRIVATE DATA");
  await page.getByRole("button", { name: "Reset private data" }).click();
  await page.getByText("Private data reset complete").waitFor({ timeout: 15_000 });
  assert.equal(connectorStore.list(actorId).length, 0);
  assert.equal(connectorStore.export(actorId).items.length, 0);
  assert.equal(vault.values.size, 0);
  assert.deepEqual(errors, []);
  console.log(`connected life UI E2E passed at ${listening.url}`);
  await context.close();
} finally {
  await browser.close();
  await server.close();
  await connectors.close();
  await tasks.close();
  connectorStore.close();
  plugins.close();
  life.close();
  await rm(root, { recursive: true, force: true });
}
