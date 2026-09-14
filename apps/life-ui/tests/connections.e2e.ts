import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
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
      label: id === "google-calendar" ? "Private fixture calendar" : "Private fixture inbox",
    };
  },
  async pull() {
    return { accountId: `${id}-fixture-account`, items, cursor: "fixture-cursor", complete: true };
  },
});

const oauth: ConnectedOAuth = {
  begin({ actorId: owner, provider, redirectUri }) {
    const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    target.searchParams.set("client_id", "fixture-client.apps.googleusercontent.com");
    target.searchParams.set("redirect_uri", redirectUri);
    target.searchParams.set("state", `fixture-${provider}-${owner}`);
    return { authorizationUrl: target.href, state: `fixture-${provider}-${owner}` };
  },
  async complete() {
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
const calendar = adapter("google-calendar", calendarItems);
const gmail = adapter("gmail", []);
const connectors = new ConnectorBroker({
  store: connectorStore,
  life,
  vault,
  providers: [calendar, gmail],
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
  const openSettings = async () => {
    const mobile = page.getByLabel("Settings", { exact: true });
    if (await mobile.isVisible()) await mobile.click();
    else await page.locator("aside .settings-link").click();
  };
  await openSettings();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByText("Private fixture calendar").waitFor();
  await page.getByText(/Google Calendar · Connected/).waitFor();
  assert.equal(
    await page.getByLabel("Automatically create private preparation plans").isChecked(),
    true,
  );
  assert.match((await page.locator(".connections").textContent()) ?? "", /read-only connection/);
  const mode = page.locator(".connection-list select").first();
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

  const startRoute = "**/api/connections/start";
  await page.route(startRoute, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=host-opened-fixture",
        openedExternally: true,
      }),
    }),
  );
  const ellieUrl = page.url();
  const gmailConnect = () =>
    page
      .locator(".provider-list article")
      .filter({ hasText: "Gmail" })
      .getByRole("button", { name: "Connect" });
  await gmailConnect().click();
  await page
    .getByRole("status")
    .getByText("Finish connecting in your browser. Ellie will update here when it’s ready.")
    .waitFor();
  assert.equal(page.url(), ellieUrl, "host-opened OAuth keeps the Ellie WebView in place");
  await page.unroute(startRoute);
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
  assert.equal(completed.headers.get("location"), "/?connected=1");
  const replay = await fetch(callback, { redirect: "manual" });
  assert.equal(replay.status, 400, "OAuth callback state is one-use");

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

  await page
    .locator(".connection-list article")
    .filter({ hasText: "Private fixture calendar" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await page
    .locator(".provider-list article")
    .filter({ hasText: "Google Calendar" })
    .getByRole("button", { name: "Connect" })
    .waitFor();
  assert.equal(
    [...vault.values.values()].some((value) => value.accessToken === "browser-fixture-secret"),
    false,
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
