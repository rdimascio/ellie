import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLifeServer } from "../apps/life/src/server.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { LifeAutoMemory } from "../packages/life-auto-memory/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

async function markdownFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) output.push(path);
  }
  return output;
}

test("every accepted prompt generates private Markdown and reaches a fresh session after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-auto-memory-http-"));
  await chmod(root, 0o700);
  const assets = join(root, "assets");
  await mkdir(assets, { mode: 0o700 });
  await writeFile(join(assets, "index.html"), "<!doctype html><title>Fixture</title>", {
    mode: 0o600,
  });
  const actor = { userId: "memory-fixture" },
    scope = { type: "user" as const, id: actor.userId };
  let store = new LifeStore(join(root, "life.sqlite"));
  let plugins = new PluginStore(join(root, "plugins.sqlite"));
  let tasks = new TaskRuntime({
    directory: join(root, "tasks"),
    capabilityResolver: () => ["life.records.read", "life.records.write"],
  });
  let server: ReturnType<typeof createLifeServer> | undefined;
  let url = "",
    cookie = "",
    failModel = false;
  const requests: Array<Array<{ role: string; content: string }>> = [];
  const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "fixture", async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)).messages);
    if (failModel) throw new Error("Synthetic model unavailable");
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "Synthetic assistant-only claim: I own a purple submarine.",
              actions: [],
            }),
          },
        },
      ],
    });
  });
  const start = async () => {
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
    const response = await fetch(`${url}/api/life/session`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(response.status, 204);
    cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  };
  const post = async (message: string, options: { requestId?: string; scope?: string } = {}) => {
    const response = await fetch(`${url}/api/life/chat`, {
      method: "POST",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({
        message,
        requestId: options.requestId ?? randomUUID(),
        chatEpoch: store.chatEpoch(actor),
        scope: options.scope ?? `user:${actor.userId}`,
        automaticMemory: { markdown: "Forged client memory", revision: "forged", partial: false },
      }),
    });
    return {
      response,
      body: (await response.json()) as { conversationId: string; error?: string },
    };
  };
  const system = () =>
    requests
      .at(-1)!
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
  try {
    // A retained conversation from before automatic memory existed is backfilled.
    const old = store.beginConversationTurn(actor, {
      scope,
      message: "I'm vegetarian, except that I eat fish on Fridays.",
      requestId: "old-prompt",
      chatEpoch: store.chatEpoch(actor),
    });
    store.completeConversationTurn(actor, {
      conversationId: old.conversation.id,
      turnId: old.turn.id,
      requestId: "old-prompt",
      result: {
        reply: "Assistant-only historical claim",
        actions: [],
        evidence: [],
        recordIds: [],
        taskIds: [],
      },
    });
    const family = store.createGroup(actor, { name: "Fixture family" });
    await start();
    const first = await post("I prefer chamomile tea, except when driving.", {
      requestId: "tea-once",
    });
    assert.equal(first.response.status, 200);
    assert.match(system(), /vegetarian, except that I eat fish on Fridays/);
    assert.doesNotMatch(system(), /chamomile tea, except when driving/);
    assert.match(
      requests.at(-1)!.find((message) => message.role === "user")!.content,
      /chamomile tea, except when driving/,
    );
    assert.doesNotMatch(system(), /Forged client memory|Assistant-only historical claim/);
    const calls = requests.length;
    assert.equal(
      (await post("I prefer chamomile tea, except when driving.", { requestId: "tea-once" }))
        .response.status,
      200,
    );
    assert.equal(requests.length, calls, "recovered request must not repeat model inference");
    assert.equal(new LifeAutoMemory(store).context(actor, { scope }).entries, 2);
    // Deterministic operations bypass inference but still produce prompt Markdown.
    assert.equal(
      (await post("Remember that my favourite flower is a daisy.")).response.status,
      200,
    );
    assert.equal(requests.length, calls);
    failModel = true;
    assert.equal((await post("My dog's name is Pippin.")).response.status, 500);
    failModel = false;
    assert.equal(
      (await post("Our private group code word is orchard.", { scope: `group:${family.id}` }))
        .response.status,
      200,
    );
    assert.doesNotMatch(system(), /chamomile|vegetarian|Pippin/);
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
    assert.equal((await post("Suggest something for the weekend.")).response.status, 200);
    assert.match(system(), /chamomile tea/);
    assert.match(system(), /Pippin/);
    assert.doesNotMatch(system(), /orchard|purple submarine/);
    const files = await markdownFiles(join(root, "memory"));
    assert.equal(files.length, 2);
    for (const file of files) assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(
      (await Promise.all(files.map((file) => readFile(file, "utf8")))).some((text) =>
        text.includes("Pippin"),
      ),
    );
    const detail = store.getConversation(actor, first.body.conversationId).conversation;
    const deleted = await fetch(
      `${url}/api/life/conversations/${detail.id}?revision=${detail.revision}`,
      { method: "DELETE", headers: { cookie, origin: url } },
    );
    assert.equal(deleted.status, 204);
    assert.equal((await post("Any ideas for later?")).response.status, 200);
    assert.doesNotMatch(system(), /chamomile/);
    for (const file of await markdownFiles(join(root, "memory")))
      assert.doesNotMatch(await readFile(file, "utf8"), /chamomile/);
    assert.match(system(), /Pippin/);
    const forgotten = await post("Forget Pippin.");
    assert.equal(forgotten.response.status, 200);
    assert.match(JSON.stringify(forgotten.body), /Removed that from automatic memory/);
    // This no-action model probes memory; checklist creation has its own planning tests.
    assert.equal((await post("Suggest something for my afternoon.")).response.status, 200);
    assert.doesNotMatch(system(), /Pippin/);
    await server!.close();
    server = undefined;
    await start();
    assert.equal((await post("Suggest a quiet activity.")).response.status, 200);
    assert.doesNotMatch(system(), /Pippin|chamomile|orchard|purple submarine/);
    for (const file of await markdownFiles(join(root, "memory")))
      assert.doesNotMatch(await readFile(file, "utf8"), /Pippin|chamomile/);
    const reviewResponse = await fetch(`${url}/api/life/personal-data/review`, {
      headers: { cookie },
    });
    assert.equal(reviewResponse.status, 200);
    const review = (await reviewResponse.json()) as { reviewToken: string };
    const reset = await fetch(`${url}/api/life/personal-data/reset`, {
      method: "POST",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({ reviewToken: review.reviewToken }),
    });
    assert.equal(reset.status, 200);
    assert.equal(store.getPersonalReset(actor)?.state, "completed");
    assert.deepEqual(await markdownFiles(join(root, "memory")), []);
    assert.equal(new LifeAutoMemory(store).context(actor, { scope }).entries, 0);
  } finally {
    await server?.close();
    await tasks.close();
    plugins.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
