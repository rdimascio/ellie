import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLifeServer } from "../apps/life/src/server.ts";
import { LifeStore } from "../packages/life-core/src/index.ts";
import { createLifeHarness, LocalOpenAIModel } from "../packages/life-harness/src/index.ts";
import { MLBAdapter, PluginStore } from "../packages/life-plugins/src/index.ts";
import { TaskRuntime } from "../packages/task-runtime/src/index.ts";

type CapturedMessage = { role: string; content: string };
const HTTP_TIMEOUT_MS = 3_000;

async function markdownFiles(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
    else if (entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

test("forgetting survives same-conversation replay, cache rebuild, restart, and source deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "ellie-quality-forgetting-"));
  const assets = join(root, "assets");
  const actor = { userId: "forgetting-fixture" };
  const requests: CapturedMessage[][] = [];
  const model = new LocalOpenAIModel("http://127.0.0.1:8080/v1", "fixture", async (_url, init) => {
    const messages = (JSON.parse(String(init?.body)) as { messages: CapturedMessage[] }).messages;
    requests.push(messages);
    const echo = /private launch phrase is silver comet/i.test(messages.at(-1)?.content ?? "");
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: echo
                ? "I heard that your private launch phrase is silver comet."
                : "Fixture reply",
              actions: [],
            }),
          },
        },
      ],
    });
  });
  let store: LifeStore | undefined;
  let plugins: PluginStore | undefined;
  let tasks: TaskRuntime | undefined;
  let server: ReturnType<typeof createLifeServer> | undefined;
  let url = "";
  let cookie = "";

  const start = async () => {
    const activeStore = (store = new LifeStore(join(root, "life.sqlite")));
    const activePlugins = (plugins = new PluginStore(join(root, "plugins.sqlite")));
    const activeTasks = (tasks = new TaskRuntime({
      directory: join(root, "tasks"),
      capabilityResolver: () => ["life.records.read", "life.records.write"],
    }));
    const token = randomUUID().replaceAll("-", "") + randomUUID();
    server = createLifeServer({
      stateDir: root,
      assetsDir: assets,
      store: activeStore,
      plugins: activePlugins,
      tasks: activeTasks,
      harness: createLifeHarness({
        store: activeStore,
        plugins: activePlugins,
        tasks: activeTasks,
        mlb: new MLBAdapter(),
        model,
      }),
      userId: actor.userId,
      port: 0,
      token,
    });
    url = (await server.listen()).url;
    const session = await fetch(`${url}/api/life/session`, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    assert.equal(session.status, 204);
    cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  };
  const stop = async () => {
    const activeServer = server;
    server = undefined;
    const activeTasks = tasks;
    tasks = undefined;
    const activePlugins = plugins;
    plugins = undefined;
    const activeStore = store;
    store = undefined;
    const failures: unknown[] = [];
    for (const close of [
      () => activeServer?.close(),
      () => activeTasks?.close(),
      () => activePlugins?.close(),
      () => activeStore?.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  };
  const post = async (
    message: string,
    options: { conversationId?: string; requestId?: string } = {},
  ) => {
    const response = await fetch(`${url}/api/life/chat`, {
      method: "POST",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({
        message,
        requestId: options.requestId ?? randomUUID(),
        chatEpoch: store!.chatEpoch(actor),
        scope: `user:${actor.userId}`,
        ...(options.conversationId ? { conversationId: options.conversationId } : {}),
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const body = (await response.json()) as { conversationId: string; error?: string };
    assert.equal(response.status, 200, body.error);
    return body;
  };
  const system = (messages = requests.at(-1)!) =>
    messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n");
  const snapshots = async () =>
    Promise.all((await markdownFiles(join(root, "memory"))).map((path) => readFile(path, "utf8")));
  const memory = async () => {
    const response = await fetch(
      `${url}/api/life/memory?scope=${encodeURIComponent(`user:${actor.userId}`)}`,
      { headers: { cookie }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { summary: string };
  };

  try {
    await chmod(root, 0o700);
    await mkdir(assets, { mode: 0o700 });
    await writeFile(join(assets, "index.html"), "<!doctype html><title>Fixture</title>", {
      mode: 0o600,
    });
    await start();
    const sourceRequestId = "source-secret-request";
    const source = await post("My private launch phrase is silver comet.", {
      requestId: sourceRequestId,
    });
    await post("I prefer jasmine tea after lunch.", { conversationId: source.conversationId });
    await post("My bicycle is forest green.");

    const warmOne = await memory();
    const warmTwo = await memory();
    for (const warmed of [warmOne, warmTwo]) {
      assert.match(warmed.summary, /silver comet/i);
      assert.match(warmed.summary, /jasmine tea/i);
      assert.match(warmed.summary, /forest green/i);
    }
    const warmedSnapshots = (await snapshots()).join("\n");
    assert.match(warmedSnapshots, /silver comet/i);
    assert.match(warmedSnapshots, /jasmine tea/i);
    const callsBeforeInitialProbe = requests.length;
    await post("What personal details should you keep in mind?", {
      conversationId: source.conversationId,
    });
    assert.equal(requests.length, callsBeforeInitialProbe + 1);
    const beforeForget = requests.at(-1)!;
    assert.match(system(beforeForget), /silver comet/i, "the warmed fact reaches system context");
    assert.ok(
      beforeForget.some(
        (message) => message.role === "user" && /silver comet/i.test(message.content),
      ),
      "the same conversation contains the user's factual turn",
    );
    assert.ok(
      beforeForget.some(
        (message) => message.role === "assistant" && /silver comet/i.test(message.content),
      ),
      "the same conversation contains the synthetic assistant echo",
    );
    assert.match(system(beforeForget), /jasmine tea/i);
    assert.match(system(beforeForget), /forest green/i);

    const callsBeforeForget = requests.length;
    await post("Forget silver comet.", { conversationId: source.conversationId });
    assert.equal(requests.length, callsBeforeForget, "Forget completes without model inference");
    const forgottenSnapshots = (await snapshots()).join("\n");
    assert.doesNotMatch(forgottenSnapshots, /silver comet/i);
    assert.match(forgottenSnapshots, /jasmine tea/i);
    assert.match(forgottenSnapshots, /forest green/i);
    const forgottenMemory = await memory();
    assert.doesNotMatch(forgottenMemory.summary, /silver comet/i);
    assert.match(forgottenMemory.summary, /jasmine tea/i);
    assert.match(forgottenMemory.summary, /forest green/i);
    const callsBeforeNeutralProbe = requests.length;
    await post("Which preferences are still useful?", { conversationId: source.conversationId });
    assert.equal(requests.length, callsBeforeNeutralProbe + 1);
    const afterForget = requests.at(-1)!;
    assert.doesNotMatch(
      afterForget.map((message) => message.content).join("\n"),
      /silver comet/i,
      "forgotten text is absent from system memory and every replayed conversation message",
    );
    assert.match(
      afterForget.map((message) => message.content).join("\n"),
      /jasmine tea/i,
      "the unrelated turn in the same conversation remains available",
    );

    const callsBeforeRecovery = requests.length;
    const recovered = await post("My private launch phrase is silver comet.", {
      requestId: sourceRequestId,
    });
    assert.equal(recovered.conversationId, source.conversationId);
    assert.equal(requests.length, callsBeforeRecovery, "request recovery does not rerun inference");
    assert.ok((await snapshots()).every((text) => !/silver comet/i.test(text)));

    const visibleTranscript = await fetch(
      `${url}/api/life/conversations/${source.conversationId}`,
      { headers: { cookie }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    assert.equal(visibleTranscript.status, 200);
    assert.match(await visibleTranscript.text(), /silver comet/i, "Forget retains visible history");

    await stop();
    await start();
    const callsBeforeRestartProbe = requests.length;
    await post("What do you remember after restarting?");
    assert.equal(requests.length, callsBeforeRestartProbe + 1);
    assert.doesNotMatch(
      requests
        .at(-1)!
        .map((message) => message.content)
        .join("\n"),
      /silver comet/i,
    );
    assert.doesNotMatch(system(), /silver comet/i);
    assert.match(system(), /jasmine tea/i);
    assert.match(system(), /forest green/i);

    const detailResponse = await fetch(`${url}/api/life/conversations/${source.conversationId}`, {
      headers: { cookie },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    assert.equal(detailResponse.status, 200);
    const detail = (await detailResponse.json()) as { conversation: { revision: number } };
    const deleted = await fetch(
      `${url}/api/life/conversations/${source.conversationId}?revision=${detail.conversation.revision}`,
      {
        method: "DELETE",
        headers: { cookie, origin: url },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      },
    );
    assert.equal(deleted.status, 204);
    const afterDeleteMemory = await memory();
    assert.doesNotMatch(afterDeleteMemory.summary, /silver comet|jasmine tea/i);
    assert.match(afterDeleteMemory.summary, /forest green/i);

    await post("Which retained details are still relevant?");
    assert.doesNotMatch(system(), /silver comet|jasmine tea/i);
    assert.match(system(), /forest green/i, "deleting one source conversation preserves another");
    const finalSnapshots = await snapshots();
    assert.ok(finalSnapshots.every((text) => !/silver comet|jasmine tea/i.test(text)));
    assert.ok(finalSnapshots.some((text) => /forest green/i.test(text)));

    await stop();
    await start();
    const callsBeforeDeleteRestartProbe = requests.length;
    await post("What remains after deleting that conversation?");
    assert.equal(requests.length, callsBeforeDeleteRestartProbe + 1);
    assert.doesNotMatch(
      requests
        .at(-1)!
        .map((message) => message.content)
        .join("\n"),
      /silver comet|jasmine tea/i,
    );
    assert.doesNotMatch(system(), /silver comet|jasmine tea/i);
    assert.match(system(), /forest green/i);
    const restartedSnapshots = await snapshots();
    assert.ok(restartedSnapshots.every((text) => !/silver comet|jasmine tea/i.test(text)));
    assert.ok(restartedSnapshots.some((text) => /forest green/i.test(text)));

    const callsBeforeRetiredReplay = requests.length;
    const replay = await fetch(`${url}/api/life/chat`, {
      method: "POST",
      headers: { cookie, origin: url, "content-type": "application/json" },
      body: JSON.stringify({
        message: "My private launch phrase is silver comet.",
        requestId: sourceRequestId,
        chatEpoch: store!.chatEpoch(actor),
        scope: `user:${actor.userId}`,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    assert.equal(replay.status, 409);
    assert.equal(
      requests.length,
      callsBeforeRetiredReplay,
      "a retired request never reaches model",
    );
  } finally {
    try {
      await stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
