import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { PluginStore, MLBAdapter } from "../packages/life-plugins/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error(
    "Usage: node scripts/verify-life-model.mjs http://127.0.0.1:PORT/v1 EXACT_MODEL_ID",
  );
  process.exit(2);
}
let inferenceRequests = 0;
const model = new LocalOpenAIModel(args[0], args[1], async (...request) => {
  inferenceRequests++;
  return fetch(...request);
});

const root = await mkdtemp("/tmp/ellie-real-model-fixture-"),
  actor = { userId: "synthetic-model-acceptance" },
  scope = { type: "user", id: actor.userId },
  now = Date.UTC(2026, 8, 14, 9),
  results = [];
await mkdir(join(root, "tasks"), { mode: 0o700 });
const store = new LifeStore(join(root, "life.sqlite"), { now: () => now }),
  plugins = new PluginStore(join(root, "plugins.sqlite"), () => now),
  tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    now: () => now,
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  }),
  harness = createLifeHarness({
    store,
    plugins,
    tasks,
    model,
    mlb: new MLBAdapter(),
    now: () => now,
  });
store.setUserSetting(actor, "timeZone", "America/Los_Angeles");

async function run(name, message, verify, options = {}) {
  const started = Date.now(),
    priorInferenceRequests = inferenceRequests;
  try {
    const result = await harness.chat({ actor, scope, message, conversationId: name, ...options });
    verify(result);
    results.push({
      name,
      elapsedMs: Date.now() - started,
      inferenceRequests: inferenceRequests - priorInferenceRequests,
      status: "passed",
      reply: result.reply,
      actions: result.actions,
    });
  } catch (error) {
    results.push({
      name,
      elapsedMs: Date.now() - started,
      inferenceRequests: inferenceRequests - priorInferenceRequests,
      status: "failed",
      error: String(error),
    });
  }
  console.log(JSON.stringify(results.at(-1)));
}

try {
  await run(
    "reminder",
    "Could you add a reminder to water the basil tomorrow at 10 am?",
    (result) => {
      const reminders = store.listRecords(actor, { scope, kinds: ["reminder"] });
      assert.equal(reminders.length, 1);
      assert.equal(reminders[0].data.dueAt, Date.UTC(2026, 8, 15, 17));
      assert.equal(result.taskIds.length, 1);
      assert.match(result.reply, /remind/);
    },
  );
  await run(
    "event",
    "Please add my dentist appointment to my calendar for tomorrow at 2 pm. It lasts 30 minutes.",
    () => {
      const events = store.listRecords(actor, { scope, kinds: ["event"] });
      assert.equal(events.length, 1);
      assert.equal(events[0].data.startAt, Date.UTC(2026, 8, 15, 21));
      assert.equal(events[0].data.endAt - events[0].data.startAt, 30 * 60_000);
    },
  );
  await run("need", "Please add oat milk to my shopping needs, with a budget of 8 USD.", () => {
    const needs = store.listRecords(actor, { scope, kinds: ["need"] });
    assert.equal(needs.length, 1);
    assert.equal(needs[0].data.budget, 8);
    assert.equal(needs[0].data.currency, "USD");
  });
  const priorReminderCount = store.listRecords(actor, { scope, kinds: ["reminder"] }).length;
  await run("draft", "Could you remind me to phone Maya?", (result) => {
    assert.equal(
      store.listRecords(actor, { scope, kinds: ["reminder"] }).length,
      priorReminderCount,
    );
    assert.equal(result.continuation?.action, "create");
    assert.deepEqual(result.continuation.missing, ["when"]);
    assert.match(result.reply, /when/i);
  });
  const maya = store.createRecord(actor, {
    kind: "contact",
    scope,
    title: "Maya",
    body: "She loves growing vegetables on her balcony and already has gardening gloves.",
    data: { interests: ["gardening", "hiking"] },
  });
  store.createRecord(actor, {
    kind: "need",
    scope,
    title: "Maya birthday gift",
    data: { budget: 40, currency: "USD", completed: false },
    relationships: [{ type: "for-person", targetId: maya.id }],
  });
  const beforeAdvice = store
    .listRecords(actor, { scope })
    .map((record) => [record.id, record.revision]);
  await run(
    "personalized-advice",
    "What kind of gift would suit Maya, using what you remember about her?",
    (result) => {
      assert.match(result.reply, /garden|vegetable|balcony/i);
      assert.equal(result.records.length, 0);
      assert.equal(result.taskIds.length, 0);
      assert.deepEqual(
        store.listRecords(actor, { scope }).map((record) => [record.id, record.revision]),
        beforeAdvice,
      );
    },
  );
  const group = store.createGroup(actor, { name: "Synthetic empty space" });
  await run(
    "group-context-privacy",
    "What personal interests have I saved for Maya in this space?",
    (result) => {
      assert.doesNotMatch(result.reply, /gardening|hiking|vegetables|balcony/);
      assert.equal(result.records.length, 0);
      assert.equal(result.taskIds.length, 0);
    },
    { scope: { type: "group", id: group.id } },
  );
} finally {
  await tasks.close();
  plugins.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
