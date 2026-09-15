import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { createLifeServer } from "../apps/life/src/server.ts";
import { LifeAutoMemory } from "../packages/life-auto-memory/src/index.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

type Scenario = {
  id: string;
  expected: string;
  actual: string;
  pass: boolean;
  syntheticLatencyMs: number;
};

const scenarios: Scenario[] = [];
const requiredScenarioIds = [
  "qualified-preference-captured",
  "correction-survives-distraction",
  "idempotent-request-retry",
  "restart-new-conversation-scope",
] as const;
const output = process.env.ELLIE_QUALITY_REPORT;
if (output && !isAbsolute(output)) {
  process.stderr.write("ELLIE_QUALITY_REPORT must be an absolute path.\n");
  process.exit(2);
}
async function evaluate(id: string, expected: string, check: () => Promise<string>) {
  const started = performance.now();
  try {
    const actual = await check();
    scenarios.push({
      id,
      expected,
      actual,
      pass: actual === "pass",
      syntheticLatencyMs: Math.round((performance.now() - started) * 100) / 100,
    });
  } catch (error) {
    scenarios.push({
      id,
      expected,
      actual: error instanceof Error ? error.message.slice(0, 500) : "unknown failure",
      pass: false,
      syntheticLatencyMs: Math.round((performance.now() - started) * 100) / 100,
    });
  }
}

let root: string | undefined;
let assets = "";
const actor = { userId: "quality-user" };
const scope = { type: "user" as const, id: actor.userId };
const captured: Array<Array<{ role: string; content: string }>> = [];
const model = new LocalOpenAIModel(
  "http://127.0.0.1:8080/v1",
  "synthetic-quality-model",
  async (_url, init) => {
    captured.push(
      (JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> })
        .messages,
    );
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "Synthetic assistant claim: the user owns a purple submarine.",
              actions: [],
            }),
          },
        },
      ],
    });
  },
);
let store: LifeStore;
let plugins: PluginStore;
let tasks: TaskRuntime;
let server: ReturnType<typeof createLifeServer> | undefined;
let url = "";
let cookie = "";
let infrastructureError: string | undefined;
const teardownErrors: string[] = [];
const fetchLocal = (input: string, init?: RequestInit) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(5_000) });
async function start() {
  if (!root) throw new Error("quality fixture is unavailable");
  const token = randomUUID().replaceAll("-", "") + randomUUID();
  server = createLifeServer({
    stateDir: root,
    assetsDir: assets,
    store,
    plugins,
    tasks,
    harness: createLifeHarness({ store, plugins, tasks, mlb: new MLBAdapter(), model }),
    userId: actor.userId,
    port: 0,
    token,
  });
  url = (await server.listen()).url;
  const response = await fetchLocal(`${url}/api/life/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 204);
  cookie = response.headers.get("set-cookie")!.split(";")[0]!;
}
async function post(
  message: string,
  options: { requestId?: string; conversationId?: string } = {},
) {
  const response = await fetchLocal(`${url}/api/life/chat`, {
    method: "POST",
    headers: { cookie, origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      message,
      requestId: options.requestId ?? randomUUID(),
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      chatEpoch: store.chatEpoch(actor),
      scope: `user:${actor.userId}`,
    }),
  });
  const body = (await response.json()) as { conversationId: string };
  if (!response.ok) throw new Error(`chat returned ${response.status}`);
  return body;
}
const latestSystem = () =>
  captured
    .at(-1)!
    .filter((item) => item.role === "system")
    .map((item) => item.content)
    .join("\n");

try {
  root = await mkdtemp(join(tmpdir(), "ellie-quality-lab-"));
  await chmod(root, 0o700);
  assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Quality lab</title>", {
    mode: 0o600,
  });
  store = new LifeStore(join(root, "life.sqlite"));
  plugins = new PluginStore(join(root, "plugins.sqlite"));
  tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
  await start();
  let conversationId = "";
  await evaluate(
    "qualified-preference-captured",
    "The complete qualified preference reaches a later model call.",
    async () => {
      conversationId = (
        await post("I prefer morning appointments, except on Fridays when afternoons are better.")
      ).conversationId;
      await post("Suggest a time for next week.", { conversationId });
      return /I prefer morning appointments, except on Fridays when afternoons are better\./i.test(
        latestSystem(),
      )
        ? "pass"
        : "missing qualification";
    },
  );
  await evaluate(
    "correction-survives-distraction",
    "A correction remains after unrelated prompt history.",
    async () => {
      await post("Actually, I prefer afternoon appointments every day.", { conversationId });
      for (let index = 0; index < 16; index++)
        await post(`What is a useful neutral idea number ${index}?`, { conversationId });
      await post("When should I schedule something?", { conversationId });
      const system = latestSystem();
      return /prefer afternoon appointments every day/i.test(system)
        ? "pass"
        : "correction missing";
    },
  );
  await evaluate(
    "idempotent-request-retry",
    "Retrying one request ID does not invoke the model twice or add a duplicate turn.",
    async () => {
      const before = captured.length;
      const requestId = "quality-retry-once";
      const first = await post("Give me one calm suggestion.", { requestId });
      const turnsBeforeRetry = store.getConversation(actor, first.conversationId).conversation
        .turnCount;
      await post("Give me one calm suggestion.", {
        requestId,
        conversationId: first.conversationId,
      });
      const turnsAfterRetry = store.getConversation(actor, first.conversationId).conversation
        .turnCount;
      return captured.length === before + 1 && turnsAfterRetry === turnsBeforeRetry
        ? "pass"
        : `model calls increased by ${captured.length - before}; turns ${turnsBeforeRetry}->${turnsAfterRetry}`;
    },
  );

  const wrongActor = { userId: "other-quality-user" };
  const wrong = store.beginConversationTurn(wrongActor, {
    scope: { type: "user", id: wrongActor.userId },
    message: "My private wrong-actor code is cobalt.",
    requestId: "wrong-actor-prompt",
    chatEpoch: store.chatEpoch(wrongActor),
  });
  new LifeAutoMemory(store).captureTurn(wrongActor, {
    conversationId: wrong.conversation.id,
    turnId: wrong.turn.id,
  });
  await server!.close();
  server = undefined;
  await tasks.close();
  plugins.close();
  store.close();
  store = new LifeStore(join(root, "life.sqlite"));
  plugins = new PluginStore(join(root, "plugins.sqlite"));
  tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
  await start();
  await evaluate(
    "restart-new-conversation-scope",
    "A fresh conversation after restart receives the user's correction, not assistant claims or another actor's memory.",
    async () => {
      await post("Help me choose an appointment time after restart.");
      const system = latestSystem();
      return /prefer afternoon appointments every day/i.test(system) &&
        !/purple submarine|cobalt/i.test(system)
        ? "pass"
        : "scope or provenance isolation failed";
    },
  );
} catch (error) {
  infrastructureError =
    error instanceof Error ? error.message.slice(0, 500) : "unknown infrastructure failure";
} finally {
  const cleanup = async (label: string, work: () => void | Promise<void>) => {
    try {
      await work();
    } catch (error) {
      teardownErrors.push(
        `${label}: ${error instanceof Error ? error.message.slice(0, 300) : "unknown failure"}`,
      );
    }
  };
  await cleanup("server", async () => server?.close());
  if (tasks!) await cleanup("tasks", async () => tasks.close());
  if (plugins!) await cleanup("plugins", () => plugins.close());
  if (store!) await cleanup("store", () => store.close());
  if (root) await cleanup("fixture", async () => rm(root!, { recursive: true, force: true }));
}

const completedIds = new Set(scenarios.map((scenario) => scenario.id));
const complete = requiredScenarioIds.every((id) => completedIds.has(id));
const scriptPath = fileURLToPath(import.meta.url);
const checkout = resolve(dirname(scriptPath), "..");
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: checkout,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" }).trim() !== "";
const scenarioDigest = createHash("sha256")
  .update(await readFile(scriptPath))
  .digest("hex");
const report = {
  format: "ellie-life-quality-lab-v1",
  scenarioVersion: 1,
  generatedAt: new Date().toISOString(),
  modelMode: "synthetic" as const,
  liveModelEvaluation: null,
  source: { revision: sourceRevision, dirty, scenarioDigest },
  transport: "synthetic deterministic local fetch injection",
  latencyDisclaimer:
    "syntheticLatencyMs measures local fixture execution only; it is not live-model latency or a model-quality score.",
  infrastructure: {
    status: infrastructureError ? "failed" : "ready",
    error: infrastructureError ?? null,
    teardown: teardownErrors.length ? "failed" : "clean",
    teardownErrors,
  },
  passed:
    !infrastructureError &&
    teardownErrors.length === 0 &&
    complete &&
    scenarios.length === requiredScenarioIds.length &&
    scenarios.every((scenario) => scenario.pass),
  scenarios,
};
if (output) {
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
