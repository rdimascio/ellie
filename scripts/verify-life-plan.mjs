import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { PluginStore, MLBAdapter } from "../packages/life-plugins/src/index.ts";
import { LifePlans } from "../packages/life-plans/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("Usage: node scripts/verify-life-plan.mjs http://127.0.0.1:PORT/v1 EXACT_MODEL_ID");
  process.exit(2);
}
const root = await mkdtemp("/tmp/ellie-real-plan-fixture-"),
  actor = { userId: "synthetic-plan-acceptance" },
  scope = { type: "user", id: actor.userId },
  now = Date.UTC(2026, 8, 14, 9),
  started = Date.now();
let inferenceRequests = 0;
const model = new LocalOpenAIModel(args[0], args[1], async (...request) => {
    inferenceRequests++;
    return fetch(...request);
  }),
  store = new LifeStore(join(root, "life.sqlite"), { now: () => now }),
  plugins = new PluginStore(join(root, "plugins.sqlite"), () => now),
  tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    now: () => now,
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  }),
  plans = new LifePlans(store),
  harness = createLifeHarness({
    store,
    plugins,
    tasks,
    model,
    mlb: new MLBAdapter(),
    now: () => now,
  });
let storeClosed = false;
try {
  const creation = await harness.chat({
    actor,
    scope,
    conversationId: "create-plan",
    message:
      "Make a checklist for preparing for a weekend camping trip. Keep it to three practical steps about packing, route planning and checking weather.",
  });
  const record = creation.records.find(
    (item) => item.kind === "goal" && item.data.type === "life-plan-v1",
  );
  assert.ok(record, JSON.stringify({ stage: "creation", response: creation }));
  assert.ok(inferenceRequests >= 1, "This acceptance must exercise actual model inference.");
  const original = plans.get(actor, record.id);
  assert.equal(original.totalSteps, 3);
  assert.equal(original.completedSteps, 0);
  assert.equal(tasks.list({ owner: `user:${actor.userId}` }).length, 0);
  assert.equal(plugins.list(`user:${actor.userId}`).length, 0);
  console.log(
    JSON.stringify({
      stage: "created",
      reply: creation.reply,
      title: record.title,
      steps: original.steps,
    }),
  );

  const beforeControl = inferenceRequests;
  const completion = await harness.chat({
    actor,
    scope,
    conversationId: "complete-step",
    message: `Complete step 2 of plan ${record.title}`,
  });
  const completed = plans.get(actor, record.id);
  assert.equal(completed.steps[1].id, original.steps[1].id);
  assert.equal(completed.steps[1].completed, true);
  assert.equal(completed.completedSteps, 1);
  assert.equal(
    inferenceRequests,
    beforeControl,
    "Explicit step control should not need inference.",
  );
  console.log(
    JSON.stringify({
      stage: "completed-step",
      reply: completion.reply,
      completedSteps: completed.completedSteps,
    }),
  );

  const beforeAdvice = inferenceRequests;
  const advice = await harness.chat({
    actor,
    scope,
    conversationId: "plan-advice",
    message: `Explain what is still unfinished in my ${record.title} checklist using the saved step states.`,
  });
  assert.ok(inferenceRequests > beforeAdvice);
  assert.equal(advice.records.length, 0);
  assert.equal(advice.taskIds.length, 0);
  assert.deepEqual(plans.get(actor, record.id), completed);
  assert.equal(tasks.list({ owner: `user:${actor.userId}` }).length, 0);
  assert.match(advice.reply, /unfinished|remain|left|still|incomplete/i);
  console.log(JSON.stringify({ stage: "remaining-advice", reply: advice.reply }));

  await tasks.close();
  plugins.close();
  store.close();
  storeClosed = true;
  const reopened = new LifeStore(join(root, "life.sqlite"), { now: () => now });
  try {
    assert.deepEqual(new LifePlans(reopened).get(actor, record.id), completed);
  } finally {
    reopened.close();
  }
  console.log(
    JSON.stringify({
      status: "passed",
      elapsedMs: Date.now() - started,
      inferenceRequests,
      persistedSteps: completed.totalSteps,
      completedSteps: completed.completedSteps,
    }),
  );
} finally {
  if (!storeClosed) {
    await tasks.close();
    plugins.close();
    store.close();
  }
  await rm(root, { recursive: true, force: true });
}
