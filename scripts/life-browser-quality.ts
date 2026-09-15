import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser as PlaywrightBrowser, type Page } from "@playwright/test";
import {
  startLifeBrowserQualityFixture,
  type BrowserQualityModel,
} from "./life-browser-quality-fixture.ts";

type ScenarioStatus = "pass" | "fail" | "skipped";
interface ScenarioReceipt {
  name: string;
  status: ScenarioStatus;
  startedAt: string;
  durationMs: number;
  checks: string[];
  snapshots: string[];
  screenshots: string[];
  error?: string;
}
interface SnapshotRef {
  role?: string;
  name?: string;
}

const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT = 1024 * 1024;
const runnerPath = fileURLToPath(import.meta.url);
const browserPath = resolve("node_modules/.bin/agent-browser");
const reportRoot = resolve(
  process.env.REPORT_DIR ?? join("/tmp", `ellie-life-browser-quality-${Date.now()}`),
);
const session = `elq-${process.pid}-${randomUUID().slice(0, 4)}`;
const browserConfigPath = join(reportRoot, "agent-browser-config.json");
const scenarioNames = ["memory", "pending-status", "reminder", "arcade", "mlb"] as const;
const requestedScenarios = new Set(
  (process.env.LIFE_QUALITY_SCENARIOS ?? scenarioNames.join(","))
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean),
);
if ([...requestedScenarios].some((name) => !(scenarioNames as readonly string[]).includes(name)))
  throw new Error(`LIFE_QUALITY_SCENARIOS must contain: ${scenarioNames.join(", ")}.`);
if (requestedScenarios.size === 0) throw new Error("LIFE_QUALITY_SCENARIOS cannot be empty.");
const commandLog: Array<{ command: string; durationMs: number; ok: boolean }> = [];
let launchSecret = "";
let publicOrigin = "";
let bridgeBrowser: PlaywrightBrowser | undefined;
let bridgePage: Page | undefined;

function redact(value: string): string {
  let clean = value;
  if (launchSecret) clean = clean.replaceAll(launchSecret, `${publicOrigin}/[session-bootstrap]`);
  if (publicOrigin)
    clean = clean.replace(
      new RegExp(
        `${publicOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s"']*[?&](?:token|session)=[^\\s"']+`,
        "g",
      ),
      `${publicOrigin}/[session-bootstrap]`,
    );
  return clean;
}

async function browser(
  args: string[],
  options: { timeoutMs?: number; record?: boolean } = {},
): Promise<string> {
  const started = Date.now();
  const safeArgs = options.record === false ? ["open", "[session-bootstrap]"] : args;
  try {
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(
        browserPath,
        ["--namespace", session, "--config", browserConfigPath, "--session", session, ...args],
        {
          cwd: resolve("."),
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                ([key]) =>
                  !key.startsWith("AGENT_BROWSER_") || key === "AGENT_BROWSER_EXECUTABLE_PATH",
              ),
            ),
            AGENT_BROWSER_CONFIG: browserConfigPath,
            AGENT_BROWSER_MAX_OUTPUT: String(MAX_COMMAND_OUTPUT),
            AGENT_BROWSER_IDLE_TIMEOUT_MS: "180000",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) =>
        (current + chunk.toString("utf8")).slice(-MAX_COMMAND_OUTPUT);
      child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
      child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        const combined = redact(`${stdout}${stderr ? `\n${stderr}` : ""}`.trim());
        if (code === 0 && !killed) resolveOutput(combined);
        else reject(new Error(`agent-browser ${safeArgs.join(" ")} failed (${code}): ${combined}`));
      });
    });
    commandLog.push({ command: safeArgs.join(" "), durationMs: Date.now() - started, ok: true });
    return output;
  } catch (error) {
    commandLog.push({ command: safeArgs.join(" "), durationMs: Date.now() - started, ok: false });
    throw error;
  }
}

async function snapshot(receipt: ScenarioReceipt, name: string, interactive = false) {
  const raw = await browser(["--json", "snapshot", ...(interactive ? ["-i"] : ["-c"])]);
  const parsed = JSON.parse(raw) as {
    success: boolean;
    data: { snapshot: string; refs: Record<string, SnapshotRef> };
  };
  assert.equal(parsed.success, true);
  const safe = redact(parsed.data.snapshot);
  const path = join(reportRoot, `${receipt.name}-${name}.snapshot.txt`);
  await writeFile(path, `${safe}\n`, { mode: 0o600 });
  receipt.snapshots.push(basename(path));
  return { text: safe, refs: parsed.data.refs };
}

function ref(
  value: { refs: Record<string, SnapshotRef> },
  role: string,
  name: string | RegExp,
  index = 0,
): string {
  const matches = Object.entries(value.refs).filter(([, item]) => {
    const actualName = item.name ?? "";
    return (
      item.role === role && (typeof name === "string" ? actualName === name : name.test(actualName))
    );
  });
  const match = index < 0 ? matches.at(index) : matches[index];
  assert.ok(match, `Expected ${role} ${String(name)} at index ${index}`);
  return `@${match![0]}`;
}

async function click(
  receipt: ScenarioReceipt,
  step: string,
  role: string,
  name: string | RegExp,
  index = 0,
) {
  const observed = await snapshot(receipt, `${step}-before`, true);
  await browser(["click", ref(observed, role, name, index)]);
  await snapshot(receipt, `${step}-after`, false);
}

async function fillAndClick(
  receipt: ScenarioReceipt,
  step: string,
  fieldRole: string,
  fieldName: string | RegExp,
  value: string,
  buttonName: string | RegExp,
) {
  let observed = await snapshot(receipt, `${step}-form`, true);
  await browser(["fill", ref(observed, fieldRole, fieldName), value]);
  observed = await snapshot(receipt, `${step}-filled`, true);
  await browser(["click", ref(observed, "button", buttonName)]);
}

async function screenshot(receipt: ScenarioReceipt, name: string) {
  const path = join(reportRoot, `${receipt.name}-${name}.png`);
  await browser(["screenshot", "--full", path]);
  receipt.screenshots.push(basename(path));
}

async function sendChat(receipt: ScenarioReceipt, step: string, message: string) {
  await snapshot(receipt, `${step}-before`, false);
  const articleCount = Number(await browser(["get", "count", ".messages article"]));
  await fillAndClick(receipt, step, "textbox", "Message Ellie", message, "Send message");
  await browser(
    [
      "wait",
      "--fn",
      `document.querySelectorAll('.messages article').length >= ${articleCount + 2} && !document.querySelector('.typing,.provisional-reply')`,
    ],
    { timeoutMs: 20_000 },
  );
  return snapshot(receipt, `${step}-result`, false);
}

async function openHome(receipt: ScenarioReceipt) {
  await browser(["open", publicOrigin]);
  await browser(["wait", "--load", "networkidle"]);
  await snapshot(receipt, "home", false);
}

function pluginFrame(title: string) {
  assert.ok(bridgePage, "Playwright bridge was not attached to the owned browser page");
  return bridgePage
    .frameLocator(`iframe[title=${JSON.stringify(title)}]`)
    .frameLocator('iframe[title="Plugin"]');
}

async function runScenario(
  name: string,
  action: (receipt: ScenarioReceipt) => Promise<void>,
): Promise<ScenarioReceipt> {
  const receipt: ScenarioReceipt = {
    name,
    status: "pass",
    startedAt: new Date().toISOString(),
    durationMs: 0,
    checks: [],
    snapshots: [],
    screenshots: [],
  };
  const started = Date.now();
  try {
    if (!requestedScenarios.has(name)) {
      receipt.status = "skipped";
      receipt.checks.push("not selected by LIFE_QUALITY_SCENARIOS");
    } else await action(receipt);
  } catch (error) {
    receipt.status = "fail";
    receipt.error = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
    await screenshot(receipt, "failure").catch(() => {});
  } finally {
    receipt.durationMs = Date.now() - started;
    await writeFile(join(reportRoot, `${name}.json`), `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
  }
  return receipt;
}

function configuredModel(): BrowserQualityModel {
  const url = process.env.LIFE_QUALITY_MODEL_URL;
  const model = process.env.LIFE_QUALITY_MODEL_ID;
  if ((url && !model) || (!url && model))
    throw new Error("Set both LIFE_QUALITY_MODEL_URL and LIFE_QUALITY_MODEL_ID.");
  if (!url || !model) return { mode: "synthetic" };
  const endpoint = new URL(url);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)
  )
    throw new Error("The optional quality model endpoint must be explicit loopback HTTP.");
  return { mode: "loopback", url, model };
}

async function main() {
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  await writeFile(browserConfigPath, "{}\n", { mode: 0o600 });
  const fixture = await startLifeBrowserQualityFixture({ model: configuredModel() });
  publicOrigin = fixture.url;
  launchSecret = fixture.launchUrl;
  const receipts: ScenarioReceipt[] = [];
  let cleanupError: unknown;
  const diagnostics: { console?: string; errors?: string } = {};
  try {
    await browser(["open", fixture.launchUrl], { record: false });
    await browser(["wait", "--load", "networkidle"]);
    await browser(["set", "viewport", "390", "844"]);
    assert.equal(await browser(["get", "url"]), fixture.url + "/");
    const cdpUrl = await browser(["get", "cdp-url"]);
    bridgeBrowser = await chromium.connectOverCDP(cdpUrl);
    bridgePage = bridgeBrowser
      .contexts()
      .flatMap((context) => context.pages())
      .find((page) => page.url() === fixture.url + "/");
    assert.ok(bridgePage, "Expected the exact fixture-origin page in the owned browser session");
    bridgePage.setDefaultTimeout(20_000);
    bridgePage.setDefaultNavigationTimeout(30_000);

    receipts.push(
      await runScenario("memory", async (receipt) => {
        await openHome(receipt);
        await click(receipt, "open-orb", "button", "Talk to Ellie");
        await sendChat(receipt, "preference", "I prefer jasmine tea after lunch.");
        await click(receipt, "new-conversation", "button", "New");
        const beforeRecall = fixture.captures.modelMessages.length;
        await sendChat(receipt, "recall", "Which tea preference should guide your suggestions?");
        assert.equal(fixture.captures.modelMessages.length, beforeRecall + 1);
        assert.match(
          fixture.captures.modelMessages
            .at(-1)!
            .map((item) => item.content)
            .join("\n"),
          /jasmine tea/i,
        );
        await sendChat(receipt, "forget", "Forget jasmine tea.");
        const beforeProbe = fixture.captures.modelMessages.length;
        await sendChat(receipt, "post-forget-probe", "Which drink preference remains relevant?");
        assert.equal(fixture.captures.modelMessages.length, beforeProbe + 1);
        assert.doesNotMatch(
          fixture.captures.modelMessages
            .at(-1)!
            .map((item) => item.content)
            .join("\n"),
          /jasmine tea/i,
        );
        receipt.checks.push(
          "Orb chat rendered",
          "new-conversation request received remembered preference context",
          "same-conversation neutral probe excluded forgotten phrase from all model messages",
        );
        await screenshot(receipt, "complete");
      }),
    );

    receipts.push(
      await runScenario("pending-status", async (receipt) => {
        if (fixture.modelMode !== "synthetic") {
          receipt.status = "skipped";
          receipt.checks.push("synthetic-only held model gate is unavailable in loopback mode");
          return;
        }
        await openHome(receipt);
        await click(receipt, "open-orb", "button", "Talk to Ellie");
        const gate = fixture.syntheticModelGate!.holdNext();
        try {
          await fillAndClick(
            receipt,
            "held-prompt",
            "textbox",
            "Message Ellie",
            "Help me think through tomorrow.",
            "Send message",
          );
          await Promise.race([
            gate.entered,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Synthetic model gate was not entered.")), 10_000),
            ),
          ]);
          await browser(["wait", "750"]);
          const pending = await snapshot(receipt, "pending", false);
          await screenshot(receipt, "pending");
          const pendingText = await browser(["get", "text", ".messages"]);
          const pendingTextFile = `${receipt.name}-pending-rendered-text.txt`;
          await writeFile(join(reportRoot, pendingTextFile), pendingText, { mode: 0o600 });
          receipt.snapshots.push(pendingTextFile);
          assert.match(pendingText, /Help me think through tomorrow/);
          assert.match(pendingText, /Getting ready|Drafting|Checking draft|●\s*●\s*●/);
          assert.doesNotMatch(pendingText, /connection ended|check what happened/i);
          assert.doesNotMatch(pending.text, /connection ended|check what happened/i);
          assert.equal(Number(await browser(["get", "count", ".request-recovery"])), 0);
          assert.doesNotMatch(pendingText, /Synthetic contextual reply/);
        } finally {
          gate.release();
        }
        await browser([
          "wait",
          "--fn",
          "document.querySelectorAll('.messages article').length === 2 && document.querySelectorAll('.messages article.ellie').length === 1 && !document.querySelector('.typing,.provisional-reply')",
        ]);
        await snapshot(receipt, "completed", false);
        assert.match(await browser(["get", "text", ".messages"]), /Synthetic contextual reply/);

        await click(receipt, "new-before-interruption", "button", "New");
        await browser(["network", "route", "**/api/life/chat", "--abort"]);
        try {
          await fillAndClick(
            receipt,
            "interrupted-prompt",
            "textbox",
            "Message Ellie",
            "Give me one planning idea.",
            "Send message",
          );
          await browser(["wait", "--text", "connection ended before Ellie confirmed"], {
            timeoutMs: 10_000,
          });
          const interrupted = await snapshot(receipt, "interrupted", false);
          assert.match(interrupted.text, /connection ended before Ellie confirmed the outcome/i);
          const interactive = await snapshot(receipt, "interrupted-controls", true);
          const checkOutcome = ref(interactive, "button", "Check outcome");
          assert.equal((await browser(["is", "enabled", checkOutcome])).trim(), "true");
        } finally {
          await browser(["network", "unroute", "**/api/life/chat"]);
        }
        receipt.checks.push(
          "held request showed drafting without a false connection-ended warning",
          "released request rendered exactly one completed assistant result",
          "browser-induced transport interruption rendered the genuine recovery action",
        );
      }),
    );

    receipts.push(
      await runScenario("reminder", async (receipt) => {
        await openHome(receipt);
        await click(receipt, "open-orb", "button", "Talk to Ellie");
        await sendChat(receipt, "schedule", "Remind me in 1 minute to stretch.");
        await click(receipt, "close-conversation", "button", "Close conversation");
        await browser(["wait", "62000"], { timeoutMs: 65_000 });
        await browser(["reload"]);
        await browser(["wait", "--load", "networkidle"]);
        await click(receipt, "open-today", "button", "Today");
        const delivered = await snapshot(receipt, "delivered", false);
        assert.match(delivered.text, /Notification: stretch/i);
        assert.match(delivered.text, /stretch/i);
        assert.match(delivered.text, /Complete/);
        const stores = fixture.stores();
        const reminder = stores.life
          .listRecords(
            { userId: fixture.actorId },
            {
              scope: { type: "user", id: fixture.actorId },
              kinds: ["reminder"],
              limit: 100,
            },
          )
          .find((record) => /stretch/i.test(record.title));
        assert.ok(reminder);
        const scheduledTaskId = String(reminder.data.taskId);
        const deliveryTask = stores.tasks
          .list({ owner: `user:${fixture.actorId}`, limit: 100 })
          .find(
            (task) =>
              (task.id === scheduledTaskId || task.parentId === scheduledTaskId) &&
              (task.result as { status?: unknown } | undefined)?.status === "delivered",
          );
        assert.equal((deliveryTask?.result as { status?: unknown })?.status, "delivered");
        const notificationId = (deliveryTask?.result as { notificationId?: unknown })
          ?.notificationId;
        assert.equal(typeof notificationId, "string");
        const notification = stores.life.getRecord(
          { userId: fixture.actorId },
          String(notificationId),
        );
        assert.match(notification?.title ?? "", /Notification:.*stretch/i);
        receipt.checks.push("reminder created through chat and rendered as an actionable delivery");
        await screenshot(receipt, "complete");
      }),
    );

    receipts.push(
      await runScenario("arcade", async (receipt) => {
        await openHome(receipt);
        await click(receipt, "open-apps", "button", "Apps");
        await fillAndClick(
          receipt,
          "build-arcade",
          "textbox",
          "What should Ellie build?",
          "Build an arcade game with a persistent high score",
          "Build it",
        );
        await browser(["wait", "--text", "Star arcade"], { timeoutMs: 20_000 });
        await click(receipt, "open-arcade", "button", "Open", -1);
        await snapshot(receipt, "enter-arcade-frame", false);
        const arcade = pluginFrame("Star arcade");
        await arcade.getByRole("button", { name: "Let's play" }).click();
        const initialScore = Number(await arcade.locator("#score").innerText());
        await arcade.getByRole("button", { name: "Shoot" }).click();
        await snapshot(receipt, "scored", false);
        const earnedScore = Number(await arcade.locator("#score").innerText());
        assert.ok(earnedScore > initialScore);
        await arcade.getByText("High score saved with Ellie.").waitFor({ timeout: 70_000 });
        await snapshot(receipt, "saved", false);
        assert.match(await arcade.locator("body").innerText(), /High score saved with Ellie/);
        const savedBest = Number(await arcade.locator("#best").innerText());
        assert.equal(savedBest, earnedScore);
        await click(receipt, "close-arcade", "button", "Close");
        await snapshot(receipt, "persisted-card", false);
        assert.ok(bridgePage);
        const cardText = await bridgePage
          .getByRole("article")
          .filter({ hasText: "Star arcade" })
          .innerText();
        assert.match(cardText, new RegExp(`Personal best\\s+${savedBest}\\b`));
        await click(receipt, "reopen-arcade", "button", "Open", -1);
        await snapshot(receipt, "reenter-arcade-frame", false);
        const reopenedArcade = pluginFrame("Star arcade");
        const reopened = await snapshot(receipt, "reopened", false);
        assert.equal(Number(await reopenedArcade.locator("#best").innerText()), savedBest);
        const reopenedText = await reopenedArcade.locator("body").innerText();
        assert.match(reopenedText, /STAR ARCADE/);
        const arcadeEvidence = `${receipt.name}-frame-evidence.json`;
        await writeFile(
          join(reportRoot, arcadeEvidence),
          `${JSON.stringify({ initialScore, earnedScore, savedBest, cardText, reopenedBest: savedBest, reopenedText }, null, 2)}\n`,
          { mode: 0o600 },
        );
        receipt.snapshots.push(arcadeEvidence);
        receipt.checks.push(
          "arcade built through rendered form",
          "visible Shoot control changed score",
          "completed round saved and reopened nonzero best",
        );
        await screenshot(receipt, "complete");
        await click(receipt, "close-after-check", "button", "Close");
      }),
    );

    receipts.push(
      await runScenario("mlb", async (receipt) => {
        await openHome(receipt);
        await click(receipt, "open-apps", "button", "Apps");
        await fillAndClick(
          receipt,
          "build-mlb",
          "textbox",
          "What should Ellie build?",
          "Build an MLB standings widget",
          "Build it",
        );
        await browser(["wait", "--text", "Around the diamond"], { timeoutMs: 20_000 });
        await browser(["wait", "--text", "Fixture Stars"], { timeoutMs: 20_000 });
        const widget = await snapshot(receipt, "widget", false);
        assert.match(widget.text, /Around the diamond/);
        await click(receipt, "open-mlb", "button", "Open", 0);
        await snapshot(receipt, "enter-mlb-frame", false);
        const mlb = pluginFrame("Around the diamond");
        await snapshot(receipt, "games", false);
        const gamesText = await mlb.locator("body").innerText();
        assert.match(gamesText, /MLB data/);
        assert.match(gamesText, /Updated/);
        assert.match(gamesText, /Fixture Stars/);
        assert.match(gamesText, /Synthetic final/);
        await mlb.getByRole("button", { name: "Standings" }).click();
        await snapshot(receipt, "standings", false);
        const standingsText = await mlb.locator("body").innerText();
        assert.match(standingsText, /Fixture Stars/);
        assert.match(standingsText, /Fixture Stars\s+81\s+61/);
        const mlbEvidence = `${receipt.name}-frame-evidence.json`;
        await writeFile(
          join(reportRoot, mlbEvidence),
          `${JSON.stringify({ gamesText, standingsText }, null, 2)}\n`,
          { mode: 0o600 },
        );
        receipt.snapshots.push(mlbEvidence);
        receipt.checks.push(
          "MLB widget built through rendered form",
          "rendered deterministic Fixture Stars game and 81–61 standings in iframe controls",
          "receipt labels MLB source synthetic",
        );
        await screenshot(receipt, "complete");
        await click(receipt, "close-after-check", "button", "Close");
      }),
    );
  } finally {
    for (const kind of ["console", "errors"] as const) {
      try {
        const output = await browser([kind]);
        const path = join(reportRoot, `browser-${kind}.txt`);
        await writeFile(path, `${redact(output)}\n`, { mode: 0o600 });
        diagnostics[kind] = basename(path);
      } catch (error) {
        cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
      }
    }
    await bridgeBrowser?.close().catch((error) => {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
    });
    await browser(["close"]).catch((error) => {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
    });
    await fixture.close().catch((error) => {
      cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error;
    });
  }

  const source = {
    commit: await browserlessGitHead(),
    runnerSha256: createHash("sha256")
      .update(await readFile(runnerPath))
      .digest("hex"),
    fixtureSha256: createHash("sha256")
      .update(
        await readFile(
          fileURLToPath(new URL("./life-browser-quality-fixture.ts", import.meta.url)),
        ),
      )
      .digest("hex"),
    builtUiSha256: await directoryDigest(resolve("apps/life-ui/dist")),
  };
  const report = {
    version: 1,
    createdAt: new Date().toISOString(),
    modelMode: fixture.modelMode,
    evidenceSource: fixture.source,
    runtime: {
      node: process.version,
      agentBrowser: String(
        (
          JSON.parse(
            await readFile(resolve("node_modules/agent-browser/package.json"), "utf8"),
          ) as {
            version: string;
          }
        ).version,
      ),
      modelId: process.env.LIFE_QUALITY_MODEL_ID ?? "synthetic-browser-quality",
      browserDriver: "agent-browser 0.37.1 accessibility snapshots and UI actions",
      pluginFrameDriver:
        "Playwright over the owned agent-browser CDP session for visible nested-frame controls and text",
    },
    source,
    scenarios: receipts,
    diagnostics: {
      ...diagnostics,
      expectedNetworkError:
        fixture.modelMode === "synthetic" &&
        receipts.some((item) => item.name === "pending-status" && item.status === "pass")
          ? "One /api/life/chat abort is intentionally induced for recovery UI verification."
          : undefined,
    },
    commands: commandLog,
    ...(cleanupError
      ? {
          cleanupError: redact(
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          ),
        }
      : {}),
  };
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      reportDir: reportRoot,
      modelMode: fixture.modelMode,
      pass: receipts.filter((item) => item.status === "pass").length,
      fail: receipts.filter((item) => item.status === "fail").length,
      skipped: receipts.filter((item) => item.status === "skipped").length,
    }),
  );
  if (cleanupError || receipts.some((item) => item.status === "fail")) process.exitCode = 1;
}

async function browserlessGitHead(): Promise<string> {
  return new Promise((resolveHead, reject) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: resolve("."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolveHead(stdout.trim()) : reject(new Error(stderr.trim())),
    );
  });
}

async function directoryDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (current: string) => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const metadata = await stat(path);
      if (metadata.isDirectory()) await visit(path);
      else {
        hash.update(path.slice(directory.length));
        hash.update(await readFile(path));
      }
    }
  };
  await visit(directory);
  return hash.digest("hex");
}

await main().catch(async (error) => {
  await mkdir(reportRoot, { recursive: true, mode: 0o700 });
  const message = redact(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await writeFile(
    join(reportRoot, "fatal.json"),
    `${JSON.stringify({ status: "fail", error: message }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.error(message);
  process.exitCode = 1;
});
