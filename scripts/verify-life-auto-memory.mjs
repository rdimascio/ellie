import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";
import { PluginStore, MLBAdapter } from "../packages/life-plugins/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";
import { createLifeServer } from "../apps/life/src/server.ts";

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error(
    "Usage: node scripts/verify-life-auto-memory.mjs http://127.0.0.1:PORT/v1 EXACT_MODEL_ID",
  );
  process.exit(2);
}
const root = await mkdtemp("/tmp/ellie-real-memory-fixture-"),
  actor = { userId: "synthetic-memory-acceptance" },
  started = Date.now();
let inferenceRequests = 0,
  server,
  url,
  cookie;
const model = new LocalOpenAIModel(args[0], args[1], async (...request) => {
  inferenceRequests++;
  return fetch(...request);
});
let store = new LifeStore(join(root, "life.sqlite")),
  plugins = new PluginStore(join(root, "plugins.sqlite")),
  tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
const start = async () => {
  server = createLifeServer({
    stateDir: root,
    assetsDir: resolve("apps/life-ui/dist"),
    store,
    tasks,
    plugins,
    harness: createLifeHarness({ store, tasks, plugins, model, mlb: new MLBAdapter() }),
    userId: actor.userId,
    port: 0,
  });
  url = (await server.listen()).url;
  const response = await fetch(`${url}/api/life/session`, {
    method: "POST",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ token: server.token }),
  });
  assert.equal(response.status, 204);
  cookie = response.headers.get("set-cookie").split(";")[0];
};
const chat = async (message) => {
  const response = await fetch(`${url}/api/life/chat`, {
    method: "POST",
    headers: { cookie, origin: url, "content-type": "application/json" },
    body: JSON.stringify({
      scope: `user:${actor.userId}`,
      message,
      requestId: crypto.randomUUID(),
      chatEpoch: store.chatEpoch(actor),
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, "completed");
  return body;
};
try {
  await start();
  const first = await chat(
    "I'm vegetarian and I dislike mushrooms. Please keep dinner suggestions to two choices.",
  );
  assert.equal(
    store.listRecords(actor, { scope: { type: "user", id: actor.userId }, kinds: ["memory"] })
      .length,
    0,
    "Ordinary statements need no separate explicit memory record.",
  );
  console.log(JSON.stringify({ stage: "ordinary-statement", response: first }));
  await server.close();
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
  const second = await chat("What dietary preferences and response style have I told you about?");
  assert.notEqual(second.conversationId, first.conversationId);
  const reply = JSON.stringify(second);
  assert.match(reply, /vegetarian/i);
  assert.match(reply, /mushroom/i);
  assert.match(reply, /two|2/);
  assert.equal(tasks.list({ owner: `user:${actor.userId}` }).length, 0);
  assert.equal(plugins.list(`user:${actor.userId}`).length, 0);
  const memoryResponse = await fetch(`${url}/api/life/memory`, { headers: { cookie } });
  assert.equal(memoryResponse.status, 200);
  const memory = await memoryResponse.json();
  assert.match(memory.summary, /vegetarian/);
  assert.ok(inferenceRequests >= 2);
  console.log(JSON.stringify({ stage: "new-session-after-restart", response: second }));
  console.log(
    JSON.stringify({
      status: "passed",
      inferenceRequests,
      elapsedMs: Date.now() - started,
      memoryEntries: memory.entries,
    }),
  );
} finally {
  await server?.close();
  await tasks.close();
  plugins.close();
  store.close();
  await rm(root, { recursive: true, force: true });
}
