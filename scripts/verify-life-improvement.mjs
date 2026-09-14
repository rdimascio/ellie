import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { LifeLearning } from "../packages/life-learning/src/index.ts";
import { LifeTeaching } from "../packages/life-teaching/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { PluginStore, MLBAdapter } from "../packages/life-plugins/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error(
    "Usage: node scripts/verify-life-improvement.mjs http://127.0.0.1:PORT/v1 EXACT_MODEL_ID",
  );
  process.exit(2);
}
const adapter = new LocalOpenAIModel(args[0], args[1]),
  root = await mkdtemp("/tmp/ellie-real-improvement-"),
  actor = { userId: "synthetic-improvement-acceptance" },
  scope = { type: "user", id: actor.userId },
  owner = `user:${actor.userId}`,
  store = new LifeStore(join(root, "life.sqlite")),
  plugins = new PluginStore(join(root, "plugins.sqlite")),
  tasks = new TaskRuntime({ directory: join(root, "tasks") }),
  teaching = new LifeTeaching(store),
  learning = new LifeLearning(store);
let observedGuidance;
const harness = createLifeHarness({
  store,
  plugins,
  tasks,
  mlb: new MLBAdapter(),
  model: {
    plan(request, signal) {
      observedGuidance = request.adoptedGuidance;
      return adapter.plan(request, signal);
    },
    suggestImprovement(request, signal) {
      return adapter.suggestImprovement(request, signal);
    },
    previewImprovement(request, signal) {
      return adapter.previewImprovement(request, signal);
    },
  },
});
try {
  const feedback = learning.record(actor, {
      scope,
      rating: -1,
      message:
        "For dinner ideas, give exactly two vegetarian options that take about twenty minutes. Keep the answer short.",
      example: {
        prompt: "What could I make for dinner tonight?",
        response:
          "Try lasagna, roast chicken, stew, tacos, risotto, stir fry, pizza, or grilled fish.",
        preferredResponse:
          "Try vegetable tacos or a quick chickpea stir-fry; both are vegetarian options to consider for a short dinner preparation.",
      },
    }),
    started = Date.now(),
    proposal = await harness.improvements.propose(actor, {
      feedback: [{ id: feedback.id, revision: feedback.revision }],
      goal: "Make dinner suggestions easier to act on.",
    });
  assert.equal(proposal.status, "ready");
  assert.equal(proposal.previews.length, 1);
  assert.deepEqual(teaching.resolve(actor, scope), []);
  assert.equal(tasks.list({ owner }).length, 0);
  assert.equal(plugins.list(owner).length, 0);
  assert.deepEqual(
    store
      .listRecords(actor, { scope })
      .map((record) => record.kind)
      .sort(),
    ["feedback", "routine"],
  );
  const adopted = harness.improvements.adopt(actor, proposal.record.id, proposal.record.revision);
  assert.equal(adopted.guideId, proposal.record.id);
  assert.equal(teaching.resolve(actor, scope)[0]?.instructions, proposal.instructions);
  const reply = await harness.chat({
    actor,
    scope,
    message: "What could I make for dinner tonight?",
  });
  assert.equal(observedGuidance?.[0]?.instructions, proposal.instructions);
  assert.equal(reply.records.length, 0);
  assert.equal(reply.taskIds.length, 0);
  assert.equal(tasks.list({ owner }).length, 0);
  assert.equal(plugins.list(owner).length, 0);
  teaching.setEnabled(actor, adopted.record.id, adopted.record.revision, false);
  assert.deepEqual(teaching.resolve(actor, scope), []);
  console.log(
    JSON.stringify({
      status: "passed",
      model: args[1],
      elapsedMs: Date.now() - started,
      candidate: {
        title: proposal.record.title,
        instructions: proposal.instructions,
        rationale: proposal.rationale,
      },
      offlinePreview: proposal.previews[0].candidateResponse,
      actualReplyWithAdoptedGuidance: reply.reply,
      verified: [
        "no active guidance before adoption",
        "no preview tasks or apps",
        "same-record explicit adoption",
        "actual modeled reply receives adopted guidance",
        "pause removes active guidance",
      ],
    }),
  );
} finally {
  if (await harness.improvements.settleActive()) {
    await tasks.close();
    plugins.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  } else {
    console.error(`Improvement callbacks are still settling; private fixture retained at ${root}.`);
    process.exitCode = 1;
  }
}
